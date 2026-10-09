import type { SupportedActionLanguage } from "@follow/shared"
import type { ConfigResponse, SummaryResponse } from "@follow-app/client-sdk"

import { createLocalAIHeaders, localAIUrl } from "./config"

/** The entry payload the gateway needs, because it has no access to Folo's (closed source) backend. */
export interface LocalAIEntryPayload {
  id: string
  title?: string | null
  description?: string | null
  content?: string | null
  readabilityContent?: string | null
}

export type LocalAITranslationMode = "bilingual" | "translation-only"

const readErrorText = async (response: Response) => {
  try {
    return (await response.text()).slice(0, 300)
  } catch {
    return ""
  }
}

const assertOk = async (response: Response, action: string) => {
  if (response.ok) return

  throw new Error(
    `Local AI gateway ${action} failed (${response.status}): ${await readErrorText(response)}`,
  )
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
  const response = await fetch(localAIUrl("/ai/summary"), {
    method: "POST",
    headers: createLocalAIHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(params),
  })

  await assertOk(response, "summary")

  const payload = (await response.json()) as { data?: string | null }

  return { code: 0, data: payload?.data ?? null }
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
  const response = await fetch(localAIUrl("/ai/translation/batch"), {
    method: "POST",
    headers: createLocalAIHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(params),
  })

  await assertOk(response, "translation")

  return response
}

/**
 * Same contract as `GET {API_URL}/ai/chat/config`. Usage/rate limits are meaningless for a
 * self-hosted gateway, so they are reported as empty instead of Folo's quota.
 */
export const fetchLocalAIConfig = async (): Promise<ConfigResponse> => {
  const response = await fetch(localAIUrl("/ai/chat/config"), {
    headers: createLocalAIHeaders(),
  })

  await assertOk(response, "config")

  const payload = (await response.json()) as Partial<ConfigResponse>
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
