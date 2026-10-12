import { describe, expect, test } from "vitest"

import { createFakeModel } from "./test-model"
import {
  handleTranslationBatchRequest,
  translateLongField,
  translateShortFields,
  TRANSLATION_CHUNK_CHARS,
} from "./translation"

describe("translateShortFields", () => {
  test("asks for one JSON object with exactly the requested keys", async () => {
    const fake = createFakeModel(() =>
      JSON.stringify({ title: "Titel", description: "Beschreibung" }),
    )

    const data = await translateShortFields(
      fake.model,
      { title: "Title", description: "Description", content: "unused" },
      ["title", "description"],
      "de-DE",
    )

    expect(data).toEqual({ title: "Titel", description: "Beschreibung" })
    expect(fake.calls[0]!.prompt).toContain("Translate each section below into de-DE.")
    expect(fake.calls[0]!.prompt).toContain("exactly these keys: title, description")
    expect(fake.calls[0]!.prompt).toContain("## title\nTitle")
    expect(fake.calls[0]!.prompt).not.toContain("unused")
  })

  test("reads a fenced JSON answer", async () => {
    const fake = createFakeModel(() => '```json\n{"title": "Translated"}\n```')

    await expect(
      translateShortFields(fake.model, { title: "Title" }, ["title"], "en"),
    ).resolves.toEqual({ title: "Translated" })
  })

  test("falls back to the raw answer for a single field", async () => {
    const fake = createFakeModel(() => "Just the translation")

    await expect(
      translateShortFields(fake.model, { title: "Title" }, ["title"], "en"),
    ).resolves.toEqual({ title: "Just the translation" })
  })

  test("gives up instead of inventing a value for several unparsable fields", async () => {
    const fake = createFakeModel(() => "no json here")

    await expect(
      translateShortFields(
        fake.model,
        { title: "T", description: "D" },
        ["title", "description"],
        "en",
      ),
    ).resolves.toBeNull()
  })

  test("does nothing when every field is empty", async () => {
    const fake = createFakeModel(() => "unused")

    await expect(
      translateShortFields(fake.model, { title: "  " }, ["title"], "en"),
    ).resolves.toBeNull()
    expect(fake.calls).toHaveLength(0)
  })
})

describe("translateLongField", () => {
  const longValue = `${"a".repeat(6000)}\n\n${"b".repeat(6000)}`

  test("translates a long field chunk by chunk and rejoins it", async () => {
    const fake = createFakeModel(() => "Teil")

    const translated = await translateLongField(fake.model, "content", longValue, "de-DE")

    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[0]!.prompt).toContain('part 1 of 2 of the "content" field')
    expect(fake.calls[1]!.prompt).toContain('part 2 of 2 of the "content" field')
    expect(translated).toBe("Teil\n\nTeil")
  })

  test("marks a chunk the model left empty instead of dropping it", async () => {
    const fake = createFakeModel((call) => (call.prompt.includes("part 2 of 2") ? "" : "Teil eins"))
    fake.setEmptyAnswers([1])

    const translated = await translateLongField(fake.model, "content", longValue, "en")

    expect(translated).toBe("Teil eins\n\n[…part 2 of 2 left untranslated]")
  })

  test("chunks at the documented limit", () => {
    expect(TRANSLATION_CHUNK_CHARS).toBe(8000)
  })
})

describe("handleTranslationBatchRequest", () => {
  test("rejects a body without entries or fields", async () => {
    const fake = createFakeModel()

    const missingEntries = await handleTranslationBatchRequest({
      body: { fields: ["title"] },
      model: fake.model,
    })
    expect(missingEntries.status).toBe(400)
    await expect(missingEntries.json()).resolves.toEqual({
      error: "Fields `entries` and `fields` are required",
    })

    const missingFields = await handleTranslationBatchRequest({
      body: { entries: [{ id: "1" }] },
      model: fake.model,
    })
    expect(missingFields.status).toBe(400)
  })

  test("ignores fields Folo does not translate", async () => {
    const fake = createFakeModel(() => JSON.stringify({ title: "Titel" }))

    const response = await handleTranslationBatchRequest({
      body: { entries: [{ id: "e1", title: "Title" }], fields: ["title", "url"], language: "en" },
      model: fake.model,
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("application/x-ndjson; charset=utf-8")
    await expect(response.text()).resolves.toBe(
      `${JSON.stringify({ id: "e1", data: { title: "Titel" } })}\n`,
    )
    expect(fake.calls[0]!.prompt).toContain("exactly these keys: title")
  })

  test("streams one NDJSON line per translated entry", async () => {
    const fake = createFakeModel((call) =>
      JSON.stringify({ title: call.prompt.includes("One") ? "Eins" : "Zwei" }),
    )

    const response = await handleTranslationBatchRequest({
      body: {
        entries: [
          { id: "e1", title: "One" },
          { id: "e2", title: "Two" },
        ],
        fields: ["title"],
        language: "de-DE",
      },
      model: fake.model,
    })

    const lines = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))

    expect(lines).toHaveLength(2)
    expect(lines).toEqual(
      expect.arrayContaining([
        { id: "e1", data: { title: "Eins" } },
        { id: "e2", data: { title: "Zwei" } },
      ]),
    )
  })

  test("keeps the batch alive when one entry fails", async () => {
    const fake = createFakeModel(() => JSON.stringify({ title: "Eins" }))
    fake.setFailingAnswers([0])

    const response = await handleTranslationBatchRequest({
      body: {
        entries: [
          { id: "e1", title: "One" },
          { id: "e2", title: "Two" },
        ],
        fields: ["title"],
        language: "en",
      },
      model: fake.model,
    })

    // The first entry failed upstream, the second one still arrives, and the failure is reported in
    // the reply itself: a batch that lost an entry must not read as a complete one.
    const lines = (await response.text()).trim().split("\n").filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toEqual({ id: "e2", data: { title: "Eins" } })

    const { failures } = JSON.parse(lines[1]!) as { failures: { id: string; error: string }[] }
    expect(failures).toHaveLength(1)
    expect(failures[0]!.id).toBe("e1")
    expect(failures[0]!.error).toContain("model call 0 failed")
  })
})

describe("runTranslationBatch failure reporting", () => {
  test("reports an entry the model produced no usable answer for", async () => {
    // A chatty answer for a multi-field request cannot be read as JSON, so the entry would have been
    // dropped without a word; the reply has to say that it failed.
    const fake = createFakeModel(() => "not json at all")

    const response = await handleTranslationBatchRequest({
      body: {
        entries: [{ id: "e1", title: "One", description: "Two" }],
        fields: ["title", "description"],
        language: "en",
      },
      model: fake.model,
    })

    const lines = (await response.text()).trim().split("\n").filter(Boolean)
    expect(lines).toHaveLength(1)

    const { failures } = JSON.parse(lines[0]!) as { failures: { id: string; error: string }[] }
    expect(failures).toHaveLength(1)
    expect(failures[0]!.id).toBe("e1")
    expect(failures[0]!.error).toContain("no usable translation")
  })
})
