import assert from "node:assert/strict"
import test from "node:test"
import { prepareReviewJournal } from "../src/reviewer-journal.js"
import { buildReviewPrompt } from "../src/policy.js"
import { estimateTokens } from "../src/context-budget.js"
import type { ReviewRequest } from "../src/types.js"

function request(context: ReviewRequest["context"]): ReviewRequest {
  return { context, permission: { action: "read", resources: ["a.ts"] } }
}

test("a continued pseudo-session grows the body monotonically under a stable header", () => {
  const first = prepareReviewJournal(undefined, request([
    { type: "user", text: "Inspect files" },
    { type: "tool", name: "read", input: { path: "a.ts" } },
  ]), 10_000)!
  const second = prepareReviewJournal(first, request([
    { type: "user", text: "Inspect files" },
    { type: "tool", name: "read", input: { path: "a.ts" } },
    { type: "tool", name: "read", input: { path: "b.ts" } },
  ]), 10_000)!

  assert.equal(second.epoch, 0)
  // The header line is the journal's prefix: it must stay byte-identical, or the
  // provider discards the whole cached journal. The body itself grows line by line,
  // so it stays a byte-prefix of every later prompt in the epoch.
  assert.equal(second.body[0], first.body[0])
  assert.deepEqual(second.body.slice(0, first.body.length), first.body)
  assert.ok(second.body.length >= first.body.length)
  assert.match(second.prompt, /b\.ts/)
  assert.doesNotMatch(second.prompt, /review_outcome/)
})

test("parallel tool calls in one assistant message keep the same epoch and header", () => {
  // One assistant message can request several tools at once. Those reviews share
  // the same history and differ only in the pending tool, so neither the epoch nor
  // the header line may move: a fresh `review_epoch` line at the front would throw
  // away the provider's cached prefix on every parallel call.
  const first = prepareReviewJournal(undefined, request([
    { type: "user", text: "Inspect files" },
    { type: "tool", name: "read", input: { path: "a.ts" } },
  ]), 10_000)!
  const second = prepareReviewJournal(first, request([
    { type: "user", text: "Inspect files" },
    { type: "tool", name: "read", input: { path: "b.ts" } },
  ]), 10_000)!

  assert.equal(second.epoch, 0)
  assert.equal(second.body[0], first.body[0])
  assert.notDeepEqual(second.lines, first.lines, "the pending tool line must change")
})

test("re-reviewing the same pending tool reuses the identical prompt", () => {
  // A second evaluation of one request must not reset the journal either.
  const context: ReviewRequest["context"] = [
    { type: "user", text: "Inspect files" },
    { type: "tool", name: "read", input: { path: "a.ts" } },
  ]
  const first = prepareReviewJournal(undefined, request(context), 10_000)!
  const second = prepareReviewJournal(first, request(context), 10_000)!

  assert.equal(second.epoch, 0)
  assert.deepEqual(second.lines, first.lines)
})

test("a saturated selection leaves room for the per-review suffix", () => {
  // The body is bounded below the budget so the suffix — recent actions, prior
  // verdicts, the pending tool, and the evidence index — normally fits without
  // forcing a rebuild. A body that filled the budget would restart the prompt on
  // the next review and drop the provider's cached prefix.
  const tools = Array.from({ length: 60 }, (_, index) =>
    ({ type: "tool" as const, name: "read", input: { path: `${"p".repeat(300)}${index}` } }))
  const shared = [{ type: "user" as const, text: "Inspect files" }, ...tools]
  const budget = estimateTokens(buildReviewPrompt([])) + 8_000
  const first = prepareReviewJournal(undefined, request([...shared, { type: "tool", name: "read", input: { path: "a.ts" } }]), budget)!
  assert.ok(estimateTokens(first.prompt) < budget * 0.95,
    `the body must leave headroom, used ${estimateTokens(first.prompt)} of ${budget}`)
  const second = prepareReviewJournal(first, request([...shared, { type: "tool", name: "read", input: { path: "b.ts" } }]), budget)!
  assert.equal(second.epoch, 0)
  assert.deepEqual(second.body, first.body)
})

