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
})

test("converts contradictory allows to deny", () => {
  for (const patch of [
    { risk: "medium" },
    { risk: "high" },
    { risk: "critical" },
    { risk: "unknown" },
    { authorization: "low" },
    { authorization: "unknown" },
  ]) {
    assert.equal(parseReviewResponse(JSON.stringify({ ...valid, ...patch }))?.decision, "deny")
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
