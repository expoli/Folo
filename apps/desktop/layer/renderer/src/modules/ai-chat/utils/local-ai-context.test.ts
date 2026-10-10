import { FeedViewType } from "@follow/constants"
import { resetLocalAI, setLocalAIContextBudget } from "@follow/store/ai-local/config"
import { useEntryStore } from "@follow/store/entry/store"
import type { EntryModel } from "@follow/store/entry/types"
import { beforeEach, describe, expect, test } from "vitest"

import type { AIChatContextBlock, BizUIMessage } from "../store/types"
import { buildLocalAIContext } from "./local-ai-context"

type MessageParts = BizUIMessage["parts"]

const createEntry = (id: string, overrides: Partial<EntryModel> = {}): EntryModel => ({
  id,
  guid: `${id}-guid`,
  insertedAt: new Date("2026-01-01T00:00:00.000Z"),
  publishedAt: new Date("2026-01-01T00:00:00.000Z"),
  title: `Title ${id}`,
  url: `https://example.com/${id}`,
  feedId: `feed-${id}`,
  content: `Body ${id}`,
  read: false,
  ...overrides,
})

const setEntries = (
  entries: EntryModel[],
  allViewIds: string[] = entries.map((entry) => entry.id),
) => {
  useEntryStore.setState({
    data: Object.fromEntries(entries.map((entry) => [entry.id, entry])),
    entryIdByView: {
      [FeedViewType.All]: new Set(allViewIds),
    } as Record<FeedViewType, Set<string>>,
  })
}

const blockPart = (blocks: AIChatContextBlock[]): MessageParts[number] => ({
  type: "data-block",
  data: blocks,
})

const questionPart = (text: string): MessageParts[number] => ({
  type: "data-rich-text",
  data: { state: "{}", text },
})

const mainEntryBlock = (entryId: string): AIChatContextBlock => ({
  id: `block-${entryId}`,
  type: "mainEntry",
  value: entryId,
})

const allEntriesBlock = (): AIChatContextBlock => ({
  id: "block-view",
  type: "mainView",
  value: String(FeedViewType.All),
})

const unreadOnlyBlock = (): AIChatContextBlock => ({
  id: "block-unread",
  type: "unreadOnly",
  value: "",
})

