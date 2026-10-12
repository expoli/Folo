/** Minimal HTTP response helpers of the direct mode, shared by the desktop and mobile apps. */
import { badRequest } from "./errors"

export const jsonResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })

/** Parses a request body that the transport handed over as text. Throws a readable error. */
export const parseJsonBody = (body: string | null): Record<string, unknown> => {
  if (!body || !body.trim()) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    throw badRequest(
      `Request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest("Request body must be a JSON object")
  }

  return parsed as Record<string, unknown>
}