test("the governing user instruction is never silently dropped for an older one", () => {
  // The latest instruction governs the pending request. If it does not fit the
  // budget the review is refused, rather than approving against an older and
  // possibly superseded instruction.
  const base = estimateTokens(buildReviewPrompt([]))
  const context = [
    { type: "user" as const, text: "FIRST_CONSTRAINT" },
    { type: "user" as const, text: `LATEST_${"u".repeat(400)}` },
    { type: "tool" as const, name: "read", input: { path: "a.ts" } },
  ]
  const roomy = prepareReviewJournal(undefined, request(context), base + 800)!
  assert.match(roomy.prompt, /LATEST_uuuu/)
  assert.match(roomy.prompt, /FIRST_CONSTRAINT/)
  assert.equal(prepareReviewJournal(undefined, request(context), base + 120), undefined)
})

test("user instructions keep priority over the tool backlog", () => {
  // Only tools are bounded for headroom; authorization must not be squeezed out
  // by the backlog that shares the journal.
  const newest = `LATEST_${"u".repeat(600)}`
  const prepared = prepareReviewJournal(undefined, request([
    { type: "user", text: "FIRST_CONSTRAINT" },
    ...Array.from({ length: 40 }, (_, index) => ({ type: "tool" as const, name: "read", input: { path: `${"p".repeat(300)}${index}` } })),
    { type: "user", text: newest },
    { type: "tool", name: "read", input: { path: "a.ts" } },
  ]), estimateTokens(buildReviewPrompt([])) + 8_000)!

  assert.match(prepared.prompt, /FIRST_CONSTRAINT/)
  assert.match(prepared.prompt, /LATEST_u{500}/)
})

test("a user-heavy journal still leaves append headroom", () => {
  // Users are prioritized, but they must not fill the budget to the ceiling: the
  // next review appends a line, and a saturated selection would rebuild instead.
  const users = Array.from({ length: 300 }, (_, index) => ({ type: "user" as const, text: `Request ${index} ${"u".repeat(40)}` }))
  const budget = estimateTokens(buildReviewPrompt([])) + 6_000
  const first = prepareReviewJournal(undefined, request([...users, { type: "tool", name: "read", input: { path: "a.ts" } }]), budget)!
  assert.ok(estimateTokens(first.prompt) <= budget * 0.95,
    `the selection must leave headroom, used ${estimateTokens(first.prompt)} of ${budget}`)
  const second = prepareReviewJournal(first, request([...users, { type: "tool", name: "read", input: { path: "b.ts" } }]), budget)!
  assert.equal(second.epoch, 0)
})

test("a selection full in every category still leaves append headroom", () => {
  // The headroom bound has to hold however the selection is composed, not only
  // when a single category saturates it.
  const summary = { type: "compaction" as const, summary: "s".repeat(2_000), recent: "r".repeat(500) }
  const users = Array.from({ length: 40 }, (_, index) => ({ type: "user" as const, text: `User ${index} ${"u".repeat(300)}` }))
  const tools = Array.from({ length: 40 }, (_, index) => ({ type: "tool" as const, name: "read", input: { path: `${"p".repeat(300)}${index}` } }))
  const budget = estimateTokens(buildReviewPrompt([])) + 8_000
  const first = prepareReviewJournal(undefined, request([summary, ...users, ...tools,
    { type: "tool", name: "read", input: { path: "a.ts" } }]), budget)!
  assert.ok(estimateTokens(first.prompt) <= budget * 0.9,
    `the selection must leave headroom, used ${estimateTokens(first.prompt)} of ${budget}`)
  const second = prepareReviewJournal(first, request([summary, ...users, ...tools,
    { type: "tool", name: "read", input: { path: "b.ts" } }]), budget)!
  assert.equal(second.epoch, 0)
})

test("a new user instruction reaches the reviewer without moving the header", () => {
  const first = prepareReviewJournal(undefined, request([
    { type: "user", text: "Read files" },
    { type: "tool", name: "read", input: { path: "a.ts" } },
  ]), 10_000)!
  const next = prepareReviewJournal(first, request([
    { type: "user", text: "Read files" },
    { type: "tool", name: "read", input: { path: "a.ts" } },
    { type: "user", text: "Never touch src/secrets" },
    { type: "tool", name: "read", input: { path: "b.ts" } },
  ]), 10_000)!

  // The instruction is folded into the growing body, so it is disclosed, counts
  // for authorization, and the header line never moves.
  assert.equal(next.epoch, 0)
  assert.equal(next.body[0], first.body[0])
  assert.match(next.prompt, /Never touch src\/secrets/)
})

