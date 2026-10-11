import {
  DEFAULT_CHAT_SYSTEM_PROMPT,
  languageName,
  NO_CONTEXT_NOTE,
} from "@follow/store/ai-local/direct/prompts"
import { describe, expect, test } from "vitest"

import {
  applyEntryNotes,
  buildChatSystemPrompt,
  describeChatContext,
  formatLocalContext,
  messageText,
  pendingEntryTexts,
  toModelMessages,
} from "./context"

describe("messageText", () => {
  test("joins text and rich-text data parts", () => {
    expect(
      messageText({
        role: "user",
        parts: [
          { type: "text", text: "Hello" },
          { type: "data-rich-text", data: { text: "quoted entry" } },
          { type: "step-start" },
        ],
      }),
    ).toBe("Hello\n\nquoted entry")
  })

  test("ignores parts without text", () => {
    expect(messageText({ parts: [{ type: "data-timeline", data: { count: 3 } }] })).toBe("")
    expect(messageText(undefined)).toBe("")
  })
})

describe("toModelMessages", () => {
  test("keeps the role and drops messages that carry no text", () => {
    expect(
      toModelMessages([
        { role: "user", parts: [{ type: "text", text: "Question" }] },
        { role: "assistant", parts: [{ type: "step-start" }] },
        { role: "tool", parts: [{ type: "text", text: "Tool answer" }] },
      ]),
    ).toEqual([
      { role: "user", content: "Question" },
      { role: "user", content: "Tool answer" },
    ])
  })

  test("tolerates a body without messages", () => {
    expect(toModelMessages(undefined)).toEqual([])
    expect(toModelMessages("nope")).toEqual([])
  })
})

describe("formatLocalContext", () => {
  const entries = [
    {
      title: "First entry",
      url: "https://example.com/1",
      publishedAt: "2026-01-01",
      content: "Body of the first entry",
    },
    { title: "", content: "" },
  ]

  test("renders the entries with their header and numbering", () => {
    const context = formatLocalContext({ entries })

    expect(context).toContain("The user is currently looking at the following entries in Folo.")
    expect(context).toContain("### [1] First entry — https://example.com/1 — 2026-01-01")
    expect(context).toContain("Body of the first entry")
    expect(context).toContain("### [2] (untitled)")
    expect(context).toContain("(no text attached)")
  })

  test("stays out of the prompt when every entry carries its text", () => {
    const context = formatLocalContext({
      entries: [{ title: "One", content: "Body" }],
      coverage: { matched: 1 },
    })

    // Nothing was cut and no window was named, so the prompt reads exactly as it did before.
    expect(context).not.toContain("Coverage:")
    expect(context).toContain("Body")
  })

  test("reports how much of the selection the budget could carry", () => {
    const context = formatLocalContext({
      entries: [
        { title: "Read one", content: "Body" },
        { title: "Listed one" },
        { title: "Listed two" },
      ],
      coverage: { matched: 137, window: "Today" },
    })

    expect(context).toContain(
      'Coverage: window "Today", 137 matched, 1 with text, 2 title-only, 134 not listed.',
    )
    expect(context).toContain("never summarise them as if their content were known")
    // The note comes before the entries, so the model reads the limit first.
    expect(context?.indexOf("Coverage:")).toBeLessThan(context?.indexOf("### [1]") ?? 0)
  })

  test("says when the window holds nothing instead of staying silent", () => {
    const context = formatLocalContext({
      entries: [],
      coverage: { matched: 0, window: "Yesterday" },
      blocks: [{ type: "mainView", value: "0" }],
    })

    expect(context).toContain('Coverage: window "Yesterday", 0 matched, 0 with text.')
    expect(context).toContain("The window holds no entry")
    expect(context).toContain('Context selection: mainView="0"')
  })

  test("renders the feed candidates separately", () => {
    const context = formatLocalContext({
      feeds: [{ title: "Tech feed", url: "https://example.com/rss", description: "Daily news" }],
    })

    expect(context).toContain(
      "Candidate feeds the user could subscribe to (pick only from this list):",
    )
    expect(context).toContain("### [F1] Tech feed — https://example.com/rss")
    expect(context).toContain("Daily news")
    expect(context).not.toContain("currently looking at the following entries")
  })

  test("names the context blocks the user selected", () => {
    const context = formatLocalContext({
      entries,
      blocks: [
        { type: "mainEntry", value: "entry-1" },
        { type: "timeline", value: "7d" },
      ],
    })

    expect(context).toContain('Context selection: mainEntry="entry-1", timeline="7d"')
  })

  test("stays empty without entries and feeds, whatever else arrived", () => {
    expect(formatLocalContext(undefined)).toBe("")
    expect(formatLocalContext({ blocks: [{ type: "mainEntry", value: "entry-1" }] })).toBe("")
    expect(formatLocalContext({ entries: [], feeds: [] })).toBe("")
  })
})

describe("pendingEntryTexts", () => {
  test("picks the entries whose text the prompt could not carry", () => {
    const pending = pendingEntryTexts({
      entries: [
        { title: "With text", content: "Body" },
        { title: "Waiting", body: "Full text" },
        { title: "Nothing at all" },
        { title: "Body but no text either", body: "" },
      ],
    })

    // The position is the one the prompt uses, so a note can be attributed back to it.
    expect(pending).toEqual([{ index: 2, title: "Waiting", url: undefined, body: "Full text" }])
  })

  test("finds nothing in a request without context", () => {
    expect(pendingEntryTexts(undefined)).toEqual([])
    expect(pendingEntryTexts({ entries: [{ content: "Body" }] })).toEqual([])
  })
})

