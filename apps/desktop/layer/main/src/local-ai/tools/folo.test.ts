import {
  LOCAL_AGENT_READING_TOOL_INFO,
  LOCAL_AGENT_READING_TOOL_NAMES,
  LOCAL_AI_DIGEST_TOOL_NAME,
} from "@follow/shared/local-agent-reading"
import type { ToolSet } from "ai"
import { describe, expect, test, vi } from "vitest"

import type { LocalAgentReadingToolHandlers } from "~/local-agent-reading/server"

import { createFoloReadingTools } from "./folo"

/**
 * The tools are `ToolSet` so the chat loop can take them; calling one has to go through `execute`,
 * which `ToolSet` erases. This narrow view is the only cast the test needs.
 */
const run = async (tools: ToolSet, name: string, input: unknown): Promise<unknown> => {
  const entry = tools[name] as unknown as {
    execute?: (input: unknown, options: unknown) => Promise<unknown>
  }
  if (!entry?.execute) throw new Error(`${name} has no execute function`)
  return await entry.execute(input, { toolCallId: "call-1", messages: [] })
}

const handlers = (
  overrides: Partial<LocalAgentReadingToolHandlers> = {},
): LocalAgentReadingToolHandlers => ({
  status: async () => ({ signedIn: true }) as never,
  beginScan: async () => ({ ok: true, data: { scanId: "scan-1" } }) as never,
  listEntries: async () => ({ ok: true, data: { entries: [] } }) as never,
  getContents: async () => ({ ok: true, data: { items: [] } }) as never,
  ...overrides,
})

describe("createFoloReadingTools", () => {
  test("serves the endpoint's tools unchanged, plus the app's digest", () => {
    const tools = createFoloReadingTools(handlers())

    expect(Object.keys(tools).sort()).toEqual(
      [...LOCAL_AGENT_READING_TOOL_NAMES, LOCAL_AI_DIGEST_TOOL_NAME].sort(),
    )
  })

  test("describes each tool with the shared wording", () => {
    const tools = createFoloReadingTools(handlers())

    for (const name of LOCAL_AGENT_READING_TOOL_NAMES) {
      expect(tools[name]?.description).toBe(LOCAL_AGENT_READING_TOOL_INFO[name].description)
    }
  })

  test("passes the scan scope through to the service", async () => {
    const beginScan = vi.fn(async () => ({ ok: true as const, data: { scanId: "scan-1" } }))
    const tools = createFoloReadingTools(handlers({ beginScan: beginScan as never }))

    await run(tools, "folo_begin_unread_scan", { scope: { feedIds: ["feed-1"] } })

    expect(beginScan).toHaveBeenCalledWith({ scope: { feedIds: ["feed-1"] } })
  })

  test("hands a refusal to the model instead of throwing", async () => {
    const tools = createFoloReadingTools(
      handlers({
        beginScan: async () =>
          ({
            ok: false,
            error: { code: "NOT_SIGNED_IN", message: "Folo is not signed in" },
          }) as never,
      }),
    )

    await expect(run(tools, "folo_begin_unread_scan", {})).resolves.toEqual({
      error: { code: "NOT_SIGNED_IN", message: "Folo is not signed in" },
    })
  })

  test("returns the payload of a successful call without the envelope", async () => {
    const tools = createFoloReadingTools(
      handlers({
        getContents: async () =>
          ({ ok: true, data: { items: [{ entryId: "entry-1", content: "text" }] } }) as never,
      }),
    )

    await expect(
      run(tools, "folo_get_entry_contents", { scanId: "scan-1", entryIds: ["entry-1"] }),
    ).resolves.toEqual({ items: [{ entryId: "entry-1", content: "text" }] })
  })

  test("lets a failed status surface as a failed tool call", async () => {
    const tools = createFoloReadingTools(
      handlers({
        status: async () => {
          throw new Error("renderer is gone")
        },
      }),
    )

    await expect(run(tools, "folo_get_status", {})).rejects.toThrow("renderer is gone")
  })
})