test("once sealed, the body stops changing and later reviews stay warm", () => {
  // The reported bug: a journal that fills the budget rebuilds on every review,
  // and because the header line carries the epoch, every review invalidates the
  // entire journal prefix. Past the seal the body must stay byte-identical; only
  // the bounded suffix moves, so the cached prefix survives every review.
  const tools = Array.from({ length: 60 }, (_, index) =>
    ({ type: "tool" as const, name: "read", input: { path: `${"p".repeat(300)}${index}` } }))
  const budget = estimateTokens(buildReviewPrompt([])) + 8_000
  let state = prepareReviewJournal(undefined, request([
    { type: "user", text: "Read files" }, ...tools,
    { type: "tool", name: "read", input: { path: "pending.ts" } },
  ]), budget)!
  // Drive it past the seal point, then many more reviews with large new actions.
  let sealedBody: string[] | undefined
  let dropped = false
  for (let i = 0; i < 30; i++) {
    const grown = prepareReviewJournal(state, request([
      { type: "user", text: "Read files" }, ...tools,
      ...Array.from({ length: i + 1 }, (_, j) => ({ type: "tool" as const, name: "read", input: { path: `x${j}${"q".repeat(400)}` } })),
      { type: "tool", name: "read", input: { path: "pending.ts" } },
    ]), budget)!
    assert.equal(grown.epoch, 0, `review ${i} must not start a new epoch`)
    assert.equal(grown.body[0], state.body[0], `review ${i} must keep the header line`)
    if (sealedBody) assert.deepEqual(grown.body, sealedBody, `review ${i} must not move a sealed body`)
    assert.ok(estimateTokens(grown.prompt) <= budget, `review ${i} must stay in budget`)
    if (grown.prompt.includes("since_snapshot")) { dropped = true; sealedBody ??= grown.body }
    state = grown
  }
  assert.ok(sealedBody, "the journal must reach the sealed state")
  assert.ok(dropped, "the oldest suffix actions must be dropped and accounted for")
})

test("a sealed suffix keeps interleaved instructions and actions in original order", () => {
  // Reordering users before actions changes which instruction a completed action
  // appears to have consumed, which is exactly what a one-shot authorization check
  // depends on. The whole instruction → action → instruction → action run must sit
  // in the suffix and keep its order.
  const budget = estimateTokens(buildReviewPrompt([])) + 3_000
  const filler = Array.from({ length: 24 }, (_, index) =>
    ({ type: "tool" as const, name: "read", input: { path: `${"z".repeat(300)}${index}` } }))
  const pending = { type: "tool" as const, name: "read", input: { path: "pending.ts" } }
  const first = prepareReviewJournal(undefined, request([
    { type: "user", text: "Start work" }, ...filler, pending,
  ]), budget)!
  const second = prepareReviewJournal(first, request([
    { type: "user", text: "Start work" }, ...filler,
    { type: "user", text: "now deploy once" },
    { type: "tool", name: "shell", input: { command: "deploy --once" } },
    { type: "user", text: "and run it once more" },
    { type: "tool", name: "shell", input: { command: "deploy --twice" } },
    pending,
  ]), budget)!

  assert.equal(second.epoch, 0)
  assert.equal(second.sealed, true, "the suffix case is the one under test")
  // Everything after the body is this review's suffix, and the whole
  // instruction → action → instruction → action run lives in it.
  const suffix = second.lines.slice(second.body.length)
  const at = (needle: string) => suffix.findIndex((line) => line.includes(needle))
  const order = [at("now deploy once"), at("deploy --once"), at("and run it once more"), at("deploy --twice")]
  assert.ok(order.every((position) => position >= 0), "every instruction and action stays in the suffix")
  assert.deepEqual([...order].sort((a, b) => a - b), order, "the suffix keeps chronological order")
})

test("a dropped suffix action is always accounted for by an omission marker", () => {
  // Losing the count silently would misreport a consumed one-shot authorization.
  // The suffix only ever drops actions that arrived *after* the snapshot; actions
  // omitted by the initial selection are reported by the epoch line instead.
  const budget = estimateTokens(buildReviewPrompt([])) + 3_000
  const pending = { type: "tool" as const, name: "read", input: { path: "pending.ts" } }
  const first = prepareReviewJournal(undefined, request([{ type: "user", text: "Go" }, pending]), budget)!
  const later = Array.from({ length: 40 }, (_, index) =>
    ({ type: "tool" as const, name: "read", input: { path: `${"p".repeat(400)}${index}` } }))
  const sealed = prepareReviewJournal(first, request([{ type: "user", text: "Go" }, ...later, pending]), budget)!
  assert.equal(sealed.epoch, 0)
  const kept = sealed.lines.filter((line) => line.includes(`"type":"tool"`)).length - first.body.filter((line) => line.includes(`"type":"tool"`)).length
  assert.ok(kept < later.length, "the budget must force some actions out of the suffix")
  const marker = sealed.lines.find((line) => line.includes('"since_snapshot"'))
  assert.ok(marker, "dropping any suffix action requires the marker")
  assert.match(marker, new RegExp(`"omittedActions":${later.length - kept}`))
})

