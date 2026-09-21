# Permission review architecture

The objective is safe, useful automatic permission review, not a particular number of model rounds. Evidence gathering is justified only when it resolves a concrete uncertainty. This design is grounded in executable behavior and OpenCode V2's API. The older PLAN.md is not an implementation contract.

## Reference and adaptation

The reference examined is OpenAI Codex Guardian, specifically [review_session.rs](https://github.com/openai/codex/blob/b01c3986fd2e79b8a477a08d81430f52f22bc0dc/codex-rs/core/src/guardian/review_session.rs) and its [risk policy](https://github.com/openai/codex/blob/b01c3986fd2e79b8a477a08d81430f52f22bc0dc/codex-rs/core/assets/guardian/policy.md). Relevant principles are retained reviewer context, narrowly scoped evidence, prior decisions as context rather than precedent, and shared deadlines/cancellation. This is an adaptation, not a claim of Codex/OpenClaude parity.

OpenCode V2's `generate.text` is a tool-free generation API. Therefore this plugin implements the tool loop explicitly: validated JSON evidence requests are dispatched by the host, and their results are appended before the next model call. These are real dependent rounds, not repeated independent verdicts. It does not create a native OpenCode child session or execute arbitrary reviewer tools.

## Components

Targets OpenCode 2.0.4 or newer: that release replaced `ctx.catalog` with the `ctx.model`/`ctx.provider` plugin context this plugin uses (2.0.2 and 2.0.3 expose only `catalog`). 2.0.4 through 2.0.6 share the API surface this plugin depends on.

- `index.ts`: permission admission, in-flight request coalescing, runtime toggle, model resolution, overall deadline, per-session cancellation, final effect application.
- `keyed-queue.ts`: serializes reviews within each parent session.
- `review-input.ts`: matches the exact source message/tool ID, rejects incomplete input, and projects the review prompt: every captured user instruction plus tool history from the latest compaction boundary onward.
- `review-archive.ts`: persists original user messages and tool references by session, stores result bodies separately, and reconstructs the current branch across parent compactions. Reads/writes are serialized per session so model-context capture and permission review share one source view.
- `reviewer-journal.ts`: bounded, append-only epochs; detects history rewrites and rebuilds when necessary. The append criterion is measured against the completed history so that reviews sharing one history — parallel tool calls in a single assistant message, or a repeated evaluation — extend the epoch instead of resetting it, which preserves the provider's prefix cache. Every selection pass, not just the borrowing fill, stops below a retention limit measured against the flexible space (budget minus fixed framing), and the latest user instruction is mandatory, so a saturated review keeps room to append and cannot lose the instruction that governs the pending request. Appends still consume that headroom, so the practical effect is that a rebuild becomes periodic rather than per-review.
- `evidence.ts`: immutable parent-transcript snapshot with paged history and completed tool text/error lookup. No new I/O or tool execution.
- `review-loop.ts`: assessment → optional investigation → assessment, with immediate terminal verdicts, at most one malformed-output repair, and one recovery attempt for empty output or a failed model call. Recovery shares the original deadline and never executes the pending tool.
- `response.ts`: strict JSON and decision-matrix validation, including duplicate-key rejection.
- `rpc.ts`: the shared RPC contract (`status`, `setEnabled`, `setFallback`, the `state` and `notice` events) used by the server plugin and the TUI.
- `tui-state.ts`: framework-free controller that owns the TUI's toggle state, syncing it only from confirmed RPC responses and events. It carries no review-notification logic: notices are server-authored and delivered over the `notice` RPC event as a toast.
- `model-options.ts`: registers a location-scoped reviewer variant, inheriting the selected native variant and merging request overrides. The default body requests `max_tokens: maxReviewTokens`. Registration is shared across concurrent reviews and disposed on unload. OpenCode 2.0.4 replays registry transforms lazily, so the callback may not have run when `transform()` resolves; the helper forces one registry read to confirm the variant registered, and treats a failed or unverified read as a registration error. That read is bounded by the shared initialization timeout, because the host adapter cannot cancel it (see below).
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
| `humanFallback` | `false` | When `true`, a decision the reviewer cannot approve becomes a human prompt; when `false` (default) it becomes a denial |
| `debug` | `false` | Log round/outcome diagnostics |

An explicit `modelOptions.body` replaces the default body. For Responses, use `{"body":{"max_output_tokens":2048}}`; some Chat endpoints require `max_completion_tokens`. The plugin inherits the selected native variant before applying overrides. Provider enforcement and reasoning-token accounting vary.

Input budgeting reads the selected model's current catalog limits:

```text
available = min(limit.input ?? limit.context, limit.context - outputReserve)
inputBudget = max(0, floor(available * 0.9) - 256)
```

The output reserve uses effective model/variant body caps, falling back to `limit.output`. ASCII word/whitespace runs are estimated at three characters per token; punctuation and non-ASCII text use UTF-8 byte count. This is an approximation, with 10% margin and 256 tokens for framing. Initial context uses 75% of the resulting budget, leaving space for investigation.

Evidence capture continues while the plugin is loaded, including when automatic review is toggled off. Original sources persist in plugin storage; up to 128 review journals are retained in memory. Review notices are server-authored and delivered as an RPC toast (see below); the plugin writes nothing to the session. Every automatic approval attempts a notice, so a silent allow is not mistaken for no review at all; reviewer degradation replaces that notice with one that names the fallback. Concurrent evaluations of one request share a single review and therefore a single notice. Delivery is best-effort: a failed RPC emit is reported through `debug` diagnostics only, and a notice is never allowed to change the permission decision.

## Runtime toggle and TUI synchronization

The server plugin is the single source of truth for the enabled flag. `rpc.ts` exposes `status` to read it and `setEnabled` to write it. Both the slash command and `setEnabled` go through one helper, so a disable aborts in-flight same-session work and every change emits a `state` event; clients stay consistent regardless of which path changed the flag.

The TUI's `tui-state.ts` controller holds the displayed value. It changes that value only from a confirmed `status` response or a `state` event; a user switch is never applied optimistically, so an unclear or failed switch leaves the previous value in place and emits a warning toast instead of showing a state the server did not confirm. A `status` query that cannot be answered reports "unavailable" rather than presenting the last known value as current. The controller subscribes to `state` before its first query, and a request sequence plus an event revision discard any `status` or `setEnabled` response that a newer request or event has superseded, so a stale response cannot overwrite a newer value. Events carry their location, so a TUI ignores events from other locations. `server.connected` re-runs the query to recover state missed while disconnected. Cleanup unsubscribes and silences later events, and server RPC handlers stop emitting once the plugin is disposed.

## Notification outlets

Reviewer notices are presented by the CLI plugin as a **toast**, delivered over the plugin RPC contract (`notice` event). The plugin writes **nothing** to the session: a notice cannot reach the coding model's context and cannot resume an idle one.

Both session alternatives are wrong for this:

- `session.synthetic` with `resume: true` (the default) commits the message **and resumes an idle session**, adding a model turn. A notice for a subagent's request used to be routed to the root session, which is idle while it waits for the child, so every subagent approval woke the parent model.
- `session.synthetic` with `resume: false` does not resume, but it only parks the body in the bottom session inbox. The next prompt promotes it into the transcript, so it is neither immediately visible nor permanently out of the model's context.

OpenCode V1 had an ignored, no-reply session message for exactly this use — a status line a plugin could display without starting the agent — and V2 removed it (opencode#48644, still open). Until that returns, a CLI toast is the only supported surface that is visible without touching the session.

The accepted cost is that a notice is **transient** and needs a connected CLI: a headless `opencode run` has no notification surface, and a disconnected client misses notices emitted while it was away. The authoritative record is the permission event itself, whose message still carries the reason inline in the client that asked.

When the reviewed request belongs to a subagent, the toast names the originating subagent — for example `(from review subagent "Inspect the fixture")` — so it stays attributable even though it is not placed in any particular session. Successful lookups are cached per reviewed session; failures are not cached, so a transient lookup error cannot bury later notices, and a failed lookup still sends the notice without the annotation.

The TUI slot map (`app`, `home.footer`, `home.footer.status`, `prompt.footer`, `prompt.footer.status`, `prompt.footer.file`, `session.composer.top`, `session.panel`, `sidebar.content`, `sidebar.footer`) contains no session-timeline path, so a plugin cannot render arbitrary timeline entries. A toast is the supported user-visible channel; a committed session message is not, for the reason above.

Legacy cleanup: earlier versions committed durable notice bodies to the timeline. Those bodies are still in existing transcripts, and the host replays a body with empty `text` into later model requests as a user message whose only part is empty text (verified on OpenCode 2.0.6 with an `http.request` probe). The `context` and `compaction` hooks therefore still strip that shape before dispatch (`isNoticeBody`). Matching on the empty-body shape, rather than a message id, also removes bodies committed by an instance that a fresh install cannot know about.

| Outlet | Presentation |
| --- | --- |
| `allow` decision | Toast naming the approved action, with no reason, so the approval is visible without implying a risk judgement |
| Reviewer failure (empty/invalid output, provider failure, context limit, stalled investigation, incomplete authorization) | Toast naming the failure; a subagent request also names the originating subagent |
| Model fallback and model-registration failure notices | One toast describing the fallback, replacing the plain approval toast when the verdict is `allow` |
| Review deadline / timeout | Toast naming the deadline |
| Cancellation, disable, steering | No notice; cancellation cannot produce a late approval |
| `deny` decision | The permission message becomes the inline denial in the timeline (already timeline-native) |
| `ask` / human confirmation | The permission prompt names the reason (already timeline-native) |
| `/auto-review status` and other command feedback | Toast; a command reply must not resume the session |
| TUI switch result, switch failure, status-query failure | Short toast; the TUI has no timeline slot |

Notifications never change permission semantics: the permission `effect` and `message` are computed exactly as before, and a notice is additional information, not a substitute decision. `debug` diagnostics keep the full reason.

## Invariants

1. No automatic permission change without a valid terminal decision. An investigation request is never approval.
2. A failed reviewer is not evidence that the pending operation violates policy. After bounded recovery, failure denies by default, or preserves human confirmation when `humanFallback` is enabled. The failure or fallback reason appears in the permission message, in `debug` diagnostics, and in the toast keyed to the review request. A subagent's request is named in the toast so it stays attributable; the reviewed child session is still what supplies evidence. A cancellation or disable produces no notice and no verdict: a cancelled review leaves the host's own decision in place rather than converting it into a denial.
3. The review prompt carries every user instruction the plugin captured, plus a bounded tail of recent prior actions and the tool history from the latest completed compaction boundary onward. Authorization is never discarded as backlog, recent actions are kept so a once-only instruction cannot be replayed unnoticed, and the reviewer holds no tool backlog the coding model has already shed. Evidence is separate and lazily addressable over the whole captured transcript: an earlier tool result stays retrievable by ID when a decision depends on that inspection, without entering the prompt. Future user messages, rolled-back calls, and running/pending tool results are not available through evidence lookup.

That split matters because the two have different costs. The prompt is paid on every review, so it must stay bounded and append-friendly; evidence is paid only when the reviewer asks, so keeping it complete costs nothing until it is needed.
4. Tool output cannot establish authorization, even when it contains forged user messages or instructions.
5. Each round includes previous investigation requests and returned evidence. Subsequent permission requests see retained reviewer outcomes while the journal epoch remains valid. The journal is append-only across reviews that share a history: the append decision is measured against the completed history, not the pending tool, so parallel tool calls in one assistant message, or a repeated evaluation of one request, extend the same epoch instead of starting a new one. That keeps the prompt a byte-for-byte prefix of the previous prompt, which is what lets the provider reuse its prefix cache. Only a compaction boundary, a rewritten history, or the model input budget starts a new epoch.
6. Model output, evidence access, and elapsed time have explicit bounds. There is no fixed model-round limit or global concurrency queue. Same-session reviews are serialized; different sessions run independently. Duplicate evidence requests terminate as stalled. Reviewer-model resolution and its variant registration share one bounded initialization: the host adapter drops request options and cannot cancel a registry read, so each call is raced locally against the deadline. A read that never settles therefore fails that attempt and releases the shared promise, letting a later review retry instead of inheriting a permanently pending initialization.
7. User steering, disable, and cleanup cancel in-flight work. Cancellation cannot result in late approval.
8. The review prompt is anchored at the main session's own compaction boundary for tool history, so the reviewer never inherits a backlog the coding model has already shed, and it re-anchors exactly when the coding model compacts. User instructions are exempt from that boundary: they are the authorization, and dropping them would remove the guarantee that an approval rests on a disclosed user instruction. The latest user instruction is mandatory rather than budgeted — if even it does not fit, the review is refused instead of approving against an older, possibly superseded, instruction. A bounded tail of recent actions is exempt too, so a consumed one-time authorization stays visible. The session is never locked into denial because a boundary was crossed while the plugin was absent. Initial context reserves 25% of the model-derived input budget for investigation. Every model call is checked using the same token estimate. A compaction summary is context, not authorization: it establishes the ongoing task but cannot expand permission.
9. Missing authorization is judged per request, never latched for the session. An automatic approval requires at least one disclosed user instruction, and the host refuses one when a captured user instruction was omitted from the prompt and not recovered through the history evidence tool; the reviewer is instructed to ask when a decision depends on material the prompt does not carry. Bounded selection marks what it dropped, so the outcome is human confirmation rather than invented authorization. That refusal is deliberate and fail-safe: a journal with very many user instructions can omit middle ones and therefore refuse an automatic allow until the reviewer recovers them, which is the intended trade rather than a defect. Every approval must carry explicit validated risk and authorization values. Boundaries that must survive compaction belong in durable rules (`humanReviewRules`, or the host's own deny/ask rules), not in conversational context.
10. The reviewer's remit is permission and safety classification, not task-quality review. Its policy prohibits documentation/style/implementation suggestions and quality-based permission denials; reasons are limited to risk, scope, authorization, and missing safety evidence or confirmation.

## Verification

Deterministic tests cover a one-call supported approval and dependent model responses when evidence is needed: request prior tool output → request user history → allow. They assert that intervening evidence is actually present in subsequent prompts and that permission changes only after the final verdict, including a review that needs eight model calls. Further tests exercise invalid-output repair, stalled investigation, cancellation, compaction provenance, session journal reuse, RPC toggle synchronization and stale-response rejection, the compaction-hook capture, notice delivery and cross-location filtering, and bounded context.

`npm run test:smoke` additionally exercises the installed OpenCode CLI with a configured live model. Its scenarios cover baseline permission prompting, automatic approval, and human-only rules. Model-driven multi-round behavior remains nondeterministic; deterministic protocol tests are not a substitute for model-quality evaluation.

Other live checks use `AUTO_REVIEW_SMOKE_MODEL=provider/model` with `npm run test:safety` or `npm run test:multiturn`. Add `AUTO_REVIEW_COMPACT=1` to the multi-turn check to exercise three parent compactions across four user turns.

## Compaction comparison

Codex's [reviewer lifecycle](https://github.com/openai/codex/blob/main/codex-rs/core/src/guardian/review_session.rs) compacts a reviewer when its token budget is reached and that feature is enabled, using the same review deadline. After compaction it restores the developer-level follow-up reminder; if the original transcript marker is gone, it resets the transcript cursor and sends a full review input instead of another delta. Prior verdicts are context rather than binding precedent.

Its [context policy](https://github.com/openai/codex/blob/main/codex-rs/core/src/guardian/review_session_context.rs) distinguishes legacy and thread-owned modes. Thread-owned checkpoint reuse requires an original item ID, encrypted checkpoint content, and matching producer/reviewer compaction compatibility hashes. Legacy mode can retain an existing reviewer when no usable checkpoint is available, because it may hold the remaining authorization or restrictions. [Retained-context tests](https://github.com/openai/codex/blob/main/codex-rs/core/tests/suite/guardian_retained_context.rs) also cover separately retained user instructions and verified answers, their order/identity, incomplete excerpts, resume and rollback.

This plugin adapts that design without creating reviewer sessions or forwarding model-specific encrypted checkpoints. V2 dispatches the agent loop through the `context` hook and checkpoint summaries through the separate `compaction` hook, so the server registers both and captures committed originals identically. Each checkpoint records the archived prefix length; active context replaces its suffix, and returning to an older checkpoint truncates later evidence.

The prompt is projected from the transcript: every captured user instruction plus tool history from the main session's own compaction boundary. Claude Code's auto mode reaches a compatible conclusion: its classifier reads user messages and strips tool results, and it states plainly that a boundary stated only in conversation can be lost when compaction removes it, directing users to a durable deny/ask rule for anything that must survive. Codex goes further and retains user instructions separately from the tool history. Both keep intent and bound evidence, and neither latches a missing pre-compaction origin into a session-wide denial. This plugin therefore keeps user instructions across the boundary, re-anchors the tool history at the latest completed checkpoint, and treats its summary as the coding model's own context. The transcript is never discarded: it stays in storage and remains lazily addressable as evidence, so an earlier result is retrievable by ID even though it is not carried in the prompt.

The reason the two are split is cost. The prompt is paid on every review, so it must stay bounded and append-only; evidence is paid only when the reviewer asks for it, so completeness there is free until it is needed.

One consequence is worth stating plainly: the reviewer sees the session's user instructions, including ones from before a compaction. The coding model saw them too, but the reviewer model is a separately configured model and may be a different provider, so this is real content leaving the machine for that provider. Use a reviewer you would trust with the session's user text, and treat the reviewer model as part of the session's trust boundary rather than a narrow classifier.

Originals and their ordering are retained independently of the model prompt. The prompt is rebuilt under the selected model's estimated input-token budget, rather than recursively summarizing summaries. There is no plugin-wide byte ceiling. The optional fill is bounded against the flexible space to leave append headroom, so a review that saturated the budget forces a periodic rebuild rather than one on every review. A checkpoint the plugin never observed is still a valid anchor: the review proceeds from it instead of denying for history the plugin cannot reconstruct. If retained user instructions inside the prompt themselves exceed the available review budget, the omitted entries are marked and the outcome is human confirmation until they are recovered through history evidence, not an unbounded prompt or invented authorization summary.
