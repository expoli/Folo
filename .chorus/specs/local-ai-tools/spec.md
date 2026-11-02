---
slug: local-ai-tools
title: 面板 AI 的工具循环
status: draft
created: 2026-10-29
updated: 2026-10-29
---

## Intent

面板里的本地 AI 通过主进程内的 AI SDK 工具循环自行取数，复用 local-agent-reading 的
Folo 只读能力，并接入用户配置的 MCP 服务。Folo 工具不修改阅读状态；MCP 工具仅在
`readOnlyHint === true` 时直接执行，其余工具逐次等待人工批准，不提供永久授权。

## Requirements

状态标记：`[x]` 已实现并验证；`[~]` 实现存在但验收未完成；`[ ]` 未实现。

- [x] 主进程 `streamText` 挂 `tools` + `stopWhen`，形成多次往返；渲染器不改流式结构。
  - 循环上限 `LOCAL_AI_MAX_TOOL_STEPS = 6`；`scene: "timeline-summary"` 不挂工具，使用已附缓存内容的有界预摘要，不能把缓存覆盖率当作账户全量覆盖率。
- [x] 四个 Folo 只读工具复用既有 zod schema 与 `LOCAL_AGENT_READING_TOOL_NAMES`，不新造名字。
  - 工具的 title/description 移入 `LOCAL_AGENT_READING_TOOL_INFO`，MCP 端点与面板工具读同一份字符串。
- [x] 面板工具不依赖外部 MCP 端点是否监听：`beginScan(args, { requireListening })` 把「端点暴露」与
      「数据能力就绪」分开，MCP 路径行为不变。
- [x] MCP 工具命名带服务前缀，结果截断、超时可控。
  - 配置随请求携带（`mcpServices`），渲染器只送启用的服务与连接必需字段；主进程不缓存，
    连接按对话开/关。上限：8 个服务、26 个工具、单结果 16000 字符、单次调用 15s、连接+列举 2.5s。
  - 不接 OAuth（仅 `headers`）；一个服务连不上就跳过，不影响其余工具与回答。
- [x] 写操作逐次人工审批（P3）：`readOnlyHint` 的工具直接调用；其余工具下发给模型但 `toolApproval`
      设为 `user-approval`，用户在面板里点「允许 / 拒绝」才执行。未标注的服务按“可能写”处理。
- [x] 审批结果能回到循环：`toModelMessages` 在有 tool part 时改用 SDK 的转换，工具调用、结果与
      审批决定作为消息保真；`createUIMessageStream` 带上 `originalMessages`，审批后的工具结果能挂回原调用。
- [x] 不支持工具调用的端点自动降级：在尚未输出内容或工具调用的首次明确拒绝后，当前请求无工具重跑一次；同 endpoint+model 在本次运行内后续对话不再带工具。已有输出或工具执行时不重跑。
- [x] 读取不改变已读状态；源码守卫扩展到 `local-ai/tools/`（`tools/readonly.test.ts`）。
- [~] 带 tool part 的会话重开/重新生成：持久化按 parts 原文存储（`AIPersistService` 只跳过 `state === "streaming"`），
  代码核对通过，未做界面回归。
- [x] 显式切换来源范围保留请求日期；首次发送、重新生成和审批续跑使用相同有效 scene。
- [x] 预摘要输入必须覆盖被替换的已附正文范围，预算不足保留正文和截断标记；note 单独标为摘要。
- [x] 已有足够长的正文或 reduce body 时不重复抓取源网页；有缓存 note 时复用。

## Non-goals

- 不做 Folo 自身的写操作（标已读、收藏等）：`local-agent-reading` 的“只读”承诺与它的文档/测试
  一起成立，改成可写需要独立的服务面，不在本轮。
- 不做“总是允许”：审批逐次生效，不落盘、不预置。
- 不改 Folo 官方服务端 AI 路径；不做 pi 集成。

## Follow-ups

- **dev 版协议回调冲突已修复**：未打包 Electron 使用网页登录已有的 `cli_callback` 接口，
  一次性令牌通过带随机路径的本机 HTTP 回调送回发起实例；不注册或抢占已安装版的协议关联。
  回调和 IPC 路由已通过真实 HTTP 回归；实际 Electron 登录按钮、回环交接、真实账户登录、
  登录后进入 AI 设置和干净重启保留登录均已验证。系统协议关联仍为 `folo.desktop`。
  后续聊天工具卡片的完整 UI 验收单独进行。
- 审批 UI 未做“查看即将执行的完整参数再决定”以外的辅助（如 diff 预览）。
- 工具数量日志：目前只打 `tools=requested`，建议补工具数与名字。

## Verification state

已验证（本地，未提交）：

