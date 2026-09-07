import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../src/index.js"

const allowText = JSON.stringify({
  decision: "allow",
  risk: "low",
  authorization: "high",
  matched_rules: [],
})

const denyText = JSON.stringify({
  decision: "deny",
  risk: "high",
  authorization: "low",
  reason: "The command may expose environment secrets that the user has not authorized accessing",
  matched_rules: ["secret-access"],
})

const mediumText = JSON.stringify({
  decision: "allow",
  risk: "low",
  authorization: "medium",
  reason: "Relevant but not explicitly authorized",
  matched_rules: [],
})

function createHarness(
  options: Record<string, unknown> = {},
  generate: string | ((input: any, options: { signal?: AbortSignal }) => Promise<{ text: string }>) = allowText,
  context?: () => Promise<any[]>,
  catalogOverride?: unknown,
) {
  let evaluate: ((event: any) => Promise<void>) | undefined
  let command: ((input: any) => Promise<void>) | undefined
  let onPrompt: ((event: any) => void) | undefined
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
  const catalogModel: any = { providerID: "test", id: "reviewer", limit: { context: 128_000, input: 120_000, output: 8192 }, variants: [
    { id: "max", settings: { reasoningEffort: "high" }, body: { reasoning: { effort: "high" } } },
  ] }
  const defaultCatalog = {
    model: {
      default: async () => ({ data: catalogModel }),
      list: async () => ({ data: [catalogModel] }),
    },
    transform: async (callback: (editor: any) => void) => {
      const before = structuredClone(catalogModel.variants)
      callback({ model: {
        get: (provider: string, id: string) => provider === catalogModel.providerID && id === catalogModel.id ? catalogModel : undefined,
        update: (_provider: string, _id: string, update: (draft: any) => void) => update(catalogModel),
      } })
      return { dispose: async () => { catalogModel.variants = before } }
    },
  }
  const ctx = {
    options: pluginOptions,
    storage: (() => {
      const entries = new Map<string, any>()
      return { get: async (key: string) => structuredClone(entries.get(key)), set: async (key: string, value: any) => { entries.set(key, structuredClone(value)) } }
    })(),
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
      hook: async (_name: string, callback: typeof onPrompt) => {
        if (_name === "prompt") onPrompt = callback
        return { dispose: async () => undefined }
      },
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
      if (typeof generate === "function") return generate(input, requestOptions)
      return { text: generate }
    } },
    agent: { get: async () => { throw new Error("missing") } },
    catalog: catalogOverride ?? defaultCatalog,
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
    admitPrompt: (sessionID: string) => onPrompt!({ sessionID }),
    catalogModel,
  }
}

test("only a valid eligible ask can be auto-allowed", async () => {
  const harness = createHarness()
  const cleanup = await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "allow")
  assert.equal((event as any).message, "Auto-review approved: read.")
  assert.equal(harness.visibleStatus(), undefined)
  assert.deepEqual(harness.counts(), { generateCalls: 1, contextCalls: 1, disposed: 0 })
  await cleanup?.()
  assert.equal(harness.counts().disposed, 1)
})

test("retains prior review outcomes per main session", async () => {
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
  assert.match(prompts[1]!, /"type":"review_outcome","code":"allow"/)
})

test("denial returns its permission reason in the tool error", async () => {
  const harness = createHarness({}, denyText)
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  assert.match((event as any).message, /not authorized accessing/)
  assert.match((event as any).message, /shell expansion/)
  assert.equal(harness.visibleStatus(), undefined)
})

