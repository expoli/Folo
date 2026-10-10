#!/usr/bin/env node
/**
 * End-to-end contract check for the local AI gateway.
 *
 * It talks to a running gateway (default http://127.0.0.1:8788) exactly like the patched
 * Folo client does — including parsing the chat stream with the AI SDK's `uiMessageChunkSchema`,
 * the same parser `HttpChatTransport.processResponseStream` uses.
 *
 * Usage:
 *   node test/mock-openai.mjs &                     # fake upstream
 *   AI_BASE_URL=http://127.0.0.1:8799/v1 AI_API_KEY=mock node server.mjs &
 *   GATEWAY_URL=http://127.0.0.1:8788 node test/check.mjs
 */
import { parseJsonEventStream, uiMessageChunkSchema } from "ai"

const gatewayUrl = (process.env.GATEWAY_URL || "http://127.0.0.1:8788").replace(/\/+$/, "")
const token = process.env.GATEWAY_TOKEN || ""

const headers = {
  "Content-Type": "application/json",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
}

const results = []
const check = async (name, fn) => {
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail })
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`)
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message })
    console.log(`  ✗ ${name} — ${error?.message}`)
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

console.log(`gateway: ${gatewayUrl}\n`)

await check("GET /health", async () => {
  const response = await fetch(`${gatewayUrl}/health`)
  assert(response.ok, `status ${response.status}`)
  const body = await response.json()
  assert(body.ok === true, "health payload is not ok")
  assert(body.probe === undefined, "plain /health must not probe the upstream")
  return `upstream ${body.upstream}, default ${body.defaultModel}`
})

await check("GET /health?probe=1 reports the model call", async () => {
  const response = await fetch(`${gatewayUrl}/health?probe=1`)
  assert(response.ok, `status ${response.status}`)
  const body = await response.json()
  assert(body.ok === true, "health payload is not ok")
  assert(body.probe?.ok === true, `probe failed: ${JSON.stringify(body.probe)}`)
  assert(typeof body.probe.latencyMs === "number", "missing latencyMs")
  return `model answered in ${body.probe.latencyMs}ms`
})

await check("GET /ai/chat/config announces the chat context budget", async () => {
  const response = await fetch(`${gatewayUrl}/ai/chat/config`, { headers })
  assert(response.ok, `status ${response.status}`)
  const body = await response.json()
  const budget = body.localAIContext
  assert(budget && typeof budget === "object", "missing localAIContext")
  for (const key of ["maxEntries", "maxCharsPerEntry", "maxTotalChars"]) {
    assert(
      typeof budget[key] === "number" && budget[key] > 0,
      `invalid localAIContext.${key}: ${budget[key]}`,
    )
  }
  return `${budget.maxEntries} entries x ${budget.maxCharsPerEntry} chars, ${budget.maxTotalChars} total`
})

await check("GET /ai/chat/config returns a model list", async () => {
  const response = await fetch(`${gatewayUrl}/ai/chat/config`, { headers })
  assert(response.ok, `status ${response.status}`)
  const body = await response.json()
  assert(typeof body.defaultModel === "string" && body.defaultModel, "missing defaultModel")
  assert(Array.isArray(body.availableModels) && body.availableModels.length > 0, "empty model list")
  assert(Array.isArray(body.availableModelsMenu), "missing availableModelsMenu")
  assert(body.usage && typeof body.usage.total === "number", "missing usage")
  return `${body.availableModels.length} model(s)`
})

await check("GET /ai/chat/:id/stream answers 204 (no resumable stream)", async () => {
  const response = await fetch(`${gatewayUrl}/ai/chat/some-chat-id/stream`, { headers })
  assert(response.status === 204, `expected 204, got ${response.status}`)
  return "204"
})

await check("POST /ai/chat streams parseable UI message chunks", async () => {
  const response = await fetch(`${gatewayUrl}/ai/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      id: "chat-check",
      trigger: "submit-message",
      model: "mock-model",
      scene: "general",
      localAIContext: {
        blocks: [{ type: "mainEntry", value: "entry-1" }],
        entries: [
          {
            id: "entry-1",
            title: "Mock article",
            url: "https://example.com/a",
            publishedAt: new Date().toISOString(),
            content: "The quick brown fox jumps over the lazy dog.",
          },
        ],
      },
      messages: [
        {
          id: "message-1",
          role: "user",
          parts: [
            { type: "data-block", data: [{ id: "b1", type: "mainEntry", value: "entry-1" }] },
            { type: "data-rich-text", data: { state: "{}", text: "What is this article about?" } },
          ],
        },
      ],
    }),
  })

  assert(response.ok, `status ${response.status}`)
  assert(
    response.headers.get("content-type")?.includes("text/event-stream"),
    `unexpected content type ${response.headers.get("content-type")}`,
  )

  const chunks = []
  const stream = parseJsonEventStream({ stream: response.body, schema: uiMessageChunkSchema })
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    assert(value.success, `chunk failed schema validation: ${JSON.stringify(value.error)}`)
    chunks.push(value.value)
  }

  const text = chunks
    .filter((chunk) => chunk.type === "text-delta")
    .map((chunk) => chunk.delta)
    .join("")
  assert(text.trim().length > 0, "stream contained no text")
  assert(
    chunks.some((chunk) => chunk.type === "finish"),
    "stream did not finish",
  )
  return `${chunks.length} chunks, text=${JSON.stringify(text.trim().slice(0, 40))}`
})

