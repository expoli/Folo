/**
 * Publishes the local agent reading data provider on the renderer bridge.
 *
 * The main process serves the loopback MCP endpoint and asks the renderer for account data through
 * these four methods (see `@follow/shared/local-agent-reading`). Registering them is all this side
 * does at startup: the work happens per request, and nothing is read until an agent asks.
 *
 * It mounts in the web build too. There it registers handlers nothing calls, which keeps the two
 * builds identical instead of hiding a renderer-only branch.
 */
import { useRegisterGlobalContext } from "@follow/shared/bridge"
import type { FC } from "react"
import { useMemo } from "react"

import { createLocalAgentReadingBridge } from "~/modules/local-agent-reading/bridge"
import { createLocalAgentReadingDeps } from "~/modules/local-agent-reading/deps"

export const LocalAgentReadingProvider: FC = () => {
  const bridge = useMemo(() => createLocalAgentReadingBridge(createLocalAgentReadingDeps()), [])

  useRegisterGlobalContext(
    "localAgentReadingDescribeAccount",
    bridge.localAgentReadingDescribeAccount,
  )
  useRegisterGlobalContext(
    "localAgentReadingEnumerateUnread",
    bridge.localAgentReadingEnumerateUnread,
  )
  useRegisterGlobalContext(
    "localAgentReadingResolveEntries",
    bridge.localAgentReadingResolveEntries,
  )
  useRegisterGlobalContext("localAgentReadingCancel", bridge.localAgentReadingCancel)

  return null
}
