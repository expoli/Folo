// Lightweight OpenAI-compatible upstream used by `npm run check`.
//
// It answers `POST /v1/chat/completions` (streaming and non-streaming) with deterministic
// content, so the gateway can be verified without spending tokens on a real model.
import { createServer } from "node:http"

const PORT = Number(process.env.MOCK_PORT || 8799)

const completionFor = (prompt) => {
  if (prompt.includes("Merge these")) return "Merged summary of every part."

  if (prompt.includes("Translate the text below")) return "[mock chunk translation]"

  if (prompt.includes("Translate each section")) {
    // Echo the requested keys back so the gateway's JSON parsing (including the fenced-code
    // path) is exercised.
    const keys = prompt.match(/exactly these keys: ([^\n.]+)/)?.[1] || "title"
    const payload = Object.fromEntries(
      keys.split(",").map((key) => [key.trim(), `[mock ${key.trim()}]`]),
    )
    return `Here you go:\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``
  }

  if (prompt.includes("Write the summary")) return "Mock summary in one sentence."

  return "Mock answer from the upstream model."
}

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch {
        resolve({})
      }
    })
  })

const chunk = (delta, finishReason, model) => ({
  id: "chatcmpl-mock",
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [{ index: 0, delta, finish_reason: finishReason }],
})

/** The last upstream request, so the check can read the prompt the gateway built. */
let lastRequest = null

const server = createServer(async (req, res) => {
  if (req.url === "/__last-request") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(lastRequest))
    return
  }
  if (!req.url?.startsWith("/v1/chat/completions")) {
    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: { message: `Unsupported ${req.method} ${req.url}` } }))
    return
  }

  const body = await readBody(req)
  lastRequest = body
  const model = body.model || "mock-model"
  const prompt = JSON.stringify(body.messages || [])
  const answer = completionFor(prompt)

  if (!body.stream) {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(
      JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          { index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    )
    return
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  })
  res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "" }, null, model))}\n\n`)

  for (const word of answer.split(" ")) {
    res.write(`data: ${JSON.stringify(chunk({ content: `${word} ` }, null, model))}\n\n`)
  }

  res.write(`data: ${JSON.stringify(chunk({}, "stop", model))}\n\n`)
  res.write("data: [DONE]\n\n")
  res.end()
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-upstream] http://127.0.0.1:${PORT}/v1`)
})
