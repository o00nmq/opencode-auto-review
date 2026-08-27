# OpenCode Auto Review

Automatically reviews selected OpenCode V2 permission prompts. Safe requests can proceed without a human prompt; unsafe or unverifiable requests are denied.

This plugin is not a sandbox. Keep appropriate OpenCode permissions and system isolation in place.

## Install

Install the plugin globally:

```sh
opencode2 plugin add opencode-auto-review
```

To select a reviewer model or change other options, edit the plugin entry in `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-auto-review",
      "options": {
        "model": "provider/model"
      }
    }
  ]
}
```

The `model` option is optional. Without it, the plugin uses the `auto-reviewer` agent model or the current OpenCode default model.

Options and defaults:

- `enabled`: `true`
- `agent`: `"auto-reviewer"`
- `model`: unset; uses the agent model or current OpenCode default model
- `timeoutMs`: `30000`
- `maxReviewBytes`: `65536`
- `maxConcurrentReviews`: `3`
- `maxQueuedReviews`: `32`
- `actions`: `["read", "edit", "glob", "grep", "shell", "webfetch", "websearch", "external_directory"]`
- `humanReviewRules`: `[]`
- `debug`: `false`

## Usage

Use `/auto-review on`, `/auto-review off`, `/auto-review toggle`, or `/auto-review status`. The TUI also provides **Toggle Auto-review** in the command palette and displays `Auto Mode` while enabled.

The plugin reviews only eligible tool requests whose current permission effect is `ask`. Existing `allow` and `deny` rules are not overridden. Invalid input, unsafe decisions, timeouts, and provider failures are denied. Review requests contain bounded user and tool-call context and exclude assistant reasoning, tool results, attachments, skills, and synthetic messages.

## Development

```sh
npm install
npm run check
npm test
```

Run an optional live test with:

```sh
AUTO_REVIEW_SMOKE_MODEL=provider/model npm run test:smoke
```

## License

MIT
