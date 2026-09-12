export interface AutoReviewLocation {
  directory?: string
  workspaceID?: string
}

interface StateEvent {
  data: { enabled?: unknown }
  location?: AutoReviewLocation
}

/** The subset of the generated RPC client this controller depends on. */
export interface AutoReviewRpcClient {
  // JSON-schema RPC methods are typed `unknown` by the generated client; the
  // controller narrows the response instead of trusting the declared shape.
  status(input: unknown, options?: unknown): Promise<unknown>
  setEnabled(input: { enabled: boolean }, options?: unknown): Promise<unknown>
  events: {
    on(name: "state", handler: (event: StateEvent) => void, options?: unknown): () => void
  }
}

export interface AutoReviewControllerOptions {
  client: AutoReviewRpcClient
  location?: AutoReviewLocation | undefined
  initial: boolean
  /** Called only when a confirmed response or event changes the value. */
  onChange(value: boolean): void
  /** Called when a switch could not be confirmed by the server. */
  toast(message: string): void
}

export interface AutoReviewController {
  /** Last value confirmed by an RPC response or event. */
  enabled(): boolean
  /** Query the authoritative state. Returns whether this call confirmed and applied it. */
  refresh(): Promise<boolean>
  /** Request a switch. Returns whether the response confirmed a value. */
  setEnabled(next: boolean): Promise<boolean>
  start(): void
  dispose(): void
}

/**
 * State transitions are driven only by confirmed RPC responses and live events,
 * never by optimistic local guesses. A request sequence and an event revision
 * together discard a stale `status` response so it cannot overwrite a newer
 * value (for example after a reconnect).
 */
export function createAutoReviewController(options: AutoReviewControllerOptions): AutoReviewController {
  let current = options.initial
  let disposed = false
  let requestSequence = 0
  let eventRevision = 0
  let stopState: (() => void) | undefined

  const isLocal = (location: AutoReviewLocation | undefined): boolean => {
    const active = options.location
    if (!active || !location) return true
    return location.directory === active.directory && location.workspaceID === active.workspaceID
  }

  const callOptions = () => {
    const active = options.location
    if (!active?.directory) return undefined
    return { location: { directory: active.directory, ...(active.workspaceID ? { workspace: active.workspaceID } : {}) } }
  }

  const apply = (value: unknown): boolean => {
    if (disposed || typeof value !== "boolean") return false
    if (value !== current) {
      current = value
      options.onChange(value)
    }
    return true
  }

  const enabledOf = (response: unknown): unknown => {
    if (response === null || typeof response !== "object" || !("enabled" in response)) return undefined
    return (response as { enabled?: unknown }).enabled
  }

  const refresh = async (): Promise<boolean> => {
    if (disposed) return false
    const sequence = ++requestSequence
    const revision = eventRevision
    let result: unknown
    try {
      result = await options.client.status({}, callOptions())
    } catch {
      // The server plugin may not be active for this client location yet.
      return false
    }
    // A newer request or any intervening event makes this response stale.
    if (disposed || sequence !== requestSequence || revision !== eventRevision) return false
    return apply(enabledOf(result))
  }

  const setEnabled = async (next: boolean): Promise<boolean> => {
    if (disposed) return false
    const sequence = ++requestSequence
    const revision = eventRevision
    let result: unknown
    let failed = false
    try {
      result = await options.client.setEnabled({ enabled: next }, callOptions())
    } catch {
      failed = true
    }
    if (disposed) return false
    if (!failed && (sequence !== requestSequence || revision !== eventRevision)) return false
    if (failed || !apply(enabledOf(result))) {
      options.toast("Could not confirm auto-review mode. Refreshing server state.")
      void refresh()
      return false
    }
    return true
  }

  return {
    enabled: () => current,
    refresh,
    setEnabled,
    start() {
      if (disposed || stopState) return
      stopState = options.client.events.on("state", (event) => {
        if (disposed || !isLocal(event.location)) return
        if (typeof event.data?.enabled !== "boolean") return
        // Bump the revision before applying so an in-flight status response
        // that started before this event can no longer win.
        eventRevision++
        apply(event.data.enabled)
      })
      void refresh()
    },
    dispose() {
      disposed = true
      stopState?.()
      stopState = undefined
    },
  }
}
