/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"
import { createSignal, Show } from "solid-js"

export default Plugin.define({
  id: "opencode-auto-review.tui",
  setup(ctx) {
    const [enabled, setEnabled] = createSignal(ctx.options.enabled !== false)
    const stopInbox = ctx.data.on("session.inbox.enqueued", (event) => {
      const item = event.data.item
      if (item.type !== "synthetic") return
      if (item.payload.text === "Auto-review is enabled.") setEnabled(true)
      else if (item.payload.text === "Auto-review is disabled.") setEnabled(false)
    })

    const Status = (props: { mode: string }) => {
      ctx.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [{
          id: "auto-review.toggle",
          title: "Toggle Auto-review",
          group: "Auto-review",
          palette: true,
          suggested: true,
          enabled: () => ctx.ui.router.current().type === "session",
          run: async () => {
            const route = ctx.ui.router.current()
            if (route.type !== "session") {
              ctx.ui.toast.show({ message: "Open a session to change auto-review mode", variant: "warning" })
              return
            }
            const action = await ctx.ui.dialog.select({
              title: "Auto-review mode",
              options: [
                { title: "Enable", value: "on", description: "Automatically allow or deny eligible tool requests" },
                { title: "Disable", value: "off", description: "Use normal OpenCode permission handling" },
                { title: "Show status", value: "status" },
              ],
            })
            if (!action) return
            await ctx.client.session.command({
              sessionID: route.sessionID,
              command: "auto-review",
              text: action,
            })
            if (action === "on") setEnabled(true)
            else if (action === "off") setEnabled(false)
          },
        }],
        bindings: ["auto-review.toggle"],
      }))

      return (
        <Show when={enabled() && props.mode === "normal"}>
          <text fg={ctx.theme.text.action.primary.default}>
            <b>Auto Mode</b>
          </text>
        </Show>
      )
    }

    const removeStatus = ctx.ui.slot({
      append: "prompt.footer.status",
      render: ({ mode }) => <Status mode={mode} />,
    })

    return () => {
      stopInbox()
      removeStatus()
    }
  },
})
