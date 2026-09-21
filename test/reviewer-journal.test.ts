import assert from "node:assert/strict"
import test from "node:test"
import { prepareReviewJournal } from "../src/reviewer-journal.js"
import { buildReviewPrompt } from "../src/policy.js"
import { estimateTokens } from "../src/context-budget.js"
import type { ReviewRequest } from "../src/types.js"

function request(context: ReviewRequest["context"]): ReviewRequest {
  return { context, permission: { action: "read", resources: ["a.ts"] } }
}

test("a continued pseudo-session keeps the previous prompt as an exact byte prefix", () => {
  const first = prepareReviewJournal(undefined, request([
    { type: "user", text: "Inspect files" },
    { type: "tool", name: "read", input: { path: "a.ts" } },
  ]), 10_000)!
  const second = prepareReviewJournal(first, request([
    { type: "user", text: "Inspect files" },
    { type: "tool", name: "read", input: { path: "a.ts" } },
    { type: "tool", name: "read", input: { path: "b.ts" } },
  ]), 10_000)!

  assert.ok(second.prompt.startsWith(`${first.prompt}\n`))
  assert.equal(second.epoch, 0)
  assert.doesNotMatch(second.prompt, /review_outcome|Narrow read/)
})

test("parallel tool calls in one assistant message keep the same epoch and prefix", () => {
  // One assistant message can request several tools at once. Those reviews share
  // the same history and differ only in the pending tool, so the journal must
  // append rather than rebuild. A rebuild restarts the prompt with a new
  // `review_epoch` line, which breaks the byte prefix at the static policy and
  // makes the provider recompute the whole journal on every parallel call.
  const first = prepareReviewJournal(undefined, request([
    { type: "user", text: "Inspect files" },
    { type: "tool", name: "read", input: { path: "a.ts" } },
  ]), 10_000)!
  const second = prepareReviewJournal(first, request([
    { type: "user", text: "Inspect files" },
    { type: "tool", name: "read", input: { path: "b.ts" } },
  ]), 10_000)!

  assert.equal(second.epoch, 0)
  assert.ok(second.prompt.startsWith(`${first.prompt}\n`))
})

test("re-reviewing the same pending tool still appends", () => {
  // A second evaluation of one request must not reset the journal either.
  const context: ReviewRequest["context"] = [
    { type: "user", text: "Inspect files" },
    { type: "tool", name: "read", input: { path: "a.ts" } },
  ]
  const first = prepareReviewJournal(undefined, request(context), 10_000)!
  const second = prepareReviewJournal(first, request(context), 10_000)!

  assert.equal(second.epoch, 0)
  assert.ok(second.prompt.startsWith(`${first.prompt}\n`))
})

test("a saturated selection leaves append headroom instead of rebuilding on every review", () => {
  // The tool backlog is the part that grows without bound, so it is bounded below
  // the budget. Filling the budget to the last token would force a new epoch on
  // the next append, and since the rebuilt epoch fills again, every review would
  // restart the prompt and drop the provider's cached prefix.
  const tools = Array.from({ length: 60 }, (_, index) =>
    ({ type: "tool" as const, name: "read", input: { path: `${"p".repeat(300)}${index}` } }))
  const shared = [{ type: "user" as const, text: "Inspect files" }, ...tools]
  const budget = estimateTokens(buildReviewPrompt([])) + 8_000
  const first = prepareReviewJournal(undefined, request([...shared, { type: "tool", name: "read", input: { path: "a.ts" } }]), budget)!
  assert.ok(estimateTokens(first.prompt) < budget * 0.95,
    `the selection must leave headroom, used ${estimateTokens(first.prompt)} of ${budget}`)
  const second = prepareReviewJournal(first, request([...shared, { type: "tool", name: "read", input: { path: "b.ts" } }]), budget)!
  assert.equal(second.epoch, 0)
  assert.ok(second.prompt.startsWith(`${first.prompt}\n`))
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

test("history discontinuity or capacity starts a new bounded epoch", () => {
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
  const firstRequest = request([
    { type: "user", text: "Inspect files" },
    { type: "tool", name: "read", input: { path: "a.ts" } },
  ])
  const budget = estimateTokens(buildReviewPrompt([])) + 500
  const capacityFirst = prepareReviewJournal(undefined, firstRequest, budget)!
  const capacitySecond = prepareReviewJournal(capacityFirst, request([
    ...firstRequest.context,
    { type: "tool", name: "read", input: { path: "b.ts", note: "x".repeat(1_000) } },
  ]), budget)!

  assert.equal(capacitySecond.epoch, 1)
  assert.ok(estimateTokens(capacitySecond.prompt) <= budget)
  assert.equal(capacitySecond.prompt.startsWith(`${capacityFirst.prompt}\n`), false)
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
