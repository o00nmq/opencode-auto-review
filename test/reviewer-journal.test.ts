import assert from "node:assert/strict"
import test from "node:test"
import { prepareReviewJournal } from "../src/reviewer-journal.js"
import type { ReviewRequest } from "../src/types.js"

function request(context: ReviewRequest["context"]): ReviewRequest {
  return { context, history_truncated: false, permission: { action: "read", resources: ["a.ts"] } }
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
  const capacityFirst = prepareReviewJournal(undefined, firstRequest, 4_000)!
  const capacitySecond = prepareReviewJournal(capacityFirst, request([
    ...firstRequest.context,
    { type: "tool", name: "read", input: { path: "b.ts", note: "x".repeat(1_000) } },
  ]), 4_000)!

  assert.equal(capacitySecond.epoch, 1)
  assert.ok(Buffer.byteLength(capacitySecond.prompt, "utf8") <= 4_000)
  assert.equal(capacitySecond.prompt.startsWith(`${capacityFirst.prompt}\n`), false)
})

test("new epochs anchor first and latest users before other history", () => {
  const prepared = prepareReviewJournal(undefined, request([
    { type: "user", text: "FIRST_CONSTRAINT" },
    { type: "tool", name: "read", input: { path: "x".repeat(500) } },
    { type: "user", text: `MIDDLE_${"m".repeat(500)}` },
    { type: "user", text: "LATEST_REQUEST" },
    { type: "tool", name: "read", input: { path: "a.ts" } },
  ]), 3_300)!

  assert.match(prepared.prompt, /FIRST_CONSTRAINT/)
  assert.match(prepared.prompt, /LATEST_REQUEST/)
  assert.doesNotMatch(prepared.prompt, /MIDDLE_m{100}/)
  assert.match(prepared.lines[0]!, /"users":1/)
})

test("the byte limit covers fixed policy, framing, and the exact current action", () => {
  const input = request([
    { type: "user", text: "Inspect it" },
    { type: "tool", name: "read", input: { path: "a.ts" } },
  ])
  const prepared = prepareReviewJournal(undefined, input, 3_200)!
  assert.ok(Buffer.byteLength(prepared.prompt, "utf8") <= 3_200)
  assert.equal(prepareReviewJournal(undefined, input, 2_600), undefined)
  assert.equal(prepareReviewJournal(undefined, request([
    { type: "user", text: "Inspect it" },
    { type: "tool", name: "read", input: { path: "x".repeat(2_000) } },
  ]), 3_500), undefined)
})
