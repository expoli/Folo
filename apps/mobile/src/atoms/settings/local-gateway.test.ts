import { defaultAISettings } from "@follow/shared/settings/defaults"
import { LOCAL_AI_DIRECT_ORIGIN } from "@follow/shared/settings/local-ai"
import { resolveLocalAIConfig } from "@follow/store/ai-local/config"
import { describe, expect, test } from "vitest"

import { applyLocalGatewayPatch } from "./local-gateway"

const current = {
  ...defaultAISettings.localGateway,
  enabled: true,
  mode: "gateway" as const,
  baseUrl: "https://gateway.example.com",
  token: "gateway-token",
}

describe("applyLocalGatewayPatch", () => {
  test("selects and enables the direct runtime when an endpoint is saved", () => {
    const next = applyLocalGatewayPatch(
      { ...current, enabled: false },
      { enabled: true, directBaseUrl: "https://api.example.com/v1" },
    )

    expect(next.enabled).toBe(true)
    expect(next.directBaseUrl).toBe("https://api.example.com/v1")
    expect(resolveLocalAIConfig(next)).toEqual({
      mode: "direct",
      baseUrl: LOCAL_AI_DIRECT_ORIGIN,
      token: null,
    })
  })

  test.each(["", " \t ", "///"])(
    "keeps the gateway runtime when the saved direct address is %j",
    (directBaseUrl) => {
      const next = applyLocalGatewayPatch(
        { ...current, directBaseUrl: "https://api.example.com/v1" },
        { directBaseUrl },
      )

      expect(next.enabled).toBe(true)
      expect(next.directBaseUrl).toBe(directBaseUrl)
      expect(resolveLocalAIConfig(next)).toEqual(resolveLocalAIConfig(current))
      expect(resolveLocalAIConfig(next)?.mode).toBe("gateway")
    },
  )

  test.each([
    { directModel: "model-a" },
    { directModels: ["model-a"] },
    { directOptions: { ...current.directOptions, temperature: 0.5 } },
  ])("keeps the gateway runtime for direct options without an endpoint: %j", (patch) => {
    const next = applyLocalGatewayPatch(current, patch)

    expect(next.enabled).toBe(true)
    expect(resolveLocalAIConfig(next)).toEqual(resolveLocalAIConfig(current))
    expect(resolveLocalAIConfig(next)?.mode).toBe("gateway")
  })

  test.each([
    { directModel: "model-a" },
    { directModels: ["model-a"] },
    { directOptions: current.directOptions },
  ])("selects the direct runtime for options when an endpoint exists: %j", (patch) => {
    const next = applyLocalGatewayPatch(
      { ...current, directBaseUrl: "https://api.example.com/v1" },
      patch,
    )

    expect(resolveLocalAIConfig(next)).toEqual({
      mode: "direct",
      baseUrl: LOCAL_AI_DIRECT_ORIGIN,
      token: null,
    })
  })

  test("keeps the configured mode when only the switch changes", () => {
    const next = applyLocalGatewayPatch(
      { ...current, directBaseUrl: "https://api.example.com/v1" },
      { enabled: false },
    )

    expect(next.mode).toBe("gateway")
    expect(next.enabled).toBe(false)
    expect(resolveLocalAIConfig(next)).toBeNull()
    expect(resolveLocalAIConfig({ ...next, enabled: true })).toEqual(resolveLocalAIConfig(current))
  })

  test("lets an explicit mode win", () => {
    const next = applyLocalGatewayPatch(current, {
      mode: "gateway",
      directBaseUrl: "https://api.example.com/v1",
    })

    expect(next.mode).toBe("gateway")
    expect(resolveLocalAIConfig(next)).toEqual(resolveLocalAIConfig(current))
  })

  test("honors an explicit direct mode even without an endpoint", () => {
    const next = applyLocalGatewayPatch(current, { mode: "direct", directBaseUrl: "" })

    expect(next.mode).toBe("direct")
    expect(resolveLocalAIConfig(next)).toBeNull()
  })

  test("clears the active direct endpoint without falling back to the gateway", () => {
    const next = applyLocalGatewayPatch(
      { ...current, mode: "direct", directBaseUrl: "https://api.example.com/v1" },
      { directBaseUrl: "" },
    )

    expect(next.enabled).toBe(true)
    expect(next.mode).toBe("direct")
    expect(next.directBaseUrl).toBe("")
    expect(resolveLocalAIConfig(next)).toBeNull()
  })

  test("keeps the fields the patch does not mention", () => {
    const next = applyLocalGatewayPatch(current, { token: "secret" })

    expect(next).toEqual({ ...current, token: "secret" })
    expect(resolveLocalAIConfig(next)).toEqual({
      mode: "gateway",
      baseUrl: current.baseUrl,
      token: "secret",
    })
  })
})
