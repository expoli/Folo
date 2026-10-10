/**
 * Contract shared by every layer of the local AI support.
 *
 * Local AI can run in two modes: `gateway` sends the request to a self-hosted gateway process
 * (`tools/ai-gateway`), `direct` calls an OpenAI-compatible endpoint from the desktop main
 * process itself.
 */

/** Which local AI runtime serves summary / translation / chat. */
export type LocalAIMode = "gateway" | "direct"

/**
 * Origin stand-in of `direct` mode. `localAIUrl()` needs an origin to build request paths, but
 * the paths are answered by the main process there, so the direct fetch ignores the host.
 */
export const LOCAL_AI_DIRECT_ORIGIN = "http://local-ai-direct.invalid"

/** Channel the main process pushes chat stream events on. */
export const LOCAL_AI_CHAT_STREAM_CHANNEL = "localAI.chatStream"

/** One event of an open chat stream, pushed from the main process to the renderer. */
export type LocalAIChatStreamEvent =
  | { streamId: string; chunk: string }
  | { streamId: string; done: true }
  | { streamId: string; error: string }

/** OpenAI-compatible endpoint the main process calls in `direct` mode. */
export interface LocalAIDirectConfig {
  /** Endpoint root including the version segment, e.g. `https://api.openai.com/v1`. */
  baseUrl: string
  /** Model used when a request does not name one. */
  model: string
  /** Models offered in the picker; empty falls back to `model`. */
  models: string[]
}

/** Reply of the `request` IPC method: a complete HTTP response, body as text. */
export interface LocalAIHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/** One path of the local AI contract, sent from the renderer to the main process. */
export interface LocalAIRequestInput {
  /** Request path, may carry a query string. The origin is irrelevant: the main process serves it. */
  path: string
  method: string
  /** Request body as the AI SDK serialized it; `null` for requests without one. */
  body: string | null
  config: LocalAIDirectConfig
}

/** Chat is streamed, so it opens a channel instead of answering in one piece. */
export interface LocalAIChatStreamInput {
  body: string | null
  config: LocalAIDirectConfig
}

/** Handle of an open chat stream; `body` carries the reply when no stream was opened. */
export interface LocalAIChatStreamOpenResult {
  streamId: string | null
  status: number
  headers: Record<string, string>
  body: string | null
}

/**
 * Outcome of a connection test, splitting the situations the settings UI reports: the model
 * answered, the token / API key was rejected, the endpoint is not reachable, or the upstream
 * model call failed.
 */
export type LocalAIProbeResult =
  | {
      kind: "ok"
      /** Round trip of the model call the probe spends, `null` if only liveness was checked. */
      latencyMs: number | null
      upstream: string | null
      defaultModel: string | null
    }
  | { kind: "token-rejected" }
  | { kind: "unreachable"; detail: string }
  | { kind: "upstream-error"; detail: string }

/** Result of `setApiKey`; a failure is reported instead of thrown so the UI can explain it. */
export type LocalAISetApiKeyResult =
  | { ok: true; hasApiKey: boolean }
  | { ok: false; reason: "encryption-unavailable" | "empty-key" | "write-failed"; message: string }
