# OpenCode Auto Review

Automatically reviews **OpenCode V2** permission prompts for long-running unattended work. Authorized operations with low or medium bounded risk proceed automatically; unsafe operations are denied; decision-critical uncertainty or explicit confirmation requirements go to you.

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

The model is optional: the plugin falls back to the `auto-reviewer` agent's model, then OpenCode's default. Reviewer fallbacks, model-registration failures, exhausted provider errors, and timeouts are shown as messages in the conversation timeline: they scroll with the session and can be reviewed later. They are never queued in the bottom pending inbox, and they do not change the permission decision.

Automatic review is enabled by default, with **2,048 output tokens** and **90 seconds total per request**. Change these with `maxReviewTokens` and `timeoutMs`. The default output parameter targets Chat Completions; see [advanced configuration](DESIGN.md#configuration) for other APIs and human-only rules.

## Usage

Use `/auto-review on`, `/auto-review off`, `/auto-review toggle`, or `/auto-review status`. The command palette also provides **Toggle Auto-review**. The TUI reads and changes this state over the plugin RPC contract instead of parsing session text; the slash command keeps its explicit status output.

The plugin handles eligible requests that would otherwise ask for permission. It can consult earlier user instructions and tool results when needed, including after the main conversation is compacted. Its feedback is limited to permission and safety decisions.

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
