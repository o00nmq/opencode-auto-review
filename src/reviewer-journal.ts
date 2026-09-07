import { createHash } from "node:crypto"
import { buildReviewPrompt, DEFAULT_OPTIONS } from "./policy.js"
import type { ReviewContextEntry, ReviewerJournalState, ReviewRequest } from "./types.js"
import { estimateTokens } from "./context-budget.js"

const USER_BUDGET_SHARE = 0.6
const TOOL_BUDGET_SHARE = 0.3
const COMPACTION_BUDGET_SHARE = 0.1

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
  const historical = request.context.slice(0, -1)
  const current = request.context.at(-1)
  if (!current || current.type !== "tool") return

  if (previous && previous.checkpoint === request.checkpoint && previous.sourceLength <= historical.length &&
    digest(request.context.slice(0, previous.sourceLength)) === previous.sourceDigest) {
    const appended = [
      ...previous.lines,
      ...historical.slice(previous.sourceLength).map(serialize),
      serialize(reviewLine(current, request)),
    ]
    if (promptTokens(appended, reasoningTokens) <= maxInputTokens) {
      return prepared(previous.epoch, request.context, appended, reasoningTokens, request.checkpoint)
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
  const minimum = epochLines(epoch, request, historical, selected, currentTool)
  const available = maxInputTokens - promptTokens(minimum, reasoningTokens)
  if (available < 0) return

  const remaining = {
    user: Math.floor(available * USER_BUDGET_SHARE),
    tool: Math.floor(available * TOOL_BUDGET_SHARE),
    compaction: Math.floor(available * COMPACTION_BUDGET_SHARE),
  }
  const users = indexesOf(historical, "user")
  const tools = indexesOf(historical, "tool")
  const compactions = indexesOf(historical, "compaction")

  const anchoredUsers = unique([users[0], users.at(-1), ...users.slice(1, -1).reverse()])
  addWithinBudget(anchoredUsers, "user")
  addWithinBudget([...compactions].reverse(), "compaction")
  addWithinBudget([...tools].reverse(), "tool")

  // Let categories borrow unused capacity without changing their priority order.
  addWithinBudget(anchoredUsers, undefined)
  addWithinBudget([...compactions].reverse(), undefined)
  addWithinBudget([...tools].reverse(), undefined)

  const lines = epochLines(epoch, request, historical, selected, currentTool)
  return prepared(epoch, request.context, lines, reasoningTokens, request.checkpoint)

  function addWithinBudget(indexes: readonly number[], category: keyof typeof remaining | undefined) {
    for (const index of indexes) {
      if (selected.has(index)) continue
      const cost = estimateTokens(serialize(historical[index]!))
      if (category && cost > remaining[category]) continue
      const next = new Set(selected).add(index)
      if (promptTokens(epochLines(epoch, request, historical, next, currentTool), reasoningTokens) > maxInputTokens) continue
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
      source_history_truncated: request.history_truncated,
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
  context: readonly ReviewContextEntry[],
  lines: string[],
  reasoningTokens: number,
  checkpoint?: string,
): PreparedReviewJournal {
  const state = {
    ...(checkpoint ? { checkpoint } : {}),
    version: 2 as const,
    epoch,
    sourceLength: context.length,
    sourceDigest: digest(context),
    lines,
  }
  return { ...state, prompt: buildReviewPrompt(lines, reasoningTokens) }
}

function readState(value: unknown): ReviewerJournalState | undefined {
  if (!isRecord(value) || value.version !== 2 || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 0 ||
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
