/**
 * Request-shaping helpers of the app's own AI provider, copied from `tools/ai-gateway/server.mjs`
 * so the direct mode and a self-hosted gateway produce the same prompts.
 */
import { NO_CONTEXT_NOTE } from "./prompts"

interface ChatPart {
  type?: unknown
  text?: unknown
  data?: unknown
}

interface ChatMessage {
  role?: unknown
  parts?: unknown
}

export interface ModelMessage {
  role: "user" | "assistant" | "system"
  content: string
}

/** Flattens AI SDK UI messages, including Folo's `data-rich-text` / `data-*` parts, into text. */
export const messageText = (message: ChatMessage | null | undefined): string => {
  const parts = Array.isArray(message?.parts) ? (message.parts as ChatPart[]) : []

  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      if (part.type === "text" && typeof part.text === "string") return part.text
      if (typeof part.type === "string" && part.type.startsWith("data-")) {
        const { data } = part
        if (
          data &&
          typeof data === "object" &&
          typeof (data as { text?: unknown }).text === "string"
        )
          return (data as { text: string }).text
      }
      return ""
    })
    .filter(Boolean)
    .join("\n\n")
    .trim()
}

export const toModelMessages = (messages: unknown): ModelMessage[] => {
  if (!Array.isArray(messages)) return []

  return messages
    .map((message) => {
      const candidate = (message ?? {}) as ChatMessage
      const text = messageText(candidate)
      if (!text) return null

      const role: ModelMessage["role"] =
        candidate.role === "assistant"
          ? "assistant"
          : candidate.role === "system"
            ? "system"
            : "user"

      return { role, content: text }
    })
    .filter((message): message is ModelMessage => message !== null)
}

interface ContextEntry {
  title?: unknown
  url?: unknown
  publishedAt?: unknown
  content?: unknown
}

interface ContextFeed {
  title?: unknown
  url?: unknown
  description?: unknown
}

interface ContextBlock {
  type?: unknown
  value?: unknown
}

export interface LocalAIContext {
  entries?: ContextEntry[]
  feeds?: ContextFeed[]
  blocks?: ContextBlock[]
}

const asText = (value: unknown) => (typeof value === "string" && value ? value : "")

/** Renders the entries the client resolved from the chat context bar. */
export const formatLocalContext = (context: LocalAIContext | null | undefined): string => {
  const contextEntries = Array.isArray(context?.entries) ? context.entries : []
  const feeds = Array.isArray(context?.feeds) ? context.feeds : []
  if (contextEntries.length === 0 && feeds.length === 0) return ""

  const contextBlocks = Array.isArray(context?.blocks) ? context.blocks : []
  const blocks = contextBlocks
    .map((block) => (block ? `${asText(block.type)}="${asText(block.value)}"` : ""))
    .filter(Boolean)
    .join(", ")

  const entries = contextEntries
    .map((entry, index) => {
      const header = [
        asText(entry.title) || "(untitled)",
        asText(entry.url),
        asText(entry.publishedAt),
      ]
        .filter(Boolean)
        .join(" — ")
      return `### [${index + 1}] ${header}\n${asText(entry.content) || "(no content available)"}`
    })
    .join("\n\n")

  const feedSection = feeds
    .map((feed, index) => {
      const header = [asText(feed.title) || "(untitled)", asText(feed.url)]
        .filter(Boolean)
        .join(" — ")
      return `### [F${index + 1}] ${header}\n${asText(feed.description) || "(no description)"}`
    })
    .join("\n\n")

  const header = [
    contextEntries.length > 0
      ? "The user is currently looking at the following entries in Folo."
      : "",
    feeds.length > 0
      ? "Candidate feeds the user could subscribe to (pick only from this list):"
      : "",
    blocks ? `Context selection: ${blocks}` : "",
  ]
    .filter(Boolean)
    .join("\n")

  const body = [entries, feedSection].filter(Boolean).join("\n\n")

  return [header, body].filter(Boolean).join("\n\n")
}

/** Joins the chat system prompt with the attached context, or with the "no context" note. */
export const buildChatSystemPrompt = (systemPrompt: string, localContext: string) =>
  [systemPrompt, localContext, localContext === "" ? NO_CONTEXT_NOTE : ""]
    .filter(Boolean)
    .join("\n\n")

/** Counts what arrived with a chat request, for the log line the gateway also prints. */
export const describeChatContext = (context: LocalAIContext | null | undefined) => {
  const entries = Array.isArray(context?.entries) ? context.entries : []
  const feeds = Array.isArray(context?.feeds) ? context.feeds : []
  const blocks = Array.isArray(context?.blocks) ? context.blocks : []

  let contextChars = 0
  for (const entry of entries) {
    if (entry && typeof entry.content === "string") contextChars += entry.content.length
  }

  // The selection the client sent, so a wrong scope (a feed summary that covered every feed) is
  // visible in the log instead of having to be inferred from the answer.
  const selection = blocks
    .map((block) => `${block.type}:${String(block.value ?? "").slice(0, 24)}`)
    .join(",")

  return {
    blocks: blocks.length,
    entries: entries.length,
    feeds: feeds.length,
    contextChars,
    selection,
  }
}
