import { createHash } from "node:crypto"
import { buildReviewPrompt, DEFAULT_OPTIONS } from "./policy.js"
import type { ReviewContextEntry, ReviewerJournalState, ReviewRequest } from "./types.js"
import { estimateTokens } from "./context-budget.js"

const USER_BUDGET_SHARE = 0.6
const TOOL_BUDGET_SHARE = 0.3
const COMPACTION_BUDGET_SHARE = 0.1
// Optional entries stop below the budget so a subsequent review can append to the
// journal. Without it a selection that filled the budget to its last token would
// force a new epoch on the very next append, and the rebuilt selection would fill
// again, making a rebuild the steady state — every review restarting the prompt
// and losing the provider's cached prefix. Every pass stops at this limit, not
// just the borrowing fill, and the limit is measured against the flexible space
// (budget minus fixed framing) so a small budget or a large fixed part cannot
// switch it off. Appends still erode this headroom, so the honest effect is that
// rebuilds become periodic rather than per-review.
const RETENTION_SHARE = 0.75

export interface PreparedReviewJournal extends ReviewerJournalState {
  prompt: string
}

export function prepareReviewJournal(
  stored: unknown,
  request: ReviewRequest,
  maxInputTokens: number,
  reasoningTokens = DEFAULT_OPTIONS.maxReviewTokens,
): PreparedReviewJournal | undefined {
  const previous = readState(stored)
  // The journal tracks the *completed* history, not the pending tool. Several
  // reviews can share one history while differing only in the tool under review
  // (parallel calls in one assistant message, or a repeated evaluation), and
  // measuring against the pending tool would rebuild the epoch each time. A new
  // epoch restarts the prompt with a fresh `review_epoch` line, which breaks the
  // byte prefix at the static policy and forces the provider to recompute the
  // whole journal instead of reusing its prefix cache.
  const historical = request.context.slice(0, -1)
  const current = request.context.at(-1)
  if (!current || current.type !== "tool") return

  if (previous && previous.checkpoint === request.checkpoint && previous.sourceLength <= historical.length &&
    digest(historical.slice(0, previous.sourceLength)) === previous.sourceDigest) {
    const appended = [
      ...previous.lines,
      ...historical.slice(previous.sourceLength).map(serialize),
      serialize(reviewLine(current, request)),
    ]
    if (promptTokens(appended, reasoningTokens) <= maxInputTokens) {
      return prepared(previous.epoch, historical, appended, reasoningTokens, request.checkpoint)
    }
  }

  return startEpoch(previous?.epoch === undefined ? 0 : previous.epoch + 1, request, maxInputTokens, reasoningTokens)
}

function startEpoch(
  epoch: number,
  request: ReviewRequest,
  maxInputTokens: number,
  reasoningTokens: number,
): PreparedReviewJournal | undefined {
  const current = request.context.at(-1)
  if (!current || current.type !== "tool") return
  const currentTool = current
  const historical = request.context.slice(0, -1)
  const selected = new Set<number>()
  const users = indexesOf(historical, "user")
  // The latest user instruction governs the pending request, so it is mandatory
  // rather than budgeted: if even it does not fit, the review is refused instead
  // of silently approving against an older, possibly superseded, instruction.
  if (users.length) selected.add(users.at(-1)!)
  const minimum = epochLines(epoch, request, historical, selected, currentTool)
  const minimumTokens = promptTokens(minimum, reasoningTokens)
  const available = maxInputTokens - minimumTokens
  if (available < 0) return
  // Headroom is measured against the flexible space, not the whole prompt. The
  // fixed part (policy text, epoch line, review line) can already be a large
  // share of a small budget; an absolute fraction would then leave no room at all
  // and switch the borrowing fill off entirely.
  const retentionLimit = minimumTokens + Math.floor(available * RETENTION_SHARE)

  const remaining = {
    user: Math.floor(available * USER_BUDGET_SHARE),
    tool: Math.floor(available * TOOL_BUDGET_SHARE),
    compaction: Math.floor(available * COMPACTION_BUDGET_SHARE),
  }
  const tools = indexesOf(historical, "tool")
  const compactions = indexesOf(historical, "compaction")

  const anchoredUsers = unique([users[0], ...users.slice(1, -1).reverse()])
  addWithinBudget(anchoredUsers, "user")
  addWithinBudget([...compactions].reverse(), "compaction")
  addWithinBudget([...tools].reverse(), "tool")

  // Let categories borrow unused capacity without changing their priority
  // order. The borrowing fill is bounded so a saturated selection still leaves
  // the journal room to append, instead of forcing a rebuild on the next review
  // that would fill again and make that the steady state. If the bounded
  // selection omits a user instruction, the host refuses an automatic allow until
  // it is recovered through history evidence.
  addWithinBudget(anchoredUsers, undefined)
  addWithinBudget([...compactions].reverse(), undefined)
  addWithinBudget([...tools].reverse(), undefined)

  const lines = epochLines(epoch, request, historical, selected, currentTool)
  return prepared(epoch, historical, lines, reasoningTokens, request.checkpoint)

  function addWithinBudget(indexes: readonly number[], category: keyof typeof remaining | undefined) {
    for (const index of indexes) {
      if (selected.has(index)) continue
      const cost = estimateTokens(serialize(historical[index]!))
      if (category && cost > remaining[category]) continue
      const next = new Set(selected).add(index)
      // Every pass, priority or borrowing, stops at the retention limit, so the
      // headroom holds however the selection is composed — not only when one
      // category saturates it.
      if (promptTokens(epochLines(epoch, request, historical, next, currentTool), reasoningTokens) > retentionLimit) continue
      selected.add(index)
      if (category) remaining[category] -= cost
    }
  }
}

