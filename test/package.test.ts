import assert from "node:assert/strict"
import test from "node:test"
import plugin from "opencode-auto-review"
import tui from "opencode-auto-review/tui"

test("package exposes server and TUI plugins", () => {
  assert.equal(plugin.tui, true)
  assert.equal(tui.id, "opencode-auto-review.tui")
})
