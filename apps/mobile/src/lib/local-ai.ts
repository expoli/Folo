import { resetModelListCache } from "@follow/ai-runtime/config"
import { routeLocalAIRequest } from "@follow/ai-runtime/router"
import type { LocalAIGatewaySettings } from "@follow/shared/settings/interface"
import type { LocalAIDirectConfig, LocalAISetApiKeyResult } from "@follow/shared/settings/local-ai"
import { LOCAL_AI_DIRECT_ORIGIN } from "@follow/shared/settings/local-ai"
import type { LocalAIConfig } from "@follow/store/ai-local/config"
import { configureLocalAI, resolveLocalAIConfig } from "@follow/store/ai-local/config"
import {
  getDirectAIConfig,
  localAIRuntimeFingerprint,
  normalizeLocalGatewaySettings,
} from "@follow/store/ai-local/settings"
import { summaryActions } from "@follow/store/summary/store"
import { translationActions } from "@follow/store/translation/store"
import { EventBus } from "@follow/utils/event-bus"

import {
  createDefaultAISettings,
  getAISettings,
  setLocalAIGatewaySetting,
} from "@/src/atoms/settings/ai"
import { safeSecureStore, SecureStorageUnavailableError } from "@/src/lib/secure-store"
import { toast } from "@/src/lib/toast"

/**
 * Local AI on mobile.
 *
 * `direct` mode is the mode the in-app settings configure: the app itself calls an
 * OpenAI-compatible endpoint, without a gateway process in between. The shared direct core answers
 * the `/ai/*` paths in-process (see `@follow/ai-runtime/router`), so the store layer
 * that asks for a summary or a translation does not know which mode is running.
 *
 * The address, the models and the tuning live in the `ai` settings; the API key is kept in the
 * OS keychain, like the desktop app keeps it in its keyring.
 */

/** Where the API key of the direct endpoint is kept (encrypted by the OS keychain). */
export const DIRECT_API_KEY_STORE_KEY = "follow_local_ai_direct_api_key"

/**
 * Reads the key from the OS keychain only. When the keychain is not usable the app keeps no key at
 * all — a plaintext copy in the app's own store would be readable by anything on the device.
 */
export const getDirectApiKey = () =>
  safeSecureStore.getItem(DIRECT_API_KEY_STORE_KEY, { allowInsecureFallback: false })?.trim() ||
  null

/**
 * Saves (or clears) the key. A failure is reported instead of thrown, so the settings screen can
 * say why nothing was stored; it is never caused by writing the key unencrypted.
 */
export const setDirectApiKey = (apiKey: string): LocalAISetApiKeyResult => {
  const trimmed = apiKey.trim()

  if (!trimmed) {
    safeSecureStore.removeItem(DIRECT_API_KEY_STORE_KEY)
    // A rejected key may sit in the model-list cache; the user has just replaced it.
    resetModelListCache()
    return { ok: true, hasApiKey: false }
  }

  try {
    safeSecureStore.setItem(DIRECT_API_KEY_STORE_KEY, trimmed, { allowInsecureFallback: false })
  } catch (error) {
    const unavailable = error instanceof SecureStorageUnavailableError
    return {
      ok: false,
      reason: unavailable ? "encryption-unavailable" : "write-failed",
      message: unavailable
        ? "This device has no usable keychain, so the key was not stored (it would have been written unencrypted). Set up a screen lock / passcode and try again."
        : error instanceof Error
          ? error.message
          : "Could not write the API key",
    }
  }

  // A rejected key may sit in the model-list cache; the user has just replaced it.
  resetModelListCache()
  return { ok: true, hasApiKey: true }
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
 * a week. A changed runtime (another endpoint, another model, the other mode) therefore drops them;
 * turning local AI off keeps them, so a free account does not lose text it could no longer
 * regenerate.
 */
let lastRuntimeFingerprint: string | null = null

/**
 * Resets start immediately — a caller that reads a cached answer right after the switch must not see
 * the old one — and are chained afterwards, so a failing reset cannot become an unhandled rejection
 * and a second switch still waits for the first one.
 */
let cachedTextReset: Promise<void> = Promise.resolve()
const dropCachedAITexts = (): Promise<void> => {
  const dropped = Promise.all([translationActions.reset(), summaryActions.reset()]).then(
    () => undefined,
    (error: unknown) => {
      console.error("[local-ai] could not drop the cached AI text:", error)
    },
  )
  cachedTextReset = Promise.all([cachedTextReset, dropped]).then(() => undefined)

  return cachedTextReset
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

  // Both runtimes are fingerprinted: a changed gateway address makes the cached text just as stale
  // as a changed model does.
  const fingerprint = localAIRuntimeFingerprint(
    resolved,
    resolved?.mode === "direct" ? getDirectConfig(settings) : null,
  )
  if (fingerprint !== null) {
    if (lastRuntimeFingerprint !== null && fingerprint !== lastRuntimeFingerprint) {
      void dropCachedAITexts()
    }

    lastRuntimeFingerprint = fingerprint
  }

  // A gateway is called with the runtime's own fetch; only the direct mode installs a transport.
  return configureLocalAI({
    ...resolved,
    // The fingerprint is what tells the store that the endpoint or model changed: `baseUrl` is the
    // same internal origin in `direct` mode whatever the endpoint is.
    fingerprint,
    fetch: resolved?.mode === "direct" ? directFetch : undefined,
    onError: reportLocalAIError,
  })
}

/**
 * Turns local AI on or off. Only `enabled` is written: the mode the user configured (a gateway or a
 * direct endpoint) is what local AI runs on, and the switch must not repoint it.
 */
export const setLocalAIEnabled = (enabled: boolean) => {
  setLocalAIGatewaySetting({ enabled })
  applyLocalAISettings()
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
