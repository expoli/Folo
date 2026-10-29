import { BlockSliceAction } from "../store/slices/block.slice"
import type { AIChatContextBlock } from "../store/types"

const UNREAD_ONLY_ID = BlockSliceAction.SPECIAL_TYPES.unreadOnly

/** Whether the panel is currently scoped to unread entries. */
export const isUnreadOnlyScope = (blocks: AIChatContextBlock[]) =>
  blocks.some((block) => block.type === "unreadOnly")

/**
 * Scopes the panel to unread entries, or stops doing so.
 *
 * The panel owns this switch. The list's own filter seeds it when the panel opens, and a later
 * change there does not rewrite the scope of a conversation already in progress — the two used to be
 * the same switch, which made "what the AI reads" depend on a control in the timeline.
 */
export const setUnreadOnlyScope = (
  actions: Pick<BlockSliceAction, "addOrUpdateBlock" | "removeBlock">,
  on: boolean,
) => {
  if (on) {
    actions.addOrUpdateBlock({ id: UNREAD_ONLY_ID, type: "unreadOnly", value: "true" })
    return
  }

  actions.removeBlock(UNREAD_ONLY_ID)
}
