import type { RequestOptions } from "node:http"
import { Agent, request } from "node:http"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { BrowserLoginCallback } from "./browser-login-callback"
import { createBrowserLoginCallback } from "./browser-login-callback"

const callbacks = new Set<BrowserLoginCallback>()

const startCallback = async (
  onToken: (token: string) => void | Promise<void>,
  timeoutMs?: number,
) => {
  const callback = await createBrowserLoginCallback({ onToken, timeoutMs })
  callbacks.add(callback)
  return callback
}

const withToken = (url: string, token: string) => {
  const target = new URL(url)
  target.searchParams.set("token", token)
  return target
}

const sendRequest = (url: string | URL, options: RequestOptions = {}) => {
  const { promise, resolve, reject } = Promise.withResolvers<{
    statusCode: number | undefined
    connection: string | undefined
    body: string
  }>()
  const req = request(url, { agent: false, ...options }, (response) => {
    let body = ""
    response.setEncoding("utf8")
    response.on("data", (chunk) => {
      body += chunk
    })
    response.once("error", reject)
    response.once("end", () => {
      resolve({ statusCode: response.statusCode, connection: response.headers.connection, body })
    })
  })
  req.once("error", reject)
  req.end()
  return promise
}

afterEach(() => {
  for (const callback of callbacks) {
    callback.close()
  }
  callbacks.clear()
  vi.useRealTimers()
})

const invalidRequests: Array<[string, (url: URL) => RequestOptions, number]> = [
  ["wrong path", () => ({ path: "/callback?token=ignored" }), 404],
  ["normalized path", (url) => ({ path: `/unused/..${url.pathname}?token=ignored` }), 404],
  ["trailing slash", (url) => ({ path: `${url.pathname}/?token=ignored` }), 404],
  ["wrong Host", (url) => ({ headers: { host: `localhost:${url.port}` } }), 403],
  ["wrong port", () => ({ headers: { host: "127.0.0.1:0" } }), 403],
  ["wrong method", () => ({ method: "POST" }), 405],
  ["missing token", (url) => ({ path: url.pathname }), 400],
  ["empty token", (url) => ({ path: `${url.pathname}?token=` }), 400],
  ["blank token", (url) => ({ path: `${url.pathname}?token=%20%09` }), 400],
]

describe("createBrowserLoginCallback", () => {
  it("delivers the decoded token once and closes even a kept-alive connection", async () => {
    const onToken = vi.fn()
    const callback = await startCallback(onToken)
    const target = withToken(callback.url, "opaque+token/with=characters")
    const agent = new Agent({ keepAlive: true })

    try {
      expect(target.hostname).toBe("127.0.0.1")
      const response = await sendRequest(target, { agent, headers: { connection: "keep-alive" } })
      expect(response.statusCode).toBe(200)
      expect(response.connection).toBe("close")
      expect(onToken).toHaveBeenCalledExactlyOnceWith("opaque+token/with=characters")
      await expect(sendRequest(target)).rejects.toThrow()
      expect(onToken).toHaveBeenCalledTimes(1)
    } finally {
      agent.destroy()
    }
  })

  it.each(invalidRequests)(
    "does not consume the callback for %s",
    async (_name, options, status) => {
      const onToken = vi.fn()
      const callback = await startCallback(onToken)
      const target = withToken(callback.url, "valid-token")

      expect((await sendRequest(target, options(target))).statusCode).toBe(status)
      expect(onToken).not.toHaveBeenCalled()
      expect((await sendRequest(target)).statusCode).toBe(200)
      expect(onToken).toHaveBeenCalledExactlyOnceWith("valid-token")
    },
  )

  it("rejects a callback path issued for another login attempt", async () => {
    const first = await startCallback(vi.fn())
    const onToken = vi.fn()
    const second = await startCallback(onToken)
    const mismatched = withToken(second.url, "wrong-attempt")
    mismatched.pathname = new URL(first.url).pathname

    expect((await sendRequest(mismatched)).statusCode).toBe(404)
    expect(onToken).not.toHaveBeenCalled()
    expect((await sendRequest(withToken(second.url, "second-attempt"))).statusCode).toBe(200)
    expect(onToken).toHaveBeenCalledExactlyOnceWith("second-attempt")
  })

  it("rejects concurrent duplicates while waiting for token delivery", async () => {
    const entered = Promise.withResolvers<void>()
    const delivery = Promise.withResolvers<void>()
    const onToken = vi.fn(async () => {
      entered.resolve()
      await delivery.promise
    })
    const callback = await startCallback(onToken)
    let completed = false
    const firstResponse = sendRequest(withToken(callback.url, "first-token")).then((response) => {
      completed = true
      return response
    })

    try {
      await entered.promise
      expect((await sendRequest(withToken(callback.url, "second-token"))).statusCode).toBe(409)
      expect(onToken).toHaveBeenCalledExactlyOnceWith("first-token")
      expect(completed).toBe(false)
      delivery.resolve()
      expect((await firstResponse).statusCode).toBe(200)
      expect(onToken).toHaveBeenCalledTimes(1)
    } finally {
      delivery.resolve()
      await firstResponse.catch(() => {})
    }
  })

  it.each(["throw", "reject"])(
    "returns a generic error when token delivery %ss",
    async (failure) => {
      const token = "private-callback-token"
      const errorMessage = `Private authentication failure: ${token}`
      const onToken = vi.fn(() => {
        if (failure === "throw") {
          throw new Error(errorMessage)
        }
        return Promise.reject(new Error(errorMessage))
      })
      const callback = await startCallback(onToken)
      const target = withToken(callback.url, token)
      const response = await sendRequest(target)

      expect(response.statusCode).toBe(500)
      expect(response.body).not.toContain(token)
      expect(response.body).not.toContain(errorMessage)
      expect(onToken).toHaveBeenCalledExactlyOnceWith(token)
      await expect(sendRequest(target)).rejects.toThrow()
      expect(onToken).toHaveBeenCalledTimes(1)
    },
  )

  it.each(["close", "timeout"])("%s cancels an unused callback", async (cancel) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const onToken = vi.fn()
    const callback = await startCallback(onToken, 100)

    if (cancel === "close") {
      callback.close()
      callback.close()
    } else {
      await vi.advanceTimersByTimeAsync(100)
    }

    await expect(sendRequest(withToken(callback.url, "cancelled-token"))).rejects.toThrow()
    expect(onToken).not.toHaveBeenCalled()
  })

  it.each(["close", "timeout"])("%s cancels an in-flight callback", async (cancel) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const entered = Promise.withResolvers<void>()
    const delivery = Promise.withResolvers<void>()
    const onToken = vi.fn(async () => {
      entered.resolve()
      await delivery.promise
    })
    const callback = await startCallback(onToken, 100)
    const target = withToken(callback.url, "cancelled-token")
    const cancelled = expect(sendRequest(target)).rejects.toThrow()

    try {
      await entered.promise
      if (cancel === "close") {
        callback.close()
        callback.close()
      } else {
        await vi.advanceTimersByTimeAsync(100)
      }
      delivery.resolve()

      await cancelled
      await expect(sendRequest(target)).rejects.toThrow()
      expect(onToken).toHaveBeenCalledExactlyOnceWith("cancelled-token")
    } finally {
      delivery.resolve()
    }
  })
})
