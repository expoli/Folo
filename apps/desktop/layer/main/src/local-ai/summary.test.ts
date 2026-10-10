import { describe, expect, test } from "vitest"

import { handleSummaryRequest, summarizeContent, SUMMARY_CHUNK_CHARS } from "./summary"
import { createFakeModel } from "./test-model"

/** Two paragraphs that just exceed the chunk limit, so the map-reduce path runs. */
const twoChunkContent = () => `${"a".repeat(6000)}\n\n${"b".repeat(6000)}`

describe("summarizeContent", () => {
  test("summarizes a short article in one call", async () => {
    const fake = createFakeModel(() => "Short summary")

    const summary = await summarizeContent({
      model: fake.model,
      language: "zh-CN",
      title: "A title",
      content: "A short body",
    })

    expect(summary).toBe("Short summary")
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]!.prompt).toContain("Write the summary in Simplified Chinese.")
    expect(fake.calls[0]!.prompt).toContain("Title: A title")
    expect(fake.calls[0]!.prompt).toContain("A short body")
    expect(fake.calls[0]!.prompt).not.toContain("part 1 of")
  })

  test("returns null instead of an empty summary", async () => {
    const fake = createFakeModel(() => "   ")

    await expect(
      summarizeContent({ model: fake.model, content: "A short body" }),
    ).resolves.toBeNull()
  })

  test("maps and merges a long article, then reports the coverage", async () => {
    const content = twoChunkContent()
    const fake = createFakeModel((call) =>
      call.prompt.includes("Merge these")
        ? "Merged summary"
        : `Part summary ${call.prompt.length > 0 ? 1 : 0}`,
    )

    const summary = await summarizeContent({ model: fake.model, language: "en", content })

    // Two chunk calls plus the merge call.
    expect(fake.calls).toHaveLength(3)
    expect(fake.calls[0]!.prompt).toContain(
      "This is part 1 of 2 of a long article — summarize this part.",
    )
    expect(fake.calls[1]!.prompt).toContain(
      "This is part 2 of 2 of a long article — summarize this part.",
    )
    expect(fake.calls[2]!.prompt).toContain("Merge these 2 partial summaries of one article")
    expect(fake.calls[2]!.prompt).toContain("## Part 1")
    expect(fake.calls[2]!.prompt).toContain("## Part 2")

    expect(summary).toBe(
      `Merged summary\n\n_Summarized the full article in 2 of 2 parts (${content.length} characters)._`,
    )
  })

  test("reports the parts that survived a failing chunk", async () => {
    const content = twoChunkContent()
    // The first chunk call answers nothing, the merge call answers text.
    const fake = createFakeModel(() => "Only part two arrived")
    fake.setEmptyAnswers([0])

    const summary = await summarizeContent({ model: fake.model, content })

    expect(fake.calls).toHaveLength(3)
    expect(summary).toContain("Only part two arrived")
    expect(summary).toContain(
      `_Summarized the full article in 1 of 2 parts (${content.length} characters)._`,
    )
  })

  test("keeps the coverage note when the merge call fails", async () => {
    const content = twoChunkContent()
    const fake = createFakeModel((call) =>
      call.prompt.includes("Merge these") ? "" : "Part summary",
    )
    fake.setEmptyAnswers([2])

    await expect(summarizeContent({ model: fake.model, content })).resolves.toBe(
      `_Summarized the full article in 2 of 2 parts (${content.length} characters)._`,
    )
  })

  test("returns null when no chunk produced a summary", async () => {
    const content = twoChunkContent()
    const fake = createFakeModel(() => "unused")
    fake.setEmptyAnswers([0, 1, 2])

    await expect(summarizeContent({ model: fake.model, content })).resolves.toBeNull()
    // Only the two chunk calls: there is nothing to merge.
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls.every((call) => !call.prompt.includes("Merge these"))).toBe(true)
  })

  test("chunks at the documented limit", () => {
    expect(SUMMARY_CHUNK_CHARS).toBe(12_000)
  })
})

describe("handleSummaryRequest", () => {
  test("rejects a request without content", async () => {
    const fake = createFakeModel()
    const response = await handleSummaryRequest({ body: {}, model: fake.model })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: "Field `content` is required" })
    expect(fake.calls).toHaveLength(0)
  })

  test("answers in Folo's summary envelope", async () => {
    const fake = createFakeModel(() => "The summary")
    const response = await handleSummaryRequest({
      body: { content: "Body", language: "en", title: "Title" },
      model: fake.model,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ code: 0, data: "The summary" })
  })
})
