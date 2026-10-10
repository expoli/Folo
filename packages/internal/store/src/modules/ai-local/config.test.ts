import { beforeEach, describe, expect, test } from "vitest"

import {
  configureLocalAI,
  DEFAULT_LOCAL_AI_CONTEXT_BUDGET,
  getLocalAIConfig,
  getLocalAIContextBudget,
  isLocalAIEnabled,
  localAIUrl,
  resetLocalAI,
  resolveLocalAIConfig,
  setLocalAIContextBudget,
} from "./config"

describe("local AI config", () => {
  beforeEach(() => {
    resetLocalAI()
  })

  test("is disabled by default", () => {
    expect(isLocalAIEnabled()).toBe(false)
    expect(getLocalAIConfig()).toEqual({ baseUrl: null, token: null })
    expect(() => localAIUrl("/ai/summary")).toThrow()
  })

  test("normalizes the base URL and trims blank values", () => {
    configureLocalAI({ baseUrl: "http://127.0.0.1:8788/", token: " secret " })

    expect(getLocalAIConfig()).toEqual({ baseUrl: "http://127.0.0.1:8788", token: "secret" })
    expect(localAIUrl("/ai/chat")).toBe("http://127.0.0.1:8788/ai/chat")
    expect(localAIUrl("ai/chat")).toBe("http://127.0.0.1:8788/ai/chat")
  })

  test.each([null, undefined, { baseUrl: "" }, { baseUrl: "   " }])(
    "stays disabled for %s",
    (value) => {
      configureLocalAI(value as Parameters<typeof configureLocalAI>[0])

      expect(isLocalAIEnabled()).toBe(false)
      expect(() => localAIUrl("/ai/chat")).toThrow()
    },
  )

  test("starts with the conservative context budget", () => {
    expect(getLocalAIContextBudget()).toEqual(DEFAULT_LOCAL_AI_CONTEXT_BUDGET)
    expect(DEFAULT_LOCAL_AI_CONTEXT_BUDGET).toEqual({
      maxEntries: 20,
      maxCharsPerEntry: 1500,
      maxTotalChars: 30_000,
    })
  })

  test("accepts the budget announced by the gateway", () => {
    expect(
      setLocalAIContextBudget({ maxEntries: 5, maxCharsPerEntry: 100, maxTotalChars: 250 }),
    ).toEqual({ maxEntries: 5, maxCharsPerEntry: 100, maxTotalChars: 250 })
    expect(getLocalAIContextBudget().maxCharsPerEntry).toBe(100)
  })

  test.each([
    [undefined, DEFAULT_LOCAL_AI_CONTEXT_BUDGET],
    [null, DEFAULT_LOCAL_AI_CONTEXT_BUDGET],
    [{}, DEFAULT_LOCAL_AI_CONTEXT_BUDGET],
    [
      { maxEntries: 0, maxCharsPerEntry: -1, maxTotalChars: Number.NaN },
      DEFAULT_LOCAL_AI_CONTEXT_BUDGET,
    ],
    [{ maxEntries: 7 }, { ...DEFAULT_LOCAL_AI_CONTEXT_BUDGET, maxEntries: 7 }],
  ])("falls back field by field for %s", (budget, expected) => {
    setLocalAIContextBudget(budget as Parameters<typeof setLocalAIContextBudget>[0])

    expect(getLocalAIContextBudget()).toEqual(expected)
  })

  test("resets the budget when local AI is reset", () => {
    configureLocalAI({ baseUrl: "http://127.0.0.1:8788" })
    setLocalAIContextBudget({ maxTotalChars: 42 })

    resetLocalAI()

    expect(getLocalAIContextBudget()).toEqual(DEFAULT_LOCAL_AI_CONTEXT_BUDGET)
  })
})

describe("resolveLocalAIConfig", () => {
  test("maps saved settings onto the gateway config, trimming blanks and slashes", () => {
    expect(
      resolveLocalAIConfig({
        enabled: true,
        baseUrl: "  http://127.0.0.1:8788/  ",
        token: " token-1 ",
      }),
    ).toEqual({ baseUrl: "http://127.0.0.1:8788", token: "token-1" })
  })

  test("keeps the token empty when the settings do not carry one", () => {
    expect(
      resolveLocalAIConfig({ enabled: true, baseUrl: "http://127.0.0.1:8788", token: "" }),
    ).toEqual({ baseUrl: "http://127.0.0.1:8788", token: null })
  })

  test.each([
    ["the switch is off", { enabled: false, baseUrl: "http://127.0.0.1:8788", token: "t" }],
    ["the address is empty", { enabled: true, baseUrl: "", token: "t" }],
    ["the address is blank", { enabled: true, baseUrl: "   ", token: "" }],
    ["settings predate the gateway", undefined],
    ["settings are unreadable", null],
  ])("disables the gateway when %s", (_label, settings) => {
    expect(resolveLocalAIConfig(settings)).toBeNull()
  })

  test("feeds configureLocalAI so the store follows the saved settings", () => {
    configureLocalAI(resolveLocalAIConfig({ enabled: false, baseUrl: "", token: "" }))
    expect(isLocalAIEnabled()).toBe(false)

    configureLocalAI(
      resolveLocalAIConfig({ enabled: true, baseUrl: "http://127.0.0.1:8788", token: "t" }),
    )
    expect(isLocalAIEnabled()).toBe(true)
    expect(localAIUrl("/ai/summary")).toBe("http://127.0.0.1:8788/ai/summary")
  })
})
