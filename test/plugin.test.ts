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
  let onContext: ((event: any) => Promise<void> | void) | undefined
  let onCompaction: ((event: any) => Promise<void> | void) | undefined
  let generateCalls = 0
  let contextCalls = 0
  let disposed = 0
  let rpcDisposed = 0
  let rpcHandlers: Record<string, (input: any, context: any) => Promise<unknown>> | undefined
  const rpcEvents: { name: string; data: any }[] = []
  const noticeToasts = () => rpcEvents
    .filter((event) => event.name === "notice")
    .map((event) => event.data as { description: string; severity: string })
  let generationSignal: AbortSignal | undefined
  const generatedPrompts: string[] = []
  const synthetic: string[] = []
  const syntheticDescriptions: string[] = []
  const syntheticCalls: Array<{ sessionID?: string; text: string; description?: string; delivery?: string; resume?: boolean | null; metadata?: Record<string, unknown> }> = []
  let commandDescription = ""
  const messages: any[] = [
    { id: "user", type: "user", text: "Read package.json" },
    { id: "assistant", type: "assistant", content: [
      { type: "tool", id: "tool", name: "read", state: { status: "running", input: { path: "package.json" } } },
    ] },
  ]
  const pluginOptions: Record<string, unknown> = { model: "test/reviewer", ...options }
  if (options.model === null) delete pluginOptions.model
  // Session records for notice routing. Tests seed `ses_test` -> "ses_parent" to
  // model a subagent; an unseeded session is treated as a root session.
  const sessions: Record<string, { parentID?: string; agent?: string; title?: string; error?: boolean; hang?: boolean }> = {}
  const sessionInfo = (sessionID: string) => {
    const record = sessions[sessionID]
    if (record?.error) throw new Error(`session lookup failed: ${sessionID}`)
    if (record?.hang) return new Promise<never>(() => undefined)
    return { id: sessionID, ...record }
  }
  const catalogModel: any = { providerID: "test", id: "reviewer", limit: { context: 128_000, input: 120_000, output: 8192 }, variants: [
    { id: "max", settings: { reasoningEffort: "high" }, body: { reasoning: { effort: "high" } } },
  ] }
  const defaultCatalog = (() => {
    // Model the 2.0.4 registry faithfully: transforms are replayed lazily on the
    // next read, not when `transform()` resolves. A synchronous mock would hide a
    // registration that never actually runs.
    let retained: { callback: (editor: any) => void; before: any[] } | undefined
    const editor = () => ({
      get: (provider: string, id: string) => provider === catalogModel.providerID && id === catalogModel.id ? catalogModel : undefined,
      update: (_provider: string, _id: string, update: (draft: any) => void) => update(catalogModel),
    })
    const replay = () => {
      if (!retained) return
      catalogModel.variants = structuredClone(retained.before)
      retained.callback(editor())
    }
    return {
      default: async () => ({ data: catalogModel }),
      list: async () => { replay(); return { data: [catalogModel] } },
      transform: async (callback: (editor: any) => void) => {
        const before = structuredClone(catalogModel.variants)
        retained = { callback, before }
        return {
          dispose: async () => {
            retained = undefined
            catalogModel.variants = structuredClone(before)
          },
        }
      },
    }
  })()
  // OpenCode 2.0.4 exposes the model domain directly on the plugin context and
  // flattens the transform editor (`editor.get`/`editor.update`), replacing
  // 2.0.2's `ctx.catalog.model` nesting.
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
        if (_name === "context") onContext = callback
        if (_name === "compaction") onCompaction = callback
        return { dispose: async () => undefined }
      },
      context: async () => { contextCalls++; return context ? context() : messages },
      get: async ({ sessionID }: { sessionID: string }) => sessionInfo(sessionID),
      synthetic: async (input: { sessionID?: string; text: string; description?: string; delivery?: string; resume?: boolean | null; metadata?: Record<string, unknown> }) => {
        syntheticCalls.push(structuredClone(input))
        synthetic.push(input.text)
        if (input.description) syntheticDescriptions.push(input.description)
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
    model: { ...(catalogOverride ?? defaultCatalog) },
    rpc: {
      register: async (_definition: unknown, handlers: Record<string, (input: any, context: any) => Promise<unknown>>) => {
        rpcHandlers = handlers
        return {
          events: { emit: async (name: string, data: unknown) => { rpcEvents.push({ name, data }) } },
          dispose: async () => { rpcDisposed++ },
        }
      },
    },
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
      // Notices are fire-and-forget and may await session lookups before they
      // commit, so settle that chain before callers inspect synthetic output.
      for (let turn = 0; turn < 4; turn++) await new Promise((done) => setImmediate(done))
      return event
    },
    async command(text: string) {
      assert.ok(command)
      await command({ sessionID: "ses_test", prompt: { text }, delivery: "steer" })
      return noticeToasts().at(-1)?.description
    },
    counts: () => ({ generateCalls, contextCalls, disposed }),
    commandDescription: () => commandDescription,
    // Command feedback is an `info` toast now, not a session message.
    visibleStatus: () => noticeToasts().filter((toast) => toast.severity === "info").at(-1)?.description,
    // Nothing may write to the session any more: a session message resumes an
    // idle session. These stay for asserting emptiness.
    visibleMessages: () => syntheticCalls.filter((call) => call.resume === false).map((call) => call.text),
    sessionWrites: () => syntheticCalls.slice(),
    // CLI toasts. Every notice, including a clean approval, is one.
    toasts: () => noticeToasts(),
    messages,
    generationSignal: () => generationSignal,
    generatedPrompts: () => generatedPrompts,
    admitPrompt: (sessionID: string) => onPrompt!({ sessionID }),
    async compact(sessionID = "ses_test", compactionMessages: any[] = []) {
      assert.ok(onCompaction)
      const event = { sessionID, model: {}, system: [], messages: compactionMessages, options: {} }
      await onCompaction(event)
      return event
    },
    async dispatch(sessionID = "ses_test", dispatchMessages: any[] = []) {
      assert.ok(onContext)
      const event = { sessionID, model: {}, system: [], messages: dispatchMessages, options: {} }
      await onContext(event)
      return event
    },
    async rpcStatus() {
      assert.ok(rpcHandlers?.status)
      return rpcHandlers.status(undefined, {})
    },
    async rpcSetEnabled(value: boolean) {
      assert.ok(rpcHandlers?.setEnabled)
      return rpcHandlers.setEnabled({ enabled: value }, {})
    },
    async rpcSetFallback(value: boolean) {
      assert.ok(rpcHandlers?.setFallback)
      return rpcHandlers.setFallback({ humanFallback: value }, {})
    },
    rpcEvents: () => rpcEvents.slice(),
    rpcDisposed: () => rpcDisposed,
    catalogModel,
    sessions,
  }
}

