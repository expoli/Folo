---
slug: local-ai-tools
change: 2026-10-29-tool-loop
title: 技术设计 — 面板 AI 工具循环
status: draft
created: 2026-10-29
decisions:
  engine: AI SDK tool loop（主进程内，零新增依赖）
  scope: Folo 只读 + MCP 工具
  writes: MCP 非只读工具逐次人工审批；Folo 不可写
---

# 技术设计

## 1. 数据流

```
renderer                         main (local-ai)                   外部
────────                         ───────────────                   ────
HttpChatTransport  ──IPC fetch──▶ routeLocalAIRequest
  (现有，不改)                     └─ createChatStreamResponse
                                     ├─ 组装 ToolSet：folo + mcp
                                     ├─ streamText({ tools, stopWhen })
                                     │    ├─ folo_* ─▶ LocalAgentReadingService ─▶ renderer 桥
                                     │    └─ mcp__*  ─▶ MCP Client ────────────▶ 用户已配置服务
                                     └─ toUIMessageStream() ──▶ tool-* parts
renderer: AIMessageParts → ToolInvocationComponent（现有，通用卡片）
```

关键点：循环完全在主进程，渲染器只负责显示。现有 `ExtendChatTransport`、`AIPersistService`、
`AIMessageParts` 的 tool 分支都不需要改结构。

## 2. 主进程模块

| 文件                                          | 职责                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| `local-ai/tools/folo.ts`                      | 把 `LocalAgentReadingService` 的四个方法包成 AI SDK 工具                   |
| `local-ai/tools/mcp.ts`                       | 按 `mcpServices` 建 MCP 客户端、`tools/list` → AI SDK 工具、结果压平与截断 |
| `local-ai/tools/index.ts`                     | 汇总、命名去重、read-only 过滤、错误包装、步数/长度预算                    |
| `local-ai/chat.ts`                            | 注入 `tools`、`stopWhen`、`abortSignal`；无工具回退路径                    |
| `packages/internal/ai-runtime/src/prompts.ts` | 工具版系统提示（替换「我看不到你的数据」那段）                             |

`apps/desktop/layer/main/package.json` 需显式声明 `ai`（当前靠 workspace hoist 解析）。

## 3. 工具契约（复用既有 zod schema，不新写）

| 工具名                    | 入参 schema（已有）                    | 数据来源                            |
| ------------------------- | -------------------------------------- | ----------------------------------- |
| `folo_get_status`         | 无                                     | `LocalAgentReadingService.status()` |
| `folo_begin_unread_scan`  | `localAgentReadingBeginScanArgsSchema` | `.beginScan()`                      |
| `folo_list_scan_entries`  | `localAgentReadingListArgsSchema`      | `.listEntries()`                    |
| `folo_get_entry_contents` | `localAgentReadingContentsArgsSchema`  | `.getContents()`                    |

工具名与 MCP 端点共用 `LOCAL_AGENT_READING_TOOL_NAMES`，避免两套名字漂移；schema 直接用
`packages/internal/shared/src/local-agent-reading.ts` 里已导出的 zod 对象，`server.ts` 与工具层
共用一份定义。

**必须先解开的耦合**：`service.beginScan()` 里 `if (!this.server.isListening()) return SERVICE_DISABLED`。
面板内工具不需要对外暴露端口，因此要把「数据能力就绪」与「端点对局域网暴露」拆开：

- 给 service 增加内部入口（例如 `beginScan(args, { gate: "endpoint" | "app" })`），MCP 调用仍走
  endpoint 门控，面板工具走 app 门控（登录 + renderer ready + 未取消）。
- 对应的测试：端点关闭时 MCP 调用仍返回 `SERVICE_DISABLED`，而 app 路径可用；账号切换/退出登录
  仍然丢弃扫描。

## 4. 循环参数

- `stopWhen: stepCountIs(6)`（`ai` 已导出；后续可提到设置 `maxToolSteps`）。
- 每步沿用 `directCallOptions(config)` 的 `maxOutputTokens` / `temperature` / `providerOptions`。
- `abortSignal` 从请求透传；渲染器「停止」按钮现有的 abort 机制覆盖整个循环。
- 摘要场景（`scene: "timeline-summary"`）**不挂工具**：reduce 预摘要已经覆盖它的取数需求，挂工具会
  让成本不可控。

## 5. MCP 适配（P2 + P3，已实现）

- **配置来源**：随请求携带 `mcpServices`（渲染器只送 `enabled` 且 `mcpEnabled` 的服务，字段白名单
  `id/name/transportType/url/headers`）。没有新增 IPC：`ai` 设置活在渲染器 atoms，
  请求携带天然没有缓存失效问题。
- 连接：`StreamableHTTPClientTransport`（或 SSE） + `requestInit.headers`；SSE 走 `EventSource`，
  只接受 `requestInit`，其他传输用 `fetch: netFetch` 走 Chromium 网络栈。连接与 `tools/list` 共 2.5s 超时，
  失败的服务跳过并记日志。
- 生命周期：按对话开/关，`onEnd` 与 abort 都会关闭；不跨对话缓存。
- 命名：`mcp__<service-slug>__<tool>`，冲突加序号，全名 ≤ 64 字符。
- 审批（P3）：`readOnlyHint === true` 的工具直接调用；其余进 `approvals`，由 `chat.ts` 作
  `toolApproval: { <name>: "user-approval" }` 传给 `streamText`。未标注的服务按“可能写”处理。
  审批结果作为消息回来，`toModelMessages` 在有 tool part 时改用 SDK 的 `convertToModelMessages`，
  `createUIMessageStream` 带 `originalMessages`，工具结果才能挂回原调用。
