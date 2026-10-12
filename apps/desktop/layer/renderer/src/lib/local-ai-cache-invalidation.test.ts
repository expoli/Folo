import { defaultAISettings } from "@follow/shared/settings/defaults"
import type { LocalAIGatewaySettings } from "@follow/shared/settings/interface"
import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import { LOCAL_AI_DIRECT_ORIGIN } from "@follow/shared/settings/local-ai"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

/**
 * The cache invalidation of the local AI wiring: switching the runtime has to drop the summaries and
 * translations the previous one wrote, and a failing drop has to be reported instead of escaping as
 * an unhandled rejection.
 */
const mocks = vi.hoisted(() => ({
  resetTranslations: vi.fn(),
  resetSummaries: vi.fn(),
  settings: null as LocalAIGatewaySettings | null,
  direct: null as LocalAIDirectConfig | null,
}))

vi.mock("@follow/store/translation/store", () => ({
  translationActions: { reset: mocks.resetTranslations, removeTranslation: vi.fn() },
  translationSyncService: { generateTranslation: vi.fn() },
}))

vi.mock("@follow/store/summary/store", () => ({
  summaryActions: { reset: mocks.resetSummaries },
}))

vi.mock("~/lib/client", () => ({ ipcServices: null }))
vi.mock("~/modules/ai-chat/services", () => ({ AIChatService: {} }))
vi.mock("@follow/shared/env.desktop", () => ({ env: {} }))

const settings = (changes: Partial<LocalAIGatewaySettings> = {}): LocalAIGatewaySettings => ({
  ...defaultAISettings.localGateway,
  enabled: true,
  mode: "direct",
  directBaseUrl: "https://api.example.com/v1",
  directModel: "model-a",
  directModels: ["model-a"],
  ...changes,
})

vi.mock("~/atoms/settings/ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/atoms/settings/ai")>()
  return {
    ...original,
    getAISettings: () => ({ ...original.getAISettings(), localGateway: mocks.settings! }),
    createDefaultSettings: () => ({
      ...original.createDefaultSettings(),
      localGateway: mocks.settings!,
    }),
  }
})

const { applyLocalAIGatewaySettings } = await import("./local-ai-gateway")

/** Aligns the module with the current runtime, so the next apply is the change under test. */
const align = () => {
  applyLocalAIGatewaySettings()
  mocks.resetTranslations.mockClear()
  mocks.resetSummaries.mockClear()
}

describe("local AI cache invalidation", () => {
  beforeEach(() => {
    mocks.resetTranslations.mockReset().mockResolvedValue(undefined)
    mocks.resetSummaries.mockReset().mockResolvedValue(undefined)
    mocks.settings = settings()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test("drops the cached text when the direct model or its tuning changes", () => {
    align()

    mocks.settings = settings({ directModel: "model-b" })
    applyLocalAIGatewaySettings()

    expect(mocks.resetTranslations).toHaveBeenCalledTimes(1)
    expect(mocks.resetSummaries).toHaveBeenCalledTimes(1)
  })

  test("drops the cached text when only the gateway address changes", () => {
    mocks.settings = settings({ mode: "gateway", baseUrl: "http://127.0.0.1:8788", token: "" })
    align()

    mocks.settings = settings({ mode: "gateway", baseUrl: "http://127.0.0.1:9999", token: "" })
    applyLocalAIGatewaySettings()

    expect(mocks.resetTranslations).toHaveBeenCalledTimes(1)
    expect(mocks.resetSummaries).toHaveBeenCalledTimes(1)
  })

  test("keeps the cached text when nothing about the runtime changed", () => {
    align()

    applyLocalAIGatewaySettings()

    expect(mocks.resetTranslations).not.toHaveBeenCalled()
    expect(mocks.resetSummaries).not.toHaveBeenCalled()
  })

  test("keeps it when local AI is switched off, which a free account could not regenerate", () => {
    align()

    mocks.settings = settings({ enabled: false })
    applyLocalAIGatewaySettings()

    expect(mocks.resetTranslations).not.toHaveBeenCalled()
    expect(mocks.resetSummaries).not.toHaveBeenCalled()
  })

  test("reports a failing drop instead of letting it become an unhandled rejection", async () => {
    align()
    const reported = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.resetSummaries.mockRejectedValue(new Error("no database"))

    mocks.settings = settings({ directModel: "model-b" })
    expect(() => applyLocalAIGatewaySettings()).not.toThrow()

    // Contained and said out loud; an unhandled rejection here would fail this suite.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reported).toHaveBeenCalledWith(
      "[local-ai] could not drop the cached AI text:",
      expect.any(Error),
    )

    // A failing drop must not stop the next switch from trying again.
    mocks.resetSummaries.mockResolvedValue(undefined)
    mocks.settings = settings({ directModel: "model-c" })
    applyLocalAIGatewaySettings()

    expect(mocks.resetSummaries).toHaveBeenCalledTimes(2)
  })
})

describe("direct endpoint fingerprint", () => {
  test("is what the store sees, because every direct request uses the same origin", () => {
    mocks.settings = settings()
    const config = applyLocalAIGatewaySettings()

    expect(config.mode).toBe("direct")
    expect(config.baseUrl).toBe(LOCAL_AI_DIRECT_ORIGIN)
    expect(config.fingerprint).toContain("https://api.example.com/v1")
    expect(config.fingerprint).toContain("model-a")
  })
})
