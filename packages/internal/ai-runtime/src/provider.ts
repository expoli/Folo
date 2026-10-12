import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import type { LanguageModel } from "ai"

import { badRequest } from "./errors"
import {
  boundedNumber,
  clampedNumber,
  MAX_CHUNK_CHARS,
  MAX_CONCURRENCY,
  MAX_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS_LIMIT,
  MAX_TEMPERATURE,
  MIN_CHUNK_CHARS,
} from "./limits"

/** Numeric defaults and ceilings of one call; they live in `./limits` so the gateway can reuse them. */
export {
  MAX_CHUNK_CHARS,
  MAX_CONCURRENCY,
  MAX_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS_LIMIT,
  MAX_TEMPERATURE,
  MIN_CHUNK_CHARS,
}

/** Everything a direct-model call may be tuned with; absent fields keep the built-in defaults. */
export interface DirectCallOptions {
  maxOutputTokens: number
  /** `0` is a meaningful value, not a missing one, so it survives unchanged. */
  temperature?: number
  providerOptions?: Record<string, Record<string, string | number | boolean>>
  /** Chunk size of long-article summary calls. */
  summaryChunkChars?: number
  /** Chunk size of long-field translation calls. */
  translationChunkChars?: number
  /** Entries translated at the same time. */
  translationConcurrency?: number
}

/** Reads the knobs of one request; the settings leave a field empty to keep the default. */
export const directCallOptions = (config: LocalAIDirectConfig): DirectCallOptions => ({
  maxOutputTokens:
    boundedNumber(config.maxOutputTokens, 1, MAX_OUTPUT_TOKENS_LIMIT) ?? MAX_OUTPUT_TOKENS,
  temperature: clampedNumber(config.temperature, 0, MAX_TEMPERATURE),
  // `reasoningEffort` is a standard option of the OpenAI-compatible provider, so the thinking
  // budget travels with the call instead of being injected into the body by hand. The key is the
  // provider's settings name in camel case, which is what the SDK looks for (`local-ai` is
  // deprecated).
  providerOptions: config.reasoningEffort
    ? { localAi: { reasoningEffort: config.reasoningEffort } }
    : undefined,
  summaryChunkChars: boundedNumber(config.summaryChunkChars, MIN_CHUNK_CHARS, MAX_CHUNK_CHARS),
  translationChunkChars: boundedNumber(
    config.translationChunkChars,
    MIN_CHUNK_CHARS,
    MAX_CHUNK_CHARS,
  ),
  translationConcurrency: boundedNumber(config.translationConcurrency, 1, MAX_CONCURRENCY),
})

/**
 * Talks to the OpenAI-compatible endpoint the user configured: OpenAI, OpenRouter, Vercel AI
 * Gateway, Ollama, vLLM, LM Studio or an internal gateway all speak plain chat completions.
 *
 * `fetch` is injected: the desktop app passes Chromium's network stack so the call follows the
 * app's proxy, the mobile app passes its own runtime's fetch.
 */
const createProvider = (
  config: LocalAIDirectConfig,
  apiKey: string | null,
  fetch: typeof globalThis.fetch,
) =>
  createOpenAICompatible({
    name: "local-ai",
    baseURL: config.baseUrl,
    fetch: withExtraRequestBody(config, fetch),
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

/** How much article text a caller may attach to one chat request. */
export interface LocalAIContextBudget {
  maxEntries: number
  maxCharsPerEntry: number
  maxTotalChars: number
}

/**
 * Merges the user's extra JSON into every model request body: providers expose thinking knobs that
 * are not part of the OpenAI-compatible schema (`thinking_budget`, `enable_thinking`, …).
 */
const withExtraRequestBody = (
  config: LocalAIDirectConfig,
  fetch: typeof globalThis.fetch,
): typeof globalThis.fetch => {
  const extra = parseExtraRequestBody(config.extraRequestBody)
  if (!extra) return fetch

  return async (input, init) => {
    if (typeof init?.body !== "string") return fetch(input, init)

    try {
      const body: unknown = JSON.parse(init.body)
      if (!body || typeof body !== "object" || Array.isArray(body)) return fetch(input, init)

      return await fetch(input, { ...init, body: JSON.stringify({ ...body, ...extra }) })
    } catch {
      return fetch(input, init)
    }
  }
}

/** Invalid JSON is reported and ignored, so a typo cannot break every request. */
const parseExtraRequestBody = (raw: string | null | undefined): Record<string, unknown> | null => {
  if (!raw?.trim()) return null

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn("[local-ai] the extra request body has to be a JSON object, ignoring it")
      return null
    }

    return parsed as Record<string, unknown>
  } catch (error) {
    console.warn("[local-ai] the extra request body is not valid JSON, ignoring it:", error)
    return null
  }
}

/**
 * Model handle for one request; throws when the user has not configured a model yet.
 *
 * A platform that does not talk to an OpenAI-compatible endpoint (the self-hosted gateway uses
 * `@ai-sdk/openai`) injects its own factory instead of calling this one.
 */
export const createDirectModel = (params: {
  config: LocalAIDirectConfig
  apiKey: string | null
  fetch: typeof globalThis.fetch
  requestedModel?: string | null
}): LanguageModel => {
  const modelId = resolveModelId(params.config, params.requestedModel)
  if (!modelId) {
    // A request problem, not an upstream failure: the settings need a model before anything runs.
    throw badRequest("No model is configured for the direct endpoint")
  }

  return createProvider(params.config, params.apiKey, params.fetch).chatModel(modelId)
}

/** How a caller turns a request into a model handle, so a platform can bring its own provider. */
export type LanguageModelFactory = (params: {
  config: LocalAIDirectConfig
  apiKey: string | null
  fetch: typeof globalThis.fetch
  requestedModel?: string | null
}) => LanguageModel
