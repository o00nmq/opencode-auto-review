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
  decision: "allow" | "deny"
  risk: "low" | "medium" | "high" | "critical" | "unknown"
  authorization: "high" | "medium" | "low" | "unknown"
  reason: string
  matched_rules: string[]
}
