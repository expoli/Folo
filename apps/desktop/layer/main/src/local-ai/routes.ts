import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import { LOCAL_AI_DIRECT_ORIGIN } from "@follow/shared/settings/local-ai"

import { createChatStreamResponse, createStreamResumeResponse, probeDirectModel } from "./chat"
import { jsonResponse, netFetch, parseJsonBody } from "./http"
import {
  availableModelIds,
  createDirectModel,
  DIRECT_CONTEXT_BUDGET,
  directCallOptions,
  resolveModelId,
} from "./provider"
import { handleSummaryRequest } from "./summary"
import { handleSummaryTitleRequest } from "./title"
import { handleTranslationBatchRequest } from "./translation"

/** Waiting time of the optional model-list request; a slow endpoint falls back to the settings. */
const MODEL_LIST_TIMEOUT_MS = 5_000
/** The catalogue rarely changes, and every chat panel asks for it. */
const MODEL_LIST_CACHE_TTL_MS = 60_000
/** A dead endpoint is retried after this, so opening the chat is not delayed every time. */
const MODEL_LIST_FAILURE_TTL_MS = 10_000

interface ModelListResult {
  ids: string[]
  rejected: boolean
}

const modelListCache = new Map<string, { at: number; ttl: number; result: ModelListResult }>()

/** Keeps test cases independent from each other. */
export const resetModelListCache = () => modelListCache.clear()

const CHAT_STREAM_PATH = /^\/ai\/chat\/[^/]+\/stream$/

export interface LocalAIRouteInput {
  /** Request path, may carry a query string. The origin is ignored. */
  path: string
  method: string
  /** Request body as sent by the AI SDK; `null` for requests without one. */
  body: string | null
  config: LocalAIDirectConfig
  /** API key from the encrypted store; `null` when the user has not saved one. */
  apiKey: string | null
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
 */
export const fetchUpstreamModelIds = async (
  config: LocalAIDirectConfig,
  apiKey: string | null,
): Promise<ModelListResult> => {
  const cacheKey = `${modelListUrl(config.baseUrl)}|${apiKey ? 1 : 0}`
  const cached = modelListCache.get(cacheKey)
  if (cached && Date.now() - cached.at < cached.ttl) return cached.result

  const remember = (result: ModelListResult, ttl: number) => {
    modelListCache.set(cacheKey, { at: Date.now(), ttl, result })
    return result
  }

  try {
    const response = await netFetch(modelListUrl(config.baseUrl), {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
    })

    if (response.status === 401 || response.status === 403) {
      return remember({ ids: [], rejected: true }, MODEL_LIST_CACHE_TTL_MS)
    }
    if (!response.ok) {
      return remember({ ids: [], rejected: false }, MODEL_LIST_CACHE_TTL_MS)
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
 * `GET /ai/chat/config`: the model catalogue the chat picker shows plus the context budget the
 * client uses to attach article text. Quota fields stay out: a local endpoint has no Folo quota,
 * and the client fills in empty ones for local AI.
 */
export const handleConfig = async (config: LocalAIDirectConfig, apiKey: string | null) => {
  const { ids, rejected } = await fetchUpstreamModelIds(config, apiKey)
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
    payload.probe = await probeDirectModel({ config, apiKey })
  }

  return jsonResponse(200, payload)
}

const probeRequested = (path: string) => {
  const { searchParams } = new URL(path, LOCAL_AI_DIRECT_ORIGIN)
  const probe = searchParams.get("probe")
  return probe === "1" || probe === "true"
}

/** Dispatches one path of the local AI contract; every other path answers 404. */
export const routeLocalAIRequest = async (input: LocalAIRouteInput): Promise<Response> => {
  const { pathname } = new URL(input.path, LOCAL_AI_DIRECT_ORIGIN)
  const method = input.method.toUpperCase()
  const { config, apiKey } = input
  // The settings travel with every request, so a change applies to the next call without a restart.
  const call = directCallOptions(config)

  if (method === "GET" && pathname === "/health") {
    return handleHealth(config, apiKey, probeRequested(input.path))
  }

  if (method === "GET" && pathname === "/ai/chat/config") {
    return handleConfig(config, apiKey)
  }

  if (method === "GET" && CHAT_STREAM_PATH.test(pathname)) {
    return createStreamResumeResponse()
  }

  try {
    if (method === "POST" && pathname === "/ai/chat") {
      // Awaited: the chat handler is async now (it summarizes the articles the prompt cannot carry
      // first), and a bare `return` would let its rejections escape the catch below.
      return await createChatStreamResponse({ body: parseJsonBody(input.body), config, apiKey })
    }

    if (method === "POST" && pathname === "/ai/summary") {
      return await handleSummaryRequest({
        body: parseJsonBody(input.body),
        model: createDirectModel({ config, apiKey }),
        call,
      })
    }

    if (method === "POST" && pathname === "/ai/summary-title") {
      return await handleSummaryTitleRequest({
        body: parseJsonBody(input.body),
        model: createDirectModel({ config, apiKey }),
        call,
      })
    }

    if (method === "POST" && pathname === "/ai/translation/batch") {
      return await handleTranslationBatchRequest({
        body: parseJsonBody(input.body),
        model: createDirectModel({ config, apiKey }),
        call,
      })
    }
  } catch (error) {
    // An unreadable body or a missing model is a request problem, so report it as one.
    console.error("[local-ai] request failed:", error)
    return jsonResponse(400, {
      error: error instanceof Error ? error.message : "Local AI request failed",
    })
  }

  return jsonResponse(404, { error: `Unsupported endpoint: ${method} ${pathname}` })
}
