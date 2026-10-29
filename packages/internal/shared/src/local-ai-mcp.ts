/**
 * MCP services a chat request may use.
 *
 * The services are configured in the renderer (Settings → AI → MCP), and the chat request is the
 * only thing that crosses into the main process, so this is the shape it carries: what a connection
 * needs and nothing else. Status fields the settings keep for their own UI (`isConnected`,
 * `toolCount`, timestamps) are deliberately absent — a stale copy of them would be worse than none.
 */
import { z } from "zod"

/** Transports the app can open. stdio servers are not supported: the app spawns no processes. */
export const LOCAL_AI_MCP_TRANSPORTS = ["streamable-http", "sse"] as const

export const LOCAL_AI_MCP_LIMITS = {
  /** Services one request may open. Beyond this the prompt pays more than the answers gain. */
  maxServices: 8,
  /** Tools one request may offer, across every service. Folo's own four come on top. */
  maxTools: 26,
  /** Characters one tool result may hand to the model; a service may return far more. */
  resultChars: 16_000,
  /** Characters of a tool description the model sees. */
  descriptionChars: 300,
  /** Opening a connection and listing its tools. A slow server must not stall the chat. */
  connectTimeoutMs: 2_500,
  /** One tool call, so a stuck server cannot hold the loop. */
  callTimeoutMs: 15_000,
} as const

const httpUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === "http:" || url.protocol === "https:"
    } catch {
      return false
    }
  }, "expected an http(s) URL")

export const localAIMcpServiceSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
    transportType: z.enum(LOCAL_AI_MCP_TRANSPORTS),
    url: httpUrlSchema,
    /** Headers the service authenticates with; carried per request, never stored by the app. */
    headers: z.record(z.string().max(128), z.string().max(4096)).optional(),
  })
  .strict()

export type LocalAIMcpService = z.infer<typeof localAIMcpServiceSchema>

/**
 * The services a request may use.
 *
 * One malformed entry must not cost the user the whole chat, so entries are validated one by one
 * and the invalid ones are dropped; the list is capped at `maxServices`.
 */
export const parseLocalAIMcpServices = (value: unknown): LocalAIMcpService[] => {
  if (!Array.isArray(value) || value.length === 0) return []

  const services: LocalAIMcpService[] = []
  for (const entry of value) {
    const parsed = localAIMcpServiceSchema.safeParse(entry)
    if (parsed.success) services.push(parsed.data)
    if (services.length >= LOCAL_AI_MCP_LIMITS.maxServices) break
  }

  return services
}
