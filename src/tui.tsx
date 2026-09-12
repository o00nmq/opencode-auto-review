/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createSignal, Show } from "solid-js"
import { AutoReview } from "./rpc.js"
import { createAutoReviewController } from "./tui-state.js"

export default Plugin.define({
  id: "opencode-auto-review.tui",
  setup(ctx) {
    const [enabled, setEnabled] = createSignal(ctx.options.enabled !== false)
    const rpc = ctx.client.rpc(AutoReview)
    let disposed = false
    const toast = (message: string) => {
      if (!disposed) ctx.ui.toast.show({ message, variant: "warning", duration: 4_000 })
    }

    // Only confirmed RPC responses or events move the signal; the controller
    // keeps the authoritative state and discards stale status responses.
    const controller = createAutoReviewController({
      client: rpc,
      location: ctx.location,
      initial: ctx.options.enabled !== false,
      onChange: (value) => setEnabled(value),
      toast,
    })
    controller.start()
    // A reconnect may have missed state events; re-query the authoritative state.
    const stopConnected = ctx.data.on("server.connected", () => void controller.refresh())

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
          if (disposed) return
          const action = await ctx.ui.dialog.select({
            title: "Auto-review mode",
            options: [
              { title: "Enable", value: "on", description: "Review eligible requests; ask when evidence or confirmation is needed" },
              { title: "Disable", value: "off", description: "Use normal OpenCode permission handling" },
              { title: "Show status", value: "status" },
            ],
          })
          if (!action || disposed) return
          if (action === "status") {
            const confirmed = await controller.refresh()
            if (disposed) return
            if (!confirmed) {
              toast("Auto-review status is unavailable right now.")
              return
            }
            ctx.ui.toast.show({ message: `Auto-review is ${controller.enabled() ? "enabled" : "disabled"}.` })
            return
          }
          await controller.setEnabled(action === "on")
        },
      }],
      bindings: ["auto-review.toggle"],
    }))

    const Status = (props: { mode: string }) => (
      <Show when={enabled() && props.mode === "normal"}>
        <text fg={ctx.theme.text.action.primary.default}>
          <b>Auto Mode</b>
        </text>
      </Show>
    )

    const removeStatus = ctx.ui.slot({
      append: "prompt.footer.status",
      render: ({ mode }) => <Status mode={mode} />,
    })

    return () => {
      disposed = true
      stopConnected()
      controller.dispose()
      removeStatus()
    }
  },
})
