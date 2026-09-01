import { Plugin } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import { ReviewCoordinator } from "./coordinator.js"
import { KeyedQueue } from "./keyed-queue.js"
import {
  findHumanReviewReason,
  isEligibleAction,
  parseOptions,
} from "./policy.js"
import { buildReviewRequest } from "./review-input.js"
import { prepareReviewJournal } from "./reviewer-journal.js"
import { parseReviewResponse } from "./response.js"
import type { PermissionEvent, ReviewDecision, ReviewerJournalState, ReviewRequest } from "./types.js"

const FAILURE_MESSAGE = "The request could not be verified safely. Retry later or use a safer approach."

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
        deny(event as PermissionEvent, humanReason)
        diagnose({ action: event.action, outcome: "human_rule" })
        return
      }

      const controller = new AbortController()
      activeControllers.add(controller)
      const timer = setTimeout(() => controller.abort(), options.timeoutMs)
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
          return decision ? { decision, code: decision.decision } : { code: "review_failure" }
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
        deny(event as PermissionEvent, outcome?.decision?.reason ?? outcome?.message ?? FAILURE_MESSAGE)
      } catch {
        if (!disposed) {
          diagnose({ action: event.action, outcome: controller.signal.aborted ? "timeout" : "failure" })
          deny(event as PermissionEvent, FAILURE_MESSAGE)
        }
      } finally {
        clearTimeout(timer)
        activeControllers.delete(controller)
      }
    })

    async function generateReview(
      sessionID: string,
      request: ReviewRequest,
      signal: AbortSignal,
    ): Promise<ReviewDecision | "oversized" | undefined> {
      const selectedModel = await getModel()
      if (!selectedModel) return
      const prepared = prepareReviewJournal(reviewerStates.get(sessionID), request, options.maxReviewBytes)
      if (!prepared) return "oversized"
      const { prompt, ...state } = prepared
      reviewerStates.set(sessionID, state)
      try {
        const result = await ctx.generate.text(
          { prompt, model: selectedModel },
          { signal },
        )
        if (signal.aborted) return
        return parseReviewResponse(result.text)
      } catch {
        return
      }
    }

    async function getModel(): Promise<ReviewerModel | undefined> {
      if (model) return model
      pendingModel ??= resolveModel(ctx, options.agent, options.model, options.timeoutMs)
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

    function deny(event: PermissionEvent, reason: string): void {
      event.effect = "deny"
      event.message = denialMessage(reason)
    }

    return async () => {
      disposed = true
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
): Promise<ReviewerModel | undefined> {
  if (configured) return parseModel(configured)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    try {
      const agent = await raceWithAbort(ctx.agent.get({ agentID }, { signal: controller.signal }), controller.signal)
      if (agent.data.model) return copyModel(agent.data.model)
    } catch {}
    try {
      const fallback = await raceWithAbort(ctx.catalog.model.default({}, { signal: controller.signal }), controller.signal)
      if (fallback.data) return copyModel(fallback.data)
    } catch {}
  } finally {
    clearTimeout(timer)
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