test("medium authorization is allowed and shows its rationale", async () => {
  const harness = createHarness({}, mediumText)
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "allow")
  assert.equal((event as any).message, "Auto-review approved: Relevant but not explicitly authorized")
  assert.equal(harness.visibleStatus(), undefined)
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

test("human rules preserve confirmation while reviewer recursion remains ask", async () => {
  const harness = createHarness({
    agent: "auto-reviewer",
    humanReviewRules: [{ action: "shell", resource: "git push *", reason: "Remote changes require confirmation" }],
  })
  await harness.setup()
  const human = await harness.run({ action: "shell", resources: ["git push origin main"] })
  assert.equal(human.effect, "ask")
  assert.match((human as any).message, /Remote changes require confirmation/)
  assert.equal((await harness.run({ agent: "auto-reviewer" })).effect, "ask")
  assert.equal(harness.counts().generateCalls, 0)
})

test("malformed output exhausts bounded repair rounds and asks", async () => {
  const harness = createHarness({}, "not json")
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "ask")
  assert.match((event as any).message, /one format repair/)
  assert.equal(harness.counts().generateCalls, 2)
})

test("provider errors preserve human confirmation", async () => {
  const harness = createHarness({}, async () => { throw new Error("provider secret") })
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "ask")
  assert.match((event as any).message, /did not return a complete valid decision/)
})

test("missing reviewer agent uses the OpenCode default model", async () => {
  const harness = createHarness({ model: null })
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "allow")
  assert.equal(harness.counts().generateCalls, 1)
})

test("input budget follows current model limits and can exceed the old 64 KiB ceiling", async () => {
  const harness = createHarness()
  harness.catalogModel.limit = { context: 16_000, input: 8000, output: 8192 }
  harness.messages[1].content[0].state.input = { path: "x".repeat(70_000) }
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "ask")
  assert.match((event as any).message, /model input budget/)
  assert.equal(harness.counts().generateCalls, 0)
  harness.catalogModel.limit = { context: 256_000, input: 220_000, output: 8192 }
  assert.equal((await harness.run()).effect, "allow")
  assert.ok(Buffer.byteLength(harness.generatedPrompts()[0]!, "utf8") > 65_536)
})

test("review deadline aborts even a provider that ignores cancellation", async () => {
  const harness = createHarness({ timeoutMs: 1000 }, () => new Promise(() => undefined))
  await harness.setup()
  const started = Date.now()
  const event = await harness.run()
  assert.ok(Date.now() - started >= 900)
  assert.equal(event.effect, "ask")
  assert.equal(harness.counts().generateCalls, 1)
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

function aborts(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(new Error("aborted"))
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
  })
}

test("permission evaluation executes multiple evidence rounds before applying a verdict", async () => {
  let round = 0
  const harness = createHarness({}, async ({ prompt }) => {
    round++
    if (round === 1) {
      assert.match(prompt, /"toolID":"prior-read"/)
      return { text: JSON.stringify({ decision: "investigate", reason: "Check the script contents", requests: [
        { type: "tool_result", messageID: "prior", toolID: "prior-read", offset: 0 },
      ] }) }
    }
    if (round === 2) {
      assert.match(prompt, /echo fixture-only/)
      assert.match(prompt, /Check the script contents/)
      return { text: JSON.stringify({ decision: "investigate", reason: "Verify user scope", requests: [
        { type: "history", offset: 0 },
      ] }) }
    }
    assert.equal(round, 3)
    assert.match(prompt, /"type":"evidence","round":2/)
    return { text: allowText }
  })
  harness.messages.splice(1, 0, { id: "prior", type: "assistant", content: [
    { type: "tool", id: "prior-read", name: "read", state: {
      status: "completed", input: { path: "script.sh" }, content: [{ type: "text", text: "echo fixture-only" }],
    } },
  ] })
  await harness.setup()
  assert.equal((await harness.run()).effect, "allow")
  assert.equal(harness.counts().generateCalls, 3)
})

test("an explicit reviewer ask returns its question to the human", async () => {
  const harness = createHarness({}, JSON.stringify({ decision: "ask", risk: "unknown", authorization: "unknown",
    reason: "Confirm the target deployment environment", matched_rules: [] }))
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "ask")
  assert.match((event as any).message, /Confirm the target deployment environment/)
})

test("turning auto-review off cancels active work and prevents late approval", async () => {
  let resolve!: (value: { text: string }) => void
  const harness = createHarness({}, () => new Promise((done) => { resolve = done }))
  await harness.setup()
  const pending = harness.run()
  await new Promise((done) => setImmediate(done))
  await harness.command("off")
  resolve({ text: allowText })
  assert.equal((await pending).effect, "ask")
  assert.equal(harness.generationSignal()?.aborted, true)
})