await check("POST /ai/summary returns { code, data }", async () => {
  const response = await fetch(`${gatewayUrl}/ai/summary`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      entryId: "entry-1",
      language: "zh-CN",
      target: "content",
      title: "Mock article",
      content: "The quick brown fox jumps over the lazy dog.",
    }),
  })
  assert(response.ok, `status ${response.status}`)
  const body = await response.json()
  assert(body.code === 0, `unexpected code ${body.code}`)
  assert(typeof body.data === "string" && body.data.length > 0, "empty summary")
  return JSON.stringify(body.data.slice(0, 40))
})

await check("POST /ai/summary-title writes a title", async () => {
  const response = await fetch(`${gatewayUrl}/ai/summary-title`, {
    method: "POST",
    headers,
    body: JSON.stringify({ messages: [{ role: "user", content: "What did I miss today?" }] }),
  })
  assert(response.ok, `status ${response.status}`)
  const body = await response.json()
  assert(typeof body.title === "string" && body.title.length > 0, "empty title")
  return JSON.stringify(body.title)
})

await check("POST /ai/translation/batch streams NDJSON", async () => {
  const response = await fetch(`${gatewayUrl}/ai/translation/batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      language: "zh-CN",
      fields: ["title", "description"],
      mode: "bilingual",
      entries: [
        { id: "entry-1", title: "Hello", description: "World" },
        { id: "entry-2", title: "Second", description: "" },
      ],
    }),
  })
  assert(response.ok, `status ${response.status}`)

  const text = await response.text()
  const lines = text.split("\n").filter((line) => line.trim())
  assert(lines.length > 0, "no NDJSON lines received")

  const parsed = lines.map((line) => JSON.parse(line))
  assert(parsed[0].id === "entry-1", `unexpected first id ${JSON.stringify(parsed[0])}`)
  assert(parsed[0].data.title, "missing translated title")
  return `${parsed.length} line(s), keys=${Object.keys(parsed[0].data).join(",")}`
})

await check("POST /ai/summary chunks a long article and reports its coverage", async () => {
  const paragraph = "Sentence about the article. ".repeat(40)
  const content = Array.from({ length: 12 }, (_, index) => `Part ${index}. ${paragraph}`).join(
    "\n\n",
  )
  assert(content.length > 12000, `fixture too short: ${content.length}`)

  const response = await fetch(`${gatewayUrl}/ai/summary`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      entryId: "entry-long",
      language: "en",
      target: "content",
      title: "Long article",
      content,
    }),
  })
  assert(response.ok, `status ${response.status}`)
  const body = await response.json()
  assert(typeof body.data === "string" && body.data.length > 0, "empty summary")
  assert(
    body.data.includes("Summarized the full article"),
    `missing coverage note: ${body.data.slice(0, 80)}`,
  )
  assert(body.data.includes("Merged summary"), "the merged summary is missing")
  return `${content.length} chars -> ${JSON.stringify(body.data.slice(0, 60))}`
})

await check("POST /ai/translation/batch chunks a long field", async () => {
  const content = Array.from(
    { length: 10 },
    (_, index) => `Paragraph ${index}. ${"word ".repeat(200)}`,
  ).join("\n\n")
  assert(content.length > 8000, `fixture too short: ${content.length}`)

  const response = await fetch(`${gatewayUrl}/ai/translation/batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      language: "zh-CN",
      fields: ["content"],
      mode: "translation-only",
      entries: [{ id: "entry-long", content }],
    }),
  })
  assert(response.ok, `status ${response.status}`)

  const lines = (await response.text()).split("\n").filter((line) => line.trim())
  assert(lines.length === 1, `expected one NDJSON line, got ${lines.length}`)
  const parsed = JSON.parse(lines[0])
  assert(parsed.id === "entry-long", `unexpected id ${parsed.id}`)
  const parts = String(parsed.data.content).split("\n\n")
  assert(parts.length >= 2, `expected a chunked translation, got ${parts.length} part(s)`)
  assert(
    parts.every((part) => part === "[mock chunk translation]"),
    `unexpected chunk payloads: ${JSON.stringify(parts.slice(0, 2))}`,
  )
  return `${content.length} chars -> ${parts.length} chunk(s)`
})

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length > 0 ? 1 : 0)
