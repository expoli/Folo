import type { SupportedActionLanguage } from "@follow/shared"
import type { LocalAIProbeResult } from "@follow/shared/settings/local-ai"
import type { ConfigResponse, SummaryResponse } from "@follow-app/client-sdk"

import type { LocalAIContextBudget } from "./config"
import {
  createLocalAIHeaders,
  getLocalAIConfig,
  localAIUrl,
  normalizeLocalAIBaseUrl,
  setLocalAIContextBudget,
} from "./config"

/** The entry payload the gateway needs, because it has no access to Folo's (closed source) backend. */
export interface LocalAIEntryPayload {
  id: string
  title?: string | null
  description?: string | null
  content?: string | null
  readabilityContent?: string | null
}

export type LocalAITranslationMode = "bilingual" | "translation-only"

const MAX_ERROR_CHARS = 300

const gatewayBaseUrl = () => getLocalAIConfig().baseUrl ?? "(not configured)"

/** Names the runtime the user configured, so an error points at the right thing. */
const localAIPeer = () =>
  getLocalAIConfig().mode === "direct" ? "Local AI endpoint" : "Local AI gateway"

/**
 * Transport of the current mode: `direct` mode installs an IPC-backed fetch, a self-hosted
 * gateway keeps the global one.
 */
const localAIFetch = () => getLocalAIConfig().fetch ?? globalThis.fetch

const readErrorText = async (response: Response) => {
  try {
    return (await response.text()).slice(0, MAX_ERROR_CHARS).replace(/\s+/g, " ").trim()
  } catch {
    return ""
  }
}

/** Separates "the endpoint rejected us" from "the model or its upstream failed". */
const statusHint = (status: number) => {
  if (status === 401 || status === 403) return "token rejected"
  if (status >= 500) return "upstream model error"
  return "request rejected"
}

