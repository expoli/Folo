import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { LOCAL_AI_DIRECT_ORIGIN } from "@follow/shared/settings/local-ai"
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"

import { readNdjsonStream } from "../../lib/stream"
import {
  fetchLocalAIConfig,
  probeLocalAIGateway,
  requestLocalAISummary,
  requestLocalAITitle,
  requestLocalAITranslationBatch,
} from "./client"
import {
  configureLocalAI,
  DEFAULT_LOCAL_AI_CONTEXT_BUDGET,
  getLocalAIContextBudget,
  resetLocalAI,
} from "./config"

interface RecordedBody {
  content?: string
  entries?: { id: string; title?: string }[]
  fields?: string[]
  messages?: { role: string; content: string }[]
  language?: string
}

interface RecordedRequest {
  method: string
  url: string
  authorization?: string
  body?: RecordedBody
}

const requests: RecordedRequest[] = []
let server: ReturnType<typeof createServer>
let gatewayUrl = ""

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)

    const raw = Buffer.concat(chunks).toString("utf8")
    const body = raw ? JSON.parse(raw) : undefined
    requests.push({
      method: req.method || "",
      url: req.url || "",
      authorization: req.headers.authorization,
      body,
    })

    // Like the bundled gateway, `/health` ignores the token: only the authenticated endpoints
    // can tell a wrong token apart from a healthy probe.
    if (req.headers.authorization === "Bearer bad-token" && req.url !== "/health?probe=1") {
      res.writeHead(401, { "Content-Type": "text/plain" })
      res.end("Unauthorized")
      return
    }

    if (req.url === "/ai/summary") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ code: 0, data: `summary of ${body.content}` }))
      return
    }

    if (req.url === "/ai/summary-title") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ title: `title of ${body.messages?.[0]?.content ?? ""}` }))
      return
    }

    if (req.url === "/ai/translation/batch") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" })
      for (const entry of body.entries) {
        res.write(
          `${JSON.stringify({ id: entry.id, data: { title: `T:${entry.title ?? ""}` } })}\n`,
        )
      }
      res.end()
      return
    }

    if (req.url === "/ai/chat/config") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ defaultModel: "model-a", availableModels: ["model-a", "model-b"] }))
      return
    }

    if (req.url === "/broken/ai/summary") {
      res.writeHead(502, { "Content-Type": "text/plain" })
      res.end("upstream exploded")
      return
    }

    if (req.url === "/budget/ai/chat/config") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          defaultModel: "model-a",
          availableModels: ["model-a"],
          localAIContext: { maxEntries: 5, maxCharsPerEntry: 100, maxTotalChars: 250 },
        }),
      )
      return
    }

    if (req.url === "/ai/broken") {
      res.writeHead(502, { "Content-Type": "text/plain" })
      res.end("upstream exploded")
      return
    }

    // The bundled gateway answers `/health` before it checks `GATEWAY_TOKEN`, so only an
    // authenticated endpoint can tell a wrong token apart from a healthy probe.
    if (
      req.url === "/exempt/ai/chat/config" &&
      req.headers.authorization === "Bearer wrong-token"
    ) {
      res.writeHead(401, { "Content-Type": "text/plain" })
      res.end("Unauthorized")
      return
    }

    if (req.url === "/exempt/health?probe=1") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({ ok: true, defaultModel: "model-a", probe: { ok: true, latencyMs: 5 } }),
      )
      return
    }

    if (req.url === "/health?probe=1") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          ok: true,
          upstream: "http://127.0.0.1:11434/v1",
          defaultModel: "model-a",
          models: ["model-a"],
          probe: { ok: true, latencyMs: 12 },
        }),
      )
      return
    }

    // A gateway that predates `?probe=1`: reachable, but the model stays unchecked.
    if (req.url === "/unchecked/health?probe=1") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true, upstream: "http://upstream", defaultModel: "model-a" }))
      return
    }

    if (req.url === "/flaky/health?probe=1") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          ok: true,
          defaultModel: "model-a",
          probe: { ok: false, latencyMs: 900, error: "model refused the ping" },
        }),
      )
      return
    }

    if (req.url === "/broken/health?probe=1") {
      res.writeHead(502, { "Content-Type": "text/plain" })
      res.end("upstream exploded")
      return
    }

    if (req.url === "/not-a-gateway/health?probe=1") {
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end("<html>hello</html>")
      return
    }

    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  requests.length = 0
  resetLocalAI()
})

