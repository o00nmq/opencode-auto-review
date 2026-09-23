export interface PermissionSource {
  type: "tool"
  messageID: string
  id: string
}

export interface PermissionEvent {
  readonly sessionID: string
  readonly agent?: string
  readonly action: string
  readonly resources: readonly string[]
  readonly source?: PermissionSource
  effect: "allow" | "ask" | "deny"
  message?: string
}

export interface ReviewRequest {
  checkpoint?: string
  context: ReviewContextEntry[]
  permission: {
    action: string
    resources: readonly string[]
  }
}

export type ReviewContextEntry =
  | { type: "user"; text: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "compaction"; summary: string; recent: string }

export interface ReviewDecision {
  decision: "allow" | "deny" | "ask"
  risk: "low" | "medium" | "high" | "critical" | "unknown"
  authorization: "high" | "medium" | "low" | "unknown"
  reason?: string
  matched_rules: string[]
}

/**
 * Persisted reviewer journal. `body` is the cached prompt prefix for the current
 * compaction epoch; `sourceLength`/`sourceDigest` mark the snapshot boundary it
 * was selected from. Per-review lines (the pending tool, the evidence index, and
 * loop lines) are derived and never stored.
 */
export interface ReviewerJournalState {
  checkpoint?: string
  version: 5
  epoch: number
  sourceLength: number
  sourceDigest: string
  body: string[]
  /**
   * True once the body has stopped growing. Persisted so the seal survives a
   * reload: without it, a later small request could fall back into the growing
   * phase and restart the churn this state exists to prevent.
   */
  sealed: boolean
  /** Compact prior verdicts for this epoch, newest last. */
  outcomes: string[]
}