test("a legacy notice body is stripped from the dispatched model request", async () => {
  // This plugin no longer writes session messages, but an install upgraded from an
  // earlier version still has committed notice bodies in its transcript, and the
  // host replays one into later requests as a user message whose only part is
  // empty text. The filter must keep removing that body.
  const harness = createHarness({}, async () => { throw new Error("provider secret") })
  await harness.setup()
  const outcome = await harness.run()
  assert.notEqual(outcome.effect, "allow")
  const replay = { role: "user", id: "notice-1", content: [{ type: "text", text: "" }] }
  const real = { role: "user", id: "user-1", content: [{ type: "text", text: "Read package.json" }] }
  const event = await harness.dispatch("ses_test", [real, replay])
  assert.deepEqual(event.messages, [real], "only the empty notice body is removed")
})

test("a notice committed by an earlier plugin instance is still stripped", async () => {
  // Shape matching is required because a fresh plugin instance has no memory of
  // notices committed before it loaded, yet those bodies remain in the session.
  const harness = createHarness()
  await harness.setup()
  const stale = { role: "user", id: "stale-notice", content: [{ type: "text", text: "" }] }
  const real = { role: "user", id: "user-1", content: [{ type: "text", text: "hello" }] }
  const event = await harness.dispatch("ses_test", [stale, real])
  assert.deepEqual(event.messages, [real])
})

test("meaningful model messages are never stripped", async () => {
  const harness = createHarness()
  await harness.setup()
  const user = { role: "user", id: "u", content: [{ type: "text", text: "do work" }] }
  const multi = { role: "user", id: "m", content: [{ type: "text", text: "" }, { type: "text", text: "keep" }] }
  const media = { role: "user", id: "i", content: [{ type: "media", mediaType: "image/png", data: "x" }] }
  const assistant = { role: "assistant", id: "a", content: [{ type: "text", text: "" }] }
  const empty = { role: "user", id: "e", content: [] }
  // A malformed or absent `text` is not the measured notice shape, so the
  // destructive predicate must not broaden to cover it.
  const nullText = { role: "user", id: "n", content: [{ type: "text", text: null }] }
  const missingText = { role: "user", id: "x", content: [{ type: "text" }] }
  const event = await harness.dispatch("ses_test", [user, multi, media, assistant, empty, nullText, missingText])
  assert.deepEqual(event.messages, [user, multi, media, assistant, empty, nullText, missingText])
})

