/**
 * The chat pre-pass shared by the direct mode and the gateway.
 *
 * A chat prompt only carries the text of a bounded number of entries; the client sends the rest as
 * `body`, and this pass turns each one into a compact, attributable note that travels in the system
 * prompt instead of the raw text. Notes of earlier requests are reused, so the same day summarized
 * again costs nothing.
 *
 * Everything the platform owns is injected: the notes cache (a file in the desktop main process and
 * in the gateway, memory only in tests), the logger, the cancellation signal and the progress
 * callback the transports turn into their own progress events.
 */
import type { LanguageModel } from "ai"

import type { LocalAIContext } from "./context"
import { applyEntryNotes, pendingEntryTexts } from "./context"
import type { DirectCallOptions } from "./provider"
import type { NotesCache, ReduceOptions } from "./reduce"
import { summarizeEntries } from "./reduce"

/** Longest note attached per article, and for all notes together: the prompt still has a size. */
export const NOTES_ENTRY_CHARS = 600
export const NOTES_TOTAL_CHARS = 30_000

export interface ReducedChatContext {
  /** The context the prompt should render, with the notes in place of the long texts. */
  context: LocalAIContext | null
  /** Articles that travelled for the pre-pass; 0 means the prompt carried everything itself. */
  pending: number
  /** Notes that made it into the prompt. */
  attached: number
  /** Notes dropped because the note budget ran out (the articles stay listed by title). */
  dropped: number
  noteChars: number
  calls: number
  cached: number
  failed: number
}

/** Summarizes what the prompt cannot carry and attaches the notes to the context. */
export const reduceChatContext = async (params: {
  context: LocalAIContext | null | undefined
  model: LanguageModel
  /** Part of the note cache key: another model writes another note for the same article. */
  modelId: string
  language?: string | null
  call?: DirectCallOptions
  notes?: NotesCache
  /** Batch bounds and prompt wording; the gateway reads them from its environment. */
  options?: ReduceOptions
  /** Longest note per article; defaults to `NOTES_ENTRY_CHARS`. */
  noteChars?: number
  /** Total note budget; defaults to `NOTES_TOTAL_CHARS`. */
  notesTotalChars?: number
  log?: (line: string) => void
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}): Promise<ReducedChatContext> => {
  const {
    context,
    model,
    modelId,
    language,
    call,
    notes: cache,
    options,
    noteChars = NOTES_ENTRY_CHARS,
    notesTotalChars = NOTES_TOTAL_CHARS,
    log,
    signal,
    onProgress,
  } = params

  const pending = pendingEntryTexts(context)
  if (pending.length === 0) {
    return {
      context: context ?? null,
      pending: 0,
      attached: 0,
      dropped: 0,
      noteChars: 0,
      calls: 0,
      cached: 0,
      failed: 0,
    }
  }

  const startedAt = Date.now()
  log?.(`reduce: summarizing ${pending.length} article(s) the prompt cannot carry…`)
  const reduced = await summarizeEntries({
    model,
    entries: pending,
    language,
    call,
    cache,
    modelId,
    options,
    log,
    signal,
    onProgress,
  })

  // The notes are attached in the order of the entries (the more relevant ones first), so a day too
  // wide even for the note budget keeps a truthful, deterministic cut.
  const attached = new Map<number, string>()
  let attachedChars = 0
  for (const [index, note] of [...reduced.notes.entries()].sort((a, b) => a[0] - b[0])) {
    const trimmed = note.length > noteChars ? note.slice(0, noteChars) : note
    if (attachedChars + trimmed.length > notesTotalChars) break

    attached.set(index, trimmed)
    attachedChars += trimmed.length
  }

  const dropped = reduced.notes.size - attached.size
  log?.(
    `reduce: ${attached.size} of ${pending.length} entrie(s) summarised in ` +
      `${reduced.calls} call(s) (${reduced.cached} cached${
        reduced.failed > 0 ? `, ${reduced.failed} failed` : ""
      }${dropped > 0 ? `, ${dropped} over the note budget` : ""}) → ${attachedChars} note chars in ${
        Date.now() - startedAt
      }ms`,
  )

  return {
    context: applyEntryNotes(context, attached),
    pending: pending.length,
    attached: attached.size,
    dropped,
    noteChars: attachedChars,
    calls: reduced.calls,
    cached: reduced.cached,
    failed: reduced.failed,
  }
}
