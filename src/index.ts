import { Plugin } from "@opencode/plugin"
import { createHash } from "node:crypto"
import { KeyedQueue } from "./keyed-queue.js"
import { captureEvidence } from "./evidence.js"
import { runReviewLoop, type ReviewOutcome } from "./review-loop.js"
import { registerModelOptions, type ReviewerModel } from "./model-options.js"
import { ReviewArchive } from "./review-archive.js"
import { estimateTokens, inputTokenBudget } from "./context-budget.js"
import {
  findHumanReviewReason,
  isEligibleAction,
  parseOptions,
} from "./policy.js"
import { buildReviewRequest } from "./review-input.js"
import { prepareReviewJournal } from "./reviewer-journal.js"
import { AutoReview } from "./rpc.js"
import type { PermissionEvent, ReviewerJournalState, ReviewRequest } from "./types.js"

const FAILURE_MESSAGE = "The request could not be verified for automatic approval."
const REVIEWER_FAILURE_MESSAGE = "Automatic review did not return a complete valid decision. This is not a safety judgment about the requested action. Human confirmation is required."

export default Plugin.define({
  id: "opencode-auto-review",
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    let enabled = options.enabled
    let model: ReviewerModel | undefined
    let modelNotices: string[] = []
    let pendingModel: Promise<{ model: ReviewerModel | undefined; notices: string[] }> | undefined
    const modelController = new AbortController()
    let modelRegistration: { dispose(): Promise<void> } | undefined
    const inFlight = new Map<string, Promise<ReviewOutcome>>()
    const activeControllers = new Map<AbortController, string>()
    const reviewerQueue = new KeyedQueue()
    const reviewerStates = new Map<string, ReviewerJournalState>()
    const archive = new ReviewArchive(ctx.storage, (sessionID, signal) =>
      raceWithAbort(ctx.session.context({ sessionID }, { signal }), signal))
    let disposed = false
    const diagnose = (data: Record<string, string>) => {
      if (options.debug) console.info(`opencode-auto-review ${JSON.stringify(data)}`)
    }

    // The authoritative toggle state is shared with the TUI over RPC. Emitting
    // the state event keeps every client in sync regardless of which code path
    // (slash command or RPC call) performed the change.
    let emitState: (value: boolean) => void = () => undefined
    const setEnabled = (next: boolean): boolean => {
      if (disposed) return enabled
      if (enabled === next) return enabled
      enabled = next
      if (!enabled) for (const controller of activeControllers.keys()) controller.abort()
      emitState(enabled)
      return enabled
    }

    const rpcRegistration = await ctx.rpc.register(AutoReview, {
      status: async () => ({ enabled }),
      setEnabled: async (input) => {
        const requested = (input as { enabled?: unknown } | undefined)?.enabled
        if (typeof requested === "boolean") setEnabled(requested)
        return { enabled }
      },
    })
    emitState = (value) => {
      void rpcRegistration.events.emit("state", { enabled: value }).catch(() => undefined)
    }

    // Reviewer notifications are committed session timeline messages, not
    // transient toasts or bottom pending-inbox items: they scroll with the
    // conversation and stay reviewable. `resume: true` (the default) commits the
    // message; `resume: false` would queue it in the inbox instead.
    //
    // Two field policies matter here, and they differ:
    // - `description` is the only field the TUI paints for a synthetic message
    //   (OpenCode 2.0.4+ renders `message.description` for `type === "synthetic"`),
    //   so it carries all human-readable text.
    // - `text` is assembled into the model's next request as a user message. It is
    //   deliberately empty, and the `context` hook below strips that empty body
    //   from the dispatched request (see `isNoticeBody`). The host does *not* drop
    //   an empty synthetic body on its own: OpenCode 2.0.6 materializes it as a
    //   user message whose only part is empty text, and replays it on every later
    //   turn. Leaving it in place both leaks a review marker into the coding
    //   model's context and, per isolated 2.0.6 probes, can produce a degenerate
    //   zero-token request. A non-empty `text` would be replayed just the same and
    //   is therefore never used.
    //
    // Concurrent identical evaluations share one review (see `reviewRequest`), so
    // they must also share one notice. Keyed by request identity, and cleared when
    // a fresh review starts so a later legitimate review still notifies.
    const notified = new Set<string>()

    const postNotice = (request: string, description: string, sessionID: string): void => {
      if (disposed) return
      if (notified.has(request)) return
      notified.add(request)
      // Bound the marker set; request identities are unique per evaluation and a
      // stale marker only matters until that request is reviewed again.
      if (notified.size > 512) notified.delete(notified.values().next().value!)
      void resolveNoticeSession(sessionID, request)
        .then((target) => {
          if (disposed) return
          return ctx.session.synthetic({
            sessionID: target.sessionID,
            text: "",
            description: target.origin ? `${description} (from ${target.origin})` : description,
            metadata: { request },
            resume: true,
          })
        })
        .catch((error) => diagnose({ action: "notice", request, outcome: "notice_failed", reason: describeError(error) }))
    }

    // Every automatic approval leaves a trace: a silent allow is indistinguishable
    // from no review at all. The notice deliberately carries no reason, so an
    // ordinary approval cannot be mistaken for a considered risk judgement. The
    // permission message keeps whatever rationale the reviewer supplied.
    const notifyApproval = (sessionID: string, action: string, request: string): void => {
      diagnose({ action, request, outcome: "notice_approved" })
      postNotice(request, `Auto-review approved ${action}.`, sessionID)
    }

    const notifyReview = (
      sessionID: string,
      action: string,
      request: string,
      reason: string,
    ): void => {
      const detail = `Auto-review notice (${action}): ${reason.trim()}`
      diagnose({ action, request, outcome: "notice", reason: detail })
      postNotice(request, detail, sessionID)
    }

    // A subagent runs in its own child session, so a notice posted there never
    // reaches the conversation the user is watching. Walk the `parentID` chain
    // (bounded) toward the root session and post there instead, naming the
    // originating session so the notice stays attributable. Successful lookups are
    // cached because the chain is stable for a child session's lifetime; failures
    // are not cached, so a transient lookup error cannot bury every later notice.
    // Any failure falls back to the reviewed session rather than dropping it.
    const noticeTargets = new Map<string, { sessionID: string; origin?: string }>()
    async function resolveNoticeSession(sessionID: string, request: string): Promise<{ sessionID: string; origin?: string }> {
      const cached = noticeTargets.get(sessionID)
      if (cached) return cached
      try {
        // Name the session whose request actually needed review, not the root.
        const reviewed = await ctx.session.get({ sessionID })
        let current = sessionID
        let parentID = reviewed?.parentID
        for (let depth = 0; depth < 8 && typeof parentID === "string" && parentID; depth++) {
          current = parentID
          parentID = (await ctx.session.get({ sessionID: current }))?.parentID
        }
        const target = current === sessionID ? { sessionID } : { sessionID: current, origin: sessionOrigin(reviewed) }
        if (!disposed) {
          noticeTargets.set(sessionID, target)
          if (noticeTargets.size > 256) noticeTargets.delete(noticeTargets.keys().next().value!)
        }
        return target
      } catch (error) {
        diagnose({ action: "notice_route", request, outcome: "failed", reason: describeError(error) })
        return { sessionID }
      }
    }

    function sessionOrigin(session: { agent?: string; title?: string } | undefined): string {
      const agent = typeof session?.agent === "string" && session.agent.trim() ? session.agent.trim() : undefined
      const title = typeof session?.title === "string" && session.title.trim() ? session.title.trim() : undefined
      return [agent ? `${agent} subagent` : "subagent", title ? `"${title}"` : undefined].filter(Boolean).join(" ")
    }

    const commandRegistration = await ctx.command.transform((draft) => {
      draft.add({
        name: "auto-review",
        description: "Usage: /auto-review [on|off|toggle|status] (no argument toggles)",
        execute: async ({ sessionID, prompt, delivery }) => {
          const action = prompt.text.trim().toLowerCase() || "toggle"
          if (action === "on" || action === "enable") setEnabled(true)
          else if (action === "off" || action === "disable") setEnabled(false)
          else if (action === "toggle") setEnabled(!enabled)
          else if (action !== "status") {
            await showStatus(sessionID, delivery, "Usage: /auto-review [on|off|toggle|status]")
            return
          }
          await showStatus(sessionID, delivery, `Auto-review is ${enabled ? "enabled" : "disabled"}.`)
        },
      })
    })

    const promptRegistration = await ctx.session.hook("prompt", (event) => {
      // A new user turn invalidates authorization being assessed for the old one.
      for (const [controller, sessionID] of activeControllers) {
        if (sessionID === event.sessionID) controller.abort()
      }
    })

    // Capture committed originals before model dispatch, including compaction requests.
    //
    // The host replays a committed synthetic body into later model requests as a
    // user message, so every notice is removed again before dispatch (see
    // `isNoticeBody`). The notice stays in the session transcript and is visible
    // to the user; it just never reaches the coding model. The archive reads the
    // session context independently, where a notice is a `synthetic` message
    // rather than a `user` one, so this does not affect authorization.
    const contextRegistration = await ctx.session.hook("context", async (event) => {
      if (disposed) return
      await archive.load(event.sessionID, modelController.signal)
      const messages = event.messages
      if (Array.isArray(messages)) {
        const kept = messages.filter((message) => !isNoticeBody(message))
        if (kept.length !== messages.length) event.messages = kept
      }
    })

    // V2 dispatches checkpoint summaries through the separate compaction hook, so
    // capture the same originals there to keep authorization completeness intact.
    const compactionRegistration = await ctx.session.hook("compaction", async (event) => {
      if (!disposed) await archive.load(event.sessionID, modelController.signal)
    })

    const registration = await ctx.permission.hook("evaluate", async (event) => {
      if (!enabled) return
      if (event.effect !== "ask") return
      if (disposed) return
      if (!event.source || event.source.type !== "tool") return
      if (event.agent === options.agent) return
      if (!isEligibleAction(event.action, options.actions)) return

      const humanReason = findHumanReviewReason(event.action, event.resources, options.humanReviewRules)
      if (humanReason) {
        event.message = `Auto-review requires human confirmation: ${humanReason}`
        diagnose({ action: event.action, outcome: "human_rule" })
        return
      }

      const controller = new AbortController()
      const deadline = Date.now() + options.timeoutMs
      const timer = setTimeout(() => controller.abort(), options.timeoutMs)
      activeControllers.set(controller, event.sessionID)
      const key = requestIdentity(event as PermissionEvent)
      try {
        diagnose({ action: event.action, request: key, outcome: "started" })
        const outcome = await raceWithAbort(reviewRequest(key, event as PermissionEvent, controller.signal, deadline), controller.signal)
        if (disposed || !enabled || controller.signal.aborted) return
        if (Date.now() >= deadline) {
          notifyReview(event.sessionID, event.action, key, "Automatic review reached its deadline")
          askHuman(event as PermissionEvent, "Automatic review reached its deadline")
          return
        }
        diagnose({ action: event.action, request: key, outcome: outcome.code })
        const notices = outcome.notices ?? []
        // Reviewer degradation is surfaced once, in the conversation timeline.
        const degraded = degradationReasons(outcome, notices)
        if (outcome.decision?.decision === "allow") {
          // A degraded approval already gets one notice describing the fallback, so
          // it must not also emit the plain approval notice.
          if (degraded.length) notifyReview(event.sessionID, event.action, key, degraded.join("; "))
          else notifyApproval(event.sessionID, event.action, key)
          event.effect = "allow"
          event.message = withNotices(outcome.decision.reason ? `Auto-review approved: ${outcome.decision.reason}` : `Auto-review approved: ${event.action}.`, notices)
          return
        }
        if (degraded.length) notifyReview(event.sessionID, event.action, key, degraded.join("; "))
        if (outcome.decision?.decision === "deny") denyPolicy(event as PermissionEvent, outcome.decision.reason ?? FAILURE_MESSAGE, notices)
        else askHuman(event as PermissionEvent, outcome.decision?.reason ?? outcome.message ?? REVIEWER_FAILURE_MESSAGE, notices)
      } catch {
        if (!disposed) {
          const aborted = controller.signal.aborted
          diagnose({ action: event.action, outcome: aborted ? "aborted" : "failure" })
          const timedOut = aborted && Date.now() >= deadline
          const message = timedOut ? "Automatic review reached its deadline"
            : aborted ? "Automatic review was cancelled" : REVIEWER_FAILURE_MESSAGE
          if (!aborted || timedOut) notifyReview(event.sessionID, event.action, key, message)
          askHuman(event as PermissionEvent, message)
        }
      } finally {
        activeControllers.delete(controller)
        clearTimeout(timer)
      }
    })

    function reviewRequest(key: string, event: PermissionEvent, signal: AbortSignal, deadline: number): Promise<ReviewOutcome> {
      const existing = inFlight.get(key)
      if (existing) return existing
      // A fresh review for this request identity may notify again; the previous
      // notice for the same identity must not suppress it. Concurrent evaluations
      // of one request still share the single notice, because they join the review
      // created here instead of clearing this marker.
      notified.delete(key)
      const review = reviewerQueue.run(event.sessionID, signal, async (): Promise<ReviewOutcome> => {
        const loaded = await loadReviewRequest(event, signal)
        if (!loaded) return { code: "incomplete_request", message: "Automatic review could not identify the complete tool request" }
        return await generateReview(event.sessionID, loaded.request, loaded.evidence, signal, deadline) ?? {
          code: "review_failure", message: REVIEWER_FAILURE_MESSAGE,
        }
      })
      inFlight.set(key, review)
      void review.finally(() => inFlight.delete(key)).catch(() => undefined)
      return review
    }

    async function generateReview(
      sessionID: string,
      request: ReviewRequest,
      evidence: ReturnType<typeof captureEvidence>,
      signal: AbortSignal,
      deadline: number,
    ): Promise<ReviewOutcome | undefined> {
      const resolved = await raceWithAbort(getModel(), signal)
      if (signal.aborted) return
      const notices = resolved.notices
      if (!resolved.model) {
        return { code: "model_unavailable", message: "Automatic review could not resolve a reviewer model", notices }
      }
      const selectedModel = resolved.model
      const catalog = await raceWithAbort(ctx.model.list({}, { signal }), signal)
      const info = catalog.data.find((item) => item.providerID === selectedModel.providerID && item.id === selectedModel.id)
      const variant = info?.variants.find((item) => item.id === selectedModel.variant)
      const maxInputTokens = inputTokenBudget(info?.limit, { ...info?.body, ...variant?.body })
      if (!maxInputTokens) return { code: "context_limit", message: "Reviewer model has no usable input budget after reserving output tokens", notices }
      const prepared = prepareReviewJournal(
        reviewerStates.get(sessionID),
        request,
        Math.floor(maxInputTokens * 0.75) - estimateTokens(JSON.stringify(evidence.index)),
        options.maxReviewTokens,
      )
      if (!prepared) return { code: "context_limit", message: "The complete tool request is too large for the model input budget", notices }
      const { prompt: _prompt, ...state } = prepared
      const outcome = await runReviewLoop({
        lines: state.lines,
        evidence,
        options,
        maxInputTokens,
        signal,
        deadline,
        generate: (prompt) => generateText(prompt, selectedModel, signal),
        onRound: (round, outcome) => diagnose({ sessionID, round: String(round), outcome }),
      })
      if (!signal.aborted) {
        reviewerStates.delete(sessionID)
        reviewerStates.set(sessionID, { ...state, lines: outcome.lines })
        // Bound retained session state. Eviction rebuilds from source history.
        if (reviewerStates.size > 128) reviewerStates.delete(reviewerStates.keys().next().value!)
      }
      return notices.length ? { ...outcome, notices } : outcome
    }

    async function generateText(
      prompt: string,
      selectedModel: ReviewerModel,
      signal: AbortSignal,
    ): Promise<{ text?: string; timedOut: boolean; error?: string }> {
      try {
        const result = await raceWithAbort(ctx.generate.text(
          { prompt, model: selectedModel },
          { signal },
        ), signal)
        return { text: result.text, timedOut: false }
      } catch (error) {
        return { timedOut: signal.aborted, error: describeError(error) }
      }
    }

    async function getModel(): Promise<{ model: ReviewerModel | undefined; notices: string[] }> {
      if (model) return { model, notices: modelNotices }
      const pending = pendingModel ??= (async () => {
        const notices: string[] = []
        const selected = await resolveModel(ctx, options.agent, options.model, options.timeoutMs, modelController.signal, notices)
        if (!selected || disposed || !options.modelOptions) return { model: selected, notices }
        // Registration verification issues a registry read that the host cannot
        // cancel, so bound it: a read that never settles must not leave the shared
        // `pendingModel` promise unresolved, which would wedge every later review.
        const controller = new AbortController()
        const onParentAbort = () => controller.abort()
        modelController.signal.addEventListener("abort", onParentAbort, { once: true })
        const timer = setTimeout(() => controller.abort(), options.timeoutMs)
        try {
          const registered = await registerModelOptions(ctx.model, selected, options.modelOptions, controller.signal)
          if ("error" in registered) {
            notices.push(registered.error)
            return { model: undefined, notices }
          }
          if (disposed) {
            await registered.dispose()
            return { model: undefined, notices }
          }
          modelRegistration = registered
          return { model: registered.model, notices }
        } finally {
          clearTimeout(timer)
          modelController.signal.removeEventListener("abort", onParentAbort)
        }
      })()
      try {
        const resolved = await pending
        model = resolved.model
        modelNotices = resolved.notices
        return resolved
      } finally {
        pendingModel = undefined
      }
    }

    async function loadReviewRequest(event: PermissionEvent, signal: AbortSignal) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const retained = await raceWithAbort(archive.load(event.sessionID, signal), signal)
        const messages = retained.messages
        if (signal.aborted) return
        const request = buildReviewRequest(messages, event)
        if (request) {
          request.history_truncated = !retained.complete
          return { request, evidence: captureEvidence(messages, event, {
            complete: retained.complete,
            result: (messageID, toolID) => archive.result(event.sessionID, messageID, toolID),
          }) }
        }
        if (attempt < 3) await delay(25 * 2 ** attempt, signal)
      }
    }

    async function showStatus(sessionID: string, delivery: "steer" | "queue", text: string): Promise<void> {
      // `resume: false` would park this in the bottom pending inbox. Commit it to
      // the timeline instead so control feedback also scrolls with the session.
      await ctx.session.synthetic({
        sessionID,
        text,
        description: text,
        delivery,
        resume: true,
      })
    }

    function denyPolicy(event: PermissionEvent, reason: string, notices: readonly string[] = []): void {
      event.effect = "deny"
      event.message = withNotices(denialMessage(reason), notices)
    }

    function askHuman(event: PermissionEvent, reason: string, notices: readonly string[] = []): void {
      event.effect = "ask"
      event.message = withNotices(`Auto-review requires human confirmation: ${reason.trim()}`, notices)
    }

    return async () => {
      disposed = true
      modelController.abort()
      inFlight.clear()
      for (const controller of activeControllers.keys()) controller.abort()
      reviewerQueue.clear()
      reviewerStates.clear()
      noticeTargets.clear()
      notified.clear()
      await registration.dispose()
      await commandRegistration.dispose()
      await promptRegistration.dispose()
      await contextRegistration.dispose()
      await compactionRegistration.dispose()
      await rpcRegistration.dispose()
      await modelRegistration?.dispose()
    }
  },
})

