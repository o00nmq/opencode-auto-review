import assert from "node:assert/strict"
import test from "node:test"
import { estimateTokens, inputTokenBudget } from "../src/context-budget.js"

test("model input budgets reserve effective output tokens and respect a stricter input limit", () => {
  assert.equal(inputTokenBudget({ context: 10_000, output: 4000 }, { max_tokens: 2000 }), 6944)
  assert.equal(inputTokenBudget({ context: 10_000, input: 5000, output: 4000 }, { max_tokens: 2000 }), 4244)
  assert.equal(inputTokenBudget({ context: 10_000, output: 4000 }, { max_output_tokens: 5000 }), 4244)
  assert.equal(inputTokenBudget({ context: 10_000, output: 4000 }, {}), 5144)
  assert.equal(inputTokenBudget({ context: 2048, output: 4096 }, { max_tokens: 4096 }), 0)
  assert.equal(inputTokenBudget(undefined), 0)
  assert.equal(estimateTokens("abcabc"), 2)
  assert.equal(estimateTokens("中文"), 6)
  assert.equal(estimateTokens("{}"), 2)
})
