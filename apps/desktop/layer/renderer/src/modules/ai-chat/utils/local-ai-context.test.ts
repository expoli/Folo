import { FeedViewType } from "@follow/constants"
import { resetLocalAI, setLocalAIContextBudget } from "@follow/store/ai-local/config"
import { useEntryStore } from "@follow/store/entry/store"
import type { EntryModel } from "@follow/store/entry/types"
import dayjs from "dayjs"
import { beforeEach, describe, expect, test } from "vitest"

import type { AIChatContextBlock, BizUIMessage } from "../store/types"
import { buildLocalAIContext, parseMentionDateWindow } from "./local-ai-context"

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

// Folo's built-in shortcuts send an empty context block and let the server read the timeline; a
// local gateway cannot, so the client gathers the entries the prompt's date window points at.
describe("implicit timeline context", () => {
  const now = dayjs("2026-01-02T12:00:00.000Z")

  beforeEach(() => {
    resetLocalAI()
    setEntries([])
  })

  test("gathers the entries of a relative date mention", () => {
    setEntries([
      createEntry("recent", { publishedAt: new Date("2026-01-02T09:00:00.000Z") }),
      createEntry("older", { publishedAt: new Date("2025-12-30T09:00:00.000Z") }),
    ])

    const context = buildLocalAIContext(
      [questionPart('Summarize <mention-date text="24hoursago"></mention-date>.')],
      { now },
    )

    expect(context?.blocks).toEqual([{ type: "timeline", value: "last 24 hours" }])
    expect(context?.entries.map((entry) => entry.id)).toEqual(["recent"])
  })

  test("reads an explicit start/end window, newest first", () => {
    setEntries([
      createEntry("a", { publishedAt: new Date("2026-01-01T08:00:00.000Z") }),
      createEntry("b", { publishedAt: new Date("2026-01-01T20:00:00.000Z") }),
      createEntry("c", { publishedAt: new Date("2026-01-02T08:00:00.000Z") }),
    ])

    const context = buildLocalAIContext(
      [
        questionPart(
          '<mention-date start="2026-01-01T00:00:00+00:00" end="2026-01-02T00:00:00+00:00" text="yesterday"></mention-date>',
        ),
      ],
      { now },
    )

    expect(context?.entries.map((entry) => entry.id)).toEqual(["b", "a"])
  })

  test("shares the text budget between the entries of a timeline", () => {
    setLocalAIContextBudget({ maxEntries: 2, maxCharsPerEntry: 1500, maxTotalChars: 100 })
    setEntries([
      createEntry("one", {
        publishedAt: new Date("2026-01-02T09:00:00.000Z"),
        content: "x".repeat(200),
      }),
      createEntry("two", {
        publishedAt: new Date("2026-01-02T08:00:00.000Z"),
        content: "y".repeat(200),
      }),
    ])

    const context = buildLocalAIContext(
      [questionPart('Today <mention-date text="24hoursago"></mention-date>')],
      { now },
    )

    expect(context?.entries).toHaveLength(2)
    for (const entry of context!.entries) {
      expect(entry.content?.length).toBeLessThanOrEqual(100)
      expect(entry.content).toContain("[truncated")
    }
  })

  test("stays empty without a date mention or without entries in the window", () => {
    setEntries([createEntry("old", { publishedAt: new Date("2025-01-01T09:00:00.000Z") })])

    expect(buildLocalAIContext([questionPart("what did I miss?")], { now })).toBeNull()
    expect(
      buildLocalAIContext([questionPart('<mention-date text="24hoursago"></mention-date>')], {
        now,
      }),
    ).toBeNull()
  })
})

// The "Recommend feeds" shortcut expects a catalogue from the server, so the caller supplies one.
describe("feed candidates", () => {
  const feeds = [
    { id: "feed-1", title: "Feed 1", description: "First feed", url: "https://example.com/f1" },
  ]

  beforeEach(() => {
    resetLocalAI()
    setEntries([])
  })

  test("travels with the request and is labelled as the selection", () => {
    const context = buildLocalAIContext([], { feedCandidates: feeds })

    expect(context).toEqual({
      blocks: [{ type: "feedCandidates", value: "1" }],
      entries: [],
      feeds,
    })
  })

  test("does not change the explicit context path", () => {
    setEntries([createEntry("entry-1")])

    const context = buildLocalAIContext([blockPart([mainEntryBlock("entry-1")])], {
      feedCandidates: feeds,
    })

    expect(context?.feeds).toBeUndefined()
    expect(context?.entries.map((entry) => entry.id)).toEqual(["entry-1"])
  })
})

describe("parseMentionDateWindow", () => {
  const now = dayjs("2026-01-02T12:00:00.000Z")

  test("prefers the explicit range and falls back to the relative hint", () => {
    const explicit = parseMentionDateWindow(
      '<mention-date start="2025-12-27T00:00:00+00:00" end="2026-01-02T12:00:00+00:00" text="date:relative:last-7-days"></mention-date>',
      now,
    )
    expect(explicit?.start.format("YYYY-MM-DD")).toBe("2025-12-27")

    const relative = parseMentionDateWindow(
      '<mention-date text="date:relative:last-7-days"></mention-date>',
      now,
    )
    expect(relative?.start.format("YYYY-MM-DD")).toBe("2025-12-27")
    expect(relative?.label).toBe("last 7 days")
  })

  test("understands yesterday and ignores everything else", () => {
    expect(
      parseMentionDateWindow('<mention-date text="yesterday"></mention-date>', now)?.end.format(
        "YYYY-MM-DD",
      ),
    ).toBe("2026-01-01")
    expect(parseMentionDateWindow("no mention here", now)).toBeNull()
    expect(parseMentionDateWindow('<mention-date text="sometime"></mention-date>', now)).toBeNull()
  })
})
