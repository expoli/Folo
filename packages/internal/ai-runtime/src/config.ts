import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"

import { jsonResponse } from "./http"
import { probeDirectModel } from "./probe"
import { availableModelIds, DIRECT_CONTEXT_BUDGET, resolveModelId } from "./provider"

/** Waiting time of the optional model-list request; a slow endpoint falls back to the settings. */
const MODEL_LIST_TIMEOUT_MS = 5_000
/** The catalogue rarely changes, and every settings screen asks for it. */
const MODEL_LIST_CACHE_TTL_MS = 60_000
/** A dead endpoint is retried after this, so opening the settings is not delayed every time. */
const MODEL_LIST_FAILURE_TTL_MS = 10_000

export interface ModelListResult {
  ids: string[]
  rejected: boolean
}

const modelListCache = new Map<string, { at: number; ttl: number; result: ModelListResult }>()

/** Keeps test cases independent from each other. */
export const resetModelListCache = () => modelListCache.clear()

/**
 * Cheap, stable fingerprint of an API key: the cache is keyed by "which key answered this", but a
 * raw key must never be held in memory (or in a log) on its way to a cached result.
 */
const keyFingerprint = (apiKey: string) => {
  let hash = 2166136261
  for (let index = 0; index < apiKey.length; index += 1) {
    hash ^= apiKey.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return (hash >>> 0).toString(16)
}

/** Reads the OpenAI `{ data: [{ id }] }` model list, tolerating plain id arrays too. */
export const parseModelIds = (payload: unknown): string[] => {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? ((payload as { data: unknown[] }).data as unknown[])
      : []

  const ids: string[] = []
  for (const item of list) {
    if (typeof item === "string" && item.trim()) {
      ids.push(item.trim())
      continue
    }

    const id = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined
    if (typeof id === "string" && id.trim()) ids.push(id.trim())
  }

  return ids
}

const modelListUrl = (baseUrl: string) => `${baseUrl.replace(/\/+$/, "")}/models`

/**
 * Asks the endpoint for its model list. A rejected key is reported as such, so the settings UI can
 * tell "wrong API key" apart from "this endpoint has no `/models` route" (the latter falls back to
 * the models the user typed in).
 *
 * The cached entry is keyed by the endpoint *and* a fingerprint of the key: a draft probe with a
 * corrected key must not read the rejection of the previous one. A rejection is also remembered for
 * the short failure window only, so fixing a key takes effect on the next tap.
 */
export const fetchUpstreamModelIds = async (
  config: LocalAIDirectConfig,
  apiKey: string | null,
  fetch: typeof globalThis.fetch,
): Promise<ModelListResult> => {
  const cacheKey = `${modelListUrl(config.baseUrl)}|${apiKey ? keyFingerprint(apiKey) : ""}`
  const cached = modelListCache.get(cacheKey)
  if (cached && Date.now() - cached.at < cached.ttl) return cached.result

  const remember = (result: ModelListResult, ttl: number) => {
    modelListCache.set(cacheKey, { at: Date.now(), ttl, result })
    return result
  }

  try {
    const response = await fetch(modelListUrl(config.baseUrl), {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
    })

    if (response.status === 401 || response.status === 403) {
      return remember({ ids: [], rejected: true }, MODEL_LIST_FAILURE_TTL_MS)
    }
    if (!response.ok) {
      return remember({ ids: [], rejected: false }, MODEL_LIST_FAILURE_TTL_MS)
    }

    return remember(
      { ids: parseModelIds(await response.json()), rejected: false },
      MODEL_LIST_CACHE_TTL_MS,
    )
  } catch (error) {
    console.warn("[local-ai] model list unavailable:", error)
    // A refused connection or a timeout may recover any moment, so it is retried sooner.
    return remember({ ids: [], rejected: false }, MODEL_LIST_FAILURE_TTL_MS)
  }
}

/**
 * `GET /ai/chat/config`: the model catalogue the model picker shows plus the context budget the
 * client uses to attach article text. Quota fields stay out: a local endpoint has no Folo quota,
 * and the client fills in empty ones for local AI.
 */
export const handleConfig = async (
  config: LocalAIDirectConfig,
  apiKey: string | null,
  fetch: typeof globalThis.fetch,
) => {
  const { ids, rejected } = await fetchUpstreamModelIds(config, apiKey, fetch)
  if (rejected) {
    return jsonResponse(401, {
      error: `The endpoint rejected the API key (${modelListUrl(config.baseUrl)})`,
    })
  }

  const models = ids.length > 0 ? ids : availableModelIds(config)
  const defaultModel = resolveModelId(config) || models[0] || ""

  return jsonResponse(200, {
    defaultModel,
    availableModels: models,
    availableModelsMenu: models.map((model) => ({ label: model, value: model })),
    localAIContext: DIRECT_CONTEXT_BUDGET,
  })
}

/**
 * `GET /health`, and with `?probe=1` one minimal model call so "endpoint is up" can be told apart
 * from "the model answers".
 */
export const handleHealth = async (
  config: LocalAIDirectConfig,
  apiKey: string | null,
  probe: boolean,
  fetch: typeof globalThis.fetch,
) => {
  const payload: {
    ok: boolean
    upstream: string
    defaultModel: string
    models: string[]
    probe?: Awaited<ReturnType<typeof probeDirectModel>>
  } = {
    ok: true,
    upstream: config.baseUrl,
    defaultModel: resolveModelId(config),
    models: availableModelIds(config),
  }

  if (probe) {
    payload.probe = await probeDirectModel({ config, apiKey, fetch })
  }

  return jsonResponse(200, payload)
}
