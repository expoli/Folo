/**
 * Notes of the reduce pre-pass, kept across restarts.
 *
 * A summary of a busy day costs one model call per eight articles, and the notes do not change
 * while the articles do not: the same day summarized again — after a restart, or later in the day —
 * should not pay for them twice. The file is a plain JSON map, capped by count and size, pruned
 * least-recently-used first; a missing, unreadable or outdated file starts empty instead of failing
 * the request, and a cache without a file (no Electron runtime in tests) simply stays in memory.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"

import { dirname } from "pathe"

export const NOTES_CACHE_VERSION = 1
export const NOTES_CACHE_LIMIT = 2000
export const NOTES_CACHE_MAX_BYTES = 2 * 1024 * 1024
const SAVE_DELAY_MS = 1000

interface StoredNote {
  note: string
  usedAt: number
}

export interface NotesCache {
  get(key: string): string | undefined
  set(key: string, value: string): void
  /** Writes a pending change now; the debounce timer does this on its own otherwise. */
  flush(): void
  readonly size: number
}

export interface NotesCacheOptions {
  /** Where the notes live. Absent keeps them in memory only. */
  file?: string
  limit?: number
  maxBytes?: number
  /** Delay before a change reaches the disk; 0 writes synchronously. */
  saveDelayMs?: number
  /** Injectable clock, so a test can age notes without waiting. */
  now?: () => number
}

const readStoredNotes = (file: string): Map<string, StoredNote> => {
  const notes = new Map<string, StoredNote>()

  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      version?: unknown
      notes?: Record<string, { note?: unknown; usedAt?: unknown }>
    }
    if (parsed?.version !== NOTES_CACHE_VERSION || !parsed.notes) return notes

    for (const [key, value] of Object.entries(parsed.notes)) {
      if (typeof value?.note !== "string" || !value.note) continue
      notes.set(key, {
        note: value.note,
        // A note without a timestamp is as old as the file: usable, but first to be pruned.
        usedAt: typeof value.usedAt === "number" ? value.usedAt : 0,
      })
    }
  } catch {
    // No file yet, or one that cannot be read: starting empty is cheaper than a failed request.
  }

  return notes
}

/** Drops the least recently used notes until both caps are met. */
const pruneNotes = (notes: Map<string, StoredNote>, limit: number, maxBytes: number) => {
  const byAge = () => [...notes.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)

  if (notes.size > limit) {
    for (const [key] of byAge().slice(0, notes.size - limit)) notes.delete(key)
  }

  let bytes = JSON.stringify(Object.fromEntries(notes)).length
  while (bytes > maxBytes && notes.size > 1) {
    const [key] = byAge()[0]!
    notes.delete(key)
    bytes = JSON.stringify(Object.fromEntries(notes)).length
  }
}

export const createNotesCache = (options: NotesCacheOptions = {}): NotesCache => {
  const { file, limit = NOTES_CACHE_LIMIT, maxBytes = NOTES_CACHE_MAX_BYTES } = options
  const saveDelayMs = options.saveDelayMs ?? SAVE_DELAY_MS
  const now = options.now ?? Date.now
  const notes = file ? readStoredNotes(file) : new Map<string, StoredNote>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty = false

  const save = () => {
    if (!file || !dirty) return

    dirty = false
    try {
      pruneNotes(notes, limit, maxBytes)
      mkdirSync(dirname(file), { recursive: true })
      // A half-written file would lose every note, so the new content lands first and is renamed
      // over the old one in one step.
      const temporary = `${file}.tmp`
      writeFileSync(
        temporary,
        JSON.stringify({ version: NOTES_CACHE_VERSION, notes: Object.fromEntries(notes) }),
      )
      renameSync(temporary, file)
    } catch {
      // A cache that cannot be written is still a working cache for this run.
    }
  }

  const scheduleSave = () => {
    dirty = true
    if (!file || saveDelayMs === 0) {
      save()
      return
    }

    if (timer) return
    timer = setTimeout(() => {
      timer = null
      save()
    }, saveDelayMs)
    // A pending save must not keep the process alive.
    timer.unref?.()
  }

  const cache: NotesCache = {
    get size() {
      return notes.size
    },
    get(key) {
      const stored = notes.get(key)
      if (!stored) return undefined

      stored.usedAt = now()
      scheduleSave()
      return stored.note
    },
    set(key, value) {
      notes.set(key, { note: value, usedAt: now() })
      scheduleSave()
    },
    flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }

      save()
    },
  }

  // An unref'd debounce does not run when the app quits: write what is pending before it does.
  if (file) process.on("exit", () => cache.flush())

  return cache
}
