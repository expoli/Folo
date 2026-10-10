import { net } from "electron"

/** Minimal HTTP response helpers, shared by every direct-mode route. */

export const jsonResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })

/**
 * Chromium's network stack, so direct-mode requests follow the same proxy as the rest of the app.
 * Plain `fetch` (undici) only sees an in-app proxy and fails behind a system proxy.
 */
export const netFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  net.fetch(input instanceof Request ? input : input.toString(), init)) as typeof globalThis.fetch

/** Parses an IPC request body that the renderer sent as text. Throws a readable error. */
export const parseJsonBody = (body: string | null): Record<string, unknown> => {
  if (!body || !body.trim()) return {}

  const parsed: unknown = JSON.parse(body)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object")
  }

  return parsed as Record<string, unknown>
}
