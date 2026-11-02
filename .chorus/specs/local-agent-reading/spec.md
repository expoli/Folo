---
slug: local-agent-reading
title: 外部本地智能体读取 Folo 未读文章
status: active
created: 2026-10-20
updated: 2026-10-20 (live acceptance on a real signed-in account)
---

## Intent

让外部本地智能体主动读取 Folo 的未读列表和文章正文，自行生成有来源、可核对覆盖范围的总结。
用户已批准实现 `.chorus/specs/local-agent-reading/2026-10-20-unread-access/prd.md` 的设计。
本轮只在本地工作区实现与验证：没有提交、没有推送、没有部署、没有 Chorus 记录、没有改动模型或门控配置。

使用者视角的说明见 `docs/local-agent-reading.md`。

## Requirements

状态标记：`[x]` 已实现；验证证据与限制另列于下文，不表示全部边界均已实测。
`[~]` 实现存在但对应验收未完成；`[ ]` 未实现或未验证。核心流程已通过真实账户验证，完整验收仍有未覆盖项。

- [x] 使用当前登录账户和应用同步能力，不把账户凭据交给智能体，不直接扫描或修改 SQLite。
  - 主进程用 `apiClient.auth.getSession()` 判定账户；renderer 通过既有登录客户端分页读取。
  - 令牌是独立秘密，与登录会话无关；工具返回中不出现任何凭据（含错误文本，见下）。
- [x] 读取账户可访问、服务端仍保留的未读文章，不用当前页面或本地缓存冒充全量；明确订阅、列表、视图与 Inbox 的覆盖范围。
  - 默认范围＝全部 5 个视图＋该账户的每个 Inbox；可按 view/feed/inbox/时间范围收窄。
  - 列表订阅由视图分页覆盖；不支持的范围（搜索结果、归档/未收藏、账户不再返回的本地缓存）在
    `folo_get_status.unsupportedScopes` 明示。
- [x] 分页枚举、按文章 ID 去重，支持分批读取及继续处理；报告枚举时间、完整性和一致性限制。
  - 每页最多 6 次账户请求（每次向账户请求至多 100 行，与应用自身分页上限一致），游标自带完整状态；候选列表在扫描枚举完成后固定（TTL 15 分钟，最多 4 个扫描）。
  - `selectionConsistency` 固定为 `best_effort`：账户游标只有发布时间，因此**任何填满一页的边界**都视为无法证实覆盖的切点，来源降为 `partial` 并让 `enumerationComplete` 为 false；页内可见同时间戳时标 `timestamp_tie_boundary`，否则标 `page_boundary_unverified`（同一来源只标注一次）。从未分页的短来源仍为 `complete`；遍历本身仍尽力走到每个来源末尾，不截断。
- [x] 文章返回已读状态及观察时间；未知状态不当作未读，离线缓存不冒充当前状态。
  - `readState` 只有 `unread` / `unknown`；`unknown` 单独计数、永不投递。
  - 待同步的本地已读覆盖（`transactionQueue` overlay）优先于快照。
- [x] 正文附带来源、获取结果、截断信息；RSS 内容、网页提取文本和描述摘要不混为“已获取完整原文”。
  - `contentSource` = `readability` / `rss` / `description` / `source_page`；`completeness` 只在描述时为 `partial`，其余为 `unknown`。
  - 长文按 6000 字符分块，`nextCursor` 续读；每次调用返回 `counts` 与逐篇错误。
- [x] 访问文章源网页需要用户单独授权，默认关闭；未授权时明确拒绝而不是降级抓取。
  - 主进程持久化 `localAgentReadingSourcePageEnabled`（未写入即关闭），设置页有独立开关，只有主窗口能改；`folo_get_status.sourcePageEnabled` 向智能体披露当前状态。
  - 判断依据是**实际生效的读取模式**：续读游标携带的模式与显式 `mode` 同样受限，省略 `mode` 无法绕过。
  - 未授权时先完成账户身份与扫描有效性校验，再在正文解析与网页抓取之前返回 `SOURCE_PAGE_DISABLED`；关闭权限会中止在途源页请求，抓回但权限已撤销的页面不会被返回，改为已存正文加 `source_page_unavailable` 警告。
