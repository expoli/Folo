import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import { describe, expect, it } from "vitest"

import { directConfigFingerprint } from "./settings"

const config = (patch: Partial<LocalAIDirectConfig> = {}): LocalAIDirectConfig => ({
  baseUrl: "https://api.example.com/v1",
  model: "model-a",
  models: ["model-a"],
  ...patch,
})

describe("directConfigFingerprint", () => {
  it("is null while no endpoint is configured", () => {
    expect(directConfigFingerprint(null)).toBeNull()
  })

  it("stays the same for the same endpoint and model", () => {
    expect(directConfigFingerprint(config())).toBe(directConfigFingerprint(config()))
  })

  it("ignores what does not change an answer", () => {
    // The catalogue and the token decide how the app talks to the endpoint, not what it writes.
    expect(directConfigFingerprint(config({ models: ["a", "b"] }))).toBe(
      directConfigFingerprint(config()),
    )
  })

  it("changes with the endpoint, the model and the tuning", () => {
    const baseline = directConfigFingerprint(config())

    expect(directConfigFingerprint(config({ baseUrl: "https://other.example.com/v1" }))).not.toBe(
      baseline,
    )
    expect(directConfigFingerprint(config({ model: "model-b" }))).not.toBe(baseline)
    expect(directConfigFingerprint(config({ temperature: 0.2 }))).not.toBe(baseline)
  })
})
