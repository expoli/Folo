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

const DISABLED_CONFIG: LocalAIConfig = { baseUrl: null, token: null }

let config: LocalAIConfig = DISABLED_CONFIG

const normalizeBaseUrl = (baseUrl: string | null | undefined) => {
  const normalized = baseUrl?.trim().replace(/\/+$/, "")
  return normalized ? normalized : null
}

/** Called once per app bootstrap. Passing `null` (or an empty `baseUrl`) disables local AI. */
export const configureLocalAI = (next?: Partial<LocalAIConfig> | null): LocalAIConfig => {
  config = {
    baseUrl: normalizeBaseUrl(next?.baseUrl),
    token: next?.token?.trim() || null,
  }

  return config
}

export const resetLocalAI = () => {
  config = DISABLED_CONFIG
}

export const getLocalAIConfig = () => config

export const isLocalAIEnabled = () => config.baseUrl !== null

export const localAIUrl = (path: string) => {
  if (!config.baseUrl) {
    throw new Error("Local AI gateway is not configured")
  }

  return `${config.baseUrl}${path.startsWith("/") ? path : `/${path}`}`
}

export const createLocalAIHeaders = (headers?: Record<string, string>) => ({
  ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
  ...headers,
})
