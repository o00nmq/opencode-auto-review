import type { PermissionEvent, ReviewContextEntry, ReviewRequest } from "./types.js"

interface MessageInfo {
  id?: string
  type?: string
  content?: readonly unknown[]
  [key: string]: unknown
}

export function buildReviewRequest(
  messages: readonly unknown[],
  event: PermissionEvent,
): ReviewRequest | undefined {
  if (!event.source || event.source.type !== "tool") return

  const sourceIndexes = messages.flatMap((message, index) =>
    isRecord(message) && message.type === "assistant" && message.id === event.source!.messageID ? [index] : [],
  )
  if (sourceIndexes.length !== 1) return
  const sourceIndex = sourceIndexes[0]!

  const source = messages[sourceIndex] as MessageInfo
  const tool = findToolPart(source.content, event.source.id)
  if (!tool) return
  const currentTool = tool

  const compactionIndex = findLatestCompaction(messages, sourceIndex)
  if (compactionIndex !== undefined && (messages[compactionIndex] as Record<string, unknown>).status === "running") return
  const startIndex = compactionIndex ?? 0
  const history: ReviewContextEntry[] = []
  let hasUser = false

  for (let index = startIndex; index < sourceIndex; index++) {
    const message = messages[index]
    if (!isRecord(message)) continue
    if (message.type === "compaction" && message.status === "completed" &&
      typeof message.summary === "string" && typeof message.recent === "string") {
      history.push({ type: "compaction", summary: message.summary, recent: message.recent })
      continue
    }
    if (message.type === "user" && typeof message.text === "string" && message.text.trim()) {
      hasUser = true
      history.push({ type: "user", text: message.text })
      continue
    }
    if (message.type !== "assistant" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      const historicalTool = readCompleteToolPart(part)
      if (historicalTool) history.push({ type: "tool", ...historicalTool })
    }
  }
  if (!hasUser) return

  return {
    context: [...history, { type: "tool", name: currentTool.name, input: currentTool.input }],
    history_truncated: false,
    permission: { action: event.action, resources: [...event.resources] },
  }

}

function findToolPart(parts: readonly unknown[] | undefined, id: string): { name: string; input: unknown } | undefined {
  if (!parts) return
  const matches = parts.filter((part) => isRecord(part) && part.id === id && part.type === "tool")
  if (matches.length !== 1) return
  return readCompleteToolPart(matches[0])
}

function readCompleteToolPart(value: unknown): { name: string; input: unknown } | undefined {
  if (!isRecord(value) || value.type !== "tool" || typeof value.name !== "string" || !value.name) return
  if (!isRecord(value.state) || !["running", "completed", "error"].includes(value.state.status as string)) return
  if (!isJsonObject(value.state.input)) return
  return { name: value.name, input: value.state.input }
}

function findLatestCompaction(messages: readonly unknown[], sourceIndex: number): number | undefined {
  for (let index = sourceIndex - 1; index >= 0; index--) {
    const message = messages[index]
    if (isRecord(message) && message.type === "compaction" && ["running", "completed"].includes(message.status as string)) {
      return index
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Object.values(value).every(isJsonValue)
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isJsonObject(value)
}
