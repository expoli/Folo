import { randomBytes } from "node:crypto"
import { createServer } from "node:http"

export interface BrowserLoginCallback {
  url: string
  close: () => void
}

export const createBrowserLoginCallback = async (options: {
  onToken: (token: string) => void | Promise<void>
  timeoutMs?: number
}): Promise<BrowserLoginCallback> => {
  const callbackPath = `/callback/${randomBytes(32).toString("hex")}`
  let callbackHost = ""
  let closed = false
  let handlingToken = false
  let timer: NodeJS.Timeout | undefined

  const server = createServer((request, response) => {
    response.shouldKeepAlive = false
    response.setHeader("connection", "close")
    response.setHeader("cache-control", "no-store")
    response.setHeader("content-type", "text/plain; charset=utf-8")

    const reply = (statusCode: number) => {
      response.statusCode = statusCode
      response.end("Folo")
    }

    if (request.method !== "GET") {
      reply(405)
      return
    }
    if (request.headers.host !== callbackHost) {
      reply(403)
      return
    }

    const requestTarget = request.url ?? ""
    const queryIndex = requestTarget.indexOf("?")
    const requestPath = queryIndex === -1 ? requestTarget : requestTarget.slice(0, queryIndex)
    if (requestPath !== callbackPath) {
      reply(404)
      return
    }

    const requestUrl = new URL(requestTarget, `http://${callbackHost}`)
    const token = requestUrl.searchParams.get("token")
    if (!token?.trim()) {
      reply(400)
      return
    }
    if (closed || handlingToken) {
      reply(409)
      return
    }
    handlingToken = true

    void (async () => {
      let statusCode = 200
      try {
        await options.onToken(token)
      } catch {
        statusCode = 500
      }
      if (closed) {
        return
      }
      response.once("finish", close)
      response.once("close", close)
      reply(statusCode)
    })()
  })

  const close = () => {
    if (closed) {
      return
    }
    closed = true
    clearTimeout(timer)
    server.close()
    server.closeAllConnections()
  }

  server.on("connection", (socket) => socket.unref())
  const { promise: listening, resolve, reject } = Promise.withResolvers<void>()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject)
    resolve()
  })
  await listening
  server.on("error", close)
  server.unref()

  const address = server.address()
  if (!address || typeof address === "string") {
    close()
    throw new Error("Browser login callback did not bind to a TCP port")
  }
  callbackHost = `127.0.0.1:${address.port}`
  timer = setTimeout(close, options.timeoutMs ?? 5 * 60 * 1000)
  timer.unref()

  return { url: `http://${callbackHost}${callbackPath}`, close }
}
