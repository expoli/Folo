import {
  LOCAL_AGENT_READING_TOOL_INFO,
  LOCAL_AGENT_READING_TOOL_NAMES,
} from "@follow/shared/local-agent-reading"
import type { ToolSet } from "ai"
import { describe, expect, test, vi } from "vitest"

import type { LocalAgentReadingToolHandlers } from "~/local-agent-reading/server"

import { createFoloReadingTools } from "./folo"

/**
 * The tools are `ToolSet` so the chat loop can take them; calling one has to go through `execute`,
 * which `ToolSet` erases. This narrow view is the only cast the test needs.
 */
const run = async (tools: ToolSet, name: string, input: unknown): Promise<unknown> => {
  const entry = tools[name] as unknown as {
    execute?: (input: unknown, options: unknown) => Promise<unknown>
  }
  if (!entry?.execute) throw new Error(`${name} has no execute function`)
  return await entry.execute(input, { toolCallId: "call-1", messages: [] })
}

const handlers = (
  overrides: Partial<LocalAgentReadingToolHandlers> = {},
): LocalAgentReadingToolHandlers => ({
  status: async () => ({ signedIn: true }) as never,
  beginScan: async () => ({ ok: true, data: { scanId: "scan-1" } }) as never,
  listEntries: async () => ({ ok: true, data: { entries: [] } }) as never,
  getContents: async () => ({ ok: true, data: { items: [] } }) as never,
  ...overrides,
})

describe("createFoloReadingTools", () => {
  test("serves exactly the tools the endpoint serves, under the same names", () => {
    const tools = createFoloReadingTools(handlers())

    expect(Object.keys(tools).sort()).toEqual([...LOCAL_AGENT_READING_TOOL_NAMES].sort())
  })

  test("describes each tool with the shared wording", () => {
    const tools = createFoloReadingTools(handlers())

    for (const name of LOCAL_AGENT_READING_TOOL_NAMES) {
      expect(tools[name]?.description).toBe(LOCAL_AGENT_READING_TOOL_INFO[name].description)
    }
  })

  test("passes the scan scope through to the service", async () => {
    const beginScan = vi.fn(async () => ({ ok: true as const, data: { scanId: "scan-1" } }))
    const tools = createFoloReadingTools(handlers({ beginScan: beginScan as never }))

    await run(tools, "folo_begin_unread_scan", { scope: { feedIds: ["feed-1"] } })

    expect(beginScan).toHaveBeenCalledWith({ scope: { feedIds: ["feed-1"] } })
  })

  test("hands a refusal to the model instead of throwing", async () => {
    const tools = createFoloReadingTools(
      handlers({
        beginScan: async () =>
          ({
            ok: false,
            error: { code: "NOT_SIGNED_IN", message: "Folo is not signed in" },
          }) as never,
      }),
    )

    await expect(run(tools, "folo_begin_unread_scan", {})).resolves.toEqual({
      error: { code: "NOT_SIGNED_IN", message: "Folo is not signed in" },
    })
  })

  test("returns the payload of a successful call without the envelope", async () => {
    const tools = createFoloReadingTools(
      handlers({
        getContents: async () =>
          ({ ok: true, data: { items: [{ entryId: "entry-1", content: "text" }] } }) as never,
      }),
    )

    await expect(
      run(tools, "folo_get_entry_contents", { scanId: "scan-1", entryIds: ["entry-1"] }),
    ).resolves.toEqual({ items: [{ entryId: "entry-1", content: "text" }] })
  })

  test("lets a failed status surface as a failed tool call", async () => {
    const tools = createFoloReadingTools(
      handlers({
        status: async () => {
          throw new Error("renderer is gone")
        },
      }),
    )

    await expect(run(tools, "folo_get_status", {})).rejects.toThrow("renderer is gone")
  })
})
