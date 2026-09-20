import { Rpc } from "@opencode/plugin/rpc"

/**
 * Shared RPC contract between the server plugin and the TUI plugin. The TUI
 * reads the authoritative on/off state and switches it over RPC instead of
 * parsing synthetic session text.
 */
/** The two live behavior switches the CLI may read and change. */
const switches = {
  type: "object",
  properties: { enabled: { type: "boolean" }, humanFallback: { type: "boolean" } },
  required: ["enabled", "humanFallback"],
  additionalProperties: false,
} as const

export const AutoReview = Rpc.define({
  id: "opencode-auto-review",
  methods: {
    status: {
      input: { type: "object", additionalProperties: false },
      output: switches,
    },
    setEnabled: {
      input: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
        additionalProperties: false,
      },
      output: switches,
    },
    // Turning the human fallback off makes a decision that needs a human a deny
    // instead of a prompt, so an unattended session cannot stall on a question.
    setFallback: {
      input: {
        type: "object",
        properties: { humanFallback: { type: "boolean" } },
        required: ["humanFallback"],
        additionalProperties: false,
      },
      output: switches,
    },
  },
  events: {
    state: { schema: switches },
    // Reviewer notices are presented by the CLI plugin as a toast. A server
    // plugin cannot emit client UI events, so this RPC event is the supported
    // path; it also means a notice never enters the session transcript and never
    // resumes an idle session.
    notice: {
      schema: {
        type: "object",
        properties: {
          description: { type: "string" },
          severity: { enum: ["success", "info", "warning", "error"] },
        },
        required: ["description", "severity"],
        additionalProperties: false,
      },
    },
  },
})
