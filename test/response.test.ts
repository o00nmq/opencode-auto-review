import assert from "node:assert/strict"
import test from "node:test"
import { parseReviewResponse } from "../src/response.js"

const valid = {
  decision: "allow",
  risk: "low",
  authorization: "high",
  reason: "The requested read is narrow and directly authorized",
  matched_rules: ["project-read"],
}

test("accepts a matrix-consistent allow", () => {
  assert.deepEqual(parseReviewResponse(`  ${JSON.stringify(valid)}\n`), valid)
  assert.deepEqual(parseReviewResponse(JSON.stringify({
    decision: "allow", risk: "low", authorization: "high", matched_rules: [],
  })), { decision: "allow", risk: "low", authorization: "high", matched_rules: [] })
})

test("a bare allow is never upgraded to a fabricated risk/authorization assessment", () => {
  assert.equal(parseReviewResponse('{"decision":"allow"}'), undefined)
})

test("rejects contradictory allows as protocol errors", () => {
  for (const patch of [
    { risk: "high" },
    { risk: "critical" },
    { risk: "unknown" },
    { authorization: "low" },
    { authorization: "unknown" },
  ]) {
    assert.equal(parseReviewResponse(JSON.stringify({ ...valid, ...patch })), undefined)
  }
})

test("rejects malformed or expanded responses", () => {
  const cases = [
    "",
    `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``,
    `${JSON.stringify(valid)} trailing`,
    JSON.stringify({ ...valid, decision: "escalate" }),
    JSON.stringify({ ...valid, extra: true }),
    `{"decision":"deny","decision":"allow","risk":"low","authorization":"high","reason":"ok","matched_rules":[]}`,
  ]
  for (const value of cases) assert.equal(parseReviewResponse(value), undefined)
})
