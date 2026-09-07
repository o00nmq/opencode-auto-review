export interface ModelLimits {
  context: number
  input?: number
  output: number
}

/** Cross-provider estimate, not a model-specific tokenizer. */
export function estimateTokens(text: string): number {
  let tokens = 0
  for (const [part] of text.matchAll(/[A-Za-z0-9_ \t\r\n]+|[^\x00-\x7f]+|./g)) {
    tokens += /^[A-Za-z0-9_ \t\r\n]/.test(part)
      ? Math.ceil(part.length / 3)
      : Buffer.byteLength(part, "utf8")
  }
  return tokens
}

export function inputTokenBudget(limit: ModelLimits | undefined, body: Record<string, unknown> = {}): number {
  if (!limit || !Number.isFinite(limit.context) || limit.context <= 0) return 0
  const caps = [body.max_tokens, body.max_completion_tokens, body.max_output_tokens]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
  const output = caps.length ? Math.max(...caps) : limit.output
  const available = Math.min(limit.input ?? limit.context, limit.context - output)
  // Reserve 10% for estimation error and 256 tokens for protocol framing.
  return Number.isFinite(available) ? Math.max(0, Math.floor(available * 0.9) - 256) : 0
}