test("a state from an older version is rebuilt rather than trusted", () => {
  const stale = { version: 3, epoch: 7, sourceLength: 0, sourceDigest: "a".repeat(64), lines: ["{}"] }
  const prepared = prepareReviewJournal(stale, request([
    { type: "user", text: "Read files" },
    { type: "tool", name: "read", input: { path: "a.ts" } },
  ]), 10_000)!
  assert.equal(prepared.epoch, 0)
  // A v4 snapshot has no `sealed` field, so it cannot be trusted to know whether
  // the body had stopped growing. It is rebuilt once instead of being guessed at.
  const previousShape = { version: 4, epoch: 3, sourceLength: 2, sourceDigest: "b".repeat(64),
    body: ["{}", "{}"], outcomes: [] }
  const rebuilt = prepareReviewJournal(previousShape, request([
    { type: "user", text: "Read files" },
    { type: "tool", name: "read", input: { path: "a.ts" } },
  ]), 10_000)!
  assert.equal(rebuilt.epoch, 0, "a snapshot with no seal state is rebuilt, not extended")
  assert.equal(rebuilt.sealed, false)
})

test("a history discontinuity starts a new bounded epoch", () => {
  const first = prepareReviewJournal(undefined, request([
    { type: "user", text: "Inspect files" },
    { type: "tool", name: "read", input: { path: "a.ts" } },
  ]), 10_000)!
  const reset = prepareReviewJournal(first, request([
    { type: "user", text: "After compaction" },
    { type: "tool", name: "read", input: { path: "b.ts" } },
  ]), 10_000)!

  assert.equal(reset.epoch, 1)
  assert.match(reset.lines[0]!, /"omitted":\{"users":0,"tools":0,"compactions":0\}/)
})

test("exhausting the budget seals instead of starting a new epoch", () => {
  // A rebuild here would move the header line and invalidate the cached prefix,
  // and the rebuilt selection would refill the budget again — the reported
  // "every review is cold" loop. The body must survive instead.
  const base = [{ type: "user" as const, text: "Inspect files" }]
  const budget = estimateTokens(buildReviewPrompt([])) + 4_000
  // Large actions in the history (which the seal may drop) but a small pending
  // tool (which is mandatory and must fit).
  const history = Array.from({ length: 40 }, (_, index) =>
    ({ type: "tool" as const, name: "read", input: { path: `${"p".repeat(400)}${index}` } }))
  const pending = { type: "tool" as const, name: "read", input: { path: "pending.ts" } }
  const first = prepareReviewJournal(undefined, request([...base, ...history, pending]), budget)!
  let state = first
  for (let i = 0; i < 20; i++) {
    state = prepareReviewJournal(state, request([...base, ...history, pending]), budget)!
    assert.equal(state.epoch, 0, `review ${i} must not start a new epoch`)
    assert.equal(state.body[0], first.body[0], `review ${i} must keep the header line`)
    assert.ok(estimateTokens(state.prompt) <= budget, `review ${i} must stay in budget`)
  }
  assert.deepEqual(state.body, first.body)
  assert.deepEqual(state.lines.slice(0, state.body.length), first.body,
    "the sealed body is still the prefix of the journal lines")
})

test("new epochs anchor first and latest users before other history", () => {
  const prepared = prepareReviewJournal(undefined, request([
    { type: "user", text: "FIRST_CONSTRAINT" },
    { type: "tool", name: "read", input: { path: "x".repeat(500) } },
    { type: "user", text: `MIDDLE_${"m".repeat(500)}` },
    { type: "user", text: "LATEST_REQUEST" },
    { type: "tool", name: "read", input: { path: "a.ts" } },
  ]), estimateTokens(buildReviewPrompt([])) + 300)!

  assert.match(prepared.prompt, /FIRST_CONSTRAINT/)
  assert.match(prepared.prompt, /LATEST_REQUEST/)
  assert.doesNotMatch(prepared.prompt, /MIDDLE_m{100}/)
  assert.match(prepared.lines[0]!, /"users":1/)
})