function denialMessage(reason: string): string {
  return `Auto-review denied: ${reason.trim()} Do not retry unchanged or bypass this decision with obfuscation, indirection, shell expansion, or hidden output.`
}

/**
 * The model-facing form of a committed synthetic notice.
 *
 * A notice carries its text in `description` and leaves `text` empty, but the
 * host still replays it into later model requests as a `user` message whose only
 * parts are empty text (verified on OpenCode 2.0.6; the host does not drop an
 * empty synthetic body on its own). The `context` hook removes exactly that
 * shape before dispatch so a review notice never reaches the coding model, while
 * the notice itself stays in the session transcript for the user.
 *
 * Matching on shape rather than a message id also strips notices committed by an
 * earlier plugin instance, which a per-instance id set could not know about.
 * No meaningful message is all-empty text, so this cannot drop real content.
 */
function isNoticeBody(message: { role?: unknown; content?: unknown }): boolean {
  if (message.role !== "user") return false
  const content = message.content
  if (!Array.isArray(content) || content.length === 0) return false
  return content.every((part) => {
    if (typeof part !== "object" || part === null) return false
    const candidate = part as { type?: unknown; text?: unknown }
    if (candidate.type !== "text" && candidate.type !== "input_text") return false
    return (candidate.text ?? "") === ""
  })
}

