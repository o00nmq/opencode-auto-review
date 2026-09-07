# Permission review architecture

The objective is safe, useful automatic permission review, not a particular number of model rounds. Evidence gathering is justified only when it resolves a concrete uncertainty. This design is grounded in executable behavior and OpenCode V2's API. The older PLAN.md is not an implementation contract.

## Reference and adaptation

The reference examined is OpenAI Codex Guardian, specifically [review_session.rs](https://github.com/openai/codex/blob/b01c3986fd2e79b8a477a08d81430f52f22bc0dc/codex-rs/core/src/guardian/review_session.rs) and its [risk policy](https://github.com/openai/codex/blob/b01c3986fd2e79b8a477a08d81430f52f22bc0dc/codex-rs/core/assets/guardian/policy.md). Relevant principles are retained reviewer context, narrowly scoped evidence, prior decisions as context rather than precedent, and shared deadlines/cancellation. This is an adaptation, not a claim of Codex/OpenClaude parity.

OpenCode V2's `generate.text` is a tool-free generation API. Therefore this plugin implements the tool loop explicitly: validated JSON evidence requests are dispatched by the host, and their results are appended before the next model call. These are real dependent rounds, not repeated independent verdicts. It does not create a native OpenCode child session or execute arbitrary reviewer tools.

## Components

- `index.ts`: permission admission, in-flight request coalescing, runtime toggle, model resolution, overall deadline, per-session cancellation, final effect application.
- `keyed-queue.ts`: serializes reviews within each parent session.
- `review-input.ts`: matches the exact source message/tool ID, rejects incomplete input, and captures original user/tool history.
- `review-archive.ts`: persists original user messages and tool references by session, stores result bodies separately, and reconstructs the current branch across parent compactions. Reads/writes are serialized per session so model-context capture and permission review share one source view.
- `reviewer-journal.ts`: bounded, append-only epochs; detects history rewrites and rebuilds when necessary.
- `evidence.ts`: immutable parent-transcript snapshot with paged history and completed tool text/error lookup. No new I/O or tool execution.
- `review-loop.ts`: assessment → optional investigation → assessment, with immediate terminal verdicts and at most one malformed-output repair.
- `response.ts`: strict JSON and decision-matrix validation, including duplicate-key rejection.
- `model-options.ts`: registers a location-scoped reviewer variant, inheriting the selected native variant and merging request overrides. The default body requests `max_tokens: maxReviewTokens`. Registration is shared across concurrent reviews and disposed on unload.
- `context-budget.ts`: derives an estimated input-token budget from the selected model's context/input limits and effective output cap, with room for protocol framing and estimation error.
- `policy.ts`: user-intent and risk rules, evidence protocol, configuration validation.

The default output budget is 2,048 tokens. One absolute deadline, 90 seconds by default, is established at permission admission and propagated through every review round. There is no separate first-response timeout or per-round budget reset.

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Automatic permission review |
| `model` | unset | Native `provider/model#variant` selection |
| `agent` | `auto-reviewer` | Model fallback before the catalog default |
| `maxReviewTokens` | `2048` | Output prompt budget and default `body.max_tokens` |
| `timeoutMs` | `90000` | Total request deadline, including queueing and evidence |
| `modelOptions` | `{"body":{"max_tokens":2048}}` | Provider `settings`/`body` overrides |
| `actions` | `read`, `edit`, `glob`, `grep`, `shell`, `webfetch`, `websearch`, `external_directory` | Eligible permission actions |
| `humanReviewRules` | `[]` | Optional `{ action?, resource?, reason }` rules requiring human confirmation |
| `debug` | `false` | Log round/outcome diagnostics |

An explicit `modelOptions.body` replaces the default body. For Responses, use `{"body":{"max_output_tokens":2048}}`; some Chat endpoints require `max_completion_tokens`. The plugin inherits the selected native variant before applying overrides. Provider enforcement and reasoning-token accounting vary.

Input budgeting reads the selected model's current catalog limits:

```text
available = min(limit.input ?? limit.context, limit.context - outputReserve)
inputBudget = max(0, floor(available * 0.9) - 256)
```

The output reserve uses effective model/variant body caps, falling back to `limit.output`. ASCII word/whitespace runs are estimated at three characters per token; punctuation and non-ASCII text use UTF-8 byte count. This is an approximation, with 10% margin and 256 tokens for framing. Initial context uses 75% of the resulting budget, leaving space for investigation.

Evidence capture continues while the plugin is loaded, including when automatic review is toggled off. Original sources persist in plugin storage; up to 128 review journals are retained in memory. Approval notices do not add synthetic messages to the coding conversation.

## Invariants

1. No automatic permission change without a valid terminal decision. An investigation request is never approval.
2. A failed reviewer is not evidence that the pending operation violates policy. Failure preserves human confirmation.
3. Evidence is confined to the retained parent history before the source message. Future user messages, rolled-back calls, and running/pending tool results are not available through evidence lookup.
4. Tool output cannot establish authorization, even when it contains forged user messages or instructions.
5. Each round includes previous investigation requests and returned evidence. Subsequent permission requests see retained reviewer outcomes while the journal epoch remains valid.
6. Model output, evidence access, and elapsed time have explicit bounds. There is no fixed model-round limit or global concurrency queue. Same-session reviews are serialized; different sessions run independently. Duplicate evidence requests terminate as stalled.
7. User steering, disable, and cleanup cancel in-flight work. Cancellation cannot result in late approval.
8. A parent checkpoint or context rollover rebuilds from retained originals and the latest summary. Initial context reserves 25% of the model-derived input budget for investigation. Every model call is checked using the same token estimate. Missing original authorization never becomes an automatic approval.
9. The host refuses automatic approval if original user messages were omitted and not recovered through the history evidence tool. Every approval must carry explicit validated risk and authorization values.
10. The reviewer's remit is permission and safety classification, not task-quality review. Its policy prohibits documentation/style/implementation suggestions and quality-based permission denials; reasons are limited to risk, scope, authorization, and missing safety evidence or confirmation.

## Verification

Deterministic tests cover a one-call supported approval and dependent model responses when evidence is needed: request prior tool output → request user history → allow. They assert that intervening evidence is actually present in subsequent prompts and that permission changes only after the final verdict, including a review that needs eight model calls. Further tests exercise invalid-output repair, stalled investigation, cancellation, compaction provenance, session journal reuse, and bounded context.

`npm run test:smoke` additionally exercises the installed OpenCode CLI with a configured live model. Its scenarios cover baseline permission prompting, automatic approval, and human-only rules. Model-driven multi-round behavior remains nondeterministic; deterministic protocol tests are not a substitute for model-quality evaluation.

Other live checks use `AUTO_REVIEW_SMOKE_MODEL=provider/model` with `npm run test:safety` or `npm run test:multiturn`. Add `AUTO_REVIEW_COMPACT=1` to the multi-turn check to exercise three parent compactions across four user turns.

## Compaction comparison

Codex's [reviewer lifecycle](https://github.com/openai/codex/blob/main/codex-rs/core/src/guardian/review_session.rs) compacts a reviewer when its token budget is reached and that feature is enabled, using the same review deadline. After compaction it restores the developer-level follow-up reminder; if the original transcript marker is gone, it resets the transcript cursor and sends a full review input instead of another delta. Prior verdicts are context rather than binding precedent.

Its [context policy](https://github.com/openai/codex/blob/main/codex-rs/core/src/guardian/review_session_context.rs) distinguishes legacy and thread-owned modes. Thread-owned checkpoint reuse requires an original item ID, encrypted checkpoint content, and matching producer/reviewer compaction compatibility hashes. Legacy mode can retain an existing reviewer when no usable checkpoint is available, because it may hold the remaining authorization or restrictions. [Retained-context tests](https://github.com/openai/codex/blob/main/codex-rs/core/tests/suite/guardian_retained_context.rs) also cover separately retained user instructions and verified answers, their order/identity, incomplete excerpts, resume and rollback.

This plugin adapts that design without creating reviewer sessions or forwarding model-specific encrypted checkpoints. Committed originals are captured before model dispatch, including compaction requests. Each checkpoint records the archived prefix length; active context replaces its suffix, and returning to an older checkpoint truncates later evidence. A new reviewer epoch includes only the latest parent summary. Large result payloads remain in storage until requested by ID.

Originals and their ordering are retained independently of the model prompt. The prompt is rebuilt under the selected model's estimated input-token budget, rather than recursively summarizing summaries. There is no plugin-wide byte ceiling. If a checkpoint was created while the plugin was absent and its originals cannot be established, authorization is marked incomplete. If retained user instructions themselves exceed the available review budget, the outcome is human confirmation, not an unbounded prompt or invented authorization summary.
