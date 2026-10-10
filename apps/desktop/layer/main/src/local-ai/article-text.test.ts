import { describe, expect, test, vi } from "vitest"

import type { ArticleFetchResult } from "./article-text"
import {
  applyFetchedTexts,
  collectFetchTargets,
  fetchArticleTexts,
  htmlToText,
  looksLikeHtml,
  promptText,
} from "./article-text"

describe("htmlToText", () => {
  test("keeps the sentences and drops the markup", () => {
    const text = htmlToText(
      "<div><h1>Title</h1><p>First&nbsp;sentence.</p><script>ignore()</script><p>Second &amp; last.</p></div>",
    )

    expect(text).toBe("Title\nFirst sentence.\nSecond & last.")
  })

  test("turns line breaks and list items into lines", () => {
    expect(htmlToText("<p>One</p><ul><li>Two<br>Three</li></ul>")).toBe("One\nTwo\nThree")
  })

  test("leaves plain text alone", () => {
    const plain = "Just a sentence with a < in it"
    expect(promptText(plain)).toBe(plain)
    expect(looksLikeHtml(plain)).toBe(false)
  })

  test("recognizes markup", () => {
    expect(looksLikeHtml("<p>Hello</p>")).toBe(true)
    expect(looksLikeHtml("<article><p>x</p></article>")).toBe(true)
    // A single tag inside a code sample is text, not markup: flattening it would eat the sample.
    expect(looksLikeHtml("Use <div> for blocks")).toBe(false)
  })
})

describe("collectFetchTargets", () => {
  const entry = (url: string, text: string) => ({ url, content: text })

  test("takes the entries whose text is an excerpt, and those with none", () => {
    const targets = collectFetchTargets([
      entry("https://example.com/short", "One sentence."),
      entry("https://example.com/long", "x".repeat(2000)),
      { url: "https://example.com/empty" },
      entry("mailto:someone@example.com", "short"),
      entry("not a url", "short"),
    ])

    expect(targets).toEqual([
      { index: 1, url: "https://example.com/short" },
      { index: 3, url: "https://example.com/empty" },
    ])
  })

  test("keeps the pass bounded", () => {
    const entries = Array.from({ length: 60 }, (_, index) =>
      entry(`https://example.com/${index}`, ""),
    )

    expect(collectFetchTargets(entries)).toHaveLength(40)
    expect(collectFetchTargets(entries, { maxEntries: 3 })).toHaveLength(3)
  })
})

describe("fetchArticleTexts", () => {
  const targets = [
    { index: 1, url: "https://example.com/1" },
    { index: 2, url: "https://example.com/2" },
    { index: 3, url: "https://example.com/3" },
  ]

  test("collects the texts it could read and counts the rest", async () => {
    const fetchText = vi.fn(async (url: string): Promise<ArticleFetchResult> =>
      url.endsWith("/2")
        ? { ok: false, reason: "too-short" }
        : { ok: true, text: `Text of ${url}` },
    )
    const progress: string[] = []

    const result = await fetchArticleTexts({
      targets,
      fetchText,
      concurrency: 2,
      onProgress: (done, total) => progress.push(`${done}/${total}`),
      log: () => {},
    })

    expect([...result.texts.entries()]).toEqual([
      [1, "Text of https://example.com/1"],
      [3, "Text of https://example.com/3"],
    ])
    expect(result.failures).toEqual({ unreachable: 0, "too-short": 1, aborted: 0 })
    expect(progress[0]).toBe("0/3")
    expect(progress.at(-1)).toBe("3/3")
    expect(fetchText).toHaveBeenCalledTimes(3)
  })

  test("stops early when the request is aborted", async () => {
    const controller = new AbortController()
    const fetchText = vi.fn(async () => {
      controller.abort()
      return { ok: false, reason: "aborted" } as const
    })

    await fetchArticleTexts({
      targets,
      fetchText,
      concurrency: 1,
      signal: controller.signal,
      log: () => {},
    })

    expect(fetchText).toHaveBeenCalledTimes(1)
  })

  test("does nothing without targets", async () => {
    const fetchText = vi.fn()
    expect(await fetchArticleTexts({ targets: [], fetchText })).toEqual({
      texts: new Map(),
      attempted: 0,
      failures: { unreachable: 0, "too-short": 0, aborted: 0 },
      skipped: 0,
    })
    expect(fetchText).not.toHaveBeenCalled()
  })

  test("gives up on the rest once the time budget is spent", async () => {
    const fetchText = vi.fn(async () => {
      // One slow page is enough for the budget to be gone when the next one would start.
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { ok: true, text: "Fetched" } as const
    })

    const result = await fetchArticleTexts({
      targets,
      fetchText,
      concurrency: 1,
      budgetMs: 5,
      timeoutMs: 50,
      log: () => {},
    })

    expect(fetchText).toHaveBeenCalledTimes(1)
    expect(result.texts.size).toBe(1)
    expect(result.skipped).toBe(2)
  })
})

describe("applyFetchedTexts", () => {
  test("attaches the article to an entry that had nothing but a title", () => {
    const entries: { title: string; content?: string; body?: string }[] = [
      { title: "One" },
      { title: "Two", body: "excerpt" },
    ]
    const applied = applyFetchedTexts(entries, new Map([[2, "The whole article"]]))

    expect(applied).toBe(1)
    expect(entries[1]!.body).toBe("The whole article")
  })

  test("keeps a verbatim entry in the prompt, cut to its share of the budget", () => {
    const entries: { title: string; content?: string; body?: string }[] = [
      { title: "One", content: "short" },
    ]
    applyFetchedTexts(entries, new Map([[1, "y".repeat(5000)]]), { verbatimChars: 1000 })

    expect(entries[0]!.content).toHaveLength(1000)
    expect(entries[0]!.body).toBeUndefined()
  })

  test("keeps the longer text the entry already had", () => {
    const entries: { title?: string; content?: string; body?: string }[] = [
      { content: "z".repeat(3000) },
    ]
    expect(applyFetchedTexts(entries, new Map([[1, "brief fetched text"]]))).toBe(0)
    expect(entries[0]!.content).toHaveLength(3000)
  })

  test("ignores a text for an entry that is not there", () => {
    expect(applyFetchedTexts([], new Map([[1, "text"]]))).toBe(0)
  })

  test("cuts a fetched body to the allowance of one entry, and stops when they run out", () => {
    const entries: { body?: string }[] = [{}, {}]
    const applied = applyFetchedTexts(
      entries,
      new Map([
        [1, "x".repeat(9000)],
        [2, "y".repeat(9000)],
      ]),
      { bodyChars: 5000, totalBodyChars: 6000 },
    )

    expect(applied).toBe(2)
    expect(entries[0]!.body).toHaveLength(5000)
    // Only 1 000 characters were left for the second entry, and that is what it gets.
    expect(entries[1]!.body).toHaveLength(1000)

    const third: { body?: string }[] = [{}]
    expect(
      applyFetchedTexts(third, new Map([[1, "z".repeat(100)]]), {
        bodyChars: 5000,
        totalBodyChars: 0,
      }),
    ).toBe(0)
    expect(third[0]!.body).toBeUndefined()
  })
})