describe("local AI gateway client", () => {
  test("sends the entry text to the gateway and unwraps the summary response", async () => {
    configureLocalAI({ baseUrl: gatewayUrl, token: "token-1" })

    const summary = await requestLocalAISummary({
      entryId: "entry-1",
      language: "zh-CN",
      target: "content",
      title: "Title",
      content: "Body",
    })

    expect(summary).toEqual({ code: 0, data: "summary of Body" })
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/ai/summary",
      authorization: "Bearer token-1",
      body: { entryId: "entry-1", language: "zh-CN", target: "content" },
    })
  })

  test("asks the local model for a chat title in the interface language", async () => {
    configureLocalAI({ baseUrl: gatewayUrl, token: "token-1" })

    const title = await requestLocalAITitle({
      messages: [{ role: "user", content: "hello" }],
      language: "zh-CN",
    })

    expect(title).toBe("title of hello")
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/ai/summary-title",
      authorization: "Bearer token-1",
    })
    expect(requests[0]?.body?.language).toBe("zh-CN")
  })

  test("reports a failed title request with its action name", async () => {
    configureLocalAI({ baseUrl: gatewayUrl, token: "bad-token" })

    const error = await requestLocalAITitle({
      messages: [{ role: "user", content: "hello" }],
    }).catch((reason: Error) => reason)

    expect((error as Error).message).toContain("Local AI gateway title failed")
  })

  test("streams the translation batch as NDJSON", async () => {
    configureLocalAI({ baseUrl: gatewayUrl })

    const response = await requestLocalAITranslationBatch({
      entries: [
        { id: "entry-1", title: "One" },
        { id: "entry-2", title: "Two" },
      ],
      language: "en",
      fields: ["title"],
      mode: "bilingual",
    })

    const lines: { id: string; data: Record<string, string> }[] = []
    await readNdjsonStream<{ id: string; data: Record<string, string> }>(response, (line) => {
      lines.push(line)
    })

    expect(lines).toEqual([
      { id: "entry-1", data: { title: "T:One" } },
      { id: "entry-2", data: { title: "T:Two" } },
    ])
    expect(requests[0]?.body?.fields).toEqual(["title"])
  })

  test("fills the quota fields the UI expects when the gateway omits them", async () => {
    configureLocalAI({ baseUrl: gatewayUrl })

    const config = await fetchLocalAIConfig()

    expect(config.defaultModel).toBe("model-a")
    expect(config.availableModels).toEqual(["model-a", "model-b"])
    expect(config.availableModelsMenu).toEqual([
      { label: "model-a", value: "model-a" },
      { label: "model-b", value: "model-b" },
    ])
    expect(config.usage).toEqual({ total: 0, used: 0, remaining: 0, resetAt: new Date(0) })
    expect(config.rateLimit.maxTokens).toBe(0)
  })

  test("surfaces gateway failures with the status code", async () => {
    // A base URL that already contains `/ai` makes the client call `/ai/ai/summary` → 404.
    configureLocalAI({ baseUrl: `${gatewayUrl}/ai` })

    await expect(
      requestLocalAISummary({ entryId: "e", language: "en", target: "content", content: "x" }),
    ).rejects.toThrow(/404/)
  })

  test("fills the context budget announced by the gateway", async () => {
    configureLocalAI({ baseUrl: `${gatewayUrl}/budget` })

    await fetchLocalAIConfig()

    expect(getLocalAIContextBudget()).toEqual({
      maxEntries: 5,
      maxCharsPerEntry: 100,
      maxTotalChars: 250,
    })
  })

  test("keeps the conservative budget when the gateway does not announce one", async () => {
    configureLocalAI({ baseUrl: gatewayUrl })

    await fetchLocalAIConfig()

    expect(getLocalAIContextBudget()).toEqual(DEFAULT_LOCAL_AI_CONTEXT_BUDGET)
  })

  test("names the gateway URL and status when its token is rejected", async () => {
    configureLocalAI({ baseUrl: gatewayUrl, token: "bad-token" })

    const error = await requestLocalAISummary({
      entryId: "e",
      language: "en",
      target: "content",
      content: "x",
    }).catch((reason: Error) => reason)

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain(gatewayUrl)
    expect(message).toContain("401")
    expect(message).toContain("token rejected")
    expect(message.length).toBeLessThanOrEqual(300)
  })

  test("names the gateway URL and status when the upstream model fails", async () => {
    configureLocalAI({ baseUrl: `${gatewayUrl}/broken` })

    const error = await requestLocalAISummary({
      entryId: "e",
      language: "en",
      target: "content",
      content: "x",
    }).catch((reason: Error) => reason)

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain(`${gatewayUrl}/broken`)
    expect(message).toContain("502")
    expect(message).toContain("upstream model error")
    expect(message.length).toBeLessThanOrEqual(300)
  })

  test("reports an unreachable gateway with its base URL", async () => {
    configureLocalAI({ baseUrl: "http://127.0.0.1:9" })

    const error = await requestLocalAISummary({
      entryId: "e",
      language: "en",
      target: "content",
      content: "x",
    }).catch((reason: Error) => reason)

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain("unreachable")
    expect(message).toContain("http://127.0.0.1:9")
    expect(message.length).toBeLessThanOrEqual(300)
  })

  test("hands a failure to the app reporter instead of only logging it", async () => {
    const reported: string[] = []
    configureLocalAI({
      baseUrl: "http://127.0.0.1:9",
      onError: (message) => reported.push(message),
    })

    const error = (await requestLocalAISummary({
      entryId: "e",
      language: "en",
      target: "content",
      content: "x",
    }).catch((reason: Error) => reason)) as Error

    expect(reported).toEqual([error.message])
  })

  test("reports a rejected request as well", async () => {
    const reported: string[] = []
    configureLocalAI({
      baseUrl: gatewayUrl,
      token: "bad-token",
      onError: (message) => reported.push(message),
    })

    await requestLocalAISummary({
      entryId: "e",
      language: "en",
      target: "content",
      content: "x",
    }).catch(() => undefined)

    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain("failed")
  })

  test("keeps the reporter when the endpoint is configured again", async () => {
    const reported: string[] = []
    configureLocalAI({
      baseUrl: "http://127.0.0.1:9",
      onError: (message) => reported.push(message),
    })

    // The apps configure the runtime again whenever the settings change; the reporter belongs to
    // the app rather than to one endpoint.
    configureLocalAI({ baseUrl: "http://127.0.0.1:9" })

    await requestLocalAISummary({
      entryId: "e",
      language: "en",
      target: "content",
      content: "x",
    }).catch(() => undefined)

    expect(reported).toHaveLength(1)
  })
})

