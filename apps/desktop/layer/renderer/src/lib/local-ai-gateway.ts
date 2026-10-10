import type { ByokProviderName, LocalAIGatewaySettings } from "@follow/shared/settings/interface"
import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import type { LocalAIConfig } from "@follow/store/ai-local/config"
import {
  configureLocalAI,
  getLocalAIConfig,
  normalizeLocalAIBaseUrl,
  resolveLocalAIConfig,
} from "@follow/store/ai-local/config"
import { EventBus } from "@follow/utils/event-bus"
import { jotaiStore } from "@follow/utils/jotai"
import { isEqual } from "es-toolkit"
import { atom, useAtomValue } from "jotai"

import { createDefaultSettings, getAISettings, setAISetting } from "~/atoms/settings/ai"
import { ipcServices } from "~/lib/client"
import { createLocalAIDirectFetch } from "~/lib/local-ai-direct-fetch"
import { queryClient } from "~/lib/query-client"
import { ChatSliceActions } from "~/modules/ai-chat/store/chat-core/chat-actions"

/**
 * Runtime wiring of the local AI modes.
 *
 * `gateway` points the app at a self-hosted gateway process; `direct` lets the desktop main process
 * call an OpenAI-compatible endpoint itself. The address, the model list and the token live in the
 * `ai` settings, so a packaged app can be repointed from Settings → AI without a rebuild.
 * `VITE_LOCAL_AI_GATEWAY_URL` / `VITE_LOCAL_AI_TOKEN` only seed the first run, see
 * `createDefaultSettings`.
 */

/** Last config handed to `configureLocalAI`, so React consumers re-render on a change. */
const effectiveLocalAIConfigAtom = atom<LocalAIConfig>(getLocalAIConfig())
const atomOptions = { store: jotaiStore }

export const useLocalAIConfig = () => useAtomValue(effectiveLocalAIConfigAtom, atomOptions)

/**
 * Saved settings with every field defined: a stored object may predate a field (the settings atom
 * merges shallowly), so readers must never see `undefined` where a string is expected.
 */
export const normalizeLocalGatewaySettings = (
  stored?: Partial<LocalAIGatewaySettings> | null,
): LocalAIGatewaySettings => ({
  ...createDefaultSettings().localGateway,
  ...stored,
})

/** Saved local AI settings; settings stored before a field existed fall back to its default, so a
 * legacy object without `mode` / `directModels` still resolves. */
export const getLocalGatewaySettings = (): LocalAIGatewaySettings =>
  normalizeLocalGatewaySettings(getAISettings().localGateway)

/** Endpoint the direct mode talks to, or `null` while the user has not filled the address in. */
export const getDirectAIConfig = (
  settings: LocalAIGatewaySettings = getLocalGatewaySettings(),
): LocalAIDirectConfig | null => {
  const baseUrl = normalizeLocalAIBaseUrl(settings.directBaseUrl)
  if (!baseUrl) return null

  const models = (settings.directModels ?? []).filter((model) => model.trim())

  return { baseUrl, model: settings.directModel?.trim() || models[0] || "", models }
}

/** One transport for the lifetime of the window: it reads the settings on every request. */
const directFetch = createLocalAIDirectFetch(() => getDirectAIConfig())

/** BYOK providers that speak the OpenAI protocol; Google is deliberately not one of them. */
const BYOK_DIRECT_PROVIDERS: ByokProviderName[] = ["openai", "openrouter", "vercel-ai-gateway"]

/**
 * Endpoints of those providers, for BYOK entries that left the address blank. Importing copies the
 * values once; the direct mode never follows later BYOK edits.
 */
const BYOK_DEFAULT_BASE_URLS: Partial<Record<ByokProviderName, string>> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  "vercel-ai-gateway": "https://ai-gateway.vercel.sh/v1",
}

interface ImportableByokProvider {
  provider: ByokProviderName
  baseUrl: string
  apiKey: string
}

/**
 * First BYOK provider the direct mode can copy: an OpenAI-compatible one with a stored key. Returns
 * `null` when BYOK holds nothing usable, which the settings UI reports instead of guessing.
 */
const findImportableByokProvider = (): ImportableByokProvider | null => {
  for (const candidate of getAISettings().byok?.providers ?? []) {
    if (!BYOK_DIRECT_PROVIDERS.includes(candidate.provider)) continue

    const apiKey = candidate.apiKey?.trim()
    if (!apiKey) continue

    const baseUrl =
      normalizeLocalAIBaseUrl(candidate.baseURL) ?? BYOK_DEFAULT_BASE_URLS[candidate.provider]
    if (!baseUrl) continue

    return { provider: candidate.provider, baseUrl, apiKey }
  }

  return null
}

/** Outcome of `importLocalAIConfigFromByok`, so the caller can explain a refusal. */
export type LocalAIImportFromByokResult =
  | { ok: true; provider: ByokProviderName }
  | { ok: false; reason: "no-desktop" | "no-provider" | "key-not-stored"; message: string }

/**
 * Copies one BYOK provider into the direct mode: the key goes to the main process (encrypted), the
 * endpoint and the mode into the settings. The copy is one-off — later BYOK edits are not followed.
 */
export const importLocalAIConfigFromByok = async (): Promise<LocalAIImportFromByokResult> => {
  const services = ipcServices
  if (!services) {
    return { ok: false, reason: "no-desktop", message: "Importing needs the desktop app" }
  }

  const imported = findImportableByokProvider()
  if (!imported) {
    return {
      ok: false,
      reason: "no-provider",
      message: "BYOK has no usable OpenAI-compatible entry",
    }
  }

  const stored = await services.localAI.setApiKey(imported.apiKey)
  if (!stored.ok) {
    return { ok: false, reason: "key-not-stored", message: stored.message }
  }

  setAISetting("localGateway", {
    ...getLocalGatewaySettings(),
    enabled: true,
    mode: "direct",
    directBaseUrl: imported.baseUrl,
    directModels: [],
    directModel: "",
  })

  return { ok: true, provider: imported.provider }
}

/**
 * Pushes the saved settings into the shared store, so summary / translation / chat pick the new
 * runtime up on their next request. Called at bootstrap and whenever the settings change.
 */
export const applyLocalAIGatewaySettings = (): LocalAIConfig => {
  const settings = getLocalGatewaySettings()
  const resolved = resolveLocalAIConfig(settings)
  const config = configureLocalAI({
    ...resolved,
    fetch: resolved?.mode === "direct" ? directFetch : undefined,
  })

  jotaiStore.set(effectiveLocalAIConfigAtom, config)

  return config
}

/**
 * Applies local AI settings saved in Settings → AI while the app runs: the model catalogue is
 * reloaded (it belongs to the endpoint) and every mounted chat rebuilds its transport. Returns the
 * unsubscribe function of the settings listener.
 */
export const subscribeLocalAIGatewaySettings = () =>
  EventBus.subscribe("SETTING_CHANGE_EVENT", ({ key, payload }) => {
    if (key !== "ai" || !("localGateway" in payload)) return

    const previous = getLocalAIConfig()
    const next = applyLocalAIGatewaySettings()
    if (isEqual(previous, next)) return

    void queryClient.invalidateQueries({ queryKey: ["aiConfiguration"] })
    ChatSliceActions.recreateTransportEverywhere()
  })
