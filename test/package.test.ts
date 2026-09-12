import assert from "node:assert/strict"
import test from "node:test"
import plugin from "opencode-auto-review"
import tui from "opencode-auto-review/tui"
import { AutoReview } from "opencode-auto-review/rpc"

test("package exposes server, TUI, and RPC entrypoints", () => {
  assert.equal(plugin.id, "opencode-auto-review")
  assert.equal(typeof plugin.setup, "function")
  assert.equal(tui.id, "opencode-auto-review.tui")
  assert.equal(AutoReview.id, "opencode-auto-review")
  assert.deepEqual(Object.keys(AutoReview.methods).sort(), ["setEnabled", "status"])
  assert.deepEqual(Object.keys(AutoReview.events).sort(), ["state"])
})
