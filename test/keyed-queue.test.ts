import assert from "node:assert/strict"
import test from "node:test"
import { KeyedQueue } from "../src/keyed-queue.js"

test("an aborted middle waiter cannot pass an active same-key operation", async () => {
  const queue = new KeyedQueue()
  const order: string[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const first = queue.run("session", new AbortController().signal, async () => {
    order.push("first:start")
    await firstGate
    order.push("first:end")
  })
  const middleController = new AbortController()
  const middle = queue.run("session", middleController.signal, async () => {
    order.push("middle:start")
  })
  const last = queue.run("session", new AbortController().signal, async () => {
    order.push("last:start")
  })
  middleController.abort()
  releaseFirst()

  await first
  await assert.rejects(middle, /aborted/)
  await last
  assert.deepEqual(order, ["first:start", "first:end", "last:start"])
})
