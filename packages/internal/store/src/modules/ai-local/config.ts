import type { LocalAIGatewaySettings } from "@follow/shared/settings/interface"

/**
 * Local AI gateway configuration.
 *
 * By default every AI request (summary / translation / chat) is proxied through Folo's own
 * servers. When a local gateway is configured here, the shared store layer sends those
 * requests to that gateway instead, so AI runs on your own model endpoint.
 *
 * The gateway implementation lives in `tools/ai-gateway`; each app wires the configuration
 * up at bootstrap (desktop renderer / mobile `main.tsx`).
 */
export interface LocalAIConfig {
  /** Gateway origin without a trailing slash, e.g. `http://127.0.0.1:8788`. `null` disables local AI. */
  baseUrl: string | null
  /** Optional bearer token sent to the gateway. */
  token: string | null
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

const DISABLED_CONFIG: LocalAIConfig = { baseUrl: null, token: null }

let config: LocalAIConfig = DISABLED_CONFIG
let contextBudget: LocalAIContextBudget = { ...DEFAULT_LOCAL_AI_CONTEXT_BUDGET }

/** Trims a user typed gateway address and drops trailing slashes, so `baseUrl + path` stays clean. */
export const normalizeLocalAIBaseUrl = (baseUrl: string | null | undefined) => {
  const normalized = baseUrl?.trim().replace(/\/+$/, "")
  return normalized ? normalized : null
}

/** Called once per app bootstrap. Passing `null` (or an empty `baseUrl`) disables local AI. */
export const configureLocalAI = (next?: Partial<LocalAIConfig> | null): LocalAIConfig => {
  config = {
    baseUrl: normalizeLocalAIBaseUrl(next?.baseUrl),
    token: next?.token?.trim() || null,
  }

  return config
}

/**
 * Maps the persisted `localGateway` settings (desktop / mobile) onto the gateway config.
 * `enabled: false` or an empty address disables the gateway, which keeps Folo's own AI path.
 * Fields are optional so settings stored before the gateway existed still resolve to `null`.
 */
export const resolveLocalAIConfig = (
  settings?: Partial<LocalAIGatewaySettings> | null,
): Partial<LocalAIConfig> | null => {
  const baseUrl = normalizeLocalAIBaseUrl(settings?.baseUrl)
  if (!settings?.enabled || !baseUrl) {
    return null
  }

  return { baseUrl, token: settings.token?.trim() || null }
}

export const resetLocalAI = () => {
  config = DISABLED_CONFIG
  contextBudget = { ...DEFAULT_LOCAL_AI_CONTEXT_BUDGET }
}

export const getLocalAIConfig = () => config

export const isLocalAIEnabled = () => config.baseUrl !== null

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
