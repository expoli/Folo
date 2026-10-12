import type { LocalAIGatewaySettings } from "@follow/shared/settings/interface"
import type { LocalAIMode } from "@follow/shared/settings/local-ai"
import { LOCAL_AI_DIRECT_ORIGIN } from "@follow/shared/settings/local-ai"

/**
 * Local AI configuration.
 *
 * By default every AI request (summary / translation / chat) is proxied through Folo's own
 * servers. When a local runtime is configured here, the shared store layer sends those requests
 * there instead, so AI runs on your own model endpoint: either a self-hosted gateway
 * (`tools/ai-gateway`) or an OpenAI-compatible endpoint served by the desktop main process.
 *
 * Each app wires the configuration up at bootstrap (desktop renderer / mobile `main.tsx`).
 */
export interface LocalAIConfig {
  /** Request origin without a trailing slash. `null` disables local AI. */
  baseUrl: string | null
  /** Optional bearer token sent to a self-hosted gateway. */
  token: string | null
  /** Which runtime owns `baseUrl`: a gateway process or the app's own direct endpoint. */
  mode: LocalAIMode
  /**
   * Transport override of `direct` mode: the desktop renderer routes the paths above to the main
   * process over IPC. Gateways keep using the global fetch.
   */
  fetch?: typeof globalThis.fetch
  /**
   * Called when a request fails, so the app can tell the user instead of leaving the reason in the
   * console. A broken reporter never breaks a request; the error is still thrown to the caller.
   */
  onError?: (message: string) => void
  /**
   * Identity of the endpoint and model the answers come from (`localAIRuntimeFingerprint` of the
   * settings). `baseUrl` alone cannot carry it in `direct` mode, where every request goes to the
   * same internal origin, so the apps hand their settings fingerprint in: a changed endpoint, model
   * or tuning then cancels the requests of the previous one instead of letting them be stored as if
   * they came from the new one. Never contains a secret.
   */
  fingerprint?: string | null
}

/**
 * How much article text the client may attach to one chat request. The gateway announces its
 * own budget in `GET /ai/chat/config` (`localAIContext`); these defaults reproduce the behaviour
 * of gateways that predate the budget, so an old gateway keeps working unchanged.
 */
export interface LocalAIContextBudget {
  maxEntries: number
  maxCharsPerEntry: number
  maxTotalChars: number
}

export const DEFAULT_LOCAL_AI_CONTEXT_BUDGET: LocalAIContextBudget = {
  maxEntries: 20,
  maxCharsPerEntry: 1500,
  maxTotalChars: 20 * 1500,
}

const DISABLED_CONFIG: LocalAIConfig = { baseUrl: null, token: null, mode: "gateway" }

let config: LocalAIConfig = DISABLED_CONFIG
let contextBudget: LocalAIContextBudget = { ...DEFAULT_LOCAL_AI_CONTEXT_BUDGET }

/** Runtime generation: bumped whenever the configured runtime changes, see `configureLocalAI`. */
let generation = 0
/** Aborts the requests that were started for the previous runtime generation. */
let switchController = new AbortController()

/**
 * Identity of the configured runtime. A request that is still running is cancelled when this
 * changes, so what it produces cannot be stored next to the answers of the new configuration.
 */
const runtimeIdentity = (current: LocalAIConfig) =>
  JSON.stringify([
    current.mode,
    current.baseUrl,
    current.token ? "token" : "",
    current.fingerprint ?? "",
  ])

/** Trims a user typed gateway address and drops trailing slashes, so `baseUrl + path` stays clean. */
export const normalizeLocalAIBaseUrl = (baseUrl: string | null | undefined) => {
  const normalized = baseUrl?.trim().replace(/\/+$/, "")
  return normalized ? normalized : null
}

