export class KeyedQueue {
  readonly #tails = new Map<string, Promise<void>>()

  run<T>(key: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve()
    const operation = previous.then(() => {
      if (signal.aborted) throw new Error("queued operation aborted")
      return task()
    })
    const tail = operation.then(() => undefined, () => undefined)
    this.#tails.set(key, tail)
    void tail.finally(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    })
    return operation
  }

  clear(): void {
    this.#tails.clear()
  }
}