describe("buildLocalAIContext", () => {
  beforeEach(() => {
    resetLocalAI()
    setEntries([])
  })

  test("sends a single referenced article in full", () => {
    const content = "long ".repeat(1000).trim()
    setEntries([createEntry("entry-1", { content })])

    const context = buildLocalAIContext([blockPart([mainEntryBlock("entry-1")])])

    expect(context?.entries).toHaveLength(1)
    expect(context?.entries[0]?.content).toBe(content)
    expect(context?.blocks).toEqual([{ type: "mainEntry", value: "entry-1" }])
  })

  test("marks the text it has to cut for a single article", () => {
    setLocalAIContextBudget({ maxTotalChars: 1000 })
    setEntries([createEntry("entry-1", { content: "x".repeat(5000) })])

    const context = buildLocalAIContext([blockPart([mainEntryBlock("entry-1")])])

    expect(context?.entries[0]?.content).toBe(`${"x".repeat(1000)}\n…[truncated 4000 chars]`)
  })

  test("keeps the per-entry limit when several articles are attached", () => {
    setLocalAIContextBudget({ maxCharsPerEntry: 100, maxTotalChars: 10_000 })
    setEntries([
      createEntry("entry-old", {
        publishedAt: new Date("2026-01-01T00:00:00.000Z"),
        content: "a".repeat(500),
      }),
      createEntry("entry-new", {
        publishedAt: new Date("2026-02-01T00:00:00.000Z"),
        content: "b".repeat(500),
      }),
    ])

    const context = buildLocalAIContext([blockPart([allEntriesBlock()])])

    expect(context?.entries.map((entry) => entry.content)).toEqual([
      `${"b".repeat(100)}\n…[truncated 400 chars]`,
      `${"a".repeat(100)}\n…[truncated 400 chars]`,
    ])
  })

  test("orders explicit references first, then question overlap, then recency", () => {
    setLocalAIContextBudget({ maxTotalChars: 10_000 })
    setEntries([
      createEntry("entry-newest", {
        publishedAt: new Date("2026-03-01T00:00:00.000Z"),
        content: "unrelated",
      }),
      createEntry("entry-matching", {
        publishedAt: new Date("2026-02-01T00:00:00.000Z"),
        content: "all about quantum computing",
      }),
      createEntry("entry-explicit", {
        publishedAt: new Date("2026-01-01T00:00:00.000Z"),
        content: "referenced on purpose",
      }),
    ])

    const context = buildLocalAIContext(
      [blockPart([allEntriesBlock(), mainEntryBlock("entry-explicit")]), questionPart("quantum?")],
      { question: "quantum?" },
    )

    expect(context?.entries.map((entry) => entry.id)).toEqual([
      "entry-explicit",
      "entry-matching",
      "entry-newest",
    ])
  })

  test("stops at the total budget and marks the entry it cuts", () => {
    setLocalAIContextBudget({ maxCharsPerEntry: 1000, maxTotalChars: 1000 })
    setEntries([
      createEntry("entry-1", {
        publishedAt: new Date("2026-03-01T00:00:00.000Z"),
        content: "a".repeat(700),
      }),
      createEntry("entry-2", {
        publishedAt: new Date("2026-02-01T00:00:00.000Z"),
        content: "b".repeat(700),
      }),
      createEntry("entry-3", {
        publishedAt: new Date("2026-01-01T00:00:00.000Z"),
        content: "c".repeat(700),
      }),
    ])

    const context = buildLocalAIContext([blockPart([allEntriesBlock()])])

    expect(context?.entries.map((entry) => entry.id)).toEqual(["entry-1", "entry-2"])
    expect(context?.entries[0]?.content).toBe("a".repeat(700))
    expect(context?.entries[1]?.content).toBe(`${"b".repeat(300)}\n…[truncated 400 chars]`)
  })

  test("honors the entry count limit", () => {
    setLocalAIContextBudget({ maxEntries: 1, maxTotalChars: 10_000 })
    setEntries([createEntry("entry-1"), createEntry("entry-2")])

    const context = buildLocalAIContext([blockPart([allEntriesBlock()])])

    expect(context?.entries.map((entry) => entry.id)).toEqual(["entry-1"])
  })

  test("only sends unread entries for an unreadOnly block", () => {
    setEntries([
      createEntry("entry-read", { read: true }),
      createEntry("entry-unread", { read: false }),
    ])

    const context = buildLocalAIContext([blockPart([unreadOnlyBlock()])])

    expect(context?.entries.map((entry) => entry.id)).toEqual(["entry-unread"])
  })

  test("keeps the entry source fields", () => {
    const publishedAt = new Date("2026-02-03T04:05:06.000Z")
    setEntries([
      createEntry("entry-1", {
        publishedAt,
        title: "A title",
        url: "https://example.com/a",
        feedId: "feed-1",
        description: "A description",
        content: null,
        readabilityContent: null,
      }),
    ])

    const context = buildLocalAIContext([blockPart([mainEntryBlock("entry-1")])])

    expect(context?.entries[0]).toEqual({
      id: "entry-1",
      title: "A title",
      url: "https://example.com/a",
      feedId: "feed-1",
      publishedAt: publishedAt.toISOString(),
      content: "A description",
    })
  })

  test("returns null without blocks or without resolvable entries", () => {
    setEntries([createEntry("entry-1")])

    expect(buildLocalAIContext([questionPart("hello")])).toBeNull()
    expect(buildLocalAIContext([blockPart([mainEntryBlock("missing-entry")])])).toBeNull()
  })
})
