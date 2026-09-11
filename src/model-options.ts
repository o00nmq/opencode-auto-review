import { createHash } from "node:crypto"
import type { Model, Plugin } from "@opencode-ai/plugin"

export interface ModelOptions {
  settings?: Record<string, unknown>
  body?: Record<string, unknown>
}

export interface ReviewerModel {
  id: string
  providerID: string
  variant?: string
}

export function parseModelOptions(value: unknown): ModelOptions | undefined {
  if (value === undefined) return
  if (!object(value) || Object.keys(value).some((key) => key !== "settings" && key !== "body") ||
    Object.values(value).some((entry) => !object(entry))) {
    throw new TypeError("modelOptions must contain settings/body objects")
  }
  return value as ModelOptions
}

/** Add a reviewer-only variant; never alter the base model or an existing variant. */
export async function registerModelOptions(
  catalog: Plugin.Context["catalog"],
  model: ReviewerModel,
  options: ModelOptions,
): Promise<{ model: ReviewerModel; dispose(): Promise<void> } | { error: string }> {
  const overrides = structuredClone(options)
  const id = `opencode-auto-review-${createHash("sha256").update(JSON.stringify([model, overrides])).digest("hex").slice(0, 16)}` as Model.Variant["id"]
  let reason: string | undefined
  let applied = false
  const registration = await catalog.transform((editor) => {
    const original = editor.model.get(model.providerID, model.id)
    if (!original) {
      reason = `reviewer model ${model.providerID}/${model.id} is not available`
      return
    }
    const inherited = original.variants.find((variant) => String(variant.id) === model.variant)
    // An invalid selected variant must not silently fall back to the base model.
    if (model.variant && !inherited) {
      reason = `reviewer variant "${model.variant}" is not available for ${model.providerID}/${model.id}`
      return
    }
    editor.model.update(model.providerID, model.id, (draft) => {
      draft.variants = [
        ...draft.variants.filter((variant) => variant.id !== id),
        {
          ...structuredClone(inherited ?? {}),
          id,
          ...(overrides.settings ? { settings: merge(inherited?.settings ?? {}, overrides.settings) } : {}),
          ...(overrides.body ? { body: merge(inherited?.body ?? {}, overrides.body) } : {}),
        },
      ]
    })
    applied = true
  })
  // Returning an unregistered variant id would silently drop the requested overrides.
  if (!applied) {
    await registration.dispose()
    return { error: reason ?? `reviewer model options for ${model.providerID}/${model.id} could not be applied` }
  }
  return { model: { ...model, variant: id }, dispose: () => registration.dispose() }
}

function merge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(override)])].map((key) => {
    if (!Object.hasOwn(override, key)) return [key, structuredClone(base[key])]
    const value = override[key]
    return [key, object(base[key]) && object(value) ? merge(base[key], value) : structuredClone(value)]
  }))
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
