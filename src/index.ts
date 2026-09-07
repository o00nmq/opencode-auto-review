import { Plugin } from "@opencode-ai/plugin"
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
import type { PermissionEvent, ReviewerJournalState, ReviewRequest } from "./types.js"

const FAILURE_MESSAGE = "The request could not be verified for automatic approval."
const REVIEWER_FAILURE_MESSAGE = "Automatic review did not return a complete valid decision. This is not a safety judgment about the requested action. Human confirmation is required."

export default Plugin.define({
  id: "opencode-auto-review",
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    let enabled = options.enabled
    let model: ReviewerModel | undefined
    let pendingModel: Promise<ReviewerModel | undefined> | undefined
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

    const commandRegistration = await ctx.command.transform((draft) => {
      draft.add({
        name: "auto-review",
        description: "Usage: /auto-review [on|off|toggle|status] (no argument toggles)",
        execute: async ({ sessionID, prompt, delivery }) => {
          const action = prompt.text.trim().toLowerCase() || "toggle"
          if (action === "on" || action === "enable") enabled = true
          else if (action === "off" || action === "disable") enabled = false
          else if (action === "toggle") enabled = !enabled
          else if (action !== "status") {
            await showStatus(sessionID, delivery, "Usage: /auto-review [on|off|toggle|status]")
            return
          }
          if (!enabled) for (const controller of activeControllers.keys()) controller.abort()
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
    const contextRegistration = await ctx.session.hook("context", async (event) => {
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
      try {
        const key = requestIdentity(event as PermissionEvent)
        diagnose({ action: event.action, request: key, outcome: "started" })
        const outcome = await raceWithAbort(reviewRequest(key, event as PermissionEvent, controller.signal, deadline), controller.signal)
        if (disposed || !enabled || controller.signal.aborted) return
        if (Date.now() >= deadline) {
          askHuman(event as PermissionEvent, "Automatic review reached its deadline")
          return
        }
        diagnose({ action: event.action, request: key, outcome: outcome.code })
        if (outcome.decision?.decision === "allow") {
          event.effect = "allow"
          event.message = outcome.decision.reason ? `Auto-review approved: ${outcome.decision.reason}` : `Auto-review approved: ${event.action}.`
          return
        }
        if (outcome.decision?.decision === "deny") denyPolicy(event as PermissionEvent, outcome.decision.reason ?? FAILURE_MESSAGE)
        else askHuman(event as PermissionEvent, outcome.decision?.reason ?? outcome.message ?? REVIEWER_FAILURE_MESSAGE)
      } catch {
        if (!disposed) {
          diagnose({ action: event.action, outcome: controller.signal.aborted ? "aborted" : "failure" })
          askHuman(event as PermissionEvent, controller.signal.aborted ? "Automatic review was cancelled or reached its deadline" : REVIEWER_FAILURE_MESSAGE)
        }
      } finally {
        activeControllers.delete(controller)
        clearTimeout(timer)
      }
    })

    function reviewRequest(key: string, event: PermissionEvent, signal: AbortSignal, deadline: number): Promise<ReviewOutcome> {
      const existing = inFlight.get(key)
      if (existing) return existing
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
      const selectedModel = await raceWithAbort(getModel(), signal)
      if (!selectedModel || signal.aborted) return
      const catalog = await raceWithAbort(ctx.catalog.model.list({}, { signal }), signal)
      const info = catalog.data.find((item) => item.providerID === selectedModel.providerID && item.id === selectedModel.id)
      const variant = info?.variants.find((item) => item.id === selectedModel.variant)
      const maxInputTokens = inputTokenBudget(info?.limit, { ...info?.body, ...variant?.body })
      if (!maxInputTokens) return { code: "context_limit", message: "Reviewer model has no usable input budget after reserving output tokens" }
      const prepared = prepareReviewJournal(
        reviewerStates.get(sessionID),
        request,
        Math.floor(maxInputTokens * 0.75) - estimateTokens(JSON.stringify(evidence.index)),
        options.maxReviewTokens,
      )
      if (!prepared) return { code: "context_limit", message: "The complete tool request is too large for the model input budget" }
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
      return outcome
    }

    async function generateText(
      prompt: string,
      selectedModel: ReviewerModel,
      signal: AbortSignal,
    ): Promise<{ text?: string; timedOut: boolean }> {
      try {
        const result = await raceWithAbort(ctx.generate.text(
          { prompt, model: selectedModel },
          { signal },
        ), signal)
        return { text: result.text, timedOut: false }
      } catch {
        return { timedOut: signal.aborted }
      }
    }

    async function getModel(): Promise<ReviewerModel | undefined> {
      if (model) return model
      pendingModel ??= (async () => {
        const selected = await resolveModel(ctx, options.agent, options.model, options.timeoutMs, modelController.signal)
        if (!selected || disposed || !options.modelOptions) return selected
        const registered = await registerModelOptions(ctx.catalog, selected, options.modelOptions)
        if (disposed) {
          await registered.dispose()
          return
        }
        modelRegistration = registered
        return registered.model
      })()
      try {
        model = await pendingModel
        return model
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
      await ctx.session.synthetic({
        sessionID,
        text,
        description: text,
        delivery,
        resume: false,
      })
    }

    function denyPolicy(event: PermissionEvent, reason: string): void {
      event.effect = "deny"
      event.message = denialMessage(reason)
    }

    function askHuman(event: PermissionEvent, reason: string): void {
      event.effect = "ask"
      event.message = `Auto-review requires human confirmation: ${reason.trim()}`
    }

    return async () => {
      disposed = true
      modelController.abort()
      inFlight.clear()
      for (const controller of activeControllers.keys()) controller.abort()
      reviewerQueue.clear()
      reviewerStates.clear()
      await registration.dispose()
      await commandRegistration.dispose()
      await promptRegistration.dispose()
      await contextRegistration.dispose()
      await modelRegistration?.dispose()
    }
  },
})

function denialMessage(reason: string): string {
  return `Auto-review denied: ${reason.trim()} Do not retry unchanged or bypass this decision with obfuscation, indirection, shell expansion, or hidden output.`
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
      if (agent.data.model) return copyModel(agent.data.model)
    } catch {}
    if (controller.signal.aborted) return
    try {
      const fallback = await raceWithAbort(ctx.catalog.model.default({}, { signal: controller.signal }), controller.signal)
      if (fallback.data) return copyModel(fallback.data)
    } catch {}
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