describe("probeLocalAIGateway", () => {
  test("reports the model and the latency of a healthy gateway", async () => {
    // The trailing slash is trimmed, so the probe URL keeps a single separator.
    const result = await probeLocalAIGateway({ baseUrl: `${gatewayUrl}/`, token: "token-1" })

    expect(result).toEqual({
      kind: "ok",
      latencyMs: 12,
      upstream: "http://127.0.0.1:11434/v1",
      defaultModel: "model-a",
    })
    expect(requests[0]).toMatchObject({
      method: "GET",
      url: "/ai/chat/config",
      authorization: "Bearer token-1",
    })
    expect(requests.find((request) => request.url === "/health?probe=1")).toMatchObject({
      method: "GET",
      authorization: "Bearer token-1",
    })
  })

  test("sends no authorization header without a token", async () => {
    await probeLocalAIGateway({ baseUrl: gatewayUrl })

    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((request) => request.authorization === undefined)).toBe(true)
  })

  test("reports a rejected token", async () => {
    await expect(probeLocalAIGateway({ baseUrl: gatewayUrl, token: "bad-token" })).resolves.toEqual(
      { kind: "token-rejected" },
    )
  })

  test("reports a rejected token even when /health ignores the token", async () => {
    // The bundled gateway exempts `/health` from `GATEWAY_TOKEN`, so a wrong token would look
    // healthy there; the authenticated preflight is what catches it.
    await expect(
      probeLocalAIGateway({ baseUrl: `${gatewayUrl}/exempt`, token: "wrong-token" }),
    ).resolves.toEqual({ kind: "token-rejected" })
  })

  test("reports an unreachable gateway with the fetch failure", async () => {
    const result = await probeLocalAIGateway({ baseUrl: "http://127.0.0.1:9" })

    expect(result.kind).toBe("unreachable")
    expect((result as { detail: string }).detail).toBeTruthy()
  })

  test("reports a refused address without calling fetch", async () => {
    await expect(probeLocalAIGateway({ baseUrl: "   " })).resolves.toEqual({
      kind: "unreachable",
      detail: "no gateway address",
    })
    expect(requests).toHaveLength(0)
  })

  test("reports a model that failed the gateway's own probe", async () => {
    await expect(probeLocalAIGateway({ baseUrl: `${gatewayUrl}/flaky` })).resolves.toEqual({
      kind: "upstream-error",
      detail: "model refused the ping",
    })
  })

  test("reports a gateway error status as an upstream error", async () => {
    await expect(probeLocalAIGateway({ baseUrl: `${gatewayUrl}/broken` })).resolves.toEqual({
      kind: "upstream-error",
      detail: "upstream exploded",
    })
  })

  test("stays ok without a latency for a gateway that does not probe", async () => {
    await expect(probeLocalAIGateway({ baseUrl: `${gatewayUrl}/unchecked` })).resolves.toEqual({
      kind: "ok",
      latencyMs: null,
      upstream: "http://upstream",
      defaultModel: "model-a",
    })
  })

  test("treats a non JSON body as an unreachable gateway", async () => {
    const result = await probeLocalAIGateway({ baseUrl: `${gatewayUrl}/not-a-gateway` })

    expect(result.kind).toBe("unreachable")
    expect((result as { detail: string }).detail).toContain("invalid /health response")
  })
})