/** Called once per app bootstrap. Passing `null` (or an empty `baseUrl`) disables local AI. */
export const configureLocalAI = (next?: Partial<LocalAIConfig> | null): LocalAIConfig => {
  const previous = config
  config = {
    baseUrl: normalizeLocalAIBaseUrl(next?.baseUrl),
    token: next?.token?.trim() || null,
    mode: next?.mode ?? "gateway",
    // Only present when the app knows the endpoint identity, so `getLocalAIConfig()` keeps its
    // shape for the apps that compare configs.
    ...(next?.fingerprint ? { fingerprint: next.fingerprint } : {}),
    fetch: next?.fetch,
    // An app registers the reporter once, so re-configuring the endpoint keeps it.
    onError: next?.onError ?? config.onError,
  }

  // A different runtime makes whatever the previous one was asked for stale: cancel it instead of
  // letting an answer of the old endpoint be stored as if it came from the new one.
  if (runtimeIdentity(previous) !== runtimeIdentity(config)) {
    generation += 1
    switchController.abort()
    switchController = new AbortController()
  }

  return config
}

/** Tells the app-owned reporter about a failed request; never throws. */
export const reportLocalAIError = (message: string) => {
  try {
    config.onError?.(message)
  } catch (error) {
    console.warn("[local-ai] the error reporter threw", error)
  }
}

/**
 * Maps the persisted `localGateway` settings (desktop / mobile) onto the runtime config.
 *
 * `enabled: false` disables local AI entirely, which keeps Folo's own AI path. `gateway` needs a
 * gateway address; `direct` needs an endpoint the app's own provider adapter can reach and gets a
 * synthetic origin, because the direct transport answers the paths locally. Fields are optional so
 * settings stored before a mode existed still resolve to `null`.
 */
export const resolveLocalAIConfig = (
  settings?: Partial<LocalAIGatewaySettings> | null,
): Partial<LocalAIConfig> | null => {
  if (!settings?.enabled) {
    return null
  }

  if (settings.mode === "direct") {
    const directBaseUrl = normalizeLocalAIBaseUrl(settings.directBaseUrl)
    if (!directBaseUrl) {
      return null
    }

    return { mode: "direct", baseUrl: LOCAL_AI_DIRECT_ORIGIN, token: null }
  }

  const baseUrl = normalizeLocalAIBaseUrl(settings.baseUrl)
  if (!baseUrl) {
    return null
  }

  return { mode: "gateway", baseUrl, token: settings.token?.trim() || null }
}

export const resetLocalAI = () => {
  configureLocalAI(DISABLED_CONFIG)
  contextBudget = { ...DEFAULT_LOCAL_AI_CONTEXT_BUDGET }
}

export const getLocalAIConfig = () => config

export const isLocalAIEnabled = () => config.baseUrl !== null

/**
 * Aborted when the configured runtime is replaced. A request that is still running then fails
 * instead of writing an answer of the previous endpoint into the caches of the new one.
 */
export const getLocalAIRequestSignal = () => switchController.signal

/** Bumped on every runtime change; a caller compares it to know whether its answer is still wanted. */
export const getLocalAIGeneration = () => generation

export const localAIUrl = (path: string) => {
  if (!config.baseUrl) {
    throw new Error("Local AI gateway is not configured")
  }

  return `${config.baseUrl}${path.startsWith("/") ? path : `/${path}`}`
}

export const getLocalAIContextBudget = (): LocalAIContextBudget => contextBudget

/**
 * Filled from the `localAIContext` field of `GET /ai/chat/config`. Missing or nonsensical values
 * fall back to the conservative defaults field by field.
 */
export const setLocalAIContextBudget = (budget?: Partial<LocalAIContextBudget> | null) => {
  const resolve = (value: number | undefined, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback

  contextBudget = {
    maxEntries: resolve(budget?.maxEntries, DEFAULT_LOCAL_AI_CONTEXT_BUDGET.maxEntries),
    maxCharsPerEntry: resolve(
      budget?.maxCharsPerEntry,
      DEFAULT_LOCAL_AI_CONTEXT_BUDGET.maxCharsPerEntry,
    ),
    maxTotalChars: resolve(budget?.maxTotalChars, DEFAULT_LOCAL_AI_CONTEXT_BUDGET.maxTotalChars),
  }

  return contextBudget
}

export const createLocalAIHeaders = (headers?: Record<string, string>) => ({
  ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
  ...headers,
})
