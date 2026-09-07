import assert from "node:assert/strict"
import test from "node:test"
import { ReviewArchive } from "../src/review-archive.js"
import { captureEvidence } from "../src/evidence.js"
import { buildReviewRequest } from "../src/review-input.js"
import { prepareReviewJournal } from "../src/reviewer-journal.js"
import type { PermissionEvent } from "../src/types.js"
import { estimateTokens } from "../src/context-budget.js"

function fixture() {
  const values = new Map<string, any>()
  let context: unknown[] = []
  const storage: any = { get: async (key: string) => structuredClone(values.get(key)), set: async (key: string, value: any) => { values.set(key, structuredClone(value)) } }
  return { values, set: (messages: unknown[]) => { context = messages }, create: () => new ReviewArchive(storage, async () => structuredClone(context)) }
}
const signal = new AbortController().signal
const user = (id: string, text: string) => ({ id, type: "user", text })
const tool = (id: string, text?: string) => ({ id, type: "assistant", content: [{ type: "tool", id: `tool-${id}`, name: "read", state: {
  status: text === undefined ? "running" : "completed", input: { path: "fixture.txt" }, ...(text === undefined ? {} : { content: [{ type: "text", text }] }),
} }] })
const checkpoint = (id: string, summary = "Summary is not authorization") => ({ id, type: "compaction", status: "completed", summary, recent: "" })
const event = (id: string): PermissionEvent => ({ sessionID: "s", action: "read", resources: ["fixture.txt"], effect: "ask", source: { type: "tool", messageID: id, id: `tool-${id}` } })

test("repeated parent compactions retain originals with bounded prompts and lazy tool results", async () => {
  const f = fixture()
  const archive = f.create()
  const result = "ORIGINAL_INSPECTION_".repeat(10_000)
  f.set([user("root", "Never publish private files"), tool("original", result)])
  const initial = await archive.load("s", signal)
  let journal = prepareReviewJournal(undefined, buildReviewRequest(initial.messages, event("original"))!, 16_000)!
  for (let n = 1; n <= 3; n++) {
    f.set([checkpoint(`cp${n}`, `Summary ${n} ${"x".repeat(20_000)}`), user(`u${n}`, `Inspect file ${n}`), tool(`a${n}`)])
    const retained = await archive.load("s", signal)
    assert.equal(retained.complete, true)
    assert.equal(retained.messages.filter((message: any) => message.type === "compaction").length, 1)
    assert.deepEqual(retained.messages[0], user("root", "Never publish private files"))
    journal = prepareReviewJournal(journal, buildReviewRequest(retained.messages, event(`a${n}`))!, 16_000)!
    assert.equal(journal.epoch, n)
    assert.ok(estimateTokens(journal.prompt) <= 16_000)
    assert.match(journal.prompt, /Never publish private files/)
  }
  assert.ok(!JSON.stringify(f.values.get("history/s")).includes("ORIGINAL_INSPECTION_"), "large results must stay outside the history manifest")
  const restarted = f.create()
  const retained = await restarted.load("s", signal)
  const evidence = captureEvidence(retained.messages, event("a3"), { complete: retained.complete, result: (messageID, toolID) => restarted.result("s", messageID, toolID) })
  const page: any = await evidence.read({ type: "tool_result", messageID: "original", toolID: "tool-original", offset: 0 })
  assert.match(page.text, /ORIGINAL_INSPECTION_/)
  assert.equal(page.next, 4000)
})

test("returning to an earlier checkpoint drops later authorization instead of resurrecting it", async () => {
  const f = fixture()
  const archive = f.create()
  f.set([user("root", "Inspect only")])
  await archive.load("s", signal)
  f.set([checkpoint("cp1"), user("grant", "You may publish"), tool("old", "old branch evidence")])
  await archive.load("s", signal)
  f.set([checkpoint("cp2"), user("later", "Continue")])
  await archive.load("s", signal)
  f.set([checkpoint("cp1"), user("replacement", "Do not publish"), tool("new")])
  const retained = await archive.load("s", signal)
  assert.doesNotMatch(JSON.stringify(retained.messages), /You may publish|old branch evidence|Continue/)
  assert.match(JSON.stringify(retained.messages), /Do not publish/)
  const evidence = captureEvidence(retained.messages, event("new"), { complete: retained.complete, result: (messageID, toolID) => archive.result("s", messageID, toolID) })
  assert.match(JSON.stringify(await evidence.read({ type: "tool_result", messageID: "old", toolID: "tool-old", offset: 0 })), /No completed result/)

  const fresh = fixture()
  fresh.set([checkpoint("unknown"), user("recent", "Continue"), tool("new")])
  assert.equal((await fresh.create().load("s", signal)).complete, false)

  f.set([checkpoint("created-while-unloaded"), user("recent", "Continue"), tool("new")])
  assert.equal((await f.create().load("s", signal)).complete, false)
})
