import { Rpc } from "@opencode/plugin/rpc"

/**
 * Shared RPC contract between the server plugin and the TUI plugin. The TUI
 * reads the authoritative on/off state and switches it over RPC instead of
 * parsing synthetic session text.
 */
export const AutoReview = Rpc.define({
  id: "opencode-auto-review",
  methods: {
    status: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
        additionalProperties: false,
      },
    },
    setEnabled: {
      input: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
        additionalProperties: false,
      },
    },
  },
  events: {
    state: {
      schema: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
        additionalProperties: false,
      },
    },
  },
})
