import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../src/index.js"

const allowText = JSON.stringify({
  decision: "allow",
  risk: "low",
  authorization: "high",
  reason: "Narrow read",
  matched_rules: [],
})

const denyText = JSON.stringify({
  decision: "deny",
  risk: "high",
  authorization: "low",
  reason: "The command may expose environment secrets",
  matched_rules: ["secret-access"],
})

function createHarness(
  options: Record<string, unknown> = {},
  generate: string | (() => Promise<{ text: string }>) = allowText,
  context?: () => Promise<any[]>,
) {
  let evaluate: ((event: any) => Promise<void>) | undefined
  let command: ((input: any) => Promise<void>) | undefined
  let generateCalls = 0
  let contextCalls = 0
  let disposed = 0
  let generationSignal: AbortSignal | undefined
  const generatedPrompts: string[] = []
  const synthetic: string[] = []
  const syntheticDescriptions: string[] = []
  let commandDescription = ""
  const messages: any[] = [
    { id: "user", type: "user", text: "Read package.json" },
    { id: "assistant", type: "assistant", content: [
      { type: "tool", id: "tool", name: "read", state: { status: "running", input: { path: "package.json" } } },
    ] },
  ]
  const pluginOptions: Record<string, unknown> = { model: "test/reviewer", ...options }
  if (options.model === null) delete pluginOptions.model
  const ctx = {
    options: pluginOptions,
    permission: {
      hook: async (_name: string, callback: typeof evaluate) => {
        evaluate = callback
        return { dispose: async () => { disposed++ } }
      },
    },
    command: {
      transform: async (callback: (draft: any) => void) => {
        callback({ add: (definition: any) => {
          command = definition.execute
          commandDescription = definition.description
        } })
        return { dispose: async () => undefined }
      },
    },
    session: {
      context: async () => { contextCalls++; return context ? context() : messages },
      synthetic: async ({ text, description }: { text: string; description: string }) => {
        synthetic.push(text)
        syntheticDescriptions.push(description)
      },
    },
    generate: { text: async (input: any, requestOptions: { signal?: AbortSignal }) => {
      generateCalls++
      generatedPrompts.push(input.prompt)
      generationSignal = requestOptions.signal
      return typeof generate === "function" ? generate() : { text: generate }
    } },
    agent: { get: async () => { throw new Error("missing") } },
    catalog: { model: { default: async () => ({ data: { providerID: "test", id: "reviewer" } }) } },
  }
  return {
    async setup() {
      const cleanup = await plugin.setup(ctx as any)
      assert.ok(evaluate)
      return cleanup
    },
    async run(patch: Record<string, unknown> = {}) {
      const event = {
        sessionID: "ses_test",
        agent: "build",
        action: "read",
        resources: ["package.json"],
        source: { type: "tool", messageID: "assistant", id: "tool" },
        effect: "ask",
        ...patch,
      }
      await evaluate!(event)
      return event
    },
    async command(text: string) {
      assert.ok(command)
      await command({ sessionID: "ses_test", prompt: { text }, delivery: "steer" })
      return synthetic.at(-1)
    },
    counts: () => ({ generateCalls, contextCalls, disposed }),
    commandDescription: () => commandDescription,
    visibleStatus: () => syntheticDescriptions.at(-1),
    messages,
    generationSignal: () => generationSignal,
    generatedPrompts: () => generatedPrompts,
  }
}

test("only a valid eligible ask can be auto-allowed", async () => {
  const harness = createHarness()
  const cleanup = await harness.setup()
  assert.equal((await harness.run()).effect, "allow")
  assert.equal(harness.visibleStatus(), "Auto-review approved: read.")
  assert.deepEqual(harness.counts(), { generateCalls: 1, contextCalls: 1, disposed: 0 })
  await cleanup?.()
  assert.equal(harness.counts().disposed, 1)
})

