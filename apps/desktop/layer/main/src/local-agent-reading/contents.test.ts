import { describe, expect, test, vi } from "vitest"

import { resolveContents } from "./contents"
import { candidateEntry, createSyntheticProvider } from "./test-doubles"

const candidates = [
  candidateEntry({ id: "a", url: "https://example.com/a" }),
  candidateEntry({ id: "b", url: "https://example.com/b" }),
]

const resolve = (
  provider: ReturnType<typeof createSyntheticProvider>["provider"],
  params: {
    mode?: "cached" | "detail" | "source_page"
    entryIds?: string[]
    cursor?: string | null
    candidates?: typeof candidates
    fetchSourcePage?: Parameters<typeof resolveContents>[0]["fetchSourcePage"]
    isSourcePageEnabled?: () => boolean
  } = {},
) =>
  resolveContents({
    scanId: "scan-1",
    accountId: "acct-1",
    candidates: params.candidates ?? candidates,
    mode: params.mode ?? "cached",
    entryIds: params.entryIds ?? ["a"],
    cursor: params.cursor ?? null,
    provider,
    isSourcePageEnabled: params.isSourcePageEnabled ?? (() => true),
    ...(params.fetchSourcePage ? { fetchSourcePage: params.fetchSourcePage } : {}),
  })

