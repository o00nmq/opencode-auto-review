const MESSAGE = "opencode-auto-review is incompatible with OpenCode V1. Use OpenCode V2 to load this plugin."

export async function OpenCodeV1Unsupported(): Promise<Record<string, never>> {
  console.warn(MESSAGE)
  return {}
}

export default {
  id: "opencode-auto-review.v1-unsupported",
  server: OpenCodeV1Unsupported,
}
