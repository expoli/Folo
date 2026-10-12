import type { LanguageModel } from "ai"

/**
 * Test double of a language model.
 *
 * It records every call and answers with scripted text, so the prompt assembly, the chunking and the
 * summaries can be asserted without an endpoint. Only used by `*.test.ts` files.
 */

export interface RecordedModelCall {
  /** The `system` prompt of the call, `undefined` when the caller sent none. */
  system: string | undefined
  /** The `prompt` of the call, flattened to text. */
  prompt: string
}

export interface FakeLanguageModel {
  model: LanguageModel
  calls: RecordedModelCall[]
  /** Calls answered with an empty text, in order. */
  setEmptyAnswers: (indexes: number[]) => void
  /** Calls that reject, standing in for an upstream error on one part of a batch. */
  setFailingAnswers: (indexes: number[]) => void
}

interface GenerateOptions {
  prompt?: unknown
  system?: unknown
  messages?: unknown
}

const flatten = (value: unknown): string => {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(flatten).join("\n")

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    if (typeof record.text === "string") return record.text
    // `generateText` wraps a plain `prompt` into `{ role, content: [{ type: "text", text }] }`.
    if (record.content !== undefined) return flatten(record.content)
    return JSON.stringify(record)
  }

  return ""
}

export const createFakeModel = (
  reply: (call: RecordedModelCall) => string = () => "answer",
): FakeLanguageModel => {
  const calls: RecordedModelCall[] = []
  const emptyAnswers = new Set<number>()
  const failingAnswers = new Set<number>()

  const record = (options: GenerateOptions) => {
    const call: RecordedModelCall = {
      system: typeof options.system === "string" ? options.system : undefined,
      prompt: flatten(options.prompt ?? options.messages),
    }
    calls.push(call)
    return call
  }

  const answer = (call: RecordedModelCall, index: number) => {
    if (failingAnswers.has(index)) {
      throw new Error(`model call ${index} failed`)
    }

    return emptyAnswers.has(index) ? "" : reply(call)
  }

  const model = {
    specificationVersion: "v4",
    provider: "test",
    modelId: "test-model",
    supportedUrls: {},
    doGenerate: async (options: GenerateOptions & { prompt?: unknown }) => {
      const index = calls.length
      const call = record(options)

      return {
        content: [{ type: "text", text: answer(call, index) }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }
    },
    doStream: async (options: GenerateOptions) => {
      const index = calls.length
      const call = record(options)
      const text = answer(call, index)

      const parts: unknown[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "0" },
        ...(text ? [{ type: "text-delta", id: "0", delta: text }] : []),
        { type: "text-end", id: "0" },
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ]

      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part)
            controller.close()
          },
        }),
      }
    },
  }

  return {
    model: model as unknown as LanguageModel,
    calls,
    setEmptyAnswers: (indexes) => {
      for (const index of indexes) emptyAnswers.add(index)
    },
    setFailingAnswers: (indexes) => {
      for (const index of indexes) failingAnswers.add(index)
    },
  }
}
