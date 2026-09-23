import { createHash } from "node:crypto"
import { buildReviewPrompt, DEFAULT_OPTIONS } from "./policy.js"
import type { ReviewContextEntry, ReviewerJournalState, ReviewRequest } from "./types.js"
import { estimateTokens } from "./context-budget.js"

const USER_BUDGET_SHARE = 0.6
const TOOL_BUDGET_SHARE = 0.3
const COMPACTION_BUDGET_SHARE = 0.1
// The body is snapshotted below the budget so the per-review suffix — recent
// actions, prior verdicts, the pending tool, and the evidence index — normally has
// room; if it does not, the suffix drops optional entries and, failing that, the
// review falls back to a rebuild. The limit is measured against the flexible space
// (budget minus fixed framing) so a small budget or a large fixed policy part
// cannot switch it off.
const RETENTION_SHARE = 0.75
/**
 * The body grows while it stays under this share of the budget; past it the body
 * is sealed and only a bounded suffix moves. Sealing a little below the budget
 * leaves room for that suffix, so the cached prefix is most of the prompt instead
 * of the whole journal being discarded.
 */
const SEAL_SHARE = 0.85
/** Maximum prior verdicts carried after the sealed body; fewer are kept when the suffix budget is tight. */
export const OUTCOME_TAIL = 4

function sealLimit(maxInputTokens: number): number {
  return Math.floor(maxInputTokens * SEAL_SHARE)
}

export interface PreparedReviewJournal extends ReviewerJournalState {
  /** This review's prompt lines: cached body + bounded suffix + review line. */
  lines: string[]
  prompt: string
}

/**
 * Prepare the reviewer journal for one review, in two phases.
 *
 * **Grow.** Until the body is sealed, each review's new entries are folded into
 * it, so the body grows monotonically and the header line stays byte-identical.
 * The shared prefix is the body itself, not the whole prompt: the tail (recent
 * actions, verdicts, the pending tool, the evidence index) changes every review.
 *
 * **Seal.** Once the body would exceed the seal limit it is retained
 * byte-identical and only a bounded suffix moves; the seal is recorded in the
 * persisted state so a later small request cannot resume growing. Sealing avoids
 * a costly failure mode: a rebuild rewrites the header line — and because the
 * journal's first line is the `review_epoch` marker, whose omission counts change
 * when a grown history is re-selected, that invalidates the cached prefix for the
 * *entire* journal, leaving only the static policy block cached. A rebuilt
 * selection also refills the budget, so a saturated session would rebuild on every
 * review. Sealing keeps the header and body fixed, so the cached prefix survives
 * every review until the boundary genuinely changes.
 *
 * Compaction, a rewritten history, or a pending request that cannot fit even after
 * every optional suffix entry is dropped still starts a new epoch. Everything that
 * must stay fresh lives after the body: the new user instructions (authorization
 * must remain present), the actions that still fit in their original order, an
 * explicit omission count, prior verdicts, the pending tool, and the evidence
 * index.
 */
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

  if (previous && previous.checkpoint === request.checkpoint &&
    previous.sourceLength <= historical.length &&
    digest(historical.slice(0, previous.sourceLength)) === previous.sourceDigest) {
    const fresh = historical.slice(previous.sourceLength)
    const review = serialize(reviewLine(current, request))
    if (!previous.sealed) {
      // 1) Grow. Folding the new entries into the body keeps the header line
      //    byte-identical and extends the body line by line, so the body remains a
      //    byte-prefix of every later prompt in the epoch. The tail still changes
      //    per review, so the reused prefix is the body, not the whole prompt.
      const grownBody = [...previous.body, ...previous.outcomes, ...fresh.map(serialize)]
      const grown = [...grownBody, review]
      if (promptTokens(grown, reasoningTokens) <= sealLimit(maxInputTokens)) {
        const state: ReviewerJournalState = { ...previous, body: grownBody, outcomes: [], sealed: false,
          sourceLength: historical.length, sourceDigest: digest(historical) }
        return { ...state, lines: grown, prompt: buildReviewPrompt(grown, reasoningTokens) }
      }
    }
    // 2) Sealed. Growing further would exceed the budget, and rebuilding would
    //    rewrite the header line — and because the journal's first line is the
    //    epoch marker, that invalidates the *entire* journal prefix for the
    //    provider, leaving only the static policy block cached. So the body is
    //    retained as the cached prefix and only a bounded suffix moves. The seal is
    //    persisted: `sourceLength` deliberately stays at the last grown boundary, so
    //    post-seal entries are re-derived from the transcript each review instead of
    //    being folded in.
    const suffix = suffixLines(fresh, previous.outcomes, previous.body, current, request, maxInputTokens, reasoningTokens)
    if (suffix) {
      const lines = [...previous.body, ...suffix, review]
      return { ...previous, sealed: true, lines, prompt: buildReviewPrompt(lines, reasoningTokens) }
    }
  }

  // Fallback. Either the epoch cannot be extended (a compaction, a rewritten
  // history, or no prior state), or the suffix could not fit even after every
  // optional entry was dropped — a genuinely over-budget request. Rebuilding
  // rewrites the header line, so it is the expensive path and not the default one.
  const epoch = previous?.epoch === undefined ? 0 : previous.epoch + 1
  const body = buildBody(epoch, request, maxInputTokens, reasoningTokens)
  if (!body) return
  const state: ReviewerJournalState = {
    ...(request.checkpoint ? { checkpoint: request.checkpoint } : {}),
    version: 5,
    epoch,
    sourceLength: historical.length,
    sourceDigest: digest(historical),
    body,
    sealed: false,
    outcomes: [],
  }
  const lines = [...state.body, serialize(reviewLine(current, request))]
  return { ...state, lines, prompt: buildReviewPrompt(lines, reasoningTokens) }
}