describe("applyEntryNotes", () => {
  test("attaches the notes of the pre-pass and leaves the attached texts alone", () => {
    const context = applyEntryNotes(
      {
        entries: [
          { title: "With text", content: "Body", body: "Full text" },
          { title: "Summarised", body: "Full text" },
        ],
      },
      new Map([[2, "A note"]]),
    )

    expect(context?.entries).toEqual([
      { title: "With text", content: "Body", body: "Full text" },
      { title: "Summarised", body: "Full text", note: "A note" },
    ])
  })

  test("returns the context unchanged when nothing was summarized", () => {
    const context = { entries: [{ title: "One" }] }

    expect(applyEntryNotes(context, new Map())).toBe(context)
    expect(applyEntryNotes(undefined, new Map([[1, "note"]]))).toBeNull()
  })
})

describe("formatLocalContext with summarized articles", () => {
  test("renders the note as a summary and says what was not read", () => {
    const context = formatLocalContext({
      coverage: { matched: 3 },
      entries: [
        { title: "With text", content: "Body" },
        { title: "Summarised", note: "The gist of it" },
        { title: "Only a title" },
      ],
    })

    expect(context).toContain("### [2] Summarised")
    expect(context).toContain("(summarised from its full text)\nThe gist of it")
    expect(context).toContain("### [3] Only a title")
    expect(context).toContain(
      "Coverage: 3 matched, 1 with text, 1 summarised from their text, 1 title-only.",
    )
    // A summarized article was read; only the title-only one carries the warning.
    expect(context).toContain("never summarise them as if their content were known")
  })

  test("states what was summarized even when nothing was left out", () => {
    const context = formatLocalContext({
      coverage: { matched: 1 },
      entries: [{ title: "Summarised", note: "The gist of it" }],
    })

    // The counts stay, so the model can tell a note apart from an article it read in full.
    expect(context).toContain("Coverage: 1 matched, 0 with text, 1 summarised from their text.")
    expect(context).not.toContain("title-only")
    expect(context).toContain("The gist of it")
  })
})

describe("buildChatSystemPrompt", () => {
  test("appends the attached context", () => {
    const prompt = buildChatSystemPrompt(DEFAULT_CHAT_SYSTEM_PROMPT, "### [1] Entry")

    expect(prompt).toContain(DEFAULT_CHAT_SYSTEM_PROMPT)
    expect(prompt).toContain("### [1] Entry")
    expect(prompt).not.toContain(NO_CONTEXT_NOTE)
  })

  test("explains the missing context instead of inventing one", () => {
    const prompt = buildChatSystemPrompt(DEFAULT_CHAT_SYSTEM_PROMPT, "")

    expect(prompt).toContain(NO_CONTEXT_NOTE)
    expect(prompt.endsWith(NO_CONTEXT_NOTE)).toBe(true)
  })

  test("states the language the interface runs in", () => {
    const prompt = buildChatSystemPrompt(DEFAULT_CHAT_SYSTEM_PROMPT, "### [1] Entry", "ja")

    // A shortcut's own prompt may be written in another language; the answer still has to match.
    expect(prompt).toContain("Reply in Japanese.")
    expect(prompt).not.toContain("Reply in English.")
  })
})

describe("describeChatContext", () => {
  test("counts blocks, entries, feeds and content characters", () => {
    expect(
      describeChatContext({
        entries: [{ content: "12345" }, { content: "678" }],
        feeds: [{ title: "a" }],
        blocks: [
          { type: "mainFeed", value: "feed-1" },
          { type: "unreadOnly", value: "" },
        ],
      }),
    ).toEqual({
      blocks: 2,
      entries: 2,
      withText: 2,
      reduceTexts: 0,
      matched: 2,
      window: "",
      feeds: 1,
      contextChars: 8,
      // The selection is logged, so a wrong scope is visible without guessing.
      selection: "mainFeed:feed-1,unreadOnly:",
    })
  })

  test("logs the period the prompt asked about", () => {
    expect(
      describeChatContext({
        entries: [{ content: "12345" }],
        coverage: { matched: 94, window: "last 24 hours" },
      }),
    ).toMatchObject({ matched: 94, window: "last 24 hours" })
  })

  test("reports how many matched entries carried text", () => {
    expect(
      describeChatContext({
        entries: [{ content: "12345" }, { title: "no text" }, { title: "no text either" }],
        coverage: { matched: 40, window: "Today" },
      }),
    ).toEqual({
      blocks: 0,
      entries: 3,
      withText: 1,
      reduceTexts: 0,
      matched: 40,
      window: "Today",
      feeds: 0,
      contextChars: 5,
      selection: "",
    })
  })

  test("reports how many articles the client sent for the reduce pre-pass", () => {
    expect(
      describeChatContext({
        entries: [
          { content: "12345" },
          { body: "full text sent for summarizing" },
          { title: "no text at all" },
        ],
        coverage: { matched: 3 },
      }),
    ).toMatchObject({ entries: 3, withText: 1, reduceTexts: 1 })
  })

  test("reports zeros for a request without context", () => {
    expect(describeChatContext(undefined)).toEqual({
      blocks: 0,
      entries: 0,
      withText: 0,
      reduceTexts: 0,
      matched: 0,
      window: "",
      feeds: 0,
      contextChars: 0,
      selection: "",
    })
  })
})

describe("languageName", () => {
  test("maps the languages the client sends", () => {
    expect(languageName("zh-CN")).toBe("Simplified Chinese")
    expect(languageName("ja")).toBe("Japanese")
  })

  test("falls back to the code, then to English", () => {
    expect(languageName("pt-BR")).toBe("pt-BR")
    expect(languageName(null)).toBe("English")
  })
})
