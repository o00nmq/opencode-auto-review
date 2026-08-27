import assert from "node:assert/strict"
import test from "node:test"
import { ReviewCoordinator } from "../src/coordinator.js"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test("coalesces identical work before acquiring a concurrency slot", async () => {
  const coordinator = new ReviewCoordinator<number>(1, 4)
  const signal = new AbortController().signal
  const work = deferred<number | undefined>()
  let calls = 0
  const first = coordinator.run("same", signal, () => { calls++; return work.promise })
  const second = coordinator.run("same", signal, () => { calls++; return work.promise })
  assert.equal(first, second)
  await new Promise((done) => setImmediate(done))
  assert.equal(calls, 1)
  work.resolve(7)
  assert.equal(await first, 7)
})

test("bounds distinct work and removes completed entries", async () => {
  const coordinator = new ReviewCoordinator<number>(2, 4)
  const signal = new AbortController().signal
  const gates = [deferred<number | undefined>(), deferred<number | undefined>(), deferred<number | undefined>()]
  let active = 0
  let peak = 0
  const runs = gates.map((gate, index) => coordinator.run(String(index), signal, async () => {
    active++
    peak = Math.max(peak, active)
    const value = await gate.promise
    active--
    return value
  }))
  await new Promise((done) => setImmediate(done))
  assert.equal(active, 2)
  gates[0]!.resolve(0)
  await new Promise((done) => setImmediate(done))
  assert.equal(active, 2)
  gates[1]!.resolve(1)
  gates[2]!.resolve(2)
  assert.deepEqual(await Promise.all(runs), [0, 1, 2])
  assert.equal(peak, 2)
})

test("queue capacity and abort are fail-safe", async () => {
  const coordinator = new ReviewCoordinator<number>(1, 1)
  const gate = deferred<number | undefined>()
  const first = coordinator.run("first", new AbortController().signal, () => gate.promise)
  const queuedController = new AbortController()
  let queuedRan = false
  const queued = coordinator.run("queued", queuedController.signal, async () => { queuedRan = true; return 2 })
  const overflow = await coordinator.run("overflow", new AbortController().signal, async () => 3)
  assert.equal(overflow, undefined)
  queuedController.abort()
  assert.equal(await queued, undefined)
  assert.equal(queuedRan, false)
  gate.resolve(1)
  assert.equal(await first, 1)
})
