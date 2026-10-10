import { describe, expect, test } from "vitest"

import {
  buildChatSystemPrompt,
  describeChatContext,
  formatLocalContext,
  messageText,
  toModelMessages,
} from "./context"
import { DEFAULT_CHAT_SYSTEM_PROMPT, languageName, NO_CONTEXT_NOTE } from "./prompts"

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
    expect(context).toContain("(no content available)")
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
})

describe("describeChatContext", () => {
  test("counts blocks, entries, feeds and content characters", () => {
    expect(
      describeChatContext({
        entries: [{ content: "12345" }, { content: "678" }],
        feeds: [{ title: "a" }],
        blocks: [{ type: "mainEntry" }],
      }),
    ).toEqual({ blocks: 1, entries: 2, feeds: 1, contextChars: 8 })
  })

  test("reports zeros for a request without context", () => {
    expect(describeChatContext(undefined)).toEqual({
      blocks: 0,
      entries: 0,
      feeds: 0,
      contextChars: 0,
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
