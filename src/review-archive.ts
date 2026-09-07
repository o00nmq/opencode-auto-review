import type { Plugin } from "@opencode-ai/plugin"
import { KeyedQueue } from "./keyed-queue.js"

interface Message {
  id: string
  type: "user" | "assistant"
  text?: string
  content?: Tool[]
}

interface Tool {
  type: "tool"
  id: string
  name: string
  state: { status: string; input: unknown }
}

interface Archive {
  messages: Message[]
  checkpoints: { id: string; length: number }[]
  complete: boolean
}

/** Original evidence lives in storage; only a bounded selection enters model context. */
export class ReviewArchive {
  readonly #queue = new KeyedQueue()
  readonly #observed = new Set<string>()

  constructor(
    readonly storage: Plugin.Context["storage"],
    readonly context: (sessionID: string, signal: AbortSignal) => Promise<readonly unknown[]>,
  ) {}

  load(sessionID: string, signal: AbortSignal) {
    return this.#queue.run(sessionID, signal, async () => {
      const raw = await this.context(sessionID, signal)
      const key = `history/${sessionID}`
      const previous = await this.storage.get(key) as unknown as Archive | undefined
      const checkpoint = raw.filter((message) => record(message) && message.type === "compaction" && message.status === "completed").at(-1) as Record<string, unknown> | undefined
      const id = typeof checkpoint?.id === "string" ? checkpoint.id : undefined
      const known = previous?.checkpoints.findIndex((item) => item.id === id) ?? -1
      const length = !id ? 0 : known >= 0 ? previous!.checkpoints[known]!.length : previous?.messages.length ?? 0
      const prefix = previous?.messages.slice(0, length) ?? []
      const messages = new Map(prefix.map((message) => [message.id, message]))

      for (const message of raw) {
        if (!record(message) || typeof message.id !== "string") continue
        if (message.type === "user" && typeof message.text === "string") {
          messages.set(message.id, { id: message.id, type: "user", text: message.text })
        }
        if (message.type !== "assistant" || !Array.isArray(message.content)) continue
        const tools: Tool[] = []
        for (const part of message.content) {
          if (!record(part) || part.type !== "tool" || typeof part.id !== "string" || typeof part.name !== "string" ||
            !record(part.state) || !record(part.state.input) || typeof part.state.status !== "string") continue
          tools.push({ type: "tool", id: part.id, name: part.name, state: { status: part.state.status, input: part.state.input } })
          if (part.state.status === "completed" || part.state.status === "error") {
            await this.storage.set(this.resultKey(sessionID, message.id, part.id), JSON.stringify({
              status: part.state.status,
              content: Array.isArray(part.state.content) ? part.state.content.filter(item => record(item) && item.type === "text") : [],
              error: part.state.error,
            }))
          }
        }
        if (tools.length) messages.set(message.id, { id: message.id, type: "assistant", content: tools })
      }

      const archive: Archive = {
        messages: [...messages.values()],
        checkpoints: !id ? [] : known >= 0
          ? previous!.checkpoints.slice(0, known + 1)
          : [...(previous?.checkpoints ?? []), { id, length }],
        // A checkpoint created while this plugin was absent may cover unseen instructions.
        complete: !id || (previous?.complete === true && (known >= 0 || this.#observed.has(sessionID))),
      }
      await this.storage.set(key, JSON.parse(JSON.stringify(archive)))
      this.#observed.add(sessionID)
      // The checkpoint is background only. Never append the accumulated summary chain.
      const view: unknown[] = [...archive.messages]
      if (checkpoint) view.splice(length, 0, checkpoint)
      return { messages: view, complete: archive.complete }
    })
  }

  async result(sessionID: string, messageID: string, toolID: string): Promise<string | undefined> {
    const result = await this.storage.get(this.resultKey(sessionID, messageID, toolID))
    return typeof result === "string" ? result : undefined
  }

  private resultKey(sessionID: string, messageID: string, toolID: string) {
    return `result/${sessionID}/${messageID}/${toolID}`
  }
}

function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
