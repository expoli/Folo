/**
 * Request-shaping helpers of the app's own AI provider, copied from `tools/ai-gateway/server.mjs`
 * so the direct mode and a self-hosted gateway produce the same prompts.
 */
import { languageName, NO_CONTEXT_NOTE } from "./prompts"

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
  /** Text the prompt is too small to carry verbatim; the pre-pass summarizes it into `note`. */
  body?: unknown
  note?: unknown
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
  coverage?: ContextCoverage
}

interface ContextCoverage {
  /** Entries the client's selection matched before the text budget was applied. */
  matched?: unknown
  /** The period the prompt named ("Today"), when it named one. */
  window?: unknown
}

const asText = (value: unknown) => (typeof value === "string" && value ? value : "")

/** Entry texts the prompt cannot carry in full, in prompt order, for the reduce pre-pass. */
export interface PendingEntryText {
  /** 1-based position among the entries, so a note can be attributed to its article. */
  index: number
  title?: string
  url?: string
  body: string
}

export const pendingEntryTexts = (context: LocalAIContext | null | undefined): PendingEntryText[] =>
  (Array.isArray(context?.entries) ? context.entries : [])
    .map((entry, position) => ({ entry, index: position + 1 }))
    .filter(({ entry }) => !asText(entry.content) && asText(entry.body))
    .map(({ entry, index }) => ({
      index,
      title: asText(entry.title) || undefined,
      url: asText(entry.url) || undefined,
      body: asText(entry.body),
    }))

/** Adds the notes of the pre-pass, leaving the entries that arrived with their text untouched. */
export const applyEntryNotes = (
  context: LocalAIContext | null | undefined,
  notes: Map<number, string>,
): LocalAIContext | null => {
  if (!context || notes.size === 0) return context ?? null

  if (!Array.isArray(context.entries)) return context

  return {
    ...context,
    entries: context.entries.map((entry, position) => {
      const note = notes.get(position + 1)
      return note && !asText(entry.content) ? { ...entry, note } : entry
    }),
  }
}

/**
 * What the selection matched versus what the text budget could carry. A summary of "today" must not
 * read as if it covered the day when only the newest articles travelled with the request, and an
 * entry listed by title alone must not be summarised as if it had been read.
 */
const formatCoverage = (context: LocalAIContext, entries: ContextEntry[]): string => {
  const matched =
    typeof context.coverage?.matched === "number" ? context.coverage.matched : entries.length
  const window = asText(context.coverage?.window)

  if (matched === 0 && !window) return ""

  const withText = entries.filter((entry) => asText(entry.content)).length
  const fromNotes = entries.filter((entry) => !asText(entry.content) && asText(entry.note)).length
  const listedOnly = entries.length - withText - fromNotes
  const leftOut = Math.max(0, matched - entries.length)

  // A plain chat whose articles all carry text has nothing to report: stay out of its prompt.
  if (!window && listedOnly === 0 && leftOut === 0 && fromNotes === 0) return ""

  const counts = [
    window ? `window "${window}"` : "",
    `${matched} matched`,
    `${withText} with text`,
    fromNotes > 0 ? `${fromNotes} summarised from their text` : "",
    listedOnly > 0 ? `${listedOnly} title-only` : "",
    leftOut > 0 ? `${leftOut} not listed` : "",
  ].filter(Boolean)

  return [
    `Coverage: ${counts.join(", ")}.`,
    matched === 0 && window
      ? "The window holds no entry: say so instead of describing entries outside it."
      : "",
    listedOnly > 0
      ? 'Entries marked "(no text attached)" were not read — never summarise them as if their content were known.'
      : "",
  ]
    .filter(Boolean)
    .join(" ")
}

/** Renders the entries the client resolved from the chat context bar. */
export const formatLocalContext = (context: LocalAIContext | null | undefined): string => {
  const contextEntries = Array.isArray(context?.entries) ? context.entries : []
  const feeds = Array.isArray(context?.feeds) ? context.feeds : []
  const coverage = formatCoverage(context ?? {}, contextEntries)
  if (contextEntries.length === 0 && feeds.length === 0 && coverage === "") return ""

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
      const body =
        asText(entry.content) ||
        (asText(entry.note)
          ? `(summarised from its full text)\n${asText(entry.note)}`
          : "(no text attached)")

      return `### [${index + 1}] ${header}\n${body}`
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

  const body = [coverage, entries, feedSection].filter(Boolean).join("\n\n")

  return [header, body].filter(Boolean).join("\n\n")
}

/** Joins the chat system prompt with the attached context, or with the "no context" note. */
/**
 * System prompt of a chat request: the base prompt, the language the app runs in (a shortcut's own
 * prompt may be written in another language, and the answer should still match the interface) and
 * whatever entries the client attached.
 */
export const buildChatSystemPrompt = (
  systemPrompt: string,
  localContext: string,
  language?: string | null,
) =>
  [
    systemPrompt,
    language ? `Reply in ${languageName(language)}.` : "",
    localContext,
    localContext === "" ? NO_CONTEXT_NOTE : "",
  ]
    .filter(Boolean)
    .join("\n\n")

/** Counts what arrived with a chat request, for the log line the gateway also prints. */
export const describeChatContext = (context: LocalAIContext | null | undefined) => {
  const entries = Array.isArray(context?.entries) ? context.entries : []
  const feeds = Array.isArray(context?.feeds) ? context.feeds : []
  const blocks = Array.isArray(context?.blocks) ? context.blocks : []

  let contextChars = 0
  let withText = 0
  let reduceTexts = 0
  for (const entry of entries) {
    if (entry && typeof entry.content === "string" && entry.content) {
      contextChars += entry.content.length
      withText += 1
    }

    if (entry && !asText(entry.content) && asText(entry.body)) reduceTexts += 1
  }

  const matched =
    typeof context?.coverage?.matched === "number" ? context.coverage.matched : entries.length
  // The period the prompt asked about: without it a log line cannot tell whether a summary of
  // "today" was scoped to today or to the whole view.
  const window = typeof context?.coverage?.window === "string" ? context.coverage.window : ""

  // The selection the client sent, so a wrong scope (a feed summary that covered every feed) is
  // visible in the log instead of having to be inferred from the answer.
  const selection = blocks
    .map((block) => `${block.type}:${String(block.value ?? "").slice(0, 24)}`)
    .join(",")

  return {
    blocks: blocks.length,
    entries: entries.length,
    withText,
    /** Articles the client sent for the reduce pre-pass; zero means it never asked for one. */
    reduceTexts,
    matched,
    window,
    feeds: feeds.length,
    contextChars,
    selection,
  }
}