test("new user input cancels only that session's outstanding review", async () => {
  const harness = createHarness({}, (_input, { signal }) => aborts(signal!))
  await harness.setup()
  const pending = harness.run()
  await new Promise((done) => setImmediate(done))
  harness.admitPrompt("other-session")
  assert.equal(harness.generationSignal()?.aborted, false)
  harness.admitPrompt("ses_test")
  assert.equal((await pending).effect, "ask")
  assert.equal(harness.generationSignal()?.aborted, true)
})

test("a hung context read does not block the next same-session review after its deadline", async () => {
  let hang = true
  const harness = createHarness({ timeoutMs: 1000 }, allowText,
    async () => hang ? new Promise(() => undefined) : harness.messages)
  await harness.setup()
  assert.equal((await harness.run()).effect, "ask")
  hang = false
  await new Promise((done) => setImmediate(done))
  assert.equal((await harness.run()).effect, "allow")
})

test("independent sessions run concurrently while identical in-flight requests share one review", async () => {
  let release!: (result: { text: string }) => void
  const gate = new Promise<{ text: string }>((resolve) => { release = resolve })
  const harness = createHarness({}, () => gate)
  const cleanup = await harness.setup()
  const pending = ["one", "one", "two", "three", "four", "five"].map(sessionID => harness.run({ sessionID }))
  try {
    await new Promise((done) => setImmediate(done))
    assert.equal(harness.counts().generateCalls, 5)
    assert.equal(harness.counts().contextCalls, 5)
    release({ text: allowText })
    assert.ok((await Promise.all(pending)).every(event => event.effect === "allow"))
  } finally {
    release({ text: allowText })
    await cleanup?.()
  }
})

test("plugin modelOptions select a derived variant once across concurrent reviews and dispose it", async () => {
  const selected: any = { providerID: "test", id: "reviewer", limit: { context: 128_000, output: 8192 }, variants: [], body: { max_tokens: 4096 } }
  let registrations = 0
  let disposals = 0
  const catalog = {
    transform: async (callback: (editor: any) => void) => {
      registrations++
      callback({ model: { get: () => selected, update: (_p: string, _m: string, update: (draft: any) => void) => update(selected) } })
      return { dispose: async () => { disposals++; selected.variants = [] } }
    },
    model: { list: async () => ({ data: [selected] }) },
  }
  const harness = createHarness({ modelOptions: { body: { max_tokens: 512 } } }, async (input) => {
    assert.equal(input.body, undefined, "unsupported generate fields must not be sent")
    assert.equal(input.model.variant, selected.variants[0].id)
    assert.equal(selected.variants[0].body.max_tokens, 512)
    assert.equal(selected.body.max_tokens, 4096)
    return { text: allowText }
  }, undefined, catalog)
  const cleanup = await harness.setup()
  const results = await Promise.all([harness.run({ sessionID: "one" }), harness.run({ sessionID: "two" })])
  assert.ok(results.every((event) => event.effect === "allow"))
  assert.equal(registrations, 1)
  await cleanup?.()
  assert.equal(disposals, 1)
  assert.deepEqual(selected.variants, [])
})

test("default Chat budget preserves the selected native reasoning variant", async () => {
  const harness = createHarness({ model: "test/reviewer#max" }, async (input) => {
    const variant = harness.catalogModel.variants.find((entry: any) => entry.id === input.model.variant)
    assert.equal(variant.body.max_tokens, 2048)
    assert.deepEqual(variant.settings, { reasoningEffort: "high" })
    assert.deepEqual(variant.body.reasoning, { effort: "high" })
    assert.equal(harness.catalogModel.variants[0].id, "max")
    assert.equal(harness.catalogModel.variants[0].body.max_tokens, undefined)
    return { text: allowText }
  })
  const cleanup = await harness.setup()
  assert.equal((await harness.run()).effect, "allow")
  await cleanup?.()
})
