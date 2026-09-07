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
  history_truncated: boolean
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

export interface ReviewerJournalState {
  checkpoint?: string
  version: 2
  epoch: number
  sourceLength: number
  sourceDigest: string
  lines: string[]
}
