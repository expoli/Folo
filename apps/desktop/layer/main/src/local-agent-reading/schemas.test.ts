import {
  LOCAL_AGENT_READING_LIMITS,
  LOCAL_AGENT_READING_TOOL_NAMES,
  localAgentReadingBeginScanArgsSchema,
  localAgentReadingContentsArgsSchema,
  localAgentReadingListArgsSchema,
  localAgentReadingScopeSchema,
} from "@follow/shared/local-agent-reading"
import { describe, expect, test } from "vitest"

describe("scan scope", () => {
  test("accepts an empty scope, which means every supported source", () => {
    expect(localAgentReadingScopeSchema.parse({})).toEqual({})
  })

  test("accepts views, feeds, inboxes and a time range", () => {
    const scope = {
      views: [0, 1],
      feedIds: ["feed-1"],
      inboxIds: ["inbox-1"],
      publishedAfter: "2026-10-01T00:00:00.000Z",
      publishedBefore: "2026-10-02T00:00:00.000Z",
    }

    expect(localAgentReadingScopeSchema.parse(scope)).toEqual(scope)
  })

  test("refuses a view outside the FeedViewType range", () => {
    expect(localAgentReadingScopeSchema.safeParse({ views: [7] }).success).toBe(false)
    expect(localAgentReadingScopeSchema.safeParse({ views: [-2] }).success).toBe(false)
    expect(localAgentReadingScopeSchema.safeParse({ views: [0.5] }).success).toBe(false)
  })

  test("refuses unknown fields and unparsable dates", () => {
    expect(localAgentReadingScopeSchema.safeParse({ readState: "unread" }).success).toBe(false)
    expect(localAgentReadingScopeSchema.safeParse({ publishedAfter: "yesterday" }).success).toBe(
      false,
    )
  })

  test("bounds the number of feeds and inboxes one scan may name", () => {
    const tooManyFeeds = { feedIds: Array.from({ length: 51 }, (_, index) => `feed-${index}`) }
    expect(localAgentReadingScopeSchema.safeParse(tooManyFeeds).success).toBe(false)
  })
})

describe("tool arguments", () => {
  test("the list tool bounds the page size", () => {
    expect(localAgentReadingListArgsSchema.safeParse({ scanId: "scan" }).success).toBe(true)
    expect(
      localAgentReadingListArgsSchema.safeParse({
        scanId: "scan",
        limit: LOCAL_AGENT_READING_LIMITS.maxListLimit,
      }).success,
    ).toBe(true)
    expect(
      localAgentReadingListArgsSchema.safeParse({
        scanId: "scan",
        limit: LOCAL_AGENT_READING_LIMITS.maxListLimit + 1,
      }).success,
    ).toBe(false)
    expect(localAgentReadingListArgsSchema.safeParse({ scanId: "" }).success).toBe(false)
  })

  test("the contents tool bounds the batch and the modes", () => {
    const tooMany = Array.from(
      { length: LOCAL_AGENT_READING_LIMITS.maxContentBatch + 1 },
      (_, index) => `entry-${index}`,
    )

    expect(localAgentReadingContentsArgsSchema.safeParse({ scanId: "scan" }).success).toBe(true)
    expect(
      localAgentReadingContentsArgsSchema.safeParse({ scanId: "scan", entryIds: tooMany }).success,
    ).toBe(false)
    expect(
      localAgentReadingContentsArgsSchema.safeParse({ scanId: "scan", mode: "mark_read" }).success,
    ).toBe(false)
    for (const mode of ["cached", "detail", "source_page"] as const) {
      expect(localAgentReadingContentsArgsSchema.safeParse({ scanId: "scan", mode }).success).toBe(
        true,
      )
    }
  })

  test("a scan takes no arguments that could change read state", () => {
    const shape = Object.keys(localAgentReadingBeginScanArgsSchema.shape)
    expect(shape).toEqual(["scope"])
  })

  test("the tool names are reads only", () => {
    expect([...LOCAL_AGENT_READING_TOOL_NAMES]).toEqual([
      "folo_get_status",
      "folo_begin_unread_scan",
      "folo_list_scan_entries",
      "folo_get_entry_contents",
    ])
  })
})
