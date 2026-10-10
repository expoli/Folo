import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import type { LanguageModel } from "ai"

import { netFetch } from "./http"

/** Output cap of one model call, matching `AI_MAX_OUTPUT_TOKENS`' default in the gateway. */
export const MAX_OUTPUT_TOKENS = 2048

/**
 * Talks to the OpenAI-compatible endpoint the user configured: OpenAI, OpenRouter, Vercel AI
 * Gateway, Ollama, vLLM, LM Studio or an internal gateway all speak plain chat completions.
 */
const createProvider = (config: LocalAIDirectConfig, apiKey: string | null) =>
  createOpenAICompatible({
    name: "local-ai",
    baseURL: config.baseUrl,
    // Chromium's stack, so the call follows the same proxy as the rest of the app.
    fetch: netFetch,
    // Endpoints such as a local Ollama need no key; without one no `Authorization` is sent.
    ...(apiKey ? { apiKey } : {}),
  })

/** Models the picker may request, in the order the settings declare them. */
export const availableModelIds = (config: LocalAIDirectConfig) => {
  const models = config.models.filter((model) => model.trim())
  if (models.length > 0) return models

  return config.model.trim() ? [config.model.trim()] : []
}

/**
 * Falls back to the configured default when a request names a model the user did not pick, so a
 * stale model in a stored chat session cannot fail the request.
 */
export const resolveModelId = (config: LocalAIDirectConfig, requested?: string | null) => {
  const models = availableModelIds(config)
  if (requested && models.includes(requested)) return requested

  const fallback = config.model.trim() || models[0] || ""
  if (requested && requested !== fallback) {
    console.warn(`[local-ai] unknown model "${requested}", falling back to ${fallback || "(none)"}`)
  }

  return fallback
}

/**
 * Text the client may attach to one chat request, announced through `localAIContext` in
 * `GET /ai/chat/config`. Same budget as the gateway's defaults, so both modes fit the same
 * amount of article text into the model context.
 */
export const DIRECT_CONTEXT_BUDGET = {
  maxEntries: 20,
  maxCharsPerEntry: 20_000,
  maxTotalChars: 60_000,
}

/** Model handle for one request; throws when the user has not configured a model yet. */
export const createDirectModel = (params: {
  config: LocalAIDirectConfig
  apiKey: string | null
  requestedModel?: string | null
}): LanguageModel => {
  const modelId = resolveModelId(params.config, params.requestedModel)
  if (!modelId) {
    throw new Error("No model is configured for the direct endpoint")
  }

  return createProvider(params.config, params.apiKey).chatModel(modelId)
}