test("the token estimate covers fixed policy, framing, and the exact current action", () => {
  const input = request([
    { type: "user", text: "Inspect it" },
    { type: "tool", name: "read", input: { path: "a.ts" } },
  ])
  const budget = estimateTokens(buildReviewPrompt([])) + 200
  const prepared = prepareReviewJournal(undefined, input, budget)!
  assert.ok(estimateTokens(prepared.prompt) <= budget)
  assert.equal(prepareReviewJournal(undefined, input, budget - 150), undefined)
  assert.equal(prepareReviewJournal(undefined, request([
    { type: "user", text: "Inspect it" },
    { type: "tool", name: "read", input: { path: "x".repeat(2_000) } },
  ]), budget), undefined)
})

test("a sealed body stays sealed when a later request is smaller", () => {
  // Sealing is not just "the body happened to be too big once". A large pending
  // request seals the body; a later small request must not resume growing, which
  // would restart the churn the seal exists to stop.
  const budget = estimateTokens(buildReviewPrompt([])) + 3_000
  const history = Array.from({ length: 8 }, (_, index) =>
    ({ type: "tool" as const, name: "read", input: { path: `${"z".repeat(300)}${index}` } }))
  const user = { type: "user" as const, text: "Go" }
  const action = { type: "tool" as const, name: "read", input: { path: "small-action.ts" } }
  const bigPending = { type: "tool" as const, name: "read", input: { path: "P".repeat(5_000) } }
  const smallPending = { type: "tool" as const, name: "read", input: { path: "pending.ts" } }

  const first = prepareReviewJournal(undefined, request([user, ...history, smallPending]), budget)!
  assert.equal(first.sealed, false, "the first selection is not sealed")
  const sealed = prepareReviewJournal(first, request([user, ...history, action, bigPending]), budget)!
  assert.equal(sealed.epoch, 0)
  assert.equal(sealed.sealed, true, "the oversize pending request must seal the body")

  const later = prepareReviewJournal(sealed, request([user, ...history, action, smallPending]), budget)!
  assert.equal(later.epoch, 0)
  assert.equal(later.sealed, true, "a smaller request must not unseal the body")
  assert.deepEqual(later.body, sealed.body, "a sealed body must not resume growing")
})

test("a sealed snapshot restored from storage stays sealed", () => {
  // The seal has to survive the round trip, or a reload silently resumes growing.
  const budget = estimateTokens(buildReviewPrompt([])) + 3_000
  const history = Array.from({ length: 8 }, (_, index) =>
    ({ type: "tool" as const, name: "read", input: { path: `${"z".repeat(300)}${index}` } }))
  const user = { type: "user" as const, text: "Go" }
  const action = { type: "tool" as const, name: "read", input: { path: "small-action.ts" } }
  const bigPending = { type: "tool" as const, name: "read", input: { path: "P".repeat(5_000) } }
  const smallPending = { type: "tool" as const, name: "read", input: { path: "pending.ts" } }
  const sealed = prepareReviewJournal(prepareReviewJournal(undefined, request([
    user, ...history, smallPending,
  ]), budget)!, request([user, ...history, action, bigPending]), budget)!
  assert.equal(sealed.sealed, true)

  // Only the persisted fields survive; `lines`/`prompt` are per-review.
  const stored = JSON.parse(JSON.stringify({
    checkpoint: sealed.checkpoint, version: sealed.version, epoch: sealed.epoch,
    sourceLength: sealed.sourceLength, sourceDigest: sealed.sourceDigest,
    body: sealed.body, sealed: sealed.sealed, outcomes: sealed.outcomes,
  }))
  const restored = prepareReviewJournal(stored, request([user, ...history, action, smallPending]), budget)!
  assert.equal(restored.epoch, sealed.epoch)
  assert.equal(restored.sealed, true, "the restored snapshot must still be sealed")
  assert.deepEqual(restored.body, sealed.body, "the restored body must not resume growing")
})

