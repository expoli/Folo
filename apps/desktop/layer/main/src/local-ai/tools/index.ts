/**
 * The tool set a local chat request carries.
 *
 * Only Folo's own read-only tools for now; the numbers here are the whole budget of a tool loop, so
 * an endpoint that keeps calling tools cannot turn one question into an unbounded bill.
 */
import type { ToolSet } from "ai"

import type { LocalAgentReadingToolHandlers } from "~/local-agent-reading/server"

import { createFoloReadingTools } from "./folo"

/** Model round trips one chat may spend on tools before it has to answer. */
export const LOCAL_AI_MAX_TOOL_STEPS = 6

export const createLocalAITools = (handlers: LocalAgentReadingToolHandlers): ToolSet =>
  createFoloReadingTools(handlers)

/**
 * What the chat tools read through.
 *
 * Bound by the app wiring where the reading service is built, so this module (and the chat request
 * path) stays free of Electron and can be loaded by tests that never start an app.
 */
let readingHandlers: LocalAgentReadingToolHandlers | null = null

export const setReadingToolHandlers = (handlers: LocalAgentReadingToolHandlers | null) => {
  readingHandlers = handlers
}

export const getReadingToolHandlers = (): LocalAgentReadingToolHandlers | null => readingHandlers

/**
 * Endpoints that rejected a request because it carried tools.
 *
 * Not every OpenAI-compatible endpoint speaks tool calling, and a request that carries tools fails
 * before any text arrives. Rather than probe every configured model (a request per model per start),
 * the first rejection is remembered for this app run and the next chat goes out without tools.
 */
const rejectedEndpoints = new Set<string>()

export const localAIToolSupportKey = (options: { baseUrl: string; model: string }) =>
  `${options.baseUrl}|${options.model}`

export const isToolSupportRejected = (key: string) => rejectedEndpoints.has(key)

export const markToolSupportRejected = (key: string) => {
  rejectedEndpoints.add(key)
}

/** Test seam: the memory above lives as long as the app does. */
export const resetToolSupport = () => {
  rejectedEndpoints.clear()
}

/**
 * Whether an error says the endpoint cannot do tools, rather than that this request was wrong.
 *
 * `deepseek`, `ollama` and most gateways phrase it as "tools are not supported" on a 400; some
 * report 404 for the field and a few 422. The status is only used to keep an unrelated failure (a
 * bad key, a rate limit) from silently turning the feature off for the rest of the run.
 */
const TOOL_REJECTION = new RegExp(
  [
    "\\btools?\\b[^.]{1,80}(?:not supported|unsupported|not available|does not support)",
    "(?:not supported|unsupported|does not support)[^.]{1,80}\\btools?\\b",
  ].join("|"),
  "i",
)

export const isToolRejectionError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  if (!message || !TOOL_REJECTION.test(message)) return false

  const status = (error as { statusCode?: unknown } | null)?.statusCode
  return status === undefined || status === 400 || status === 404 || status === 422
}