/** Surface reviewer degradation instead of hiding it behind an otherwise normal decision. */
function withNotices(message: string, notices: readonly string[]): string {
  const unique = [...new Set(notices.map((notice) => notice.trim()).filter(Boolean))]
  return unique.length ? `${message} [auto-review fallback: ${unique.join("; ")}]` : message
}

/** Reasons the reviewer could not reach a verdict on its own, for user-visible surfacing. */
function degradationReasons(outcome: ReviewOutcome, notices: readonly string[]): string[] {
  const reasons = [...notices]
  if (!outcome.decision && outcome.code !== "aborted") {
    reasons.push(outcome.message?.trim() || `automatic review ended without a decision (${outcome.code})`)
  }
  return [...new Set(reasons.map((reason) => reason.trim()).filter(Boolean))]
}

function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  const clean = raw.replace(/\s+/g, " ").trim().slice(0, 300)
  return clean || "unknown error"
}

function requestIdentity(event: PermissionEvent): string {
  return createHash("sha256").update(JSON.stringify([
    event.sessionID,
    event.source?.messageID,
    event.source?.id,
    event.action,
    event.resources,
  ])).digest("hex")
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new Error("automatic review aborted")
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => rejectAbort(new Error("automatic review aborted"))
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("automatic review aborted"))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error("automatic review aborted"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

async function resolveModel(
  ctx: Plugin.Context,
  agentID: string,
  configured: string | undefined,
  timeoutMs: number,
  parentSignal: AbortSignal,
  notices: string[],
): Promise<ReviewerModel | undefined> {
  if (parentSignal.aborted) return
  if (configured) return parseModel(configured)
  const controller = new AbortController()
  const onParentAbort = () => controller.abort()
  parentSignal.addEventListener("abort", onParentAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    try {
      const agent = await raceWithAbort(ctx.agent.get({ agentID }, { signal: controller.signal }), controller.signal)
      if (agent.data.model) {
        notices.push(`no reviewer model configured; using the "${agentID}" agent model ${agent.data.model.providerID}/${agent.data.model.id}`)
        return copyModel(agent.data.model)
      }
    } catch (error) {
      notices.push(`reviewer agent lookup failed: ${describeError(error)}`)
    }
    if (controller.signal.aborted) return
    try {
      const fallback = await raceWithAbort(ctx.model.default({}, { signal: controller.signal }), controller.signal)
      if (fallback.data) {
        notices.push(`no reviewer model configured; using the catalog default model ${fallback.data.providerID}/${fallback.data.id}`)
        return copyModel(fallback.data)
      }
    } catch (error) {
      notices.push(`reviewer default model lookup failed: ${describeError(error)}`)
    }
  } finally {
    clearTimeout(timer)
    parentSignal.removeEventListener("abort", onParentAbort)
  }
}

function parseModel(value: string): ReviewerModel | undefined {
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return
  const providerID = value.slice(0, slash)
  const modelAndVariant = value.slice(slash + 1)
  const hash = modelAndVariant.lastIndexOf("#")
  if (hash < 0) return { providerID, id: modelAndVariant }
  const id = modelAndVariant.slice(0, hash)
  const variant = modelAndVariant.slice(hash + 1)
  if (!id || !variant) return
  return { providerID, id, variant }
}

function copyModel(model: ReviewerModel): ReviewerModel {
  return {
    providerID: model.providerID,
    id: model.id,
    ...(model.variant ? { variant: model.variant } : {}),
  }
}
