import type { LocalAIChatStreamEvent } from "@follow/shared/settings/local-ai"
import { afterEach, describe, expect, test, vi } from "vitest"

import { cancelChatStream, openChatStream } from "./streams"

const encoder = new TextEncoder()

/** Answers with the given byte chunks, so decoder behaviour across chunk borders is observable. */
const chunkedResponse = (chunks: Uint8Array[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  )

const collect = () => {
  const events: LocalAIChatStreamEvent[] = []
  return { events, send: (event: LocalAIChatStreamEvent) => events.push(event) }
}

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.restoreAllMocks()
})

describe("openChatStream", () => {
  test("pushes the SSE chunks and finishes with a done event", async () => {
    const { events, send } = collect()
    const streamId = openChatStream({
      response: chunkedResponse([encoder.encode("data: one\n\n"), encoder.encode("data: two\n\n")]),
      abortController: new AbortController(),
      send,
    })

    expect(streamId).toBeTruthy()
    await settled()

    expect(events).toEqual([
      { streamId, chunk: "data: one\n\n" },
      { streamId, chunk: "data: two\n\n" },
      { streamId, done: true },
    ])
  })

  test("keeps a multi-byte character that is split across two chunks intact", async () => {
    const { events, send } = collect()
    const bytes = encoder.encode("摘要")
    const streamId = openChatStream({
      // The first chunk ends in the middle of the three-byte character.
      response: chunkedResponse([bytes.slice(0, 2), bytes.slice(2)]),
      abortController: new AbortController(),
      send,
    })

    await settled()

    expect(events).toEqual([
      { streamId, chunk: "摘要" },
      { streamId, done: true },
    ])
  })

  test("reports an upstream failure as an error event", async () => {
    const { events, send } = collect()
    let delivered = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!delivered) {
            delivered = true
            controller.enqueue(encoder.encode("data: one\n\n"))
            return
          }

          controller.error(new Error("socket closed"))
        },
      }),
    )

    openChatStream({ response, abortController: new AbortController(), send })
    await settled()

    expect(events[0]).toMatchObject({ chunk: "data: one\n\n" })
    expect(events[1]).toMatchObject({ error: "socket closed" })
    expect(events).toHaveLength(2)
  })

  test("answers null for a response without a body", () => {
    const { send } = collect()

    expect(
      openChatStream({
        response: new Response(null, { status: 204 }),
        abortController: new AbortController(),
        send,
      }),
    ).toBeNull()
  })
})

describe("cancelChatStream", () => {
  test("aborts the upstream call of an open stream, and only once", async () => {
    const { send } = collect()
    const abortController = new AbortController()
    const streamId = openChatStream({
      // A stream that stays open, like a chat the user is watching.
      response: new Response(new ReadableStream<Uint8Array>({ start: () => {} })),
      abortController,
      send,
    })!

    expect(cancelChatStream(streamId)).toBe(true)
    expect(abortController.signal.aborted).toBe(true)
    expect(cancelChatStream(streamId)).toBe(false)
  })

  test("ignores an unknown stream id", () => {
    expect(cancelChatStream("nope")).toBe(false)
  })

  test("forgets a stream once it has finished", async () => {
    const { send } = collect()
    const streamId = openChatStream({
      response: chunkedResponse([encoder.encode("data: one\n\n")]),
      abortController: new AbortController(),
      send,
    })!

    await settled()

    expect(cancelChatStream(streamId)).toBe(false)
  })
})

describe("openChatStream onFinish", () => {
  test("reports the end of the stream to its caller", async () => {
    const { send } = collect()
    const onFinish = vi.fn()

    openChatStream({
      response: chunkedResponse([encoder.encode("data: one\n\n")]),
      abortController: new AbortController(),
      send,
      onFinish,
    })

    await settled()

    expect(onFinish).toHaveBeenCalledTimes(1)
  })

  test("reports a cancelled stream to its caller", async () => {
    const { send } = collect()
    const onFinish = vi.fn()
    const abortController = new AbortController()
    // Like a real response, the body ends when the request is aborted.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        abortController.signal.addEventListener("abort", () =>
          controller.error(new DOMException("aborted", "AbortError")),
        )
      },
    })

    const streamId = openChatStream({
      response: new Response(body),
      abortController,
      send,
      onFinish,
    })!

    cancelChatStream(streamId)
    await settled()
    await settled()

    expect(onFinish).toHaveBeenCalledTimes(1)
  })
})

describe("stream decoder", () => {
  test("flushes the last bytes when the stream ends inside a character", async () => {
    const { events, send } = collect()
    const bytes = encoder.encode("ok 摘")
    const streamId = openChatStream({
      // The stream is cut inside the last (three byte) character: without the final flush those
      // bytes would be dropped without a trace.
      response: chunkedResponse([bytes.slice(0, bytes.length - 1)]),
      abortController: new AbortController(),
      send,
    })!

    await settled()

    const text = events.flatMap((event) => ("chunk" in event ? [event.chunk] : [])).join("")
    expect(text).toBe("ok \uFFFD")
    expect(events.at(-1)).toEqual({ streamId, done: true })
  })
})
