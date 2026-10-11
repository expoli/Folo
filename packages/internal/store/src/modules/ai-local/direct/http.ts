/** Minimal HTTP response helpers of the direct mode, shared by the desktop and mobile apps. */

export const jsonResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })

/** Parses a request body that the transport handed over as text. Throws a readable error. */
export const parseJsonBody = (body: string | null): Record<string, unknown> => {
  if (!body || !body.trim()) return {}

  const parsed: unknown = JSON.parse(body)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object")
  }

  return parsed as Record<string, unknown>
}
