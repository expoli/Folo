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
    // Feed-scoped blocks index by feed, so the fixture keeps both indexes in sync.
    entryIdByFeed: entries.reduce<Record<string, Set<string>>>((index, entry) => {
      const feedId = entry.feedId ?? ""
      if (!feedId) return index

      const ids = index[feedId] ?? new Set<string>()
      ids.add(entry.id)
      index[feedId] = ids
      return index
    }, {}),
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

const feedBlock = (feedId: string): AIChatContextBlock => ({
  id: `block-feed-${feedId}`,
  type: "mainFeed",
  value: feedId,
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

    // The entry that no longer fits the budget is still listed, so nothing is dropped silently.
    expect(context?.entries.map((entry) => entry.id)).toEqual(["entry-1", "entry-2", "entry-3"])
    expect(context?.entries[0]?.content).toBe("a".repeat(700))
    expect(context?.entries[1]?.content).toBe(`${"b".repeat(300)}\n…[truncated 400 chars]`)
    expect(context?.entries[2]?.content).toBeNull()
    expect(context?.coverage).toEqual({ matched: 3 })
  })

  test("limits the entries that carry text and lists the rest", () => {
    setLocalAIContextBudget({ maxEntries: 1, maxTotalChars: 10_000 })
    setEntries([createEntry("entry-1"), createEntry("entry-2"), createEntry("entry-3")])

    const context = buildLocalAIContext([blockPart([allEntriesBlock()])])

    expect(context?.entries.map((entry) => entry.id)).toEqual(["entry-1", "entry-2", "entry-3"])
    expect(context?.entries.map((entry) => entry.content)).toEqual(["Body entry-1", null, null])
    expect(context?.coverage).toEqual({ matched: 3 })
  })

  test("charges the title-only rows against the announced budget", () => {
    setLocalAIContextBudget({ maxEntries: 1, maxTotalChars: 400 })
    setEntries([
      createEntry("main", { content: "x".repeat(200) }),
      ...Array.from({ length: 10 }, (_, index) => createEntry(`tail-${index}`)),
    ])

    const context = buildLocalAIContext([blockPart([allEntriesBlock()])])

    expect(context?.coverage).toEqual({ matched: 11 })
    // The listing stops once the budget is spent instead of growing the prompt without bound.
    expect(context!.entries.length).toBeLessThan(11)
    expect(context!.entries.at(-1)?.content).toBeNull()
  })

  test("sends the text of the articles the prompt cannot carry when asked to summarize", () => {
    setLocalAIContextBudget({ maxEntries: 1, maxTotalChars: 100 })
    setEntries([
      createEntry("main", { content: "x".repeat(200) }),
      createEntry("tail", { content: "y".repeat(500) }),
    ])

    const context = buildLocalAIContext([blockPart([allEntriesBlock()])], { reduce: true })

    expect(context?.entries[1]?.content).toBeNull()
    // The tail article travels as text instead of as a title, so the pre-pass can summarize it.
    expect(context?.entries[1]?.body).toBe("y".repeat(500))
  })

  test("keeps the payload light for a chat that did not ask for summaries", () => {
    setLocalAIContextBudget({ maxEntries: 1, maxTotalChars: 100 })
    setEntries([
      createEntry("main", { content: "x".repeat(200) }),
      createEntry("tail", { content: "y".repeat(500) }),
    ])

    const context = buildLocalAIContext([blockPart([allEntriesBlock()])])

    expect(context?.entries[1]?.content).toBeNull()
    expect(context?.entries[1]).not.toHaveProperty("body")
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

  test("covers the whole day for a single-day mention (the menu's yesterday preset)", () => {
    // The preset serialises start == end == that day at local midnight, which must not come out as
    // an inverted window (it used to attach nothing at all).
    const yesterdayStart = now.startOf("day").subtract(1, "day")
    const mention = `<mention-date start="${yesterdayStart.format()}" end="${yesterdayStart.format()}" text="date:relative:yesterday"></mention-date>`

    setEntries([
      createEntry("yesterday-morning", { publishedAt: yesterdayStart.add(9, "hour").toDate() }),
      createEntry("yesterday-night", { publishedAt: yesterdayStart.add(23, "hour").toDate() }),
      createEntry("today", { publishedAt: now.subtract(1, "hour").toDate() }),
    ])

    const context = buildLocalAIContext([questionPart(mention)], { now })

    expect(context?.entries.map((entry) => entry.id)).toEqual([
      "yesterday-night",
      "yesterday-morning",
    ])
    expect(context?.blocks).toEqual([
      { type: "timeline", value: yesterdayStart.format("YYYY-MM-DD") },
    ])
  })

  test("keeps a midnight end exclusive and drops the boundary entry", () => {
    const dayStart = now.startOf("day").subtract(1, "day")
    const nextDayStart = now.startOf("day")
    const mention = `<mention-date start="${dayStart.format()}" end="${nextDayStart.format()}" text="custom"></mention-date>`

    setEntries([
      createEntry("late", { publishedAt: dayStart.add(23, "hour").add(30, "minute").toDate() }),
      createEntry("boundary", { publishedAt: nextDayStart.toDate() }),
    ])

    const context = buildLocalAIContext([questionPart(mention)], { now })

    expect(context?.entries.map((entry) => entry.id)).toEqual(["late"])
  })

  test("stays empty without a date mention, and reports an empty window", () => {
    setEntries([createEntry("old", { publishedAt: new Date("2025-01-01T09:00:00.000Z") })])

    expect(buildLocalAIContext([questionPart("what did I miss?")], { now })).toBeNull()

    // The window is real but holds nothing: the model should hear that, not read the whole view.
    const empty = buildLocalAIContext(
      [questionPart('<mention-date text="24hoursago"></mention-date>')],
      { now },
    )
    expect(empty?.entries).toEqual([])
    expect(empty?.coverage).toEqual({ matched: 0, window: "last 24 hours" })
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

// `unreadOnly` filters the timeline a message is about, it is not a timeline of its own: sending the
// union of both blocks answered about every unread entry of every feed.
describe("timeline scope of the context blocks", () => {
  beforeEach(() => {
    resetLocalAI()
    setEntries([])
  })

  test("keeps a feed summary inside that feed, unread only", () => {
    setEntries([
      createEntry("watched-unread", { feedId: "feed-watched", read: false }),
      createEntry("watched-read", { feedId: "feed-watched", read: true }),
      createEntry("other-unread", { feedId: "feed-other", read: false }),
    ])

    const context = buildLocalAIContext([blockPart([feedBlock("feed-watched"), unreadOnlyBlock()])])

    expect(context?.entries.map((entry) => entry.id)).toEqual(["watched-unread"])
  })

  test("keeps every entry of the feed when no filter is set", () => {
    setEntries([
      createEntry("watched-unread", { feedId: "feed-watched", read: false }),
      createEntry("watched-read", { feedId: "feed-watched", read: true }),
      createEntry("other", { feedId: "feed-other", read: false }),
    ])

    const context = buildLocalAIContext([blockPart([feedBlock("feed-watched")])])

    expect(context?.entries.map((entry) => entry.id).sort()).toEqual([
      "watched-read",
      "watched-unread",
    ])
  })

  test("reads a folder block as the union of its feeds", () => {
    setEntries([
      createEntry("a", { feedId: "feed-a", read: true }),
      createEntry("b", { feedId: "feed-b", read: true }),
      createEntry("c", { feedId: "feed-c", read: true }),
    ])

    const context = buildLocalAIContext([blockPart([feedBlock("feed-a,feed-b")])])

    expect(context?.entries.map((entry) => entry.id).sort()).toEqual(["a", "b"])
  })

  test("filters a view block too, and the whole timeline when that is the scope", () => {
    setEntries([
      createEntry("unread", { feedId: "feed-a", read: false }),
      createEntry("already-read", { feedId: "feed-b", read: true }),
    ])

    expect(
      buildLocalAIContext([blockPart([allEntriesBlock(), unreadOnlyBlock()])])?.entries.map(
        (entry) => entry.id,
      ),
    ).toEqual(["unread"])
    expect(buildLocalAIContext([blockPart([unreadOnlyBlock()])])?.entries.map((e) => e.id)).toEqual(
      ["unread"],
    )
  })

  test("narrows the scope to the window the prompt names", () => {
    const now = dayjs("2026-01-02T12:00:00.000Z")
    setEntries([
      createEntry("recent", { publishedAt: now.subtract(2, "hour").toDate() }),
      createEntry("older", { publishedAt: now.subtract(3, "day").toDate() }),
    ])

    const context = buildLocalAIContext(
      [
        blockPart([allEntriesBlock()]),
        questionPart('Summarize <mention-date text="24hoursago"></mention-date>.'),
      ],
      { now },
    )

    // Without the window this answered about the newest entries of the whole view instead.
    expect(context?.entries.map((entry) => entry.id)).toEqual(["recent"])
    expect(context?.coverage).toEqual({ matched: 1, window: "last 24 hours" })
  })

  test("keeps an explicitly referenced entry that the window would drop", () => {
    const now = dayjs("2026-01-02T12:00:00.000Z")
    setEntries([
      createEntry("recent", { publishedAt: now.subtract(2, "hour").toDate() }),
      createEntry("old", { publishedAt: now.subtract(3, "day").toDate() }),
    ])

    const context = buildLocalAIContext(
      [
        blockPart([allEntriesBlock(), mainEntryBlock("old")]),
        questionPart('Explain <mention-date text="24hoursago"></mention-date>.'),
      ],
      { now },
    )

    expect(context?.entries.map((entry) => entry.id)).toEqual(["old", "recent"])
  })

  test("keeps a referenced article even when it sits outside the filter", () => {
    setEntries([
      createEntry("pinned", { feedId: "feed-other", read: true }),
      createEntry("in-feed", { feedId: "feed-watched", read: false }),
    ])

    const context = buildLocalAIContext([
      blockPart([feedBlock("feed-watched"), mainEntryBlock("pinned")]),
    ])

    expect(context?.entries[0]?.id).toBe("pinned")
    expect(context?.entries.map((entry) => entry.id).sort()).toEqual(["in-feed", "pinned"])
  })
})
