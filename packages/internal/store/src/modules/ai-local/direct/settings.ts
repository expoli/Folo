import { defaultAISettings } from "@follow/shared/settings/defaults"
import type { LocalAIGatewaySettings } from "@follow/shared/settings/interface"
import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"

import { normalizeLocalAIBaseUrl } from "../config"

/**
 * Mapping of the `ai` settings onto the direct-mode runtime, shared by the desktop and mobile apps
 * so both read the same fields with the same fallbacks.
 */

/**
 * Saved settings with every field defined: a stored object may predate a field (the settings atom
 * merges shallowly), so readers must never see `undefined` where a string is expected.
 *
 * The result is memoised per stored object, because React consumers use it as an effect dependency:
 * a fresh object on every render would make their draft-sync effect revert the user's typing.
 */
const normalizedSettingsCache = new WeakMap<object, LocalAIGatewaySettings>()

export const normalizeLocalGatewaySettings = (
  stored?: Partial<LocalAIGatewaySettings> | null,
  defaults: LocalAIGatewaySettings = defaultAISettings.localGateway,
): LocalAIGatewaySettings => {
  if (!stored) return defaults

  const cached = normalizedSettingsCache.get(stored)
  if (cached) return cached

  const normalized: LocalAIGatewaySettings = {
    ...defaults,
    ...stored,
    // A stored object may carry a partial `directOptions` as well, since the settings atom merges
    // shallowly.
    directOptions: { ...defaults.directOptions, ...stored.directOptions },
  }
  normalizedSettingsCache.set(stored, normalized)

  return normalized
}

/** Endpoint the direct mode talks to, or `null` while the user has not filled the address in. */
export const getDirectAIConfig = (
  settings: LocalAIGatewaySettings,
  defaults: LocalAIGatewaySettings = defaultAISettings.localGateway,
): LocalAIDirectConfig | null => {
  const baseUrl = normalizeLocalAIBaseUrl(settings.directBaseUrl)
  if (!baseUrl) return null

  const models = (settings.directModels ?? []).filter((model) => model.trim())
  const options = settings.directOptions ?? defaults.directOptions

  return {
    baseUrl,
    model: settings.directModel?.trim() || models[0] || "",
    models,
    // Every knob is optional: what the user left empty keeps the built-in default.
    maxOutputTokens: options.maxOutputTokens,
    temperature: options.temperature,
    reasoningEffort: options.reasoningEffort,
    extraRequestBody: options.extraRequestBody?.trim() || null,
    summaryChunkChars: options.summaryChunkChars,
    translationChunkChars: options.translationChunkChars,
    translationConcurrency: options.translationConcurrency,
  }
}
