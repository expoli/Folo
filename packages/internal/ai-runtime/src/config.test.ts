import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { fetchUpstreamModelIds, handleConfig, parseModelIds, resetModelListCache } from "./config"
import { DIRECT_CONTEXT_BUDGET } from "./provider"

const config = (patch: Partial<LocalAIDirectConfig> = {}): LocalAIDirectConfig => ({
  baseUrl: "https://api.example.com/v1",
  model: "model-a",
  models: ["model-a"],
  ...patch,
})

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  })

describe("parseModelIds", () => {
  test("reads the OpenAI list and a plain array of ids", () => {
    expect(parseModelIds({ data: [{ id: "a" }, { id: "b" }, "c", {}, null] })).toEqual([
      "a",
      "b",
      "c",
    ])
    expect(parseModelIds(["a", " b "])).toEqual(["a", "b"])
  })

  test("reads nothing out of an unexpected payload", () => {
    expect(parseModelIds({ error: "nope" })).toEqual([])
    expect(parseModelIds(null)).toEqual([])
  })
})

describe("fetchUpstreamModelIds", () => {
  beforeEach(() => {
    resetModelListCache()
    vi.useFakeTimers({ toFake: ["Date"] })
  })

  afterEach(() => {
    vi.useRealTimers()
    resetModelListCache()
  })

  test("does not reuse a rejection for another key", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ error: "nope" }, 401))
      .mockResolvedValueOnce(json({ data: [{ id: "model-b" }] }))

    await expect(fetchUpstreamModelIds(config(), "wrong-key", fetch)).resolves.toEqual({
      ids: [],
      rejected: true,
    })

    // The draft probe of the settings screen: the user corrected the key and tries again.
    await expect(fetchUpstreamModelIds(config(), "right-key", fetch)).resolves.toEqual({
      ids: ["model-b"],
      rejected: false,
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test("keeps a catalogue for a minute, and a rejection only for a moment", async () => {
    const now = Date.now()
    const accepted = vi.fn().mockResolvedValue(json({ data: [{ id: "model-a" }] }))
    const rejected = vi.fn().mockResolvedValue(json({}, 401))

    await fetchUpstreamModelIds(config(), "key", accepted)
    await fetchUpstreamModelIds(config(), "key", accepted)
    expect(accepted).toHaveBeenCalledTimes(1)

    const other = config({ baseUrl: "https://other.example.com/v1" })
    await fetchUpstreamModelIds(other, "key", rejected)

    // A rejected key is retried as soon as the short failure window is over…
    vi.setSystemTime(now + 11_000)
    await fetchUpstreamModelIds(other, "key", rejected)
    expect(rejected).toHaveBeenCalledTimes(2)

    // …while the catalogue of the first endpoint is still remembered.
    vi.setSystemTime(now + 20_000)
    await fetchUpstreamModelIds(config(), "key", accepted)
    expect(accepted).toHaveBeenCalledTimes(1)
  })

  test("reports the endpoint, never the key, when the key was rejected", async () => {
    const fetch = vi.fn().mockResolvedValue(json({}, 401))
    const response = await handleConfig(config(), "sk-secret-key", fetch)

    const text = await response.text()
    expect(response.status).toBe(401)
    expect(text).toContain("https://api.example.com/v1/models")
    expect(text).not.toContain("sk-secret-key")
  })

  test("answers the catalogue and the context budget the client uses", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ data: [{ id: "model-a" }, { id: "model-b" }] }))

    const response = await handleConfig(config(), null, fetch)
    await expect(response.json()).resolves.toEqual({
      defaultModel: "model-a",
      availableModels: ["model-a", "model-b"],
      availableModelsMenu: [
        { label: "model-a", value: "model-a" },
        { label: "model-b", value: "model-b" },
      ],
      localAIContext: DIRECT_CONTEXT_BUDGET,
    })
  })
})