describe("folo_unread_digest", () => {
  /** A fixed clock, so "today" and "last24h" mean something in a test. */
  const NOW = Date.parse("2026-10-29T10:00:00.000Z")

  const candidate = (index: number) => ({
    id: `entry-${index}`,
    title: `Entry ${index}`,
    url: `https://example.com/${index}`,
    feedId: "feed-1",
    publishedAt: new Date(NOW - index * 60_000).toISOString(),
    readState: "unread" as const,
    readStateObservedAt: new Date(NOW).toISOString(),
    hasCachedContent: true,
    source: "feed" as const,
  })

  const summary = (count: number) => ({
    scanId: "scan-1",
    accountId: "acct-1",
    scope: {},
    startedAt: new Date(NOW).toISOString(),
    finishedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    status: "partial" as const,
    enumerationComplete: false,
    selectionConsistency: "best_effort" as const,
    selectedCount: count,
    duplicatesRemoved: 0,
    unknownReadStateCount: 0,
    sources: [
      {
        kind: "view" as const,
        id: "0",
        label: "articles",
        status: "partial" as const,
        observedCount: count,
        error: null,
      },
    ],
    errors: [],
  })

  /** Records what the digest asked for and answers from the script. */
  const digestHandlers = (count = 3, body = "text of the entry") => {
    const calls = {
      beginScan: [] as unknown[],
      listEntries: [] as unknown[],
      getContents: [] as unknown[],
    }

    const value: LocalAgentReadingToolHandlers = {
      status: async () => ({}) as never,
      beginScan: async (args) => {
        calls.beginScan.push(args)
        return { ok: true, data: summary(count) } as never
      },
      listEntries: async (args) => {
        calls.listEntries.push(args)
        return {
          ok: true,
          data: {
            scan: summary(count),
            entries: Array.from({ length: count }, (_, index) => candidate(index)),
            cursor: null,
            hasMore: false,
          },
        } as never
      },
      getContents: async (args) => {
        calls.getContents.push(args)
        return {
          ok: true,
          data: {
            scanId: "scan-1",
            mode: "cached",
            items: (args.entryIds ?? []).map((entryId) => ({
              entryId,
              title: entryId,
              url: null,
              contentSource: "rss" as const,
              contentType: "text" as const,
              completeness: "unknown" as const,
              fetchedAt: new Date(NOW).toISOString(),
              content: body,
              truncated: false,
              nextCursor: null,
              warning: null,
              error: null,
            })),
            counts: {
              requested: args.entryIds?.length ?? 0,
              returned: args.entryIds?.length ?? 0,
              failed: 0,
              continued: 0,
            },
            rejectedEntryIds: [],
          },
        } as never
      },
    }

    return { value, calls }
  }

  /** What the digest hands back, as the tests read it. */
  interface DigestResult {
    counts: { matched: number; listed: number; withText: number; withoutText: number }
    enumerationComplete: boolean
    sources: { kind: string; id: string; label: string | null; status: string }[]
    entries: { id: string; excerpt: string | null; excerptTruncated?: boolean }[]
    error?: { code: string; message: string }
  }

  const digestOf = async (
    value: LocalAgentReadingToolHandlers,
    input: unknown,
  ): Promise<DigestResult> =>
    (await run(
      createFoloReadingTools(value, { now: () => NOW }),
      LOCAL_AI_DIGEST_TOOL_NAME,
      input,
    )) as DigestResult

  test("turns a named window into the timestamps the service reads", async () => {
    const { value, calls } = digestHandlers()

    await digestOf(value, { window: "last24h" })

    expect(calls.beginScan[0]).toEqual({
      scope: {
        publishedAfter: new Date(NOW - 24 * 60 * 60 * 1000).toISOString(),
        publishedBefore: new Date(NOW).toISOString(),
      },
    })
  })

  test("lets an explicit range win over the window", async () => {
    const { value, calls } = digestHandlers()

    await digestOf(value, {
      window: "last7d",
      scope: { publishedAfter: "2026-10-01T00:00:00.000Z" },
    })

    expect((calls.beginScan[0] as { scope: Record<string, string> }).scope.publishedAfter).toBe(
      "2026-10-01T00:00:00.000Z",
    )
  })

  test("reads at most the requested number of entries, in service-sized batches", async () => {
    const { value, calls } = digestHandlers(26)

    const digest = await digestOf(value, { limit: 26 })

    expect((calls.listEntries[0] as { limit: number }).limit).toBe(26)
    // 26 entries cannot be read in one call, so the digest makes the extra calls itself.
    expect(calls.getContents).toHaveLength(3)
    expect(digest.counts).toMatchObject({ listed: 26, withText: 26, withoutText: 0 })
  })

  test("clamps what a caller may ask for", async () => {
    const { value, calls } = digestHandlers(1)

    await digestOf(value, { limit: 999, bodiesPerEntry: 99_999 })

    expect((calls.listEntries[0] as { limit: number }).limit).toBeLessThanOrEqual(30)
  })

  test("hands back an excerpt, the coverage it could prove, and nothing else", async () => {
    const { value } = digestHandlers(2, "x".repeat(1000))

    const digest = await digestOf(value, { bodiesPerEntry: 100 })

    expect(digest.entries).toHaveLength(2)
    expect(digest.entries[0]).toMatchObject({ id: "entry-0", excerptTruncated: true })
    expect(digest.entries[0]?.excerpt).toHaveLength(100)
    // A summary must not read as if the whole account had been enumerated.
    expect(digest.enumerationComplete).toBe(false)
    expect(digest.sources).toEqual([
      { kind: "view", id: "0", label: "articles", status: "partial" },
    ])
  })

  test("still names the entries when their text cannot be read", async () => {
    const { value } = digestHandlers()
    const refusing: LocalAgentReadingToolHandlers = {
      ...value,
      getContents: async () =>
        ({ ok: false, error: { code: "no_content", message: "none" } }) as never,
    }

    const digest = await digestOf(refusing, {})

    expect(digest.counts).toMatchObject({ withText: 0, withoutText: 3 })
    expect(digest.entries[0]).toMatchObject({ id: "entry-0", excerpt: null })
  })

  test("passes a refused scan up instead of pretending it read something", async () => {
    const refusing: LocalAgentReadingToolHandlers = {
      ...digestHandlers().value,
      beginScan: async () =>
        ({
          ok: false,
          error: { code: "NOT_SIGNED_IN", message: "Folo is not signed in" },
        }) as never,
    }

    await expect(digestOf(refusing, {})).resolves.toEqual({
      error: { code: "NOT_SIGNED_IN", message: "Folo is not signed in" },
    })
  })
})
