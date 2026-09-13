import assert from "node:assert/strict"
import test from "node:test"
import tui from "../src/tui.js"

// tsx transpiles TSX with the classic runtime, while the plugin's JSX targets
// Solid (@opentui/solid) and is normally executed by the host. Tests only need
// the component body to run so it registers its keymap layer, so provide a
// minimal element factory rather than mounting a renderer.
;(globalThis as { React?: unknown }).React = {
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
  Fragment: Symbol("Fragment"),
}

/** A stateful fake RPC server so the TUI state is real, not just handler capture. */
function harness(options: { enabled?: boolean; failSwitch?: boolean } = {}) {
  let enabled = options.enabled ?? true
  let failStatus = false
  const statusCalls: Array<{ input: unknown; options: any }> = []
  const toasts: any[] = []
  const connectedHandlers: Array<() => void> = []
  let selectReply: string | undefined
  const commands: any[] = []
  let slotClaim: any
  const client: any = {
    status: async (input: unknown, callOptions: any) => {
      statusCalls.push({ input, options: callOptions })
      if (failStatus) throw new Error("offline")
      return { enabled }
    },
    setEnabled: async (input: any) => {
      if (options.failSwitch) throw new Error("offline")
      enabled = input.enabled
      return { enabled }
    },
    events: { on: (_name: string, _handler: unknown) => () => undefined },
  }
  const context: any = {
    options: {},
    location: { directory: "/repo", workspaceID: "ws" },
    client: { rpc: () => client },
    data: { on: (_name: string, handler: () => void) => { connectedHandlers.push(handler); return () => undefined } },
    ui: {
      toast: { show: (toast: any) => toasts.push(toast) },
      slot: (claim: any) => { slotClaim = claim; return () => undefined },
      router: { current: () => ({ type: "session", sessionID: "ses" }) },
      dialog: { select: async () => selectReply },
    },
    keymap: { layer: (callback: () => any) => { commands.push(...callback().commands); return () => undefined } },
    theme: { text: { action: { primary: { default: "#fff" } } } },
  }
  return {
    context, toasts, statusCalls, commands,
    setReply: (value: string | undefined) => { selectReply = value },
    setFailStatus: (value: boolean) => { failStatus = value },
    serverState: () => enabled,
    connect: () => connectedHandlers.forEach((handler) => handler()),
    // The host renders a slot claim inside a component, which is where the
    // keymap layer must be registered. Invoking render exercises that path.
    renderSlot: () => {
      const element = slotClaim.render({ mode: "normal" })
      // The stub factory only records the element; invoke the component the
      // way a renderer would so its body (and keymap registration) runs.
      if (element && typeof element.type === "function") element.type(element.props)
    },
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test("the footer command shows the RPC-confirmed state and reflects a real switch", async () => {
  const h = harness({ enabled: true })
  const cleanup = await tui.setup(h.context)
  h.renderSlot()
  const run = h.commands.find((command) => command.id === "auto-review.toggle")!.run
  await tick()
  assert.deepEqual(h.statusCalls[0]!.options, { location: { directory: "/repo", workspace: "ws" } })

  h.setReply("status")
  await run()
  assert.equal(h.toasts.at(-1)!.message, "Auto-review is enabled.")

  const toastsBefore = h.toasts.length
  h.setReply("off")
  await run()
  assert.equal(h.serverState(), false, "the switch must reach the server")
  assert.equal(h.toasts.length, toastsBefore, "a confirmed switch is not an error")

  h.setReply("status")
  await run()
  assert.equal(h.toasts.at(-1)!.message, "Auto-review is disabled.")
  await cleanup?.()
})

test("a switch that cannot be confirmed toasts and keeps the previous state", async () => {
  const h = harness({ enabled: true, failSwitch: true })
  const cleanup = await tui.setup(h.context)
  h.renderSlot()
  const run = h.commands.find((command) => command.id === "auto-review.toggle")!.run
  await tick()

  h.setReply("off")
  await run()
  assert.equal(h.serverState(), true, "a failed switch must not change server state")
  assert.match(h.toasts.at(-1)!.message, /Could not confirm auto-review mode/)
  assert.equal(h.toasts.at(-1)!.variant, "warning")

  h.setReply("status")
  await run()
  assert.equal(h.toasts.at(-1)!.message, "Auto-review is enabled.", "status must not report the failed guess")
  await cleanup?.()
})

test("a status query that cannot be confirmed is never reported as the current state", async () => {
  const h = harness({ enabled: true })
  const cleanup = await tui.setup(h.context)
  h.renderSlot()
  const run = h.commands.find((command) => command.id === "auto-review.toggle")!.run
  await tick()
  h.setFailStatus(true)
  h.setReply("status")
  await run()
  assert.match(h.toasts.at(-1)!.message, /status is unavailable/)
  await cleanup?.()
})

test("reconnect re-queries the authoritative state", async () => {
  const h = harness({ enabled: false })
  const cleanup = await tui.setup(h.context)
  await tick()
  h.connect()
  await tick()
  assert.ok(h.statusCalls.length >= 2)
  await cleanup?.()
})

test("setup never registers a keymap layer outside the component tree", async () => {
  // The host only provides the keymap context to rendered components. setup
  // runs outside it, so touching keymap there would fail plugin load with
  // "Keymap.Provider is missing".
  const h = harness()
  h.context.keymap.layer = () => { throw new Error("Keymap.Provider is missing") }
  const cleanup = await tui.setup(h.context)
  await cleanup?.()
})
