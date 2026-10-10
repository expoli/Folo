import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"

import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import { join } from "pathe"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  userData: "",
  encryptionAvailable: false,
  /** Methods the `@IpcMethod()` decorator collected, i.e. the IPC surface of the service. */
  methods: [] as string[],
}))

vi.mock("electron", () => ({
  app: {
    getPath: () => mocks.userData,
  },
  // Direct-mode requests go through Chromium's `net.fetch`; the cases stub `globalThis.fetch`.
  net: { fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init) },
  safeStorage: {
    isEncryptionAvailable: () => mocks.encryptionAvailable,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (buffer: Buffer) => buffer.toString("utf8"),
  },
}))

// Follows `integration.test.ts`: the real decorator pulls in Electron's `ipcMain` at import time.
vi.mock("electron-ipc-decorator", () => ({
  IpcMethod: () => (_target: unknown, propertyKey: string, descriptor: PropertyDescriptor) => {
    mocks.methods.push(propertyKey)
    return descriptor
  },
  IpcService: class {
    protected handler = { sendToRenderer: vi.fn() }
  },
  getIpcContext: () => ({
    // `once`/`off` carry the "the window went away" hook the chat service installs.
    sender: { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), off: vi.fn() },
  }),
}))

const { LocalAIService } = await import("./local-ai")
const { resetModelListCache } = await import("../../local-ai/routes")

// The decorator runs when the class is defined, i.e. at import time above.
const registeredMethods = [...mocks.methods]

const config: LocalAIDirectConfig = {
  baseUrl: "https://api.example.com/v1",
  model: "model-a",
  models: ["model-a"],
}

beforeEach(() => {
  mocks.userData = mkdtempSync(join(tmpdir(), "folo-local-ai-service-"))
  mocks.encryptionAvailable = false
  // The model list is cached between requests; cases have to start from a clean slate.
  resetModelListCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("LocalAIService", () => {
  test("exposes every method of the local AI contract under the localAI channel prefix", () => {
    new LocalAIService()

    expect(registeredMethods).toEqual([
      "hasApiKey",
      "isSecureStorageAvailable",
      "setApiKey",
      "clearApiKey",
      "listModels",
      "request",
      "openChatStream",
      "closeChatStream",
    ])
    expect(LocalAIService.groupName).toBe("localAI")
  })

  test("answers 404 for a path outside the contract", async () => {
    const service = new LocalAIService()

    await expect(
      service.request({ path: "/ai/unknown", method: "GET", body: null, config }),
    ).resolves.toEqual({
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "Unsupported endpoint: GET /ai/unknown" }),
    })
  })

  test("returns the model list of the endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    )
    const service = new LocalAIService()

    await expect(service.listModels({ config })).resolves.toEqual(["model-a", "model-b"])
  })

  test("surfaces a rejected key when fetching models", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401 })),
    )
    const service = new LocalAIService()

    await expect(service.listModels({ config })).rejects.toThrow(/rejected the API key/)
  })

  test("reports the key status without exposing the key", () => {
    mocks.encryptionAvailable = true
    const service = new LocalAIService()

    expect(service.hasApiKey()).toBe(false)
    expect(service.isSecureStorageAvailable()).toBe(true)

    expect(service.setApiKey("  secret-key  ")).toEqual({ ok: true, hasApiKey: true })
    // Every read stays a boolean; the key itself never leaves the main process.
    expect(service.hasApiKey()).toBe(true)

    service.clearApiKey()
    expect(service.hasApiKey()).toBe(false)
  })

  test("reports the missing keyring instead of storing a plaintext key", () => {
    const service = new LocalAIService()

    expect(service.setApiKey("secret-key")).toMatchObject({
      ok: false,
      reason: "encryption-unavailable",
    })
    expect(service.isSecureStorageAvailable()).toBe(false)
  })

  test("hands a rejected chat request back in one piece", async () => {
    const service = new LocalAIService()

    const result = await service.openChatStream({
      body: JSON.stringify({ messages: [] }),
      config,
    })

    expect(result).toEqual({
      streamId: null,
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "No message text found in the request" }),
    })
  })

  test("ignores an unknown chat stream id", () => {
    const service = new LocalAIService()

    expect(service.closeChatStream({ streamId: "nope" })).toBe(false)
  })
})
