import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

import { join } from "pathe"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { createNotesCache, NOTES_CACHE_VERSION } from "./notes-cache"

let directory: string
let file: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "folo-notes-"))
  file = join(directory, "nested", "notes.json")
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

const readFile = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>

describe("createNotesCache", () => {
  test("keeps notes for the next run", () => {
    const first = createNotesCache({ file, saveDelayMs: 0 })
    first.set("model|en|Article|abc", "A note about the article")
    expect(first.size).toBe(1)

    const second = createNotesCache({ file })
    expect(second.get("model|en|Article|abc")).toBe("A note about the article")
  })

  test("writes atomically and leaves no temporary file behind", () => {
    const cache = createNotesCache({ file, saveDelayMs: 0 })
    cache.set("key", "note")

    expect(Object.keys(readFile().notes as object)).toEqual(["key"])
    expect(() => readFileSync(`${file}.tmp`, "utf8")).toThrow()
  })

  test("debounces a burst of notes into one write", async () => {
    const cache = createNotesCache({ file, saveDelayMs: 10 })
    cache.set("one", "note one")
    cache.set("two", "note two")

    // Nothing on disk until the debounce elapses...
    expect(() => readFileSync(file, "utf8")).toThrow()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(Object.keys(readFile().notes as object).sort()).toEqual(["one", "two"])

    cache.flush()
  })

  test("drops the least recently used notes when it is full", () => {
    let clock = 1000
    const cache = createNotesCache({ file, limit: 2, saveDelayMs: 0, now: () => clock })

    cache.set("oldest", "note")
    clock += 10
    cache.set("middle", "note")
    clock += 10
    expect(cache.get("oldest")).toBe("note")
    clock += 10
    cache.set("newest", "note")

    // Reading `oldest` made it the most recent, so `middle` goes first.
    const reloaded = createNotesCache({ file, limit: 2 })
    expect(reloaded.get("oldest")).toBe("note")
    expect(reloaded.get("newest")).toBe("note")
    expect(reloaded.size).toBe(2)
  })

  test("stays under the size cap", () => {
    const cache = createNotesCache({ file, limit: 100, maxBytes: 400, saveDelayMs: 0 })
    for (let index = 0; index < 20; index += 1) cache.set(`key-${index}`, "x".repeat(60))

    const size = JSON.stringify(readFile()).length
    expect(size).toBeLessThanOrEqual(600)
    expect(cache.size).toBeLessThan(20)
  })

  test("starts empty for a corrupt or outdated file", () => {
    writeFileSync(file.replace(/\/nested\//, "/"), "not json at all")
    expect(createNotesCache({ file }).size).toBe(0)

    writeFileSync(
      file.replace(/\/nested\//, "/"),
      JSON.stringify({ version: 999, notes: { a: { note: "old", usedAt: 1 } } }),
    )
    expect(createNotesCache({ file }).size).toBe(0)
  })

  test("writes the version it can read back", () => {
    const cache = createNotesCache({ file, saveDelayMs: 0 })
    cache.set("key", "note")

    expect(readFile().version).toBe(NOTES_CACHE_VERSION)
  })

  test("works without a file", () => {
    const cache = createNotesCache()
    cache.set("key", "note")
    cache.flush()

    expect(cache.get("key")).toBe("note")
  })
})
