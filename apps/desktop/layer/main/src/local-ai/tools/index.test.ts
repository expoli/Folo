import { afterEach, describe, expect, test } from "vitest"

import {
  isToolRejectionError,
  isToolSupportRejected,
  localAIToolSupportKey,
  markToolSupportRejected,
  resetToolSupport,
} from "."

const key = (model = "deepseek-chat") =>
  localAIToolSupportKey({ baseUrl: "https://api.example.com/v1", model })

afterEach(() => {
  resetToolSupport()
})

describe("isToolRejectionError", () => {
  test("recognises an endpoint that does not do tool calling", () => {
    expect(isToolRejectionError(new Error("This endpoint does not support tools"))).toBe(true)
    expect(isToolRejectionError(new Error("tools are not supported by this model"))).toBe(true)
    expect(isToolRejectionError(new Error("unsupported parameter: tools"))).toBe(true)
  })

  test("counts the statuses providers use for that refusal", () => {
    for (const statusCode of [400, 404, 422]) {
      const error = Object.assign(new Error("tools are not supported"), { statusCode })
      expect(isToolRejectionError(error)).toBe(true)
    }
  })

  test("leaves unrelated failures alone", () => {
    expect(isToolRejectionError(new Error("invalid api key"))).toBe(false)
    expect(isToolRejectionError(new Error("rate limit exceeded"))).toBe(false)
    // A server error is the endpoint failing, not a statement about its capabilities.
    expect(
      isToolRejectionError(
        Object.assign(new Error("tools are not supported"), { statusCode: 500 }),
      ),
    ).toBe(false)
    expect(isToolRejectionError(undefined)).toBe(false)
    expect(isToolRejectionError("")).toBe(false)
  })
})

describe("tool support memory", () => {
  test("is per endpoint and model, and starts empty", () => {
    expect(isToolSupportRejected(key())).toBe(false)

    markToolSupportRejected(key())

    expect(isToolSupportRejected(key())).toBe(true)
    expect(isToolSupportRejected(key("another-model"))).toBe(false)
  })

  test("is forgotten when the app restarts", () => {
    markToolSupportRejected(key())
    resetToolSupport()

    expect(isToolSupportRejected(key())).toBe(false)
  })
})
