import { beforeEach, describe, expect, test } from "vitest"

import {
  configureLocalAI,
  getLocalAIConfig,
  isLocalAIEnabled,
  localAIUrl,
  resetLocalAI,
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
})