describe("entry contents", () => {
  test("reads cached feed text and names its source", async () => {
    const { provider, calls } = createSyntheticProvider({
      async resolveEntries(request) {
        return {
          ok: true,
          accountId: request.accountId,
          entries: [
            {
              entryId: "a",
              title: "A",
              content: "Feed text",
              contentFormat: "markdown",
              contentSource: "rss",
              completeness: "complete",
              fetchedAt: "2026-10-02T00:00:00.000Z",
              error: null,
            },
          ],
        }
      },
    })

    const result = await resolve(provider)

    expect(calls.resolve[0]).toMatchObject({ entryIds: ["a"], includeDetail: false })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      entryId: "a",
      contentSource: "rss",
      contentType: "markdown",
      completeness: "complete",
      content: "Feed text",
      truncated: false,
      warning: null,
      error: null,
    })
    expect(result.counts).toEqual({ requested: 1, returned: 1, failed: 0, continued: 0 })
  })

  test("the detail mode asks the account for the entry detail", async () => {
    const { provider, calls } = createSyntheticProvider()
    await resolve(provider, { mode: "detail" })

    expect(calls.resolve[0]).toMatchObject({ includeDetail: true })
  })

  test("a description is reported as an excerpt, never as the article", async () => {
    const { provider } = createSyntheticProvider({
      async resolveEntries(request) {
        return {
          ok: true,
          accountId: request.accountId,
          entries: [
            {
              entryId: "a",
              title: "A",
              content: "Short summary",
              contentFormat: "text",
              contentSource: "description",
              completeness: "partial",
              fetchedAt: "2026-10-02T00:00:00.000Z",
              error: null,
            },
          ],
        }
      },
    })

    const result = await resolve(provider)
    expect(result.items[0]).toMatchObject({
      contentSource: "description",
      completeness: "partial",
      warning: { code: "partial_content" },
    })
  })

  test("text of unknown length carries a warning instead of pretending to be whole", async () => {
    const { provider } = createSyntheticProvider({
      async resolveEntries(request) {
        return {
          ok: true,
          accountId: request.accountId,
          entries: [
            {
              entryId: "a",
              title: "A",
              content: "Some text",
              contentFormat: "text",
              contentSource: "readability",
              completeness: "unknown",
              fetchedAt: "2026-10-02T00:00:00.000Z",
              error: null,
            },
          ],
        }
      },
    })

    const result = await resolve(provider)
    expect(result.items[0]!.warning).toMatchObject({ code: "length_unknown" })
  })

  test("a long text continues through its cursor", async () => {
    const long = "x".repeat(9_000)
    const { provider } = createSyntheticProvider({
      async resolveEntries(request) {
        return {
          ok: true,
          accountId: request.accountId,
          entries: [
            {
              entryId: "a",
              title: "A",
              content: long,
              contentFormat: "markdown",
              contentSource: "readability",
              completeness: "complete",
              fetchedAt: "2026-10-02T00:00:00.000Z",
              error: null,
            },
          ],
        }
      },
    })

    const first = await resolve(provider)
    expect(first.items[0]!.content).toHaveLength(6_000)
    expect(first.items[0]!.truncated).toBe(true)
    expect(first.items[0]!.nextCursor).toContain("a")
    expect(first.counts).toMatchObject({ continued: 1 })

    const second = await resolve(provider, { cursor: first.items[0]!.nextCursor })
    expect(second.items[0]!.content).toHaveLength(3_000)
    expect(second.items[0]!.truncated).toBe(false)
    expect(second.items[0]!.nextCursor).toBeNull()
    // A continuation keeps the mode of the first read.
    expect(second.mode).toBe("cached")
    expect(second.counts.requested).toBe(1)
  })

  test("a cursor past the end says so instead of returning an empty article", async () => {
    const { provider } = createSyntheticProvider({
      async resolveEntries(request) {
        return {
          ok: true,
          accountId: request.accountId,
          entries: [
            {
              entryId: "a",
              title: "A",
              content: "short",
              contentFormat: "text",
              contentSource: "rss",
              completeness: "complete",
              fetchedAt: "2026-10-02T00:00:00.000Z",
              error: null,
            },
          ],
        }
      },
    })

    const result = await resolve(provider, { cursor: "c1:cached:600:a" })
    expect(result.items[0]).toMatchObject({
      content: "",
      truncated: false,
      nextCursor: null,
      warning: { code: "cursor_out_of_range" },
    })
  })

  test("one failing entry does not cost the batch", async () => {
    const { provider } = createSyntheticProvider({
      async resolveEntries(request) {
        return {
          ok: true,
          accountId: request.accountId,
          entries: [
            {
              entryId: "a",
              title: "A",
              content: "Feed text",
              contentFormat: "markdown",
              contentSource: "rss",
              completeness: "complete",
              fetchedAt: "2026-10-02T00:00:00.000Z",
              error: null,
            },
            {
              entryId: "b",
              url: null,
              title: "B",
              content: null,
              contentFormat: null,
              contentSource: null,
              completeness: "unknown",
              fetchedAt: "2026-10-02T00:00:00.000Z",
              error: { code: "not_found", message: "The account no longer has it" },
            },
          ],
        }
      },
    })

    const result = await resolve(provider, { entryIds: ["a", "b"] })

    expect(result.items.map((item) => item.entryId)).toEqual(["a", "b"])
    expect(result.items[0]!.error).toBeNull()
    expect(result.items[1]!.error).toMatchObject({ code: "entry_not_found" })
    expect(result.counts).toEqual({ requested: 2, returned: 1, failed: 1, continued: 0 })
  })

  test("a batch that failed before reading reports every entry", async () => {
    const { provider } = createSyntheticProvider({
      async resolveEntries() {
        return { ok: false, error: { code: "TIMEOUT", message: "The renderer did not answer" } }
      },
    })

    const result = await resolve(provider, { entryIds: ["a", "b"] })

    expect(result.items).toHaveLength(2)
    expect(result.items.every((item) => item.error?.code === "timeout")).toBe(true)
    expect(result.counts).toMatchObject({ returned: 0, failed: 2 })
  })

  test("ids outside the scan are reported, not served", async () => {
    const { provider } = createSyntheticProvider()
    const result = await resolve(provider, { entryIds: ["a", "nope"] })

    expect(result.rejectedEntryIds).toEqual(["nope"])
    expect(result.items.map((item) => item.entryId)).toEqual(["a"])
  })

  test("the source_page mode fetches the article and says how far it can be trusted", async () => {
    const { provider } = createSyntheticProvider({
      async resolveEntries(request) {
        return {
          ok: true,
          accountId: request.accountId,
          entries: [
            {
              entryId: "a",
              title: "A",
              content: "Feed summary",
              contentFormat: "markdown",
              contentSource: "rss",
              completeness: "partial",
              fetchedAt: "2026-10-02T00:00:00.000Z",
              error: null,
            },
          ],
        }
      },
    })
    const fetchSourcePage = vi.fn(async () => ({ ok: true as const, text: "Full page text" }))

    const result = await resolve(provider, { mode: "source_page", fetchSourcePage })

    expect(fetchSourcePage).toHaveBeenCalledWith(
      "https://example.com/a",
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    )
    expect(result.items[0]).toMatchObject({
      contentSource: "source_page",
      content: "Full page text",
      // A page that parsed is not proof that the article was whole.
      completeness: "unknown",
      warning: { code: "length_unknown" },
      error: null,
    })
  })

  test("a page that cannot be read keeps the stored text and warns", async () => {
    const { provider } = createSyntheticProvider({
      async resolveEntries(request) {
        return {
          ok: true,
          accountId: request.accountId,
          entries: [
            {
              entryId: "a",
              title: "A",
              content: "Feed summary",
              contentFormat: "markdown",
              contentSource: "rss",
              completeness: "partial",
              fetchedAt: "2026-10-02T00:00:00.000Z",
              error: null,
            },
          ],
        }
      },
    })
    const fetchSourcePage = vi.fn(async () => ({ ok: false as const, reason: "blocked" as const }))

    const result = await resolve(provider, { mode: "source_page", fetchSourcePage })

    expect(result.items[0]).toMatchObject({
      contentSource: "rss",
      content: "Feed summary",
      warning: { code: "source_page_unavailable" },
      error: null,
    })
  })

  test("a page that cannot be read and no stored text is an error with the reason", async () => {
    const { provider } = createSyntheticProvider({
      async resolveEntries(request) {
        return {
          ok: true,
          accountId: request.accountId,
          entries: [
            {
              entryId: "a",
              title: "A",
              content: null,
              contentFormat: null,
              contentSource: null,
              completeness: "unknown",
              fetchedAt: "2026-10-02T00:00:00.000Z",
              error: { code: "no_content", message: "Nothing stored" },
            },
          ],
        }
      },
    })
    const fetchSourcePage = vi.fn(async () => ({ ok: false as const, reason: "blocked" as const }))

    const result = await resolve(provider, { mode: "source_page", fetchSourcePage })

    expect(result.items[0]!.error).toMatchObject({ code: "blocked_destination" })
    expect(result.items[0]!.content).toBe("")
  })

  test("an entry without an http(s) url is never fetched", async () => {
    const { provider } = createSyntheticProvider({
      async resolveEntries(request) {
        return {
          ok: true,
          accountId: request.accountId,
          entries: [
            {
              entryId: "a",
              title: "A",
              content: "Stored",
              contentFormat: "text",
              contentSource: "rss",
              completeness: "complete",
              fetchedAt: "2026-10-02T00:00:00.000Z",
              error: null,
            },
          ],
        }
      },
    })
    const fetchSourcePage = vi.fn(async () => ({ ok: true as const, text: "unused" }))

    const result = await resolve(provider, {
      mode: "source_page",
      candidates: [candidateEntry({ id: "a", url: "ftp://example.com/a" })],
      fetchSourcePage,
    })
    expect(fetchSourcePage).not.toHaveBeenCalled()
    expect(result.items[0]!.contentSource).toBe("rss")
  })

  test("no page is requested while the permission is off", async () => {
    const { provider } = createSyntheticProvider({
      async resolveEntries(request) {
        return {
          ok: true,
          accountId: request.accountId,
          entries: [
            {
              entryId: "a",
              title: "A",
              content: "Stored text",
              contentFormat: "text",
              contentSource: "rss",
              completeness: "complete",
              fetchedAt: "2026-10-02T00:00:00.000Z",
              error: null,
            },
            {
              entryId: "b",
              title: "B",
              content: null,
              contentFormat: null,
              contentSource: null,
              completeness: "unknown",
              fetchedAt: "2026-10-02T00:00:00.000Z",
              error: null,
            },
          ],
        }
      },
    })
    const fetchSourcePage = vi.fn(async () => ({ ok: true as const, text: "Page text" }))

    const result = await resolve(provider, {
      mode: "source_page",
      entryIds: ["a", "b"],
      fetchSourcePage,
      isSourcePageEnabled: () => false,
    })

    expect(fetchSourcePage).not.toHaveBeenCalled()
    // The stored text of the first entry is still served, with the reason as a warning.
    expect(result.items[0]).toMatchObject({
      entryId: "a",
      contentSource: "rss",
      content: "Stored text",
      warning: { code: "source_page_unavailable" },
      error: null,
    })
    // The second entry keeps its own reason instead of blaming the page.
    expect(result.items[1]).toMatchObject({
      entryId: "b",
      content: "",
      error: { code: "no_content" },
    })
    expect(result.mode).toBe("source_page")
  })

  test("a page that arrives after the permission was revoked is not served", async () => {
    const { provider } = createSyntheticProvider({
      async resolveEntries(request) {
        return {
          ok: true,
          accountId: request.accountId,
          entries: [
            {
              entryId: "a",
              title: "A",
              content: "Stored text",
              contentFormat: "text",
              contentSource: "rss",
              completeness: "complete",
              fetchedAt: "2026-10-02T00:00:00.000Z",
              error: null,
            },
          ],
        }
      },
    })
    let enabled = true
    const fetchSourcePage = vi.fn(async () => {
      // The user revokes the permission while the page is being read.
      enabled = false
      return { ok: true as const, text: "Late page text" }
    })

    const result = await resolve(provider, {
      mode: "source_page",
      fetchSourcePage,
      isSourcePageEnabled: () => enabled,
    })

    expect(fetchSourcePage).toHaveBeenCalledTimes(1)
    expect(result.items[0]!.content).toBe("Stored text")
    expect(result.items[0]!.contentSource).toBe("rss")
    expect(result.items[0]!.warning?.code).toBe("source_page_unavailable")
  })
})
