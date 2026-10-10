import { describe, expect, test } from "vitest"

import { cleanTitle, fallbackTitle } from "./title"

describe("cleanTitle", () => {
  test("drops quotes, the trailing period and any following lines", () => {
    expect(cleanTitle('  "A tidy title."  ')).toBe("A tidy title")
    expect(cleanTitle("Title\n\nand an explanation")).toBe("Title")
    expect(cleanTitle("")).toBe("")
    expect(cleanTitle(undefined)).toBe("")
  })
})

describe("fallbackTitle", () => {
  test("prefers a short message over a long shortcut template", () => {
    expect(
      fallbackTitle([
        { role: "user", content: `${"long template ".repeat(20)}` },
        { role: "assistant", content: "A short answer" },
      ]),
    ).toBe("A short answer")
  })

  test("takes the first line of a long answer", () => {
    expect(
      fallbackTitle([{ role: "assistant", content: "The day in a nutshell\nand then more text" }]),
    ).toBe("The day in a nutshell")
  })

  test("stays empty without a conversation", () => {
    expect(fallbackTitle([])).toBe("")
    expect(fallbackTitle([{ role: "assistant", content: "   " }])).toBe("")
  })
})
