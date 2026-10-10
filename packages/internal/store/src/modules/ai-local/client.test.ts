import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"

import { readNdjsonStream } from "../../lib/stream"
import { fetchLocalAIConfig, requestLocalAISummary, requestLocalAITranslationBatch } from "./client"
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

    if (req.headers.authorization === "Bearer bad-token") {
      res.writeHead(401, { "Content-Type": "text/plain" })
      res.end("Unauthorized")
      return
    }

    if (req.url === "/ai/summary") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ code: 0, data: `summary of ${body.content}` }))
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
    expect(message).toContain("gateway token rejected")
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
})
