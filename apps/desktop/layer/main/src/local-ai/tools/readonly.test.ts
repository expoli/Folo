/**
 * The chat tools must stay read-only too.
 *
 * The panel is a second way into the same service, so the guarantee has to hold on this side as
 * well: no tool marks an entry read, writes it back, or opens the article reader (opening an entry
 * is what marks it read). A unit test of a return value cannot see that kind of regression; a scan
 * of these sources can.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

const MODULES = ["folo.ts", "index.ts"]

const sourceOf = (file: string) =>
  readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8")

const FORBIDDEN = [
  // Local and remote read-state writes.
  "markEntriesRead",
  "markEntryUnread",
  "markEntryReadStatus",
  "collectEntryIdsToMark",
  "patchMany",
  // Cache and store writes.
  "entryActions.",
  "EntryService.patch",
  "EntryService.upsert",
  "updateEntryContent",
  // UI: opening the article reader is what marks an entry read.
  "navigateEntry",
  "useNavigateEntry",
]

describe("local AI tools are read-only", () => {
  test.each(MODULES)("%s touches no read state", (file) => {
    const source = sourceOf(file)
    expect(FORBIDDEN.filter((needle) => source.includes(needle))).toEqual([])
  })

  test("only the reading tools and the digest are exposed", () => {
    const source = sourceOf("folo.ts")
    expect(source).toContain("createFoloReadingTools")
    // The four the endpoint serves, named literally so a rename is caught here.
    expect(source.match(/folo_[a-z_]+:/g)?.sort()).toEqual([
      "folo_begin_unread_scan:",
      "folo_get_entry_contents:",
      "folo_get_status:",
      "folo_list_scan_entries:",
    ])
    // The digest is the only addition, and it is named by its shared constant; a new tool would
    // have to be added to this list with an argument for why it cannot write.
    expect(source).toContain("[LOCAL_AI_DIGEST_TOOL_NAME]: tool({")
  })
})