describe("direct mode transport", () => {
  interface DirectCall {
    url: string
    method: string
    authorization?: string
    body: Record<string, unknown> | null
  }

  const directCalls: DirectCall[] = []
  const directFetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const headers = (init?.headers ?? {}) as Record<string, string>
    directCalls.push({
      url,
      method: init?.method ?? "GET",
      authorization: headers.Authorization,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    })

    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })

    const { pathname } = new URL(url)
    if (pathname === "/ai/summary") {
      return json({ code: 0, data: "direct summary" })
    }
    if (pathname === "/ai/translation/batch") {
      const body = directCalls.at(-1)?.body as { entries?: { id: string }[] } | null
      const lines = (body?.entries ?? []).map(
        (entry) => `${JSON.stringify({ id: entry.id, data: { title: `D:${entry.id}` } })}\n`,
      )
      return new Response(lines.join(""), {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      })
    }
    if (pathname === "/ai/chat/config") {
      return json({
        defaultModel: "local-model",
        availableModels: ["local-model", "local-model-small"],
        localAIContext: { maxEntries: 3, maxCharsPerEntry: 500, maxTotalChars: 1500 },
      })
    }
    if (pathname === "/health") {
      return json({
        ok: true,
        upstream: "https://api.example.com/v1",
        defaultModel: "local-model",
        probe: { ok: true, latencyMs: 7 },
      })
    }

    return new Response(JSON.stringify({ error: `unsupported ${pathname}` }), { status: 404 })
  }

  beforeEach(() => {
    directCalls.length = 0
    configureLocalAI({
      mode: "direct",
      baseUrl: LOCAL_AI_DIRECT_ORIGIN,
      token: null,
      fetch: directFetch,
    })
  })

  test("sends summary, translation and chat config through the injected fetch", async () => {
    const summary = await requestLocalAISummary({
      entryId: "entry-1",
      language: "zh-CN",
      target: "content",
      title: "Title",
      content: "Body",
    })

    expect(summary).toEqual({ code: 0, data: "direct summary" })
    expect(directCalls[0]).toMatchObject({
      url: `${LOCAL_AI_DIRECT_ORIGIN}/ai/summary`,
      method: "POST",
      body: { entryId: "entry-1", content: "Body" },
    })

    const response = await requestLocalAITranslationBatch({
      entries: [{ id: "entry-1", title: "One" }],
      language: "en",
      fields: ["title"],
      mode: "bilingual",
    })
    const lines: { id: string; data: Record<string, string> }[] = []
    await readNdjsonStream<{ id: string; data: Record<string, string> }>(response, (line) => {
      lines.push(line)
    })

    expect(lines).toEqual([{ id: "entry-1", data: { title: "D:entry-1" } }])
    expect(directCalls[1]).toMatchObject({
      url: `${LOCAL_AI_DIRECT_ORIGIN}/ai/translation/batch`,
      method: "POST",
    })

    const config = await fetchLocalAIConfig()

    expect(config.defaultModel).toBe("local-model")
    expect(config.availableModels).toEqual(["local-model", "local-model-small"])
    expect(directCalls[2]).toMatchObject({
      url: `${LOCAL_AI_DIRECT_ORIGIN}/ai/chat/config`,
      method: "GET",
    })
  })

  test("never builds an authorization header: the key stays in the main process", async () => {
    await requestLocalAISummary({ entryId: "e", language: "en", target: "content", content: "x" })

    expect(directCalls.every((call) => call.authorization === undefined)).toBe(true)
  })

  test("keeps the context budget the direct endpoint announces", async () => {
    await fetchLocalAIConfig()

    expect(getLocalAIContextBudget()).toEqual({
      maxEntries: 3,
      maxCharsPerEntry: 500,
      maxTotalChars: 1500,
    })
  })

  test("probes through the injected fetch", async () => {
    await expect(probeLocalAIGateway({ baseUrl: LOCAL_AI_DIRECT_ORIGIN })).resolves.toEqual({
      kind: "ok",
      latencyMs: 7,
      upstream: "https://api.example.com/v1",
      defaultModel: "local-model",
    })
    expect(directCalls.map((call) => call.url)).toEqual([
      `${LOCAL_AI_DIRECT_ORIGIN}/ai/chat/config`,
      `${LOCAL_AI_DIRECT_ORIGIN}/health?probe=1`,
    ])
  })

  test("probes a draft endpoint through an explicitly passed transport", async () => {
    resetLocalAI()

    await expect(
      probeLocalAIGateway({ baseUrl: LOCAL_AI_DIRECT_ORIGIN, fetch: directFetch }),
    ).resolves.toMatchObject({ kind: "ok", defaultModel: "local-model" })
    expect(directCalls).toHaveLength(2)
  })

  test("surfaces a rejected key as a token rejection", async () => {
    const rejectingFetch: typeof globalThis.fetch = async () =>
      new Response("Unauthorized", { status: 401 })

    await expect(
      probeLocalAIGateway({ baseUrl: LOCAL_AI_DIRECT_ORIGIN, fetch: rejectingFetch }),
    ).resolves.toEqual({ kind: "token-rejected" })
  })

  test("keeps the gateway path unchanged when the mode is gateway", async () => {
    configureLocalAI({ mode: "gateway", baseUrl: gatewayUrl })

    await requestLocalAISummary({
      entryId: "entry-1",
      language: "zh-CN",
      target: "content",
      content: "Body",
    })

    expect(requests[0]).toMatchObject({ method: "POST", url: "/ai/summary" })
    expect(directCalls).toHaveLength(0)
  })
})

describe("local AI runtime switching", () => {
  test("cancels a request whose runtime was replaced while it was running", async () => {
    configureLocalAI({ baseUrl: gatewayUrl, token: null, fingerprint: "gateway-a" })

    // A gateway that never answers: the user gives up on it by switching the endpoint.
    vi.stubGlobal(
      "fetch",
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          )
        }),
    )

    try {
      const pending = requestLocalAISummary({
        entryId: "entry-1",
        language: "en",
        target: "content",
        content: "x",
      })

      // The answer of the old gateway must not be stored next to the new gateway's answers.
      configureLocalAI({ baseUrl: gatewayUrl, token: null, fingerprint: "gateway-b" })

      await expect(pending).rejects.toThrow(/configuration changed/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
