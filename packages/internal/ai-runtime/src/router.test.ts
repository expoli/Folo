import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import { describe, expect, test, vi } from "vitest"

import { badRequest } from "./errors"
import type { DirectRouteInput } from "./router"
import { routeLocalAIRequest } from "./router"
import { createFakeModel } from "./test-model"

const config = (): LocalAIDirectConfig => ({
  baseUrl: "https://api.example.com/v1",
  model: "model-a",
  models: ["model-a"],
})

/** Only the paths that need the model reach for the transport; the model itself is injected here. */
const unusedFetch = (async () => new Response("{}")) as typeof globalThis.fetch

const route = (patch: Partial<DirectRouteInput> = {}) =>
  routeLocalAIRequest({
    path: "/ai/summary",
    method: "POST",
    body: JSON.stringify({ content: "The article text." }),
    config: config(),
    apiKey: null,
    fetch: unusedFetch,
    createModel: () => createFakeModel(() => "a summary").model,
    ...patch,
  })

describe("routeLocalAIRequest", () => {
  test("answers a provider failure as a bad upstream, not as a bad request", async () => {
    const fake = createFakeModel(() => "unused")
    fake.setFailingAnswers([0])

    const response = await route({ createModel: () => fake.model })

    expect(response?.status).toBe(502)
    await expect(response?.json()).resolves.toMatchObject({
      error: expect.stringContaining("model call 0 failed"),
    })
  })

  test("keeps the status of a typed request error", async () => {
    const response = await route({
      createModel: () => {
        throw badRequest("No model is configured for the direct endpoint")
      },
    })

    expect(response?.status).toBe(400)
    await expect(response?.json()).resolves.toMatchObject({
      error: "No model is configured for the direct endpoint",
    })
  })

  test("reports an unreadable body as a request error", async () => {
    const response = await route({ body: "{not json" })

    expect(response?.status).toBe(400)
    await expect(response?.json()).resolves.toMatchObject({
      error: expect.stringContaining("not valid JSON"),
    })
  })

  test("reports an unexpected failure as an internal error", async () => {
    const response = await route({
      createModel: () => {
        throw new Error("kaboom")
      },
    })

    expect(response?.status).toBe(500)
  })

  test("owns health and the model catalogue, and nothing else", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "model-b" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof globalThis.fetch

    const health = await route({ path: "/health", method: "GET", body: null, fetch })
    expect(health?.status).toBe(200)
    await expect(health?.json()).resolves.toMatchObject({
      ok: true,
      upstream: "https://api.example.com/v1",
      // The configured default, which is what a request without a model uses.
      defaultModel: "model-a",
    })

    const modelList = await route({ path: "/ai/chat/config", method: "GET", body: null, fetch })
    await expect(modelList?.json()).resolves.toMatchObject({ availableModels: ["model-b"] })

    // Chat streams over its own transport, so the shared router does not answer it.
    expect(await route({ path: "/ai/chat", method: "POST" })).toBeNull()
    expect(await route({ path: "/ai/unknown", method: "POST" })).toBeNull()
  })
})