test("prior verdicts are optional so they cannot force a rebuild on their own", () => {
  // Verdicts are context, not authorization. If they were mandatory in the suffix
  // budget, a long prior verdict with unchanged history and an unchanged pending
  // request would rebuild the journal on every review.
  const budget = estimateTokens(buildReviewPrompt([])) + 3_000
  const history = Array.from({ length: 30 }, (_, index) =>
    ({ type: "tool" as const, name: "read", input: { path: `${"h".repeat(300)}${index}` } }))
  const pending = { type: "tool" as const, name: "read", input: { path: "pending.ts" } }
  const verdict = JSON.stringify({ type: "review_outcome", code: "allow", decision: {
    risk: "low", authorization: "medium", reason: "r".repeat(1_000), matched_rules: [] } })
  const start = prepareReviewJournal(undefined, request([{ type: "user", text: "Go" }, ...history, pending]), budget)!
  let state = start
  for (let review = 0; review < 8; review++) {
    state = { ...state, outcomes: [...state.outcomes, verdict].slice(-4) }
    state = prepareReviewJournal(state, request([{ type: "user", text: "Go" }, ...history, pending]), budget)!
    assert.equal(state.epoch, 0, `review ${review} must not start a new epoch`)
    assert.equal(state.body[0], start.body[0], `review ${review} must keep the header line`)
  }
})

test("a pending request too large for the sealed suffix falls back to a rebuild", () => {
  // The seal is not a promise that no rebuild can ever happen: a genuinely
  // oversized pending request must still be reviewed, from a fresh smaller body.
  const budget = estimateTokens(buildReviewPrompt([])) + 3_000
  const history = Array.from({ length: 24 }, (_, index) =>
    ({ type: "tool" as const, name: "read", input: { path: `${"z".repeat(300)}${index}` } }))
  const first = prepareReviewJournal(undefined, request([
    { type: "user", text: "Go" }, ...history,
    { type: "tool", name: "read", input: { path: "pending.ts" } },
  ]), budget)!
  const rebuilt = prepareReviewJournal(first, request([
    { type: "user", text: "Go" }, ...history,
    { type: "tool", name: "read", input: { path: "P".repeat(3_000) } },
  ]), budget)
  assert.ok(rebuilt, "the oversized request must still produce a journal")
  assert.equal(rebuilt!.epoch, 1, "an oversized pending request starts a new epoch")
  assert.equal(rebuilt!.sealed, false)
  assert.ok(estimateTokens(rebuilt!.prompt) <= budget)
})

test("a compaction after sealing starts a new epoch", () => {
  const budget = estimateTokens(buildReviewPrompt([])) + 3_000
  const history = Array.from({ length: 24 }, (_, index) =>
    ({ type: "tool" as const, name: "read", input: { path: `${"z".repeat(300)}${index}` } }))
  const big = { type: "tool" as const, name: "read", input: { path: "B".repeat(6_000) } }
  const pending = { type: "tool" as const, name: "read", input: { path: "pending.ts" } }
  const base = [{ type: "user" as const, text: "Go" }]
  const sealed = prepareReviewJournal(prepareReviewJournal(undefined, request([...base, ...history, pending]), budget)!,
    request([...base, ...history, big, pending]), budget)!
  assert.equal(sealed.sealed, true)

  const afterCompaction = prepareReviewJournal(sealed, {
    ...request([...base, ...history, big, pending]),
    checkpoint: "cp-new",
  }, budget)!
  assert.equal(afterCompaction.epoch, sealed.epoch + 1, "a compaction boundary starts a new epoch")
  assert.equal(afterCompaction.sealed, false)
})

test("a smaller budget on an already-sealed state still fits", () => {
  // The estimator can shrink (a different model, a changed output cap). A sealed
  // body sized for the old budget must not be sent to one it no longer fits.
  const budget = estimateTokens(buildReviewPrompt([])) + 5_000
  const history = Array.from({ length: 40 }, (_, index) =>
    ({ type: "tool" as const, name: "read", input: { path: `${"z".repeat(400)}${index}` } }))
  const pending = { type: "tool" as const, name: "read", input: { path: "pending.ts" } }
  const context = [{ type: "user" as const, text: "Go" }, ...history, pending]
  let state = prepareReviewJournal(undefined, request(context), budget)!
  for (let review = 0; review < 3; review++) state = prepareReviewJournal(state, request(context), budget)!
  assert.equal(state.sealed, true)

  const smaller = budget - 4_000
  const shrunk = prepareReviewJournal(state, request(context), smaller)!
  assert.ok(shrunk, "the review must still be produced")
  assert.ok(estimateTokens(shrunk.prompt) <= smaller, "the shrunk prompt must fit the smaller budget")
  assert.ok(shrunk.body.length <= state.body.length, "the body must shrink, never grow, when the budget drops")
})
