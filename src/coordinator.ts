interface Waiter {
  signal: AbortSignal
  resolve: (acquired: boolean) => void
  abort: () => void
}

export class ReviewCoordinator<T> {
  readonly #inFlight = new Map<string, Promise<T | undefined>>()
  readonly #waiting: Waiter[] = []
  #active = 0
  #disposed = false

  constructor(readonly limit: number, readonly queueLimit: number) {}

  run(key: string, signal: AbortSignal, task: () => Promise<T | undefined>): Promise<T | undefined> {
    if (this.#disposed || signal.aborted) return Promise.resolve(undefined)
    const existing = this.#inFlight.get(key)
    if (existing) return existing
    if (this.#active >= this.limit && this.#waiting.length >= this.queueLimit) return Promise.resolve(undefined)

    const review = this.#execute(signal, task)
    this.#inFlight.set(key, review)
    void review.finally(() => {
      if (this.#inFlight.get(key) === review) this.#inFlight.delete(key)
    }).catch(() => undefined)
    return review
  }

  dispose(): void {
    this.#disposed = true
    this.#inFlight.clear()
    for (const waiter of this.#waiting.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.abort)
      waiter.resolve(false)
    }
  }

  async #execute(signal: AbortSignal, task: () => Promise<T | undefined>): Promise<T | undefined> {
    if (!await this.#acquire(signal)) return
    try {
      if (this.#disposed || signal.aborted) return
      return await task()
    } finally {
      this.#release()
    }
  }

  #acquire(signal: AbortSignal): Promise<boolean> {
    if (this.#disposed || signal.aborted) return Promise.resolve(false)
    if (this.#active < this.limit) {
      this.#active++
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        signal,
        resolve,
        abort: () => {
          const index = this.#waiting.indexOf(waiter)
          if (index >= 0) this.#waiting.splice(index, 1)
          resolve(false)
        },
      }
      signal.addEventListener("abort", waiter.abort, { once: true })
      this.#waiting.push(waiter)
    })
  }

  #release(): void {
    this.#active--
    if (this.#disposed) return
    while (this.#waiting.length > 0) {
      const next = this.#waiting.shift()!
      next.signal.removeEventListener("abort", next.abort)
      if (next.signal.aborted) {
        next.resolve(false)
        continue
      }
      this.#active++
      next.resolve(true)
      return
    }
  }
}
