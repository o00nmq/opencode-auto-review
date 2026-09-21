# OpenCode Auto Review

Automatically reviews **OpenCode V2** permission prompts for long-running unattended work. Authorized operations with low or medium bounded risk proceed automatically; everything else is denied with a reason the coding model can act on.

Requires OpenCode 2.0.4 or newer, which is the release that exposes the `ctx.model` plugin context this plugin uses. An older host cannot provide that context shape.

## Install

```sh
opencode2 plugin add opencode-auto-review
```

## Configure

Choose a reviewer model in `opencode.json(c)`. Replace the example with an available model; `#variant` is optional.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-auto-review",
      "options": {
        "model": "provider/model#variant"
      }
    }
  ]
}
```

The model is optional: the plugin falls back to the `auto-reviewer` agent's model, then OpenCode's default. Notices are CLI toasts, so nothing is ever written to the session and an idle session is never resumed. Notices never change the permission decision.

Automatic review is enabled by default, with **2,048 output tokens** and **90 seconds total per request**. Change these with `maxReviewTokens` and `timeoutMs`. The default output parameter targets Chat Completions; see [advanced configuration](DESIGN.md#configuration) for other APIs and human-only rules.

## Usage

`/auto-review [on|off|toggle|status]`, or the palette's **Toggle Auto-review**. The TUI reads and changes this state over the plugin RPC contract instead of parsing session text; the slash command keeps its explicit status output.

The plugin handles eligible requests that would otherwise ask for permission. It reviews each request against the task the main conversation is actually working on: your instructions are kept across a compaction, while the tool history before it is dropped so the reviewer carries no backlog the coding model has already shed. Recent actions are kept so a once-only instruction is not replayed, and an earlier tool result can still be retrieved by ID when a decision depends on it. For a boundary that must hold no matter what, use `humanReviewRules` or your own host `deny`/`ask` rules. Its feedback is limited to permission and safety decisions.

The reviewer reads your instructions, so treat the reviewer model as part of the session's trust boundary: pick one you would trust with the session's user text, especially when it is a different provider from the coding model.

By default the plugin never waits for a human: a request the reviewer cannot approve becomes a **denial** whose reason tells the model what was missing, so unattended runs cannot stall. Use `/auto-review fallback on` to prompt instead. An explicit `humanReviewRules` entry always prompts.

## Development

```sh
npm install
npm run check
npm test
```

Optional live verification:

```sh
AUTO_REVIEW_SMOKE_MODEL=provider/model npm run test:smoke
```

See [DESIGN.md](DESIGN.md) for the review architecture and further verification scenarios.

## License

MIT
