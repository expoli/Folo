import { describe, expect, test } from "vitest"

import {
  batchEntries,
  readBatchNotes,
  REDUCE_BATCH_CHARS,
  REDUCE_BATCH_ENTRIES,
  textHash,
} from "./reduce"

const entry = (index: number, body: string) => ({ index, title: `Entry ${index}`, body })

describe("batchEntries", () => {
  test("keeps a batch within the entry count", () => {
    const batches = batchEntries(
      Array.from({ length: REDUCE_BATCH_ENTRIES + 1 }, (_, position) =>
        entry(position + 1, "text"),
      ),
    )

    expect(batches.map((batch) => batch.length)).toEqual([REDUCE_BATCH_ENTRIES, 1])
  })

  test("keeps a batch within the text budget, and never leaves an article alone in a bad batch", () => {
    const long = "x".repeat(REDUCE_BATCH_CHARS)
    const batches = batchEntries([entry(1, long), entry(2, "small"), entry(3, "small")])

    // The long article takes a batch of its own; the short ones share the next one.
    expect(batches.map((batch) => batch.map((item) => item.index))).toEqual([[1], [2, 3]])
  })

  test("returns nothing for no entries", () => {
    expect(batchEntries([])).toEqual([])
  })
})

describe("readBatchNotes", () => {
  test("reads an object keyed by article number", () => {
    const notes = readBatchNotes('{"1": "First note", "2": "Second note"}', [1, 2])

    expect([...notes.entries()]).toEqual([
      [1, "First note"],
      [2, "Second note"],
    ])
  })

  test("reads a fenced reply with prose around it", () => {
    const notes = readBatchNotes(
      'Here you go:\n```json\n{"1": "Only note"}\n```\nHope that helps.',
      [1],
    )

    expect(notes.get(1)).toBe("Only note")
  })

  test("reads an array of objects", () => {
    const notes = readBatchNotes('[{"index": 2, "note": "Array note"}]', [1, 2])

    expect([...notes.entries()]).toEqual([[2, "Array note"]])
  })

  test("reads a numbered list a model replied instead of JSON", () => {
    const notes = readBatchNotes("1. First note\n2) Second note", [1, 2])

    expect([...notes.entries()]).toEqual([
      [1, "First note"],
      [2, "Second note"],
    ])
  })

  test("maps the batch-local numbering of a reply onto the articles of the batch", () => {
    // The prompt numbered its articles 60…61 while the model answered 1…2: the batch keeps its
    // order, so these are the notes of those articles and not a batch to throw away.
    expect([...readBatchNotes('{"1": "Sixty", "2": "Sixty-one"}', [60, 61]).entries()]).toEqual([
      [60, "Sixty"],
      [61, "Sixty-one"],
    ])
    expect([...readBatchNotes("1. Sixty\n2. Sixty-one", [60, 61]).entries()]).toEqual([
      [60, "Sixty"],
      [61, "Sixty-one"],
    ])
  })

  test("does not map a reply whose count does not match the batch", () => {
    expect(readBatchNotes('{"1": "Only one"}', [60, 61]).size).toBe(0)
  })

  test("drops notes of articles that were not asked about, and empty ones", () => {
    const notes = readBatchNotes('{"1": "", "9": "Not asked for"}', [1, 2])

    expect(notes.size).toBe(0)
  })

  test("reads nothing out of an unusable reply", () => {
    expect(readBatchNotes("I cannot help with that.", [1]).size).toBe(0)
    expect(readBatchNotes(null, [1]).size).toBe(0)
  })
})

describe("textHash", () => {
  test("stays stable per text and changes with it", () => {
    expect(textHash("an article")).toBe(textHash("an article"))
    expect(textHash("an article")).not.toBe(textHash("an article!"))
  })
})