test("a notice body is stripped from the compaction request too", async () => {
  // V2 dispatches checkpoint summaries through the separate compaction hook, so a
  // notice body must be filtered there as well; filtering only `context` would
  // still leak it into the compaction request.
  const harness = createHarness()
  await harness.setup()
  const replay = { role: "user", id: "notice-1", content: [{ type: "text", text: "" }] }
  const real = { role: "user", id: "user-1", content: [{ type: "text", text: "Read package.json" }] }
  const event = await harness.compact("ses_test", [real, replay])
  assert.deepEqual(event.messages, [real])
})

test("only a valid eligible ask can be auto-allowed", async () => {
  const harness = createHarness()
  const cleanup = await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "allow")
  assert.equal((event as any).message, "Auto-review approved: read.")
  // A silent allow is indistinguishable from no review at all, so every approval
  // emits a CLI toast. The notice must not carry a reason, and an approval must
  // not write to the session (that would resume it).
  const toast = harness.toasts()[0]!
  assert.equal(toast.description, "Auto-review approved read.")
  assert.equal(toast.severity, "success")
  assert.deepEqual(harness.sessionWrites(), [])
  assert.deepEqual(harness.visibleMessages(), [])
  assert.deepEqual(harness.counts(), { generateCalls: 1, contextCalls: 1, disposed: 0 })
  await cleanup?.()
  assert.equal(harness.counts().disposed, 1)
  assert.equal(harness.rpcDisposed(), 1)
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

test("a request reviewed again after its first notice still notifies", async () => {
  // The dedupe marker must not permanently suppress a later legitimate review of
  // the same request identity.
  const harness = createHarness()
  await harness.setup()
  const first = await harness.run()
  assert.equal(first.effect, "allow")
  assert.equal(harness.toasts().length, 1)
  // A second evaluation of the identical request happens after the shared review
  // settled, so it reviews again and must notify again.
  const second = await harness.run()
  assert.equal(second.effect, "allow")
  assert.equal(harness.counts().generateCalls, 2, "the settled request must be reviewed again")
  assert.equal(harness.toasts().length, 2, "the second review must notify too")
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
  // The rationale stays in the permission message, not in the approval notice.
  const toast = harness.toasts()[0]!
  assert.equal(toast.description, "Auto-review approved read.")
  assert.doesNotMatch(toast.description, /Relevant but not explicitly authorized/)
})

test("runtime command toggles auto-review without restarting", async () => {
  const harness = createHarness({ enabled: false })
  await harness.setup()
  assert.match(harness.commandDescription(), /\/auto-review \[on\|off\|toggle\|status\]/)
  assert.match(harness.commandDescription(), /fallback/)
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

test("malformed output exhausts bounded repair rounds and denies by default", async () => {
  const harness = createHarness({}, "not json")
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  assert.match((event as any).message, /one format repair/)
  assert.equal(harness.counts().generateCalls, 2)
})

test("provider errors deny by default and keep the reason", async () => {
  const harness = createHarness({}, async () => { throw new Error("provider secret") })
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  assert.match((event as any).message, /reviewer model call failed/)
  assert.match((event as any).message, /provider secret/)
  assert.match((event as any).message, /not a safety judgment/)
  assert.match((event as any).message, /Adjust the request/)
  assert.equal(harness.counts().generateCalls, 2)
  assert.deepEqual(harness.visibleMessages(), [], "failures must not leave pending synthetic inbox messages")
})

test("enabling the human fallback restores a prompt for the same failure", async () => {
  const harness = createHarness({ humanFallback: true }, async () => { throw new Error("provider secret") })
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "ask")
  assert.match((event as any).message, /human confirmation/)
  assert.doesNotMatch((event as any).message, /Adjust the request/)
})

test("missing reviewer agent uses the OpenCode default model", async () => {
  const harness = createHarness({ model: null })
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "allow")
  assert.equal(harness.counts().generateCalls, 1)
  // The fallback from agent lookup to the catalog default must be visible, not silent.
  assert.match((event as any).message, /auto-review fallback/)
  assert.match((event as any).message, /reviewer agent lookup failed: missing/)
  assert.match((event as any).message, /catalog default model test\/reviewer/)
  assert.deepEqual(harness.visibleMessages(), [])
})

test("an unavailable reviewer model denies with the registration failure instead of silently proceeding", async () => {
  const harness = createHarness({ model: "test/absent" })
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  assert.equal(harness.counts().generateCalls, 0)
  assert.match((event as any).message, /could not resolve a reviewer model/)
  assert.match((event as any).message, /test\/absent is not available/)
  assert.deepEqual(harness.visibleMessages(), [])
})

test("a missing reviewer variant reports the registration failure", async () => {
  const harness = createHarness({ model: "test/reviewer#missing" })
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  assert.equal(harness.counts().generateCalls, 0)
  assert.match((event as any).message, /variant "missing" is not available/)
  assert.deepEqual(harness.visibleMessages(), [])
})

test("an explicit reviewer ask denies by default and does not emit a fallback notice", async () => {
  const harness = createHarness({}, JSON.stringify({ decision: "ask", risk: "unknown", authorization: "unknown",
    reason: "Confirm the deployment target", matched_rules: [] }))
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  assert.match((event as any).message, /Confirm the deployment target/)
  assert.deepEqual(harness.visibleMessages(), [])
})

test("input budget follows current model limits and can exceed the old 64 KiB ceiling", async () => {
  const harness = createHarness()
  harness.catalogModel.limit = { context: 16_000, input: 8000, output: 8192 }
  harness.messages[1].content[0].state.input = { path: "x".repeat(70_000) }
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
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
  assert.equal(event.effect, "deny")
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

test("an explicit reviewer ask denies by default with its question as the reason", async () => {
  const harness = createHarness({}, JSON.stringify({ decision: "ask", risk: "unknown", authorization: "unknown",
    reason: "Confirm the target deployment environment", matched_rules: [] }))
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
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
  assert.equal((await harness.run()).effect, "deny")
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
    // The two identical "one" evaluations share one review, so they must also
    // share one notice: five requests, five toasts, none duplicated.
    assert.equal(harness.counts().generateCalls, 5)
    assert.equal(harness.toasts().length, 5)
  } finally {
    release({ text: allowText })
    await cleanup?.()
  }
})

test("a hung verification read does not permanently wedge shared reviewer-model setup", async () => {
  // The host adapter cannot cancel a registry read, so a read that never settles
  // must still release the shared model initialization; otherwise every later
  // review would wait on the same stuck promise. The registry is modeled as lazy
  // (2.0.4+): `transform` does not run its callback, a read does.
  const selected: any = { providerID: "test", id: "reviewer", limit: { context: 128_000, output: 8192 }, variants: [], body: { max_tokens: 4096 } }
  let hang = true
  let verifications = 0
  let retained: ((editor: any) => void) | undefined
  const modelDomain = {
    transform: async (callback: (editor: any) => void) => {
      retained = callback
      return { dispose: async () => { retained = undefined; selected.variants = [] } }
    },
    list: () => {
      verifications++
      if (hang) return new Promise(() => undefined)
      retained?.({ get: () => selected, update: (_p: string, _m: string, update: (draft: any) => void) => update(selected) })
      return Promise.resolve({ data: [selected] })
    },
    default: async () => ({ data: selected }),
  }
  const harness = createHarness({ timeoutMs: 1000, modelOptions: { body: { max_tokens: 512 } } }, allowText, undefined, modelDomain)
  await harness.setup()
  assert.equal((await harness.run({ sessionID: "one" })).effect, "deny", "a stalled verification must not approve")
  hang = false
  // Retry rather than assume a fixed number of event-loop turns: the stalled
  // attempt is released by its own timeout, which need not land before one
  // setImmediate. Without the bounded registration this never recovers, so the
  // loop still fails the test after the bound.
  let recovered = false
  const giveUpAt = Date.now() + 5_000
  while (!recovered && Date.now() < giveUpAt) {
    recovered = (await harness.run({ sessionID: "two" })).effect === "allow"
    if (!recovered) await new Promise((done) => setTimeout(done, 25))
  }
  assert.ok(recovered, "a later review must retry instead of reusing the stuck initialization")
  assert.ok(verifications >= 2, "the retry must issue its own verification read")
})

test("plugin modelOptions select a derived variant once across concurrent reviews and dispose it", async () => {
  const selected: any = { providerID: "test", id: "reviewer", limit: { context: 128_000, output: 8192 }, variants: [], body: { max_tokens: 4096 } }
  let registrations = 0
  let disposals = 0
  const modelDomain = {
    transform: async (callback: (editor: any) => void) => {
      registrations++
      callback({ get: () => selected, update: (_p: string, _m: string, update: (draft: any) => void) => update(selected) })
      return { dispose: async () => { disposals++; selected.variants = [] } }
    },
    list: async () => ({ data: [selected] }),
  }
  const harness = createHarness({ modelOptions: { body: { max_tokens: 512 } } }, async (input) => {
    assert.equal(input.body, undefined, "unsupported generate fields must not be sent")
    assert.equal(input.model.variant, selected.variants[0].id)
    assert.equal(selected.variants[0].body.max_tokens, 512)
    assert.equal(selected.body.max_tokens, 4096)
    return { text: allowText }
  }, undefined, modelDomain)
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

test("the RPC contract and the slash command share one toggle state and emit state events", async () => {
  const harness = createHarness()
  await harness.setup()
  assert.deepEqual(await harness.rpcStatus(), { enabled: true, humanFallback: false })
  await harness.rpcSetEnabled(false)
  assert.deepEqual(await harness.rpcStatus(), { enabled: false, humanFallback: false })
  assert.equal((await harness.run()).effect, "ask")
  assert.equal(await harness.command("on"), "Auto-review is enabled.")
  assert.deepEqual(await harness.rpcStatus(), { enabled: true, humanFallback: false })
  assert.equal((await harness.run()).effect, "allow")
  assert.deepEqual(harness.rpcEvents().filter((event) => event.name === "state").map((event) => event.name), ["state", "state"])
  assert.deepEqual(harness.rpcEvents().filter((event) => event.name === "state").map((event) => (event.data as { enabled: boolean }).enabled), [false, true])
})

test("the human fallback toggles over RPC and the slash command", async () => {
  // Default: the fallback is off, so a reviewer that cannot approve denies and an
  // unattended session cannot stall on a prompt nobody answers.
  const harness = createHarness({}, async () => { throw new Error("provider secret") })
  await harness.setup()
  const denied = await harness.run()
  assert.equal(denied.effect, "deny")
  assert.match(String((denied as { message?: string }).message), /Adjust the request/)
  assert.doesNotMatch(String((denied as { message?: string }).message), /human confirmation/i)

  assert.deepEqual(await harness.rpcSetFallback(true), { enabled: true, humanFallback: true })
  assert.equal((await harness.run()).effect, "ask")

  assert.equal(await harness.command("fallback off"), "Auto-review human fallback is disabled.")
  assert.equal((await harness.run()).effect, "deny")
  assert.equal(await harness.command("fallback status"), "Auto-review human fallback is disabled.")
  assert.equal(await harness.command("fallback"), "Auto-review human fallback is enabled.")
  assert.equal(await harness.command("fallback bogus"), "Usage: /auto-review fallback [on|off|toggle|status]")
})

test("an explicit human rule still asks when the fallback is off", async () => {
  // A configured rule is a deliberate confirmation requirement, not a fallback.
  const harness = createHarness({ humanReviewRules: [{ action: "read", resource: "*", reason: "always confirm" }] })
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "ask")
  assert.match(String((event as { message?: string }).message), /always confirm/)
})

test("the compaction hook captures original history like the context hook", async () => {
  const harness = createHarness()
  await harness.setup()
  assert.equal(harness.counts().contextCalls, 0)
  await harness.compact()
  assert.equal(harness.counts().contextCalls, 1)
})

test("reviewer degradation is reported as a toast and never writes to the session", async () => {
  const harness = createHarness({}, async () => { throw new Error("provider secret") })
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  assert.deepEqual(harness.visibleMessages(), [], "failures must not leave pending synthetic inbox messages")
  assert.deepEqual(harness.sessionWrites(), [], "a notice must never write to the session")
  const toasts = harness.toasts()
  assert.equal(toasts.length, 1)
  assert.match(toasts[0]!.description, /reviewer model call failed/)
  assert.match(toasts[0]!.description, /provider secret/)
})

test("a degraded approval emits one toast and no session write", async () => {
  const harness = createHarness({ model: null })
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "allow")
  // The degraded approval gets exactly one notice: describing the fallback, not
  // the fallback notice plus a second plain approval notice.
  const toasts = harness.toasts()
  assert.equal(toasts.length, 1)
  assert.match(toasts[0]!.description, /catalog default model test\/reviewer/)
  assert.deepEqual(harness.sessionWrites(), [])
})

test("a subagent's notice names its origin and never writes to a session", async () => {
  const harness = createHarness({}, async () => { throw new Error("subagent failure") })
  harness.sessions["ses_test"] = { parentID: "ses_parent", agent: "review", title: "Inspect the fixture" }
  harness.sessions["ses_parent"] = { agent: "build" }
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  const toasts = harness.toasts()
  assert.equal(toasts.length, 1)
  assert.match(toasts[0]!.description, /review subagent/)
  assert.match(toasts[0]!.description, /Inspect the fixture/)
  assert.match(toasts[0]!.description, /reviewer model call failed/)
  // The wake regression: routing used to post a message into the idle root
  // session, which resumed the parent model.
  assert.deepEqual(harness.sessionWrites(), [])
})

test("a nested subagent notice still names the originating subagent", async () => {
  const harness = createHarness({}, async () => { throw new Error("nested failure") })
  harness.sessions["ses_test"] = { parentID: "ses_mid", agent: "explore" }
  harness.sessions["ses_mid"] = { parentID: "ses_root", agent: "review" }
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  const toasts = harness.toasts()
  assert.equal(toasts.length, 1)
  assert.match(toasts[0]!.description, /explore subagent/)
  assert.deepEqual(harness.sessionWrites(), [])
})

test("a root session notice needs no origin annotation", async () => {
  const harness = createHarness({}, async () => { throw new Error("failure") })
  await harness.setup()
  assert.equal((await harness.run()).effect, "deny")
  assert.doesNotMatch(harness.toasts()[0]!.description, /subagent/)
})

test("a session lookup failure still reports the notice without writing to a session", async () => {
  const harness = createHarness({}, async () => { throw new Error("failure") })
  harness.sessions["ses_test"] = { error: true }
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  const toasts = harness.toasts()
  assert.equal(toasts.length, 1)})

test("a model fallback is surfaced once even for an approval", async () => {
  const harness = createHarness({ model: null })
  await harness.setup()
  const event = await harness.run()
  assert.equal(event.effect, "allow")
  assert.match((event as any).message, /auto-review fallback/)
  const toasts = harness.toasts()
  assert.equal(toasts.length, 1)
  assert.match(toasts[0]!.description, /catalog default model test\/reviewer/)
  assert.deepEqual(harness.visibleMessages(), [])
  assert.deepEqual(harness.sessionWrites(), [])
})

test("every automatic approval leaves a reason-free toast and no session write", async () => {
  const harness = createHarness()
  await harness.setup()
  assert.equal((await harness.run()).effect, "allow")
  const toasts = harness.toasts()
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0]!.description, "Auto-review approved read.")
  assert.equal(toasts[0]!.severity, "success")
  // An approval is toast-only: it must not commit a session message, because that
  // would resume an idle session.
  assert.deepEqual(harness.sessionWrites(), [])
})

test("the status command answers with a toast and writes nothing to the session", async () => {
  const harness = createHarness()
  await harness.setup()
  assert.equal(await harness.command("status"), "Auto-review is enabled.")
  assert.deepEqual(harness.visibleMessages(), [])
  assert.deepEqual(harness.sessionWrites(), [])
  assert.equal(harness.toasts().at(-1)!.severity, "info")
})

test("a session lookup that never settles still delivers the notice", async () => {
  // The origin annotation is best-effort; a stuck session query must not delay the
  // notice forever.
  const harness = createHarness({}, async () => { throw new Error("failure") })
  harness.sessions["ses_test"] = { hang: true }
  await harness.setup()
  const started = Date.now()
  const event = await harness.run()
  assert.equal(event.effect, "deny")
  const giveUpAt = Date.now() + 5_000
  while (harness.toasts().length === 0 && Date.now() < giveUpAt) {
    await new Promise((done) => setTimeout(done, 50))
  }
  assert.ok(Date.now() - started < 5_000, "the notice must not wait on an unbounded lookup")
  assert.equal(harness.toasts().length, 1)
  assert.doesNotMatch(harness.toasts()[0]!.description, /subagent/)
  assert.deepEqual(harness.sessionWrites(), [])
})
