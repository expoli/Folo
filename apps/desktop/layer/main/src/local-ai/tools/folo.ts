/**
 * The app's own chat tools: the four read-only operations of the local agent reading service.
 *
 * Wording and input schemas come from `@follow/shared/local-agent-reading` — the same objects the
 * loopback MCP endpoint registers — so a model that reads Folo through the chat panel and one that
 * reads it through the endpoint get the same description and the same validation.
 */
import {
  LOCAL_AGENT_READING_TOOL_INFO,
  localAgentReadingBeginScanArgsSchema,
  localAgentReadingContentsArgsSchema,
  localAgentReadingListArgsSchema,
} from "@follow/shared/local-agent-reading"
import type { ToolSet } from "ai"
import { jsonSchema, tool } from "ai"

import type { LocalAgentReadingToolHandlers, ToolAnswer } from "~/local-agent-reading/server"

/**
 * What a tool hands back to the model: the payload on success, the refusal otherwise.
 *
 * A refusal is an answer, not an exception: the model can act on `NOT_SIGNED_IN` or `SCAN_EXPIRED`
 * only if it reads them, so the loop keeps running. Real failures (the provider went away) still
 * throw and surface as a failed tool call.
 */
const answer = <T>(result: ToolAnswer<T>) => (result.ok ? result.data : { error: result.error })

export const createFoloReadingTools = (handlers: LocalAgentReadingToolHandlers): ToolSet => ({
  folo_get_status: tool({
    description: LOCAL_AGENT_READING_TOOL_INFO.folo_get_status.description,
    // No arguments: the contract has none, and an empty object keeps providers that insist on a
    // schema satisfied.
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute: () => handlers.status(),
  }),

  folo_begin_unread_scan: tool({
    description: LOCAL_AGENT_READING_TOOL_INFO.folo_begin_unread_scan.description,
    inputSchema: localAgentReadingBeginScanArgsSchema,
    execute: async (args) => answer(await handlers.beginScan(args)),
  }),

  folo_list_scan_entries: tool({
    description: LOCAL_AGENT_READING_TOOL_INFO.folo_list_scan_entries.description,
    inputSchema: localAgentReadingListArgsSchema,
    execute: async (args) => answer(await handlers.listEntries(args)),
  }),

  folo_get_entry_contents: tool({
    description: LOCAL_AGENT_READING_TOOL_INFO.folo_get_entry_contents.description,
    inputSchema: localAgentReadingContentsArgsSchema,
    execute: async (args) => answer(await handlers.getContents(args)),
  }),
})