- 类型检查：`@follow/shared`、`@follow/ai-runtime`、`@follow/electron-main`、`Folo` 四个包
  `tsc --noEmit` 通过。
- 单测：主进程 363 个全通过（`local-ai/tools/*`、`local-ai/chat.test.ts`、`local-ai/mcp.test.ts`、
  service 门控用例），`@follow/ai-runtime` 87 个、`@follow/shared` 39 个、渲染器 `ai-chat` 75 个全通过；
  改动文件 eslint 干净。
- 工具循环端到端：`chat.test.ts` 用假 OpenAI 兼容 SSE 上游 + 真实 SDK MCP 服务验证四条：
  工具执行后回传结果、summary 场景/未绑定服务不下发工具、**写工具停在 `tool-approval-request`
  且服务端 0 次调用**、**带 approved 决定回来后工具真的执行（`create_note` 收到原参数）**。
- MCP：`mcp.test.ts`（14 例）覆盖审批标注、命名去重、上限、错容、截断、错误回传、关闭幂等；
  `mcp.integration.test.ts` 用真实 SDK 服务端验证连接、请求头透传、只读工具免审/写工具需审、
  不可达服务被跳过。
- 审批 UI：`ToolInvocationComponent.test.tsx`（4 例）验证待审状态不再显示“已调用”、允许/拒绝各自
  带上正确的 approval id 调 `addToolApprovalResponse`、已表态后不再显示按钮。

未验证：

- 面板 UI 的**端到端**部分：审批按钮在真实 Electron 窗口里的点击、以及停止按钮中断循环。
  退出原因是 dev 版深链登录不可用（见 Follow-ups），登录闸门挡住了 composer 发送；
  审批组件本身有 DOM 测试，`addToolApprovalResponse` → `sendAutomaticallyWhen` → 主进程续跑这一段
  由 `chat.test.ts` 的 approved 用例覆盖。
- `folo_*` 的真数据执行（需登录后的账户）。
- 真实第三方 MCP 服务的写操作（未真正在第三方服务上执行过写调用）。
- 真实 Electron 产物中的历史会话重开。

## Live run（2026-10-29，dev 实例 + 真模型 + 真 MCP 服务）

环境：`electron-vite dev`（独立 profile `Folo(dev)`，未登录）、magpie `digua/deepseek-flash`
（`127.0.0.1:3425/v1`，无需 key）、本地测试 MCP 服务（`/tmp/folo-mcp-test`，三个工具：
`search_notes` 只读、`create_note` 写、`list_note_titles` 无标注）。
因为面板发送需登录，这轮在渲染器里调了面板 transport 的同一对 IPC：
`localAI.openChatStream` + `localAI.chatStream`（主进程走的是完全相同的循环）。

- 主进程日志：`tools=requested`、`mcp: 1 read-only tool(s) from 1 service(s)`、`finish=stop`。
- 模型自报工具清单：`folo_get_status`、`folo_begin_unread_scan`、`folo_list_scan_entries`、
  `folo_get_entry_contents`、`mcp__notes_test__search_notes` —— 恰好 5 个。
- “查 Kconfig 笔记”：连续 4 次 `search_notes`（`Kconfig` / `Kconfig 选项` / `menuconfig` / `内核配置`），
  回答逐条引用了笔记原文。
- “用 create_note 复制一条笔记”：模型回答自己没有写入工具，改用 `search_notes` 读出内容；
  服务端 `create_note`、`list_note_titles` 各 0 次调用，全程 7 次 `search_notes`。

## Implementation map

- `apps/desktop/layer/main/src/local-ai/chat.ts`（循环、降级、提示词选项、工具集合并与关闭）
- `apps/desktop/layer/main/src/local-ai/tools/`（`folo.ts` 四个工具、`index.ts` 组装与降级记忆、测试与只读守卫）
- `apps/desktop/layer/main/src/local-ai/mcp.ts`（MCP 连接、`tools/list` → 工具、白名单/截断/超时）
- `packages/internal/shared/src/local-ai-mcp.ts`（请求携带的服务形状与限制）
- `apps/desktop/layer/main/src/local-agent-reading/service.ts`（`beginScan` 的 `requireListening` 选项）
- `apps/desktop/layer/main/src/local-agent-reading/index.ts`（把 app 侧 handlers 绑定给工具层）
- `packages/internal/shared/src/local-agent-reading.ts`（`LOCAL_AGENT_READING_TOOL_INFO`，工具文案单一来源）
- `packages/internal/ai-runtime/src/prompts.ts` / `context.ts`（`TOOLS_NOTE` 与 `buildChatSystemPrompt` 的 `toolsAvailable`）
- `docs/local-agent-reading.md`（同一套工具在应用内的行为差异）

详细设计见同目录 `tech_design.md`，需求与验收见 `prd.md`。
