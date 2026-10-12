import type { LocalAIGatewaySettings } from "@follow/shared/settings/interface"
import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import { LOCAL_AI_DIRECT_ORIGIN } from "@follow/shared/settings/local-ai"
import type { LocalAIConfig } from "@follow/store/ai-local/config"
import { configureLocalAI, resolveLocalAIConfig } from "@follow/store/ai-local/config"
import { resetModelListCache } from "@follow/store/ai-local/direct/config"
import { routeLocalAIRequest } from "@follow/store/ai-local/direct/routes"
import {
  directConfigFingerprint,
  getDirectAIConfig,
  normalizeLocalGatewaySettings,
} from "@follow/store/ai-local/direct/settings"
import { summaryActions } from "@follow/store/summary/store"
import { translationActions } from "@follow/store/translation/store"
import { EventBus } from "@follow/utils/event-bus"

import { createDefaultAISettings, getAISettings } from "@/src/atoms/settings/ai"
import { safeSecureStore } from "@/src/lib/secure-store"
import { toast } from "@/src/lib/toast"

/**
 * Local AI on mobile.
 *
 * `direct` mode is the mode the in-app settings configure: the app itself calls an
 * OpenAI-compatible endpoint, without a gateway process in between. The shared direct core answers
 * the `/ai/*` paths in-process (see `@follow/store/ai-local/direct/routes`), so the store layer
 * that asks for a summary or a translation does not know which mode is running.
 *
 * The address, the models and the tuning live in the `ai` settings; the API key is kept in the
 * OS keychain, like the desktop app keeps it in its keyring.
 */

/** Where the API key of the direct endpoint is kept (encrypted by the OS keychain). */
export const DIRECT_API_KEY_STORE_KEY = "follow_local_ai_direct_api_key"

export const getDirectApiKey = () =>
  safeSecureStore.getItem(DIRECT_API_KEY_STORE_KEY)?.trim() || null

export const setDirectApiKey = (apiKey: string) => {
  const trimmed = apiKey.trim()
  if (trimmed) {
    safeSecureStore.setItem(DIRECT_API_KEY_STORE_KEY, trimmed)
  } else {
    safeSecureStore.removeItem(DIRECT_API_KEY_STORE_KEY)
  }

  // A rejected key may sit in the model-list cache; the user has just replaced it.
  resetModelListCache()
}

const defaultLocalGatewaySettings = () => createDefaultAISettings().localGateway

/**
 * A failed local AI request is invisible otherwise: the store reports it and the app says it out
 * loud. Repeats of the same failure are swallowed for a moment, because one broken request can
 * trigger several (a summary, a title, a batch of translations).
 */
const ERROR_TOAST_THROTTLE_MS = 8000
let lastReportedError = { message: "", at: 0 }

const reportLocalAIError = (message: string) => {
  // In direct mode the store talks to an internal origin, because the real endpoint lives in this
  // app's transport. Say the address the user typed instead.
  const displayed = message.replaceAll(
    LOCAL_AI_DIRECT_ORIGIN,
    getDirectConfig()?.baseUrl ?? LOCAL_AI_DIRECT_ORIGIN,
  )

  const now = Date.now()
  if (
    lastReportedError.message === displayed &&
    now - lastReportedError.at < ERROR_TOAST_THROTTLE_MS
  ) {
    return
  }

  lastReportedError = { message: displayed, at: now }
  toast.error(displayed, { duration: 6000 })
}

/** Saved settings with every field defined, so a stored object from an older build still resolves. */
export const getLocalGatewaySettings = (): LocalAIGatewaySettings =>
  normalizeLocalGatewaySettings(getAISettings().localGateway, defaultLocalGatewaySettings())

/** Endpoint the direct mode talks to, or `null` while the user has not filled the address in. */
export const getDirectConfig = (
  settings: LocalAIGatewaySettings = getLocalGatewaySettings(),
): LocalAIDirectConfig | null => getDirectAIConfig(settings, defaultLocalGatewaySettings())

/**
 * `direct` mode transport: the shared core answers the request in-process instead of over the
 * network, because there is no main process to delegate to on mobile.
 *
 * The body is handed over in one piece — React Native's fetch has no response streams, and the
 * desktop IPC transport returns a complete body as well, so both platforms read the same
 * `readNdjsonStream` (which falls back to `response.text()` when there is no reader).
 */
export const createLocalAIDirectFetch = (
  getConfig: () => LocalAIDirectConfig | null,
  getApiKey: () => string | null = getDirectApiKey,
): typeof globalThis.fetch => {
  return async function localAIDirectFetch(input, init) {
    const config = getConfig()
    if (!config) {
      throw new Error("No direct AI endpoint is configured")
    }

    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const { pathname, search } = new URL(url)

    const response = await routeLocalAIRequest({
      path: `${pathname}${search}`,
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body == null ? null : String(init.body),
      config,
      apiKey: getApiKey(),
      fetch: globalThis.fetch,
    })

    if (!response) {
      return new Response(JSON.stringify({ error: `Unsupported endpoint: ${pathname}` }), {
        status: 404,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      })
    }

    // Buffered on purpose: the caller reads it with `response.text()`.
    return new Response(await response.text(), {
      status: response.status,
      headers: response.headers,
    })
  }
}

const directFetch = createLocalAIDirectFetch(() => getDirectConfig())

/**
 * Cached summaries and translations carry the words of the model that wrote them, and they stay for
 * a week. A changed endpoint or model therefore drops them; turning local AI off keeps them, so a
 * free account does not lose text it could no longer regenerate.
 */
let lastDirectFingerprint: string | null = null

const dropCachedAITexts = () => {
  void translationActions.reset()
  void summaryActions.reset()
}

/**
 * Pushes the saved settings into the shared store, so summary and translation pick the new runtime
 * up on their next request. Called at bootstrap and whenever the settings change.
 *
 * The build-time `EXPO_PUBLIC_LOCAL_AI_*` values are not read here: they seed the settings on the
 * first run (`createDefaultAISettings`), so turning local AI off in the app turns it off.
 */
export const applyLocalAISettings = (): LocalAIConfig => {
  const settings = getLocalGatewaySettings()
  const resolved = resolveLocalAIConfig(settings)

  const fingerprint = directConfigFingerprint(
    resolved?.mode === "direct" ? getDirectConfig(settings) : null,
  )
  if (fingerprint !== null) {
    if (lastDirectFingerprint !== null && fingerprint !== lastDirectFingerprint) {
      dropCachedAITexts()
    }

    lastDirectFingerprint = fingerprint
  }

  // A gateway is called with the runtime's own fetch; only the direct mode installs a transport.
  return configureLocalAI({
    ...resolved,
    fetch: resolved?.mode === "direct" ? directFetch : undefined,
    onError: reportLocalAIError,
  })
}

/** Re-applies the settings after the user edits them. Returns the unsubscribe function. */
export const subscribeLocalAISettings = () =>
  EventBus.subscribe("SETTING_CHANGE_EVENT", (event) => {
    // The event type lists the settings that sync to Folo; `ai` is local-only on mobile, so the
    // key is read as a plain string here instead of widening that union.
    const { key, payload } = event as { key: string; payload: Record<string, unknown> }
    if (key !== "ai" || !("localGateway" in payload)) return

    applyLocalAISettings()
  })

export { LOCAL_AI_DIRECT_ORIGIN }