- 上限：8 个服务、 26 个工具（Folo 4 个另计）、单结果 16000 字符（超出标注 truncated）、单次调用 15s。
- 结果：`content` 文本拼接、resource 取文本、字节资源标 `[resource]`、`structuredContent` 序列化；
  `isError` 回传 `{ error }` 给模型，不抛异常。

## 6. 模型能力降级

不新增 config 契约字段（`/ai/chat/config` 由共享包 `@follow/ai-runtime` 定义，改它要同步
`tools/ai-gateway`）。改为运行时判定：

1. 首次请求带 tools；
2. 命中明确「端点不支持工具」错误（unsupported-tools 文本，状态 400 / 404 / 422 或无状态码），
   且尚未输出正文、推理或工具调用时，丢弃未发送的流信封，当前请求无工具重跑一次；
   重新构造无工具提示词，无附带上下文时使用 `NO_CONTEXT_NOTE`。已有输出或工具执行后只报错，
   不重放；认证、限流等其他错误不降级。
3. 结果缓存到本次应用运行（同模型同端点不再重复试探），不跨重启持久化。

## 7. 类型与渲染

**P1 不需要改渲染器**，工具 part 走通用 `ToolInvocationComponent`，持久化按 parts 原文存。

**P3 需要三处：**

1. 审批状态不在外部包的 `ToolWithState` 里，组件用一个窄视图（`state` + `approval`）读取，不去改
   不归本应用拥有的类型。
2. `state === "approval-requested"` 时渲染「允许 / 拒绝」，调 `chatActions.addToolApprovalResponse`；
   `approval-responded` 只显示结果，不留按钮。
3. `ZustandChat` 构造时默认 `sendAutomaticallyWhen:
lastAssistantMessageIsCompleteWithApprovalResponses`，决定一条就自动续跑，不需要用户再点发送。

## 8. 持久化与回归

- `AIPersistService` 存 parts 原文，带 tool part 的消息需要验证：新建会话、重开应用、重新生成
  （regenerate 会重放历史 parts，含工具结果）。
- 旧版本写入的历史消息（无 tool part）必须仍能加载。

## 9. 安全与只读守卫

- Folo 工具仅提供读取操作及组合 digest，不暴露 `markRead` / 写入类 API。
- MCP `readOnlyHint === true` 的工具直接执行；其余工具通过 `toolApproval` 逐次审批。
  未标注工具也需审批，模型提示词不得把 MCP 工具一概描述成只读。
- 工具结果与日志不出现凭据；沿用 `failure.ts` 的脱敏口径。
- 服务层保留全部就绪检查（登录、账号未变、renderer ready），面板工具只豁免「端点未监听」这一条。

## 10. 测试

| 层   | 内容                                                                                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单测 | `tools/folo.ts` 的方法映射与错误包装（复用 `local-agent-reading/test-doubles.ts`）、`tools/mcp.ts` 的命名/过滤/截断（mock Client）、schema 复用不漂移 |
| 集成 | 本地假 OpenAI 兼容服务端：第一次请求返回 tool_call，断言第二次请求带 tool result、最终文本落地、步数上限生效                                          |
| 只读 | 源码守卫 + 运行时未读集合比对（沿用 MCP 的验收口径）                                                                                                  |
| e2e  | 真实 Electron + 假端点：工具卡片出现、失败卡片出现、停止按钮中断循环                                                                                  |
| 手工 | 真实 deepseek 端点跑 PRD 的三条用户故事；再跑一次不支持工具的端点验证降级                                                                             |

## 11. 分阶段

**P1｜Folo 只读 + 循环 + 降级**（已实现）
service 门控拆分 → `tools/folo.ts` → `chat.ts` 注入 → 提示词 → 类型放宽 → 降级 → 测试。

**P2｜MCP 只读**（已实现）
`shared/local-ai-mcp.ts` 契约 → `local-ai/mcp.ts` 连接与转换 → `chat.ts` 合并工具集与关闭
→ 渲染器 body 携带 → 单测 + 真实 SDK 服务端的集成测试。

**P3｜写操作与审批 UI**（已实现）
MCP 写工具不再过滤，交由 `toolApproval` 逐次审批；`toModelMessages` 有 tool part 时改走 SDK 转换
（否则审批后的第二轮请求会丢失工具调用）；`ZustandChat` 自动续跑；工具卡片增审批按钮。
Folo 自身的写操作（标已读等）不在本轮，见 spec 的 Non-goals。

### P1 与本文档的差异（实现时简化）

1. 没有做结果截断：service 已把正文按 6000 字符分块、批量上限 10 条，最坏 6 万字符/次；
   再截断只会让模型引用被切开的文字。P2 接 MCP 时仍需截断，因为外部服务返回体量不可控。
2. 没有改 `apps/desktop/layer/main/package.json` 补 `ai` 依赖：`ai` 已由 workspace 提升可解析，
   加依赖会牵动 `pnpm-lock.yaml`；以后统一整理 main 依赖时一起做。
3. handlers 不走直接 import：`local-agent-reading/index.ts` 把带 `requireListening: false` 的 handlers
   注入 `local-ai/tools`，避免 `chat.ts` 拉起 `electron-log` / `WindowManager`（否则 `routes.test.ts` 会挂）。

## 12. 未决

- 步数上限是否暴露到设置页（默认 6 是否合适）。
- MCP 连接是否跨对话常驻（与「退出登录即失效」的一致性）。
- 工具结果是否需要写入消息 metadata 以便分享/导出。
- 是否需要「本次对话禁用工具」的开关（成本控制）。