const request = async (path: string, init: RequestInit) => {
  const url = localAIUrl(path)

  try {
    return await localAIFetch()(url, init)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${localAIPeer()} unreachable at ${gatewayBaseUrl()}: ${reason}`.slice(0, MAX_ERROR_CHARS),
    )
  }
}

const assertOk = async (response: Response, action: string) => {
  if (response.ok) return

  const detail = await readErrorText(response)
  const message = `${localAIPeer()} ${action} failed at ${gatewayBaseUrl()} (${response.status} ${statusHint(response.status)})`

  throw new Error((detail ? `${message}: ${detail}` : message).slice(0, MAX_ERROR_CHARS))
}

/**
 * Same contract as `GET {API_URL}/ai/summary`, except the entry content travels with the
 * request instead of being read from Folo's servers.
 */
export const requestLocalAISummary = async (params: {
  entryId: string
  language: SupportedActionLanguage
  target: "content" | "readabilityContent"
  title?: string | null
  content?: string | null
}): Promise<SummaryResponse> => {
  const response = await request("/ai/summary", {
    method: "POST",
    headers: createLocalAIHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(params),
  })

  await assertOk(response, "summary")

  const payload = (await response.json()) as { data?: string | null }

  return { code: 0, data: payload?.data ?? null }
}

/**
 * Same contract as `POST {API_URL}/ai/summary-title`, except the local model writes the title:
 * Folo generates it on its own server, which a self-hosted gateway cannot reach.
 */
export const requestLocalAITitle = async (params: {
  messages: { role: string; content: string }[]
  /** Language of the interface, so the title matches it instead of the prompt's own language. */
  language?: string | null
}): Promise<string | null> => {
  const response = await request("/ai/summary-title", {
    method: "POST",
    headers: createLocalAIHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(params),
  })

  await assertOk(response, "title")

  const payload = (await response.json()) as { title?: unknown }

  return typeof payload?.title === "string" && payload.title.trim() ? payload.title.trim() : null
}

/**
 * Same contract as `POST {API_URL}/ai/translation/batch`: the returned response body is an
 * NDJSON stream of `{ id, data }` lines, consumed by `readNdjsonStream`.
 */
export const requestLocalAITranslationBatch = async (params: {
  entries: LocalAIEntryPayload[]
  language: SupportedActionLanguage
  fields: string[]
  mode: LocalAITranslationMode
}): Promise<Response> => {
  const response = await request("/ai/translation/batch", {
    method: "POST",
    headers: createLocalAIHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(params),
  })

  await assertOk(response, "translation")

  return response
}

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null

const errorDetail = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_CHARS)

/**
 * Probes a gateway address the user typed but has not saved yet: `?probe=1` makes the gateway
 * spend one minimal model call, so "gateway is up" can be told apart from "the model answers".
 * Never throws — the caller renders the outcome, including `token-rejected` for 401/403.
 */
export const probeLocalAIGateway = async (params: {
  baseUrl: string
  token?: string | null
  signal?: AbortSignal
  /**
   * Transport override. `direct` mode passes its IPC fetch so a draft endpoint can be tested
   * before it is saved; gateways keep the global one.
   */
  fetch?: typeof globalThis.fetch
}): Promise<LocalAIProbeResult> => {
  const baseUrl = normalizeLocalAIBaseUrl(params.baseUrl)
  if (!baseUrl) {
    return { kind: "unreachable", detail: "no gateway address" }
  }

  const token = params.token?.trim()
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined

  const fetchImpl = params.fetch ?? localAIFetch()

  // `GET /health` is exempt from `GATEWAY_TOKEN`, so a wrong (or missing) token still looks
  // healthy there. Ask an authenticated endpoint first; a gateway without it falls through.
  let authResponse: Response
  try {
    authResponse = await fetchImpl(`${baseUrl}/ai/chat/config`, { headers, signal: params.signal })
  } catch (error) {
    return { kind: "unreachable", detail: errorDetail(error) }
  }

  if (authResponse.status === 401 || authResponse.status === 403) {
    return { kind: "token-rejected" }
  }

  let response: Response

  try {
    response = await fetchImpl(`${baseUrl}/health?probe=1`, {
      headers,
      signal: params.signal,
    })
  } catch (error) {
    return { kind: "unreachable", detail: errorDetail(error) }
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "token-rejected" }
  }

  if (response.status >= 500) {
    return { kind: "upstream-error", detail: (await readErrorText(response)) || "gateway error" }
  }

  if (!response.ok) {
    const detail = await readErrorText(response)
    return { kind: "unreachable", detail: `HTTP ${response.status}${detail ? ` ${detail}` : ""}` }
  }

  let payload: { probe?: unknown; upstream?: unknown; defaultModel?: unknown }
  try {
    payload = (await response.json()) as typeof payload
  } catch (error) {
    return { kind: "unreachable", detail: `invalid /health response: ${errorDetail(error)}` }
  }

  const result = {
    upstream: asNonEmptyString(payload.upstream),
    defaultModel: asNonEmptyString(payload.defaultModel),
  }
  const probe = payload.probe

  // A gateway that predates the probe answers `/health` without one; it is reachable, but the
  // model itself stays unchecked.
  if (!probe || typeof probe !== "object") {
    return { kind: "ok", latencyMs: null, ...result }
  }

  const { ok, latencyMs, error } = probe as { ok?: unknown; latencyMs?: unknown; error?: unknown }
  if (ok !== true) {
    return { kind: "upstream-error", detail: asNonEmptyString(error) || "model probe failed" }
  }

  return {
    kind: "ok",
    latencyMs: typeof latencyMs === "number" && Number.isFinite(latencyMs) ? latencyMs : null,
    ...result,
  }
}

/**
 * Same contract as `GET {API_URL}/ai/chat/config`. Usage/rate limits are meaningless for a
 * self-hosted gateway, so they are reported as empty instead of Folo's quota.
 */
export const fetchLocalAIConfig = async (): Promise<ConfigResponse> => {
  const response = await request("/ai/chat/config", {
    headers: createLocalAIHeaders(),
  })

  await assertOk(response, "config")

  const payload = (await response.json()) as Partial<ConfigResponse> & {
    localAIContext?: Partial<LocalAIContextBudget>
  }

  // The gateway decides how much article text fits its model context; keep it for
  // `buildLocalAIContext`, which runs later when the user sends a message.
  setLocalAIContextBudget(payload.localAIContext)

  const availableModels = payload.availableModels?.length
    ? payload.availableModels
    : payload.defaultModel
      ? [payload.defaultModel]
      : []
  const defaultModel = payload.defaultModel || availableModels[0] || ""
  const availableModelsMenu = payload.availableModelsMenu?.length
    ? payload.availableModelsMenu
    : availableModels.map((model) => ({ label: model, value: model }))

  return {
    defaultModel,
    availableModels,
    availableModelsMenu,
    rateLimit: {
      maxTokens: 0,
      currentTokens: 0,
      remainingTokens: 0,
      windowDuration: 0,
      windowResetTime: 0,
    },
    attachmentLimits: {
      maxFiles: 0,
      remainingFiles: 0,
      windowDuration: 0,
      windowResetTime: 0,
    },
    usage: {
      total: 0,
      used: 0,
      remaining: 0,
      resetAt: new Date(0),
    },
    freeQuota: {
      shouldCheckDailyLimit: false,
      remainingRequests: 0,
      remainingMonthlyRequests: 0,
      role: "free",
      dailyLimit: 0,
      monthlyLimit: 0,
    },
  }
}
