/**
 * Reading must never change what the user has read.
 *
 * The endpoint has no mark-as-read tool, and this side has no write path at all: it reads the
 * database, the account API and the pending-read overlay, and returns text. A guard on the module's
 * own sources keeps a future change from quietly reaching for the read-state machinery — the kind of
 * regression that would be invisible in a unit test of a return value.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const MODULES = [
  "types.ts",
  "cursor.ts",
  "plan.ts",
  "enumerate.ts",
  "resolve.ts",
  "account.ts",
  "cancel.ts",
  "bridge.ts",
  "deps.ts",
  "failure.ts",
]

const sourceOf = (file: string) =>
  readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8")

const FORBIDDEN = [
  // Local and remote read-state writes.
  "markEntriesRead",
  "markEntryUnread",
  "markEntryReadStatus",
  "collectEntryIdsToMark",
  "patchMany",
  // The app's detail fetch also stores the entry with `read: false`, so reading uses the API.
  "entrySyncServices",
  // Cache and store writes.
  "entryActions.",
  "EntryService.patch",
  "EntryService.upsert",
  "updateEntryContent",
  // UI: opening the article reader is what marks an entry read.
  "navigateEntry",
  "useNavigateEntry",
  "openEntry",
]

describe("local agent reading is read-only", () => {
  it.each(MODULES)("%s does not touch read state or the entry reader", (file) => {
    const source = sourceOf(file)
    const found = FORBIDDEN.filter((needle) => source.includes(needle))
    expect(found).toEqual([])
  })

  it("deps reads the database without writing it", () => {
    const source = sourceOf("deps.ts")
    expect(source).toContain("EntryService.getEntryMany")
    expect(source).not.toMatch(/EntryService\.(patch|upsertMany|deleteMany|reset)/)
  })
})
