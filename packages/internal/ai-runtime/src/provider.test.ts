import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import { describe, expect, test } from "vitest"

import {
  MAX_CHUNK_CHARS,
  MAX_CONCURRENCY,
  MAX_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS_LIMIT,
  MIN_CHUNK_CHARS,
} from "./limits"
import { directCallOptions, resolveModelId } from "./provider"

const config = (patch: Partial<LocalAIDirectConfig> = {}): LocalAIDirectConfig => ({
  baseUrl: "https://api.example.com/v1",
  model: "model-a",
  models: ["model-a"],
  ...patch,
})

describe("directCallOptions", () => {
  test("keeps temperature 0, which is a value and not an empty field", () => {
    expect(directCallOptions(config({ temperature: 0 })).temperature).toBe(0)
    expect(directCallOptions(config({ temperature: 0.2 })).temperature).toBe(0.2)
  })

  test("clamps temperature to the range every endpoint understands", () => {
    expect(directCallOptions(config({ temperature: 5 })).temperature).toBe(2)
    expect(directCallOptions(config({ temperature: -1 })).temperature).toBe(0)
    expect(directCallOptions(config({ temperature: null })).temperature).toBeUndefined()
  })

  test("keeps the built-in output cap unless a usable one is configured", () => {
    expect(directCallOptions(config()).maxOutputTokens).toBe(MAX_OUTPUT_TOKENS)
    expect(directCallOptions(config({ maxOutputTokens: 2048 })).maxOutputTokens).toBe(2048)
    // Zero and negative values are not a cap, and a typo must not reach the provider.
    expect(directCallOptions(config({ maxOutputTokens: 0 })).maxOutputTokens).toBe(
      MAX_OUTPUT_TOKENS,
    )
    expect(directCallOptions(config({ maxOutputTokens: -10 })).maxOutputTokens).toBe(
      MAX_OUTPUT_TOKENS,
    )
    expect(directCallOptions(config({ maxOutputTokens: 10_000_000 })).maxOutputTokens).toBe(
      MAX_OUTPUT_TOKENS_LIMIT,
    )
  })

  test("bounds the chunk sizes of long articles", () => {
    expect(directCallOptions(config({ summaryChunkChars: 10 })).summaryChunkChars).toBe(
      MIN_CHUNK_CHARS,
    )
    expect(directCallOptions(config({ summaryChunkChars: 0 })).summaryChunkChars).toBeUndefined()
    expect(directCallOptions(config({ summaryChunkChars: 9000 })).summaryChunkChars).toBe(9000)
    expect(directCallOptions(config({ summaryChunkChars: 10_000_000 })).summaryChunkChars).toBe(
      MAX_CHUNK_CHARS,
    )
    expect(directCallOptions(config({ translationChunkChars: 10 })).translationChunkChars).toBe(
      MIN_CHUNK_CHARS,
    )
    expect(
      directCallOptions(config({ translationChunkChars: 10_000_000 })).translationChunkChars,
    ).toBe(MAX_CHUNK_CHARS)
    expect(directCallOptions(config()).summaryChunkChars).toBeUndefined()
  })

  test("bounds the number of entries translated at the same time", () => {
    // Zero and negative values mean "keep the built-in default", like an empty settings field.
    expect(
      directCallOptions(config({ translationConcurrency: 0 })).translationConcurrency,
    ).toBeUndefined()
    expect(
      directCallOptions(config({ translationConcurrency: -3 })).translationConcurrency,
    ).toBeUndefined()
    expect(directCallOptions(config({ translationConcurrency: 2 })).translationConcurrency).toBe(2)
    expect(directCallOptions(config({ translationConcurrency: 1000 })).translationConcurrency).toBe(
      MAX_CONCURRENCY,
    )
    expect(directCallOptions(config()).translationConcurrency).toBeUndefined()
  })

  test("sends the reasoning effort as a provider option only when it is set", () => {
    expect(directCallOptions(config({ reasoningEffort: "high" })).providerOptions).toEqual({
      localAi: { reasoningEffort: "high" },
    })
    expect(directCallOptions(config()).providerOptions).toBeUndefined()
  })
})

describe("resolveModelId", () => {
  test("keeps a model the settings declare, and falls back for anything else", () => {
    const settings = config({ model: "model-a", models: ["model-a", "model-b"] })

    expect(resolveModelId(settings, "model-b")).toBe("model-b")
    // A chat stored with another model must not fail the request.
    expect(resolveModelId(settings, "gone-model")).toBe("model-a")
    expect(resolveModelId(settings, null)).toBe("model-a")
    expect(resolveModelId(config({ model: "", models: [] }), "model-a")).toBe("")
  })
})