/**
 * The bounded suffix after the sealed body: every new user instruction (that is
 * the authorization for the pending request and must never be dropped), plus as
 * many of the most recent actions as the budget still allows, plus as many recent
 * verdicts as still fit. Verdicts are context rather than authorization, so they
 * are droppable: otherwise a long prior verdict could consume the suffix headroom
 * on its own and force a rebuild on every review with unchanged history. Returns
 * `undefined` when even the base — body plus user instructions plus the pending
 * review — does not fit, so the caller can rebuild rather than silently review
 * without the governing instruction.
 */
function suffixLines(
  fresh: readonly ReviewContextEntry[],
  outcomes: readonly string[],
  body: readonly string[],
  current: Extract<ReviewContextEntry, { type: "tool" }>,
  request: ReviewRequest,
  maxInputTokens: number,
  reasoningTokens: number,
): string[] | undefined {
  const review = serialize(reviewLine(current, request))
  // User instructions are mandatory: authorization must never be dropped. Actions
  // are optional and are dropped oldest-first, so what survives is a contiguous
  // newest tail. All retained entries keep their original relative order, because
  // reordering them would change which instruction a completed action appears to
  // have consumed — exactly what a one-shot authorization check depends on.
  const lines = fresh.map(serialize)
  const actionIndexes = fresh.flatMap((entry, index) => entry.type !== "user" ? [index] : [])
  // `compose` returns only the suffix (the caller prepends the body and appends
  // the review line); `tokens` measures the whole prompt as the caller will build
  // it, so the fit decision matches what is actually sent.
  const compose = (dropped: ReadonlySet<number>, keptOutcomes: number) => [
    ...(dropped.size > 0 ? [serialize({ type: "since_snapshot", omittedActions: dropped.size })] : []),
    ...lines.flatMap((line, index) => dropped.has(index) ? [] : [line]),
    ...outcomes.slice(outcomes.length - keptOutcomes),
  ]
  const tokens = (dropped: ReadonlySet<number>, keptOutcomes: number) =>
    promptTokens([...body, ...compose(dropped, keptOutcomes), review], reasoningTokens)
  // The base has every optional entry dropped. If even it does not fit there is
  // nothing to seal, and the caller rebuilds.
  const dropped = new Set(actionIndexes)
  if (tokens(dropped, 0) > maxInputTokens) return
  // Add actions back newest-first. Each step is one real prompt build, so the cost
  // is proportional to what is kept rather than to the whole history. This is a
  // linear sweep rather than a binary search on purpose: the token estimate is a
  // chunk heuristic and is not monotonic in string length, so a binary search can
  // miss the largest fitting suffix and wrongly fall through to a rebuild.
  for (let index = actionIndexes.length - 1; index >= 0; index--) {
    const candidate = actionIndexes[index]!
    dropped.delete(candidate)
    if (tokens(dropped, 0) > maxInputTokens) {
      dropped.add(candidate)
      break
    }
  }
  // Then spend whatever headroom is left on the most recent verdicts.
  let keptOutcomes = 0
  for (let count = 1; count <= outcomes.length; count++) {
    if (tokens(dropped, count) > maxInputTokens) break
    keptOutcomes = count
  }
  return tokens(dropped, keptOutcomes) <= maxInputTokens ? compose(dropped, keptOutcomes) : undefined
}

/** Build a fresh body: the epoch line plus the budgeted history selection. */
function buildBody(
  epoch: number,
  request: ReviewRequest,
  maxInputTokens: number,
  reasoningTokens: number,
): string[] | undefined {
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

  addWithinBudget(anchoredUsers, undefined)
  addWithinBudget([...compactions].reverse(), undefined)
  addWithinBudget([...tools].reverse(), undefined)

  // The body stops before the review line: that line is rebuilt every review.
  return epochLines(epoch, request, historical, selected, currentTool).slice(0, -1)

  function addWithinBudget(indexes: readonly number[], category: keyof typeof remaining | undefined) {
    for (const index of indexes) {
      if (selected.has(index)) continue
      const cost = estimateTokens(serialize(historical[index]!))
      if (category && cost > remaining[category]) continue
      const next = new Set(selected).add(index)
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

function readState(value: unknown): ReviewerJournalState | undefined {
  if (!isRecord(value) || value.version !== 5 || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 0 ||
    typeof value.sealed !== "boolean" ||
    !Number.isSafeInteger(value.sourceLength) || (value.sourceLength as number) < 0 ||
    typeof value.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceDigest) ||
    !Array.isArray(value.body) || value.body.some((line) => typeof line !== "string") ||
    !Array.isArray(value.outcomes) || value.outcomes.some((line) => typeof line !== "string")) return
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
