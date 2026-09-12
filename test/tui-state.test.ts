import assert from "node:assert/strict"
import test from "node:test"
import { createAutoReviewController } from "../src/tui-state.js"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

function harness(initial = true) {
  const stateHandlers: Array<(event: any) => void> = []
  const statusCalls: Array<{ input: unknown; options: any }> = []
  const setCalls: Array<{ input: any; options: any }> = []
  const unsubscribes = { state: 0 }
  const changes: boolean[] = []
  const toasts: string[] = []
  let statusImpl: () => Promise<any> = async () => ({ enabled: initial })
  let setImpl: (input: any) => Promise<any> = async (input) => ({ enabled: input.enabled })
  const location = { directory: "/repo", workspaceID: "ws" }
  const client: any = {
    status: async (input: unknown, options: unknown) => {
      statusCalls.push({ input, options })
      return statusImpl()
    },
    setEnabled: async (input: any, options: unknown) => {
      setCalls.push({ input, options })
      return setImpl(input)
    },
    events: {
      on: (name: string, handler: (event: any) => void) => {
        if (name === "state") stateHandlers.push(handler)
        return () => { unsubscribes.state++ }
      },
    },
  }
  const controller = createAutoReviewController({
    client, location, initial,
    onChange: (value) => changes.push(value),
    toast: (message) => toasts.push(message),
  })
  const localEvent = (data: any) => ({ data, location })
  return {
    controller, client, changes, toasts, statusCalls, setCalls, unsubscribes,
    stateHandlers,
    setStatus: (fn: () => Promise<any>) => { statusImpl = fn },
    setSetEnabled: (fn: (input: any) => Promise<any>) => { setImpl = fn },
    localEvent,
  }
}

test("the initial query applies only the server-confirmed value and is location-scoped", async () => {
  const h = harness(true)
  h.setStatus(async () => ({ enabled: false }))
  h.controller.start()
  await tick()
  assert.equal(h.controller.enabled(), false)
  assert.deepEqual(h.changes, [false])
  assert.deepEqual(h.statusCalls[0]!.input, {})
  assert.deepEqual(h.statusCalls[0]!.options, { location: { directory: "/repo", workspace: "ws" } })
})

test("setEnabled never guesses: state stays until the server response confirms it", async () => {
  const gate = deferred<{ enabled: boolean }>()
  const h = harness(true)
  h.setSetEnabled(() => gate.promise)
  const pending = h.controller.setEnabled(false)
  await tick()
  assert.equal(h.controller.enabled(), true, "an in-flight switch must not optimistically change state")
  assert.deepEqual(h.changes, [])
  gate.resolve({ enabled: false })
  assert.equal(await pending, true)
  assert.equal(h.controller.enabled(), false)
  assert.deepEqual(h.changes, [false])
})

test("a switch trusts the server's returned value rather than the requested one", async () => {
  const h = harness(false)
  h.setStatus(async () => ({ enabled: false }))
  h.setSetEnabled(async () => ({ enabled: true }))
  assert.equal(await h.controller.setEnabled(false), true)
  assert.equal(h.controller.enabled(), true)
})

test("a failed switch keeps the confirmed state and surfaces a toast", async () => {
  const h = harness(true)
  h.setStatus(async () => ({ enabled: true }))
  h.setSetEnabled(async () => { throw new Error("offline") })
  assert.equal(await h.controller.setEnabled(false), false)
  assert.equal(h.controller.enabled(), true)
  assert.equal(h.toasts.length, 1)
  assert.match(h.toasts[0]!, /Could not confirm auto-review mode/)
})

test("status query failure is reported as unconfirmed instead of returning an old value", async () => {
  const h = harness(true)
  h.setStatus(async () => ({ enabled: true }))
  h.controller.start()
  await tick()
  h.setStatus(async () => { throw new Error("offline") })
  assert.equal(await h.controller.refresh(), false)
  // The value survives locally, but the caller was told it was not confirmed.
  assert.equal(h.controller.enabled(), true)
})

test("a stale status response cannot overwrite a newer response", async () => {
  const first = deferred<{ enabled: boolean }>()
  const second = deferred<{ enabled: boolean }>()
  const queue = [first, second]
  const h = harness(true)
  h.setStatus(() => queue.shift()!.promise)
  const slow = h.controller.refresh()
  const fast = h.controller.refresh()
  second.resolve({ enabled: false })
  assert.equal(await fast, true)
  assert.equal(h.controller.enabled(), false)
  first.resolve({ enabled: true })
  assert.equal(await slow, false, "the superseded response must be discarded")
  assert.equal(h.controller.enabled(), false, "a stale response must not overwrite the newer value")
})

test("a state event discards an in-flight status response that started before it", async () => {
  const gate = deferred<{ enabled: boolean }>()
  const h = harness(true)
  h.setStatus(() => gate.promise)
  h.controller.start()
  await tick()
  h.stateHandlers[0]!(h.localEvent({ enabled: false }))
  assert.equal(h.controller.enabled(), false)
  gate.resolve({ enabled: true })
  await tick()
  assert.equal(h.controller.enabled(), false, "the pre-event response must not resurrect the old value")
})

test("a late switch response cannot overwrite a newer state event", async () => {
  const h = harness(true)
  h.controller.start()
  await tick()
  const gate = deferred<{ enabled: boolean }>()
  h.setSetEnabled(() => gate.promise)
  const pending = h.controller.setEnabled(false)
  h.stateHandlers[0]!(h.localEvent({ enabled: false }))
  h.stateHandlers[0]!(h.localEvent({ enabled: true }))
  gate.resolve({ enabled: false })
  assert.equal(await pending, false)
  assert.equal(h.controller.enabled(), true)
})

test("events from another location are ignored", async () => {
  const h = harness(true)
  h.controller.start()
  await tick()
  h.stateHandlers[0]!({ data: { enabled: false }, location: { directory: "/other" } })
  assert.equal(h.controller.enabled(), true)
})

test("dispose is idempotent and silences later events", async () => {
  const h = harness(true)
  h.controller.start()
  await tick()
  h.controller.dispose()
  assert.deepEqual(h.unsubscribes, { state: 1 })
  h.stateHandlers[0]!(h.localEvent({ enabled: false }))
  assert.equal(h.controller.enabled(), true)
  assert.deepEqual(h.toasts, [])
  assert.equal(await h.controller.refresh(), false)
})