- [x] 读取不触发已读写入；AI 处理记录与人的阅读状态分离。
  - 不注册任何标记已读的工具；renderer 侧不用会写入 `read:false` 的应用内详情抓取；
    `readonly.test.ts` 在源码层面拦截 mark-read / reader 路径。
  - 真实账户的运行时对比已做：读取前后 UI 未读计数（15 个徽标、总和 334、指纹一致）与账户未读 ID 集合
    （604 条；三次完整枚举的排序后哈希一致，八次枚举的条数一致）没有变化；待同步队列的完整快照仍未取得（限制见 PRD §8.6）。
- [x] 默认关闭，仅本机、经授权访问；账户切换、退出登录、关闭服务后旧访问会话失效。
  - 开关持久化、默认关闭；固定端口 `127.0.0.1:41610`；Host/Origin/大小/速率/并发均有校验；
    401 在任何数据之前返回。
  - 退出登录、账户切换、令牌重置或撤销、关闭服务都会丢弃扫描并中止在途调用。
- [x] 用外部智能体连接最终桌面产物，验证未读分页、正文、覆盖说明和无已读副作用。
  - 已登录环境：最终 AppImage（sha256 `7e43e922…42670`，解包后运行，renderer 来自 `app.asar`）连接真实账户，
    官方 MCP SDK 客户端读到 604 条未读（5 个视图、7 页枚举、0 重复、0 未知状态），扫描显式 `partial` /
    `enumerationComplete=false`，正文按 `rss` 来源返回，`source_page` 在开关关闭时两种形态都被拒绝，
    读取前后 UI 未读计数与未读 ID 集合不变。逐项证据见 PRD §8.6。
  - 仍未覆盖：长文续读、`readability`/`description` 取值、Inbox（该账户无）、同步队列快照、
    服务端保留期限与同时间戳边界、源页开启后的真实抓取。

## Non-goals

- 首版不支持 Folo 完全退出后的访问，不新建独立同步后台服务。
- 首版不提供标记已读、修改订阅、自动定时总结或总结回写。
- 不保证绕过登录墙、付费墙、反爬，也不新增音视频转写或附件 OCR。
- 不宣称客户端分页能提供服务端尚未证实支持的原子快照。

## Implementation map

- 共享契约：`packages/internal/shared/src/local-agent-reading.ts`（类型、限制、zod 工具入参、错误码）。
- 主进程（端点与扫描）：`apps/desktop/layer/main/src/local-agent-reading/`
  （`server.ts` 守卫与 MCP、`service.ts` 工具处理与失效、`scans.ts` 有界枚举与游标、
  `contents.ts` 正文分块与受保护源页抓取、`provider.ts` renderer 桥、`token.ts` 令牌、`account.ts` 会话）。
- 设置 IPC：`apps/desktop/layer/main/src/ipc/services/local-agent-reading.ts`（仅主窗口 sender）。
- renderer 数据侧：`apps/desktop/layer/renderer/src/modules/local-agent-reading/`
  （`plan.ts` 来源计划、`enumerate.ts` 分页、`resolve.ts` 正文、`bridge.ts` 四方法、`failure.ts` 错误脱敏）。
- 设置 UI 与文案：`…/settings/tabs/integration/LocalAgentReadingSection.tsx` 与 `locales/settings/*.json`。
- 验证：`apps/desktop/e2e/tests/electron/local-agent-reading.spec.ts`（真实 Electron 产物 + 官方 MCP 客户端）、
  `apps/desktop/e2e/scripts/check-packaged-local-agent-reading.mjs`（打包产物）。

## Deliberate limitations

