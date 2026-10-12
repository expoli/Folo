import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import { LOCAL_AI_DIRECT_ORIGIN } from "@follow/shared/settings/local-ai"
import { describe, expect, it } from "vitest"

import { resolveLocalAIConfig } from "./config"
import { directConfigFingerprint, localAIRuntimeFingerprint } from "./settings"

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

describe("localAIRuntimeFingerprint", () => {
  const gateway = { mode: "gateway", baseUrl: "http://127.0.0.1:8788" } as const
  const direct = { mode: "direct", baseUrl: LOCAL_AI_DIRECT_ORIGIN } as const

  it("is null while local AI is off, so its cached text survives being turned off", () => {
    expect(localAIRuntimeFingerprint(null, null)).toBeNull()
    expect(localAIRuntimeFingerprint({ mode: "direct", baseUrl: null }, config())).toBeNull()
  })

  it("covers the gateway address, which the direct fingerprint never sees", () => {
    const fingerprint = localAIRuntimeFingerprint(gateway, null)

    expect(fingerprint).toBe(localAIRuntimeFingerprint({ ...gateway }, null))
    expect(fingerprint).not.toBe(
      localAIRuntimeFingerprint({ mode: "gateway", baseUrl: "http://127.0.0.1:8789" }, null),
    )
  })

  it("covers the direct endpoint, its model and its tuning", () => {
    expect(localAIRuntimeFingerprint(direct, config())).toBe(directConfigFingerprint(config()))
    expect(localAIRuntimeFingerprint(direct, config({ model: "model-b" }))).not.toBe(
      localAIRuntimeFingerprint(direct, config()),
    )
    expect(localAIRuntimeFingerprint(direct, config({ temperature: 0 }))).not.toBe(
      localAIRuntimeFingerprint(direct, config()),
    )
  })

  it("never carries the gateway token", () => {
    const resolved = resolveLocalAIConfig({
      enabled: true,
      mode: "gateway",
      baseUrl: "http://127.0.0.1:8788",
      token: "a-secret-gateway-token",
    })

    expect(localAIRuntimeFingerprint(resolved, null)).not.toContain("a-secret-gateway-token")
  })
})