test("reuses a hidden append-only pseudo-reviewer per main session", async () => {
  const harness = createHarness()
  await harness.setup()
  await harness.run()
  harness.messages[1]!.content[0].state.status = "completed"
  harness.messages.push({ id: "assistant2", type: "assistant", content: [
    { type: "tool", id: "tool2", name: "read", state: { status: "running", input: { path: "README.md" } } },
  ] })
  await harness.run({ source: { type: "tool", messageID: "assistant2", id: "tool2" } })
  const prompts = harness.generatedPrompts()
  assert.equal(prompts.length, 2)
  assert.ok(prompts[1]!.startsWith(`${prompts[0]!}\n`))
  assert.doesNotMatch(prompts[1]!, /Narrow read|review_outcome/)
})

test("reviewer denial returns a concise reason and safe retry guidance", async () => {
  const harness = createHarness({}, denyText)
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  assert.match((event as any).message, /environment secrets/)
  assert.match((event as any).message, /shell expansion/)
  assert.doesNotMatch((event as any).message, /secret-access/)
})

test("runtime command toggles auto-review without restarting", async () => {
  const harness = createHarness({ enabled: false })
  await harness.setup()
  assert.match(harness.commandDescription(), /\/auto-review \[on\|off\|toggle\|status\]/)
  assert.equal((await harness.run()).effect, "ask")
  assert.equal(await harness.command("on"), "Auto-review is enabled.")
  assert.equal(harness.visibleStatus(), "Auto-review is enabled.")
  assert.equal((await harness.run()).effect, "allow")
  assert.equal(await harness.command("off"), "Auto-review is disabled.")
  assert.equal((await harness.run()).effect, "ask")
  assert.match(await harness.command("invalid") ?? "", /Usage:/)
})

test("configured allow and unknown actions do not call the reviewer", async () => {
  const harness = createHarness()
  await harness.setup()
  assert.equal((await harness.run({ effect: "allow" })).effect, "allow")
  assert.equal((await harness.run({ action: "question" })).effect, "ask")
  assert.deepEqual(harness.counts(), { generateCalls: 0, contextCalls: 0, disposed: 0 })
})

test("human rules deny in auto mode while reviewer recursion remains ask", async () => {
  const harness = createHarness({
    agent: "auto-reviewer",
    humanReviewRules: [{ action: "shell", resource: "git push *", reason: "Remote changes require confirmation" }],
  })
  await harness.setup()
  const human = await harness.run({ action: "shell", resources: ["git push origin main"] })
  assert.equal(human.effect, "deny")
  assert.match((human as any).message, /Remote changes require confirmation/)
  assert.equal((await harness.run({ agent: "auto-reviewer" })).effect, "ask")
  assert.equal(harness.counts().generateCalls, 0)
})

test("malformed reviewer output fails closed to deny", async () => {
  const harness = createHarness({}, "not json")
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  assert.match((event as any).message, /could not be verified safely/)
})

test("provider errors fail closed to deny", async () => {
  const harness = createHarness({}, async () => { throw new Error("provider secret") })
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  assert.equal((event as any).message, "Auto-review denied: the request could not be verified safely. Retry later or use a safer approach.")
})

test("missing reviewer agent uses the OpenCode default model", async () => {
  const harness = createHarness({ model: null })
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "allow")
  assert.equal(harness.counts().generateCalls, 1)
})

test("oversized complete input is denied without model disclosure", async () => {
  const harness = createHarness({ maxReviewBytes: 1024 })
  harness.messages[0].text = "x".repeat(2000)
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  assert.match((event as any).message, /too large/)
  assert.equal(harness.counts().generateCalls, 0)
})

test("timeout aborts the provider request and denies", async () => {
  const harness = createHarness({ timeoutMs: 1000 }, () => new Promise(() => undefined))
  await harness.setup()
  const started = Date.now()
  const event = await harness.run()
  assert.ok(Date.now() - started >= 900)
  assert.equal(event.effect, "deny")
  assert.equal(harness.generationSignal()?.aborted, true)
})

test("cleanup prevents a late review from changing the event", async () => {
  let resolve!: (value: { text: string }) => void
  const deferred = new Promise<{ text: string }>((done) => { resolve = done })
  const harness = createHarness({}, () => deferred)
  const cleanup = await harness.setup()
  const pending = harness.run()
  await new Promise((done) => setImmediate(done))
  await cleanup?.()
  resolve({ text: allowText })
  const event = await pending
  assert.equal(event.effect, "ask")
  assert.equal(harness.generationSignal()?.aborted, true)
})
