import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { renderMarkdown } from "./markdown"

vi.mock("react-native", () => ({
  Linking: { openURL: vi.fn() },
  TextInput: ({ children, className }: { children?: React.ReactNode; className?: string }) =>
    React.createElement("mock-input", { className }, children),
  View: ({ children, className }: { children?: React.ReactNode; className?: string }) =>
    React.createElement("mock-view", { className }, children),
}))
vi.mock("@/src/components/ui/typography/Text", () => ({
  Text: ({ children, className }: { children?: React.ReactNode; className?: string }) =>
    React.createElement("mock-text", { className }, children),
}))

const summary = [
  "- Linux 7.4 内核将上游支持三款搭载高通骁龙 X2 Elite 处理器的笔记本，分别来自华硕、惠普和联想。",
  "- 华硕 **Zenbook A14**：HDMI 输出尚不支持，相关补丁正在开发中。",
  "- 联想 Yoga Slim 7x Gen11：缺少摄像头支持，且尚无嵌入式控制器（EC）驱动。",
]

// Expand the actual Markdown components, without requiring a native runtime.
const render = (source: string) => renderToStaticMarkup(renderMarkdown(source))

describe("Markdown summary lists", () => {
  it.each(["\n", "\n\n"])("renders list paragraphs as text with separator %j", (separator) => {
    const output = render(summary.join(separator))
    expect(output).not.toContain("<mock-input")
    expect(output).toContain("Linux 7.4")
    expect(output).toContain("Zenbook A14")
    expect(output).toContain("嵌入式控制器（EC）驱动。")
    expect(output.match(/•/g)).toHaveLength(3)
    expect(output).toContain("font-semibold")
  })

  it("does not nest block containers inside text for a nested list", () => {
    const output = render("- 第一条\n\n  - 嵌套条目\n\n- 第二条")
    expect(output).not.toContain("<mock-input")
    expect(output).not.toMatch(/<mock-text[^>]*>[^<]*<mock-view/)
    expect(output).toContain("嵌套条目")
  })

  it("preserves selectable input rendering for standalone paragraphs", () => {
    expect(render("普通段落")).toContain("<mock-input")
  })
})
