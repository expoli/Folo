import type { ToolUIPart } from "ai"
import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"

import { ToolInvocationComponent } from "./ToolInvocationComponent"

const { addToolApprovalResponse } = vi.hoisted(() => ({
  addToolApprovalResponse: vi.fn(async () => {}),
}))

vi.mock("../../store/hooks", () => ({
  useChatActions: () => ({ addToolApprovalResponse }),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const partOf = (overrides: Record<string, unknown>) =>
  ({
    type: "tool-mcp__notes__create_note",
    toolCallId: "call-1",
    input: { title: "Kconfig 备份", body: "副本" },
    ...overrides,
  }) as unknown as ToolUIPart

describe("ToolInvocationComponent", () => {
  let root: Root | null = null
  let host: HTMLElement | null = null

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    host?.remove()
    root = null
    host = null
    addToolApprovalResponse.mockClear()
  })

  const render = async (part: ToolUIPart) => {
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () => {
      root!.render(<ToolInvocationComponent part={part} variant="loose" />)
    })

    return host
  }

  const click = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
  }

  test("asks for a decision instead of reporting a finished call", async () => {
    const host = await render(
      partOf({ state: "approval-requested", approval: { id: "approval-1" } }),
    )

    expect(host.textContent).toContain("chat.tool.approval.required")
    expect(host.textContent).toContain("chat.tool.approval.allow")
    expect(host.textContent).toContain("chat.tool.approval.deny")
    expect(host.textContent).not.toContain("chat.tool.called")
  })

  test("allows the call with the approval id it was given", async () => {
    const host = await render(
      partOf({ state: "approval-requested", approval: { id: "approval-1" } }),
    )

    const allow = host.querySelectorAll("button")[0]
    expect(allow?.textContent).toContain("chat.tool.approval.allow")
    await click(allow!)

    expect(addToolApprovalResponse).toHaveBeenCalledWith({ id: "approval-1", approved: true })
  })

  test("denies it the same way", async () => {
    const host = await render(
      partOf({ state: "approval-requested", approval: { id: "approval-7" } }),
    )

    const deny = host.querySelectorAll("button")[1]
    await click(deny!)

    expect(addToolApprovalResponse).toHaveBeenCalledWith({ id: "approval-7", approved: false })
  })

  test("reports the decision once it is in the conversation", async () => {
    const host = await render(
      partOf({
        state: "approval-responded",
        approval: { id: "approval-1", approved: false },
      }),
    )

    expect(host.textContent).toContain("chat.tool.approval.denied")
    expect(host.querySelectorAll("button")).toHaveLength(0)
  })
})