function epochLines(
  epoch: number,
  request: ReviewRequest,
  historical: readonly ReviewContextEntry[],
  selected: ReadonlySet<number>,
  current: Extract<ReviewContextEntry, { type: "tool" }>,
): string[] {
  const retained = { users: 0, tools: 0, compactions: 0 }
  const total = { users: 0, tools: 0, compactions: 0 }
  for (let index = 0; index < historical.length; index++) {
    const key = category(historical[index]!)
    total[key]++
    if (selected.has(index)) retained[key]++
  }
  return [
    serialize({
      type: "review_epoch",
      epoch,
      omitted: {
        users: total.users - retained.users,
        tools: total.tools - retained.tools,
        compactions: total.compactions - retained.compactions,
      },
    }),
    ...historical.flatMap((entry, index) => selected.has(index) ? [serialize(entry)] : []),
    serialize(reviewLine(current, request)),
  ]
}

function reviewLine(current: Extract<ReviewContextEntry, { type: "tool" }>, request: ReviewRequest) {
  return {
    type: "review",
    tool: { name: current.name, input: current.input },
    permission: request.permission,
  }
}

function prepared(
  epoch: number,
  historical: readonly ReviewContextEntry[],
  lines: string[],
  reasoningTokens: number,
  checkpoint?: string,
): PreparedReviewJournal {
  const state = {
    ...(checkpoint ? { checkpoint } : {}),
    version: 3 as const,
    epoch,
    sourceLength: historical.length,
    sourceDigest: digest(historical),
    lines,
  }
  return { ...state, prompt: buildReviewPrompt(lines, reasoningTokens) }
}

function readState(value: unknown): ReviewerJournalState | undefined {
  if (!isRecord(value) || value.version !== 3 || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 0 ||
    !Number.isSafeInteger(value.sourceLength) || (value.sourceLength as number) < 0 ||
    typeof value.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceDigest) ||
    !Array.isArray(value.lines) || value.lines.some((line) => typeof line !== "string")) return
  return value as unknown as ReviewerJournalState
}

function indexesOf(context: readonly ReviewContextEntry[], type: ReviewContextEntry["type"]): number[] {
  return context.flatMap((entry, index) => entry.type === type ? [index] : [])
}

function unique(values: readonly (number | undefined)[]): number[] {
  return [...new Set(values.filter((value): value is number => value !== undefined))]
}

function category(entry: ReviewContextEntry): "users" | "tools" | "compactions" {
  if (entry.type === "user") return "users"
  if (entry.type === "tool") return "tools"
  return "compactions"
}

function promptTokens(lines: readonly string[], reasoningTokens: number): number {
  return estimateTokens(buildReviewPrompt(lines, reasoningTokens))
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function serialize(value: unknown): string {
  return JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
