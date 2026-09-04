import { Plugin } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import { ReviewCoordinator } from "./coordinator.js"
import { KeyedQueue } from "./keyed-queue.js"
import {
  buildFastReviewPrompt,
  buildReviewPrompt,
  findHumanReviewReason,
  isEligibleAction,
  parseOptions,
} from "./policy.js"
import { buildReviewRequest } from "./review-input.js"
import { prepareReviewJournal } from "./reviewer-journal.js"
import { parseFastReviewResponse, parseReviewResponse } from "./response.js"
import type { PermissionEvent, ReviewDecision, ReviewerJournalState, ReviewRequest } from "./types.js"

const FAILURE_MESSAGE = "The request could not be verified safely. Retry later or use a safer approach."
const TIMEOUT_MESSAGE = "Automatic review timed out before reaching a decision. This is not a safety judgment about the requested action. Ask the user for explicit approval."
const REVIEWER_FAILURE_MESSAGE = "Automatic review did not return a complete valid decision. This is not a safety judgment about the requested action. Retry the same request once, or ask the user for explicit approval."

interface ReviewOutcome {
  decision?: ReviewDecision
  message?: string
  code?: string
}

interface ReviewerModel {
  id: string
  providerID: string
  variant?: string
}

export default Plugin.define({
  id: "opencode-auto-review",
  tui: true,
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    let enabled = options.enabled
    let model: ReviewerModel | undefined
    let pendingModel: Promise<ReviewerModel | undefined> | undefined
    const modelController = new AbortController()
    const coordinator = new ReviewCoordinator<ReviewOutcome>(options.maxConcurrentReviews, options.maxQueuedReviews)
    const activeControllers = new Set<AbortController>()
    const reviewerQueue = new KeyedQueue()
    const reviewerStates = new Map<string, ReviewerJournalState>()
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
          await showStatus(sessionID, delivery, `Auto-review is ${enabled ? "enabled" : "disabled"}.`)
        },
      })
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
        denyPolicy(event as PermissionEvent, humanReason)
        diagnose({ action: event.action, outcome: "human_rule" })
        return
      }

      const controller = new AbortController()
      activeControllers.add(controller)
      try {
        const key = requestIdentity(event as PermissionEvent)
        diagnose({ action: event.action, request: key, outcome: "started" })
        const outcome = await raceWithAbort(coordinator.run(key, controller.signal, async () => {
          const request = await loadReviewRequest(event as PermissionEvent, controller.signal)
          if (!request) return {
            message: "Automatic review could not identify the complete tool request",
            code: "incomplete_request",
          }
          if (controller.signal.aborted) return { code: "timeout" }

          const decision = await reviewerQueue.run(event.sessionID, controller.signal, async () =>
            generateReview(event.sessionID, request, controller.signal))
          if (decision === "oversized") {
            return { message: "The complete tool request is too large for automatic review", code: "oversized" }
          }
          if (decision === "ask") return { code: "ask" }
          if (decision === "timeout") return { message: TIMEOUT_MESSAGE, code: "timeout" }
          return decision ? { decision, code: decision.decision } : {
            message: REVIEWER_FAILURE_MESSAGE,
            code: "review_failure",
          }
        }), controller.signal)
        if (disposed) return
        diagnose({ action: event.action, request: key, outcome: outcome?.code ?? "queue_unavailable" })
        if (outcome?.decision?.decision === "allow") {
          event.effect = "allow"
          const notice = outcome.decision.authorization === "medium"
            ? reviewMessage("approved", outcome.decision.reason!)
            : `Auto-review approved: ${event.action}.`
          try {
            await showStatus(event.sessionID, "steer", notice)
          } catch {
            diagnose({ action: event.action, outcome: "approval_notice_failure" })
          }
          return
        }
        if (outcome?.code === "ask") return
        if (outcome?.decision) denyPolicy(event as PermissionEvent, outcome.decision.reason ?? FAILURE_MESSAGE)
        else denyOperational(event as PermissionEvent, outcome?.message ?? FAILURE_MESSAGE)
      } catch {
        if (!disposed) {
          diagnose({ action: event.action, outcome: controller.signal.aborted ? "aborted" : "failure" })
          denyOperational(event as PermissionEvent, REVIEWER_FAILURE_MESSAGE)
        }
      } finally {
        activeControllers.delete(controller)
      }
    })

    async function generateReview(
      sessionID: string,
      request: ReviewRequest,
      signal: AbortSignal,
    ): Promise<ReviewDecision | "oversized" | "timeout" | "ask" | undefined> {
      const selectedModel = await getModel()
      if (!selectedModel || signal.aborted) return
      const prepared = prepareReviewJournal(
        reviewerStates.get(sessionID),
        request,
        options.maxReviewBytes,
        options.maxReviewTokens,
      )
      if (!prepared) return "oversized"
      const { prompt: _prompt, ...state } = prepared
      reviewerStates.set(sessionID, state)
      try {
        const fast = await generateStage(
          buildFastReviewPrompt(state.lines),
          selectedModel,
          options.fastTimeoutMs,
          signal,
        )
        if (signal.aborted) return
        if (parseFastReviewResponse(fast.text ?? "") === "allow") {
          return {
            decision: "allow",
            risk: "low",
            authorization: "high",
            matched_rules: ["fast-screen"],
          }
        }
        const full = await generateStage(
          buildReviewPrompt(state.lines, options.maxReviewTokens),
          selectedModel,
          options.timeoutMs,
          signal,
        )
        if (signal.aborted) return
        if (full.timedOut) return fast.timedOut ? "ask" : "timeout"
        return parseReviewResponse(full.text ?? "")
      } catch {
        return
      }
    }

    async function generateStage(
      prompt: string,
      selectedModel: ReviewerModel,
      timeoutMs: number,
      parentSignal: AbortSignal,
    ): Promise<{ text?: string; timedOut: boolean }> {
      if (parentSignal.aborted) return { timedOut: false }
      const controller = new AbortController()
      let timedOut = false
      const onParentAbort = () => controller.abort()
      parentSignal.addEventListener("abort", onParentAbort, { once: true })
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
      try {
        const result = await raceWithAbort(ctx.generate.text(
          { prompt, model: selectedModel },
          { signal: controller.signal },
        ), controller.signal)
        return { text: result.text, timedOut: false }
      } catch {
        return { timedOut }
      } finally {
        clearTimeout(timer)
        parentSignal.removeEventListener("abort", onParentAbort)
      }
    }

    async function getModel(): Promise<ReviewerModel | undefined> {
      if (model) return model
      pendingModel ??= resolveModel(ctx, options.agent, options.model, options.timeoutMs, modelController.signal)
      try {
        model = await pendingModel
        return model
      } finally {
        pendingModel = undefined
      }
    }

    async function loadReviewRequest(event: PermissionEvent, signal: AbortSignal): Promise<ReviewRequest | undefined> {
      for (let attempt = 0; attempt < 4; attempt++) {
        const messages = await ctx.session.context({ sessionID: event.sessionID }, { signal })
        if (signal.aborted) return
        const request = buildReviewRequest(messages, event)
        if (request) return request
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

    function denyOperational(event: PermissionEvent, reason: string): void {
      event.effect = "deny"
      event.message = `Auto-review unavailable: ${reason.trim()}`
    }

    return async () => {
      disposed = true
      modelController.abort()
      coordinator.dispose()
      for (const controller of activeControllers) controller.abort()
      reviewerQueue.clear()
      reviewerStates.clear()
      await registration.dispose()
      await commandRegistration.dispose()
    }
  },
})

function reviewMessage(outcome: "approved", reason: string): string {
  return `Auto-review ${outcome}: ${reason.trim()}`
}

function denialMessage(reason: string): string {
  return `Auto-review denied: ${reason.trim()} Do not retry unchanged or bypass this decision with obfuscation, indirection, shell expansion, or hidden output; use a materially safer approach.`
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