1. 端点固定端口 `41610`：被占用时报 `listenError` 并保持关闭，不做随机端口回退。
2. 无 OS keyring 时令牌只存在内存中：重启后开关仍为开、端点不监听，需要用户重新生成令牌；设置页会明示。
3. `folo_begin_unread_scan` 是同步有界操作：超大账户返回 `partial` 与明确原因，不会静默取前 N 条。
4. 续读游标会重新解析正文，正文在两次调用之间变化会导致偏移漂移。
5. `executeJavaScript` 无法真正中止：取消只是丢弃结果并请 renderer 停止。
6. `folo_get_status` 与每次工具调用都重新核对会话与 renderer 就绪状态（无缓存），换取退出登录/切换账户立即生效。
7. `syncedAt` 永远为 `null`：客户端维护变更游标而不是“最后同步时间”，不猜测。
8. 账户游标只有发布时间，无法证实同时间戳的兄弟条目：任何填满一页的边界都会把来源降为 `partial`，
   即使实际没有丢失条目。要无损需要服务端提供复合游标或可证实的包含语义，不在客户端猜测。
9. 本地“标为未读”但尚未上传的变更无法把条目加入扫描（扫描向账户请求未读条目）；本地“标为已读”总会移除条目。

## Verification state

已验证（本地，未提交）：

- 单元测试：主进程 327 个（含 `account.test.ts` 的凭据脱敏、`server.test.ts` 的源页授权与续读游标、`index.test.ts` 的开关持久化）、
  renderer 416 个（含脱敏回归、分页边界回归、设置页第二个开关的组件测试、只读源码守卫）。
- 真实传输（本地回环 + 官方 MCP SDK 客户端）：源页默认关闭时 `folo_get_status.sourcePageEnabled=false`
  且显式 `mode: source_page` 与 `c1:source_page:` 续读游标都被 `SOURCE_PAGE_DISABLED` 拒绝、零抓取；
  通过设置接口授权后同一次扫描可读到 `contentSource: source_page`；再次撤销后拒绝、而已存正文仍可读。
- 真实 Electron 产物：`local-agent-reading.spec.ts` 用真实 Electron + 官方 MCP SDK 客户端跑通
  开关、令牌、工具清单、`folo_get_status`、未登录拒绝、令牌轮换/撤销、关闭；
  `401`（无/错令牌）、`403`（Origin、外来 Host）逐项断言；并断言两个开关互相独立、
  源页权限默认关闭、工具状态跟随设置变化（不可由任何工具授予）。
- 打包产物：`pnpm run build:electron` 成功；`verify:package` 的 asar 外部依赖检查通过，
  打包内含 `folo-local-agent-reading`、`localAgentReading`、`folo_begin_unread_scan` 标记；
  `check-packaged-local-agent-reading.mjs` 在解包 AppImage 上 33 项全部通过（含“没有工具接受 URL、已读状态或源页权限”），
  含二次启动验证：开关、端点、令牌**与源页权限**在重启后自动恢复（证明主进程启动路径与 keyring 持久化可用）。

仍未验证（同一真实账户下未覆盖的部分）：

- 服务端保留期限与真实同时间戳切点：真实账户枚举中的三处注记都是“页内未见同时间戳”的
  `page_boundary_unverified`，保留期限未探测。
- 正文长文续读（抽样文本最长 913 字符，未触发 6000 字符分块）、`readability` / `description` 取值、
  源页开关开启后的真实站点抓取。
- 同步队列完整快照（队列只在 renderer 内存 store + OPFS 数据库，无只读接口）。

已完成（2026-10-20，真实登录账户，最终 AppImage，逐项数据见 PRD §8.6）：

- 已登录状态下的设置 UI：真实指针点击“集成”标签与端点开关，显示“正在监听 / 令牌已就绪”，
  `127.0.0.1:41610` 真实监听，源页开关保持关闭。
- 分页：604 条未读、5 个视图、7 页（100×6+4）、0 重复 ID、0 未知状态；三个来源 `partial`
  （`page_boundary_unverified`）、两个 `complete`，`enumerationComplete=false`。
- 正文：`cached` 读到 3 篇 `rss`（913/230/170 字符，`length_unknown`），无缓存条目逐篇 `no_content`；
  `detail` 读到 1 篇 590 字符 `rss`。
- 源页：显式 `mode` 与 `c1:source_page:` 续读游标均被 `SOURCE_PAGE_DISABLED` 拒绝。主进程账户请求不在本次 renderer 网络审计范围内，不能据此声称零账户请求。
- 只读：4/4 工具 `readOnlyHint`，无 URL / 已读状态 / 源页权限参数；无令牌 401、错令牌 401、外来 Origin 403。
