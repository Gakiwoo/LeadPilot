# LeadPilot 技术架构与决策记录（ADR）

> 对应 PRD v1.1 第 9 章 · 基线版本 v0.6.0 · 2026-11-08（ADR-023–026 为本次新增）

## 0. 架构总览（本次交付边界）

```
┌──────────────────── 浏览器 / 未来 Tauri WebView ────────────────────┐
│ React 18 + TS + Tailwind + Zustand                                  │
│ ┌──────────────────────────────────────────────────────────────┐  │
│ │ components/  四大页面 · 详情抽屉 · 开发信编辑器                 │  │
│ ├──────────────────────────────────────────────────────────────┤  │
│ │ store/       Zustand 单一状态源（本地 / 云端运行器切换）         │  │
│ ├──────────────────────────────────────────────────────────────┤  │
│ │ domain/      ★纯函数领域层：评分 / 证据 / 状态机 / 合规         │  │
│ │              （无 React、无 IO、无随机、全部可单测）             │  │
│ ├──────────────────────────────────────────────────────────────┤  │
│ │ services/    gateway-client（真实 HTTP/SSE）+ Mock 适配器        │  │
│ │ data/        演示数据 + Repository 抽象（localStorage）          │  │
│ └──────────────────────────────────────────────────────────────┘  │
└───────┬──────────────────────────────────┬───────────────────────┘
        │ REST（探测 / 判断 / 写信 / 控制）  │ SSE（任务事件单向推送）
┌───────▼──────────────────────────────────▼───────────────────────┐
│ server/ · Node 22 原生 http，零额外依赖（127.0.0.1:5181）         │
│  index.mjs        Bearer 鉴权 · CORS 白名单 · 每分钟限流           │
│  gateway.mjs      T0/T1/T2 路由 · 降级链 · 熔断 · 缓存 · 审计      │
│                   · 模型快照锁定（E6008）                          │
│  protocol.mjs     schema / 证据 / PII / 计费 / Prompt（共享协议）   │
│  orchestrator.mjs 6 阶段任务状态机 · 游标 · 并发上限 3 · 硬超时     │
│  store.mjs        tasks/cache/audit 持久化 · 重启恢复（AC-03）     │
│  t0.mjs           T0 规则事实抽取（可核验引用，不调模型）         │
│  data-sources.mjs 6 类数据源注册表 · health · 显式 demo/blocked    │
│  eval.mjs         8 项评测 + P0 发布门禁                          │
│  ⚠ 数据源适配器 / Playwright 集群 / Gmail 仍未接入                │
└──────────────────────────────────────────────────────────────────┘
                    ▲ 单一真源：shared/model-protocol.json
```

**关键边界**：评分计算、客户库、状态、合规校验全部在客户端（PRD 5.2「采集在云端，判断与发送在本地」）。服务端只负责「取事实 + 让模型做离散判断 + 把受限输出送回来」，**客户端不信任服务端结论，会再跑一次 schema + 证据校验**，然后才交给 `buildScoreCard` 合成。合规尾巴与发送前校验始终在客户端代码里，服务端与模型都不接触发件人手机号和地址。

---

## ADR-001 · 纯 Web 基线先行，Tauri 2 外壳后置

**决策**：本次不引入 Tauri/Electron，用 Vite dev server 直接跑，目录预留 `src-tauri/` 接入点。

**理由**：
- 本次要验证的是「评分可信度」这个产品假设，不是安装包与原生能力。外壳不产生任何信息量，却会引入 Rust 工具链、WebView2 分发、签名与自动更新的调试成本。
- PRD 9.2 推荐 Tauri 2 的三条理由（15MB vs 150MB、内存、DPAPI/SQLite/通知）都成立，但都属于**发布阶段**约束，不影响领域逻辑与 UI 代码的写法。
- 纯 Web 产物可以直接被 Tauri 2 作为 `frontendDist` 复用，不是返工。

**高级工程师判断（对 PRD 9.2 的补充）**：Tauri vs Electron 不该按「技术先进性」选，按团队约束选——
- 团队有 Rust 经验 / 按 10 周排期 / 安装包体积直接影响下载转化 → **Tauri 2**（同意 PRD 结论）；
- 团队无 Rust 且要求 6 周内出可用验证版本 → **Electron**，先把产品跑通再谈优化，不要为技术洁癖拖慢验证（同意 PRD 的反方意见）。

**接入点**：`src-tauri/tauri.conf.json` 指向 `dist/`，Rust 侧提供 `sqlite`、`dpapi`、`notification`、`updater` 四个 command；前端只通过 `Repository` 与 `GmailAdapter` 调用，不直接碰原生 API。

## ADR-002 · 领域层必须是纯函数

**决策**：`src/domain/` 禁止 import React、zustand、fetch、Date.now()（除状态日志）、Math.random()（除 ID）。

**理由**：PRD 6.7.2 要求「同一输入必须得到同一分数」。评分引擎一旦掺入 IO 或时间，就失去可复现性与可审计性，也无法在 CI 里跑 385 家基准集回归。

**后果**：所有模型结果以「已验证的离散枚举」形式从外部传入 `buildScoreCard(features, judgement, options)`；引擎本身不知道模型存在。前端 32 个测试里没有任何 mock server；服务端 48 个测试才负责验证网关、编排器、T0 抽取、数据源注册表、安全边界与持久化。

## ADR-003 · 不用「采样 3 次取中位数」稳定分数

**决策**：`temperature=0` + 固定 prompt/schema 版本 + 结果缓存 30 天；投票仅用于 T2 疑难样本。

**理由**：与 PRD 6.7.2 一致——成本 ×3，且中位数只压随机方差，压不住系统性偏差（例如对德国中型企业普遍高估采购意愿）。系统性偏差只能靠 385 家基准集校准。本基线把版本留痕（`model_id / model_version / prompt_version / schema_version`）写进受限输出协议，为将来做 diff 报告留了字段。

## ADR-004 · 适配器接口与真实替换点

| 接口 | 当前实现 | 真实上线替换 | 前置条件 |
|---|---|---|---|
| `DataSourceAdapter.search/detail` | `mockDataSourceAdapter`（零请求） | SerpAPI / Bing / Google CSE + Playwright 集群 + 代理池 | 数据源合同、robots 合规、同域 ≤1 req/s 限速 |
| `SSE 任务编排` | ✅ `server/orchestrator.mjs` 真实状态机 + SSE + 本地持久化（AC-03 已闭环）；本地 `createTaskRunner` 仍可切换 | 把 6 类数据源适配器接进编排器；多实例部署时把 `store.mjs` 换成 Redis/共享库 | 多实例部署、页面快照对象存储 |
| `LLMAdapter.chat` | ✅ `server/gateway.mjs` 真实调用链（Key 从环境变量读）；前端 `mockLlmAdapter` 仅作接口占位 | 补齐 DPA / ZDR、BYOK 的 DPAPI 加密、点数账本持久化 | 385 家基准集跑分后再定最终 provider 组合 |
| `T1 开发信生成` | ✅ `/v1/email/generate` 真实 T1；失败显式回退本地模板 | 加 T0 锚点抽取与 2 版差异化 Prompt | F6-2 硬约束回归集 |
| `邮箱验证器` | 演示数据里的 MX/SMTP 结果 | 自建 MX + SMTP 探测服务 | IP 信誉养护 2–3 周，禁止大规模 RCPT 爆破 |
| `GmailAdapter.createDraft` | 返回 `demo: true` 的本地草稿 ID | `users.drafts.create` + OAuth PKCE loopback | Google sensitive scope 验证（2–6 周） |
| `邮件发送 / 回复检测` | 未实现（V1） | `gmail.send` + `gmail.metadata` | CASA Tier 2（4–8 周，年费数千美元） |

**降级姿态（F0-4）**：`buildScoreCard` 的 `modelAvailable: false` 分支实现「分数变区间 + 置信度低 + 界面标注未经模型校验」；服务端无 Key 时返回 `503 E6005` 而非一段假判断；写信失败时正文为 `null` 并显式回退本地模板。三层都有单测与冒烟覆盖。

## ADR-005 · Repository 抽象保持与 SQLite 同构

**决策**：`data/repository.ts` 只暴露 `load / save / clear`，持久化的是 PRD 第 10 章 9 张表的聚合形式；Tauri 侧换成 SQLite 时仅替换该实现。

**理由**：桌面版要求「断电/崩溃后重启可续跑」（8.2），本质是持久化契约而非数据库选型。把契约收在一个 40 行的接口里，比在 20 个组件里散落 localStorage 调用安全得多。

**已知限制**：localStorage 有容量上限，`save` 已在配额超限时降级为「剥离 sourceTexts/evidence 再存」，并在再次失败时静默放弃——不伪造保存成功。桌面版不做此妥协。

**索引建议（PRD 10 章）**：`company(domain)` 唯一索引去重、`company(total_score DESC, can_send DESC)` 支撑默认排序、`company(status)` / `company(country)` 支撑筛选；1 万客户规模无需引入额外数据库。

## ADR-006 · 合规规则放在 domain 层，UI 无权绕过

**决策**：退订全局黑名单、退订尾巴注入、字数/禁词校验、G1–G4 闸门、`BATCH_DIRECT_SEND_ENABLED = false` 全部在 `domain/compliance.ts`，UI 只消费结果。

**理由**：PRD 11.2 明确「写进代码，不靠自觉」。如果规则放在按钮的 `disabled` 条件里，任何一次新页面开发都可能漏掉；放在纯函数里则可以被 8 个单测锁死，且未来任何发送入口都必须调用 `checkSendGates`。

**数据最小化**：`minimizeForModel(features, profile)` 从协议层剔除邮箱 / 电话 / 联系人姓名 / 邮件正文 / Gmail 凭据。真实接入后，网关应直接消费这个 payload，禁止业务代码自行拼装请求体。

## ADR-007 · 列表渲染策略

PRD 指定 TanStack Table + 虚拟滚动。本次基线用原生 `<table>` + CSS `content-visibility: auto` + `contain-intrinsic-size`，1,000 行量级可保持流畅且少两个依赖。

**何时升级**：出现列拖拽排序、列宽记忆、单元格编辑、分组聚合需求时（PRD F3-1 要求），换 TanStack Table + TanStack Virtual，不要继续手写。当前实现刻意没做这几项，详见 `PRD-COVERAGE.md`。

## ADR-008 · 测试顺序执行

`vite.config.ts` 设 `fileParallelism: false`，`cacheDir` 指向项目内。原因：当前 Windows 会话的 fs 代理不允许多个 Vitest worker 并发写 SSR 转换缓存（报 EPERM，且会随机漏跑一个测试文件）。改为顺序执行后 6 个文件 / 80 个测试稳定全绿、0 skipped。这是环境适配，不是产品约束；CI 环境可去掉。

**v0.3.0 补充教训**：本地全绿 ≠ 仓库可构建。首次推 GitHub 后 CI 在干净检出上报 `TS2307: Cannot find module '@/data/*'`，根因是 `.gitignore` 写了 `data/`（无前导斜杠会匹配任意层级目录），把源码 `src/data/` 一起排除，首提交漏掉 `demo-data.ts` / `repository.ts`；本地文件都在所以全部通过。改为 `/data/` 锚定仓库根并补回文件后 CI 全绿。**规则：忽略本地运行产物一律用 `/` 锚定根目录；首次接入 CI 必须做一次干净检出验证。**

## ADR-009 · 共享协议单一真源，禁止前后端各写一份枚举

**决策**：`shared/model-protocol.json` 同时被 `src/domain/llm-judgement.ts`、`src/domain/constants.ts`、`src/services/adapters.ts`、`server/protocol.mjs`、`server/gateway.mjs`、`server/eval.mjs` 读取。

**理由**：PRD 6.7.3 的 wire 字段是 `source_url / fetched_at`，而前端内部用 `sourceUrl / fetchedAt`；若靠人肉同步，必然出现「前端放行的枚举后端判越界」。首次校准就发现了 3 处漂移（证据字段名、`LLMAdapter` 缺 `embed/search/fetch`、禁词表双份）。

**后果**：`normalizeEvidence` 兼容两种命名；`validateSchema` 拒绝 `score/total_score/rating/points`；禁词与字数上限也收进 `emailPolicy`，服务端 Prompt、服务端校验、客户端校验三处共用一份。`model_version` 含 `-latest` 直接判非法（生产必须锁快照）。

## ADR-010 · 服务端网关用 Node 原生 http，不引入 Express / Redis

**决策**：`server/index.mjs` 用 `node:http` 手写路由；任务状态放进程内 `Map`，但**每个状态变更都同步写入 `Store` 接口**（见 ADR-013），缓存与审计同样落盘。

**理由**：这一阶段要验证的是**协议与降级链是否正确**，不是吞吐。零额外依赖意味着 `npm install` 后 `node server/index.mjs` 直接可跑，冒烟脚本可在任何机器复现。引入 Redis/BullMQ 只会让「E6005 是否真的没调 provider」这件事更难证明。

**边界与升级条件（v0.3.0 修订）**：单实例下 AC-03 已闭环（ADR-013）；多实例部署时 `Map` 仍是进程内状态，必须把 `Store` 换成共享 Redis / PostgreSQL，并在任务上加租约与幂等键。HTTP 层与 SSE 契约不用改。

## ADR-011 · 自由文本清洗，结构化字段硬拒

**决策**：`assertNoPii` 对结构化字段命中邮箱 / 电话 / 凭据即拒绝整个请求（400 E6004）；对 `sourceTexts` 这类官网自由文本，先用 `sanitizeContext` 替换为 `[email removed]` 再发模型，审计记 `piiRemoved` 数量。

**理由**：官网页面天然夹带 `info@company.com`，一刀切拒绝会丢掉整页事实；但请求体里出现 `contact_email` 字段说明调用方越界拼装，必须硬拦。两者处置不同，不能共用一个布尔开关。

## ADR-012 · 真实编排与真实采集必须在 UI 上分开标注

**决策**：任务配置页提供「本地演示运行器 / 云端编排器（SSE）」显式切换。云端模式的 SSE 事件是真实的，但**不写入任何客户记录**，执行页常驻紫色说明条；本地模式写入带 `demo: true` 的演示客户。

**理由**：最容易骗人的不是「纯假数据」，而是「真 SSE + 假候选域名」的混合体。编排器事件里出现 `candidate-N.demo.local` 占位域名，如果客户端顺势生成一批看起来像真的公司，用户就无法分辨哪一层是真的。

**后果**：云端模式下任务可暂停 / 续跑 / 中止、游标跨进程持久化（ADR-013），但 `companyIds` 始终为空；需要完整名单链路就切回本地运行器。切回真实数据源后，这条 UI 说明必须同步撤掉。

## ADR-013 · 持久化收在一个 Store 接口里，AC-03 单实例闭环

**决策**：新增 `server/store.mjs`，统一 `taskUpsert/taskGet/taskList/taskDelete/cacheGet/cacheSet/cacheStats/auditAppend/auditList/close` 十个方法，三种实现可替换：`sqlite`（Node 22 内置 `node:sqlite`，WAL，默认）、`json`（原子 rename 兜底）、`memory`（仅测试）。`createApp` 创建一次 store，注入 gateway 与 orchestrator。

**理由**：AC-03 要的是「杀进程后游标还在、点数不重复扣」，本质是**持久化契约**而不是数据库选型。把契约收成一个接口，编排器只管状态机，网关只管缓存，升级到共享库时两处业务代码都不用改。SQLite 三张表 `tasks/cache/audit` 足够覆盖 1 万客户规模，且零额外依赖。

**恢复语义**：`hydrate()` 把重启前 `running/queued` 的任务一律降为 `paused`（不自动续跑、不重复扣点），保留 `cursor / pointsUsed / progress`，并追加一条可核验日志；`/health.persistence` 如实报 `mode / durable / recoveredTasks`。`memory` 永远不会被说成已持久化。

**踩过的坑**：不能用 `await import('node:sqlite')` 做能力探测——Vite 的模块解析器会把 `node:` 前缀剥掉重写成 `import('sqlite')`，导致 Vitest 下探测失败、测试被 skip、`createStore()` 静默退到 JSON 兜底而与生产行为不一致。改用 `process.getBuiltinModule('node:sqlite')`（`createRequire` 兜底）这类不经过 Vite 重写的同步运行时访问；`sqliteProbeError` 一并导出便于诊断。

**升级条件**：多实例部署、任务租约与幂等键、点数账本事务化。单实例不需要 Redis。

## ADR-014 · 模型快照锁定，禁止浮动指针

**决策**：`shared/model-protocol.json` 置 `rules.requirePinnedModelVersion = true`；真实调用 = `provider API Key` **且** `LEADPILOT_MODEL_VERSION_<PROVIDER_KEY>` 指向具体快照 ID。含 `-latest` 判未锁定，返回 `E6008` 且不进入降级链；`/v1/gateway/health` 逐 provider 暴露 `pinned / modelVersion / ready`。

**理由**：PRD 6.7.2 要求「同一输入必须得到同一分数」，`temperature=0` 只能压随机方差，压不住供应商悄悄换底座。评测门禁与 30 天结果缓存都建立在「模型版本可复现」之上；浮动指针会让 385 家基准集的结论一夜作废。基线**不预置任何猜测版本号**——版本号必须由运维从 provider 官网查得后注入，宁可 E6008 降级也不猜。

**后果**：`configuredCount`（有 Key）与 `pinnedCount`（锁快照）是两个独立数字，设置页分列展示。`callOnce()` 使用 `pinnedModel` 而非协议里的默认 `model`；审计留痕 `model_version` 为具体 ID。

## ADR-015 · 服务端安全边界写进启动前置校验

**决策**：本地回环 + 未设 token 时免鉴权（`/health` 始终可探活）；一旦设置 `LEADPILOT_API_TOKEN` 或非本机监听，`/v1/*` 强制 Bearer（401 `E6009`）。CORS 按 Origin 白名单逐请求决定 `Allow-Origin`，绝不默认通配；每 IP 每分钟限流（429 `E6010` + `Retry-After`）。**非本机监听 + 无 token / CORS `*`：启动前直接 `process.exit(1)`，不静默放行。**

**理由**：`LEADPILOT_HOST=0.0.0.0` 是运维最常见的一行改动，如果服务悄悄启动成无鉴权公网端点，网关里所有 PII 与数据最小化努力都白费。把约束放在启动前置校验比放在中间件里更难被绕过。

**SSE 鉴权**：`EventSource` 不能带 Authorization，把 token 拼进 query 会泄漏到日志与浏览器历史。前端改为 `fetch` 流式读取并解析 `event/data` 帧，服务端 SSE 走同一套 `authOk()`。

**已知限制**：`VITE_LEADPILOT_TOKEN` 会暴露在浏览器 bundle，只适用于本机开发 / 可信内网；公网生产必须由同源反向代理注入凭据，前端不持有长期 token。详见 `.env.example` 注释。

## ADR-016 · T0 事实抽取必须是确定性规则层

**决策**：新增 `server/t0.mjs` 与共享协议的 `t0Extraction` 词表。输入是「调用方已经拿到的原文」（`url / text / fetched_at`），输出客户类型 / 进口信号 / 规模 / 产品词 / 负面信号 / 开发信锚点，每条事实携带 `quote / source_url / fetched_at`；未命中维度进 `noSignalFields`，绝不补零。不调用模型、不联网、不推断、不翻译、不做同义扩展。

**理由**：PRD 6.7.1 的「模型不生产事实」必须落在链路最底层。规则分的输入如果来自模型自由文本，幻觉会沿评分链一路传到综合分，且无法用 `temperature=0` 复现。T0 用确定性规则 + 逐字可核验引用，才能给 385 家基准集提供稳定输入。词表放在 `shared/model-protocol.json`，遵守 ADR-009 单一真源。

**硬约束**：`quote` 必须是清洗后原文的连续子串，产出后逐条用 `text.includes(quote)` 复核，任何一条不过直接丢弃；`no_signal` 明确注释「无记录 ≠ 没进口」，不得据此推 `no_import_evidence` 负面标记或给 0 分。输出 `extractor='rules'` 与网关 `judge()` 严格区分，禁止混称模型结果。

**接入点**：`POST /v1/t0/extract`（400 `E6004` 拦截非法来源 / PII）；`gateway.writeEmail()` 收到 `sources` 时锚点优先取 T0 quote，返回 `anchorSource='t0-rules'` 与 `t0` 元数据，**所有降级路径也如实上报**，不因 T0 成功而伪造模型正文。前端 `extractFactsWithGateway()` 提供对称入口，但当前客户端没有真实原文，不主动调用——避免制造「有原文」的假象。

**升级条件**：词表是基线定义，必须与 385 家人工标注基准集一起校准 `extraction_recall ≥ 0.70` 后冻结；真实数据源接入后再把「原文抓取」接在 T0 之前。

## ADR-017 · 数据源注册表可插拔，但绝不半接入

**决策**：新增 `server/data-sources.mjs`，注册 PRD 的 6 类源，统一 `search / healthCheck` 契约，逐源暴露 `unconfigured / not_implemented / ready / unhealthy`。编排器只消费 `health()` 与 `planBatch()`：无 ready 源 → `sourceMode='demo'` + 占位域名；**有 ready 源也返回 `sourceMode='blocked'` + 空 domains + 立即暂停任务**。异步 `collect()` 已实现且单测覆盖，但编排器当前不调用。

**理由**：最容易骗人的不是纯假数据，而是「真 SSE + 假候选域名」的混合体（ADR-012）。如果一注入实现就自动渲染出「看起来像真公司」的名单，而域名去重、T0 原文抓取、客户端写入契约都还没评审，产品最核心的可信度资产就没了。宁可显式 `blocked` 并暂停，也不产出半真半假的中间态。

**后果**：`health()` 如实报 `0/6 已接入`，`/health` 与 `/v1/gateway/health` 同步暴露，设置页与执行页逐源显示「未接入」；任务快照带 `sourceMode` 与 `dataSources`，SSE 事件同源。真实接入时必须一次性完成：6 类 adapter 实现 → 代理池与限速 → 域名去重 → T0 原文 → 客户端写入契约 → 端到端回归，然后才允许把 `blocked` 改为放行。

## ADR-018 · 依赖漏洞按暴露面分级，不盲目跨 major

**现状**：`npm audit` 报 6 项（3 moderate / 1 high / 2 critical），**全部在 dev 工具链**：`vite 5.4.21`、`vitest 2.1.9`、`esbuild`、`tinypool`、`vite-node`、`@vitest/mocker`。`npm audit fix`（不带 `--force`）实测零效果，所有修复都要求 `vite@8.3.6` / `vitest@5.1.0` 跨 major。

**决策**：不执行 `audit fix --force`。改为按暴露面收敛：
- `vite.config.ts` 的 `server` 与 `preview` 显式绑定 `127.0.0.1`（esbuild dev server 任意站点读响应、Vite optimized deps `.map` 路径穿越都要求攻击者能访问到 dev server）；
- CI 只跑 `npm ci` + 构建 + 服务端冒烟，不启动、不暴露 dev server；
- 不启用 Vitest UI server（任意文件读/执行的前提），`fileParallelism: false` 且不向 worker 传入外部可控 options（tinypool 原型污染 RCE 的前提）；
- 生产 `dist/` 是纯静态资源，不含 Vite dev server 与 Vitest，这 6 项不进入运行时产物。

**理由**：跨 3 个 major 会同时改动 Vite 插件 API、Vitest 配置格式与 TS 构建链，回归面远大于「本机开发服务器被局域网访问」这一实际风险。安全修复应先把暴露面关掉，再择期做有完整回归保障的版本升级，而不是为了把 audit 数字清零引入不可控变更。

**升级条件（单独分支，勿与功能改动混做）**：确认 `@vitejs/plugin-react` / Tailwind / PostCSS 兼容 Vite 8 → 升级 → 回归 `typecheck / test / build / smoke / verify:restart` → 人工核对前端 dev 启动与 HMR → 复核 `npm audit`。每季度或 Vite/Vitest 发布安全补丁时重跑审计。

## ADR-019 · 前端服务层单一入口，业务代码不得直连实现

**现状**：v0.4.0 之前，`useAppStore.ts` / `SettingsView.tsx` / `EmailComposer.tsx` 直接 import `@/services/gateway-client`，`CompanyList.tsx` 直连 `email-generator`，`useAppStore.ts` 直连 `task-runner`。`adapters.ts` 虽定义了 `LLMAdapter` / `DataSourceAdapter` / `GmailAdapter`，但并未成为真正的边界，替换实现要改多个组件。

**决策**：`src/services/adapters.ts` 作为唯一入口，`export *` re-export `gateway-client` / `task-runner` / `email-generator`；组件、store、`App.tsx` 一律只从 `@/services/adapters` 取能力。`scripts/check-release-gates.mjs` 静态扫描 `src/components` / `src/store` / `src/App.tsx`，发现直连具体实现的 import 即在 CI 报错。

**理由**：PRD F0-3 要求「业务代码只依赖接口」。纯靠文档约定会被下一次快速改动破坏，必须做成可执行门禁。re-export 而不是重命名包装，避免引入一层无意义的转发函数与类型漂移。

**后果**：新增服务实现时，必须在 `adapters.ts` 加一行 re-export；CI 同时断言这三个 re-export 存在。`src/services/` 内部仍可互相 import（无循环依赖），边界只约束业务侧。测试文件不在扫描范围内，允许直接测具体实现。

## ADR-020 · 385 家标注契约先落地，标注数据绝不合成

**现状**：`eval.mjs` 的八项指标与 P0 门禁已真实实现，但 `baselineManifest().status` 恒为 `NOT_LABELED`，`evaluateBaseline([])` 返回 `NO_DATA`。研发很容易为了「让 CI 变绿」生成一批合成标注。

**决策**：新增 `shared/baseline-contract.json`（字段、枚举、构成比例、双标独立性、禁用评分字段与 PII）与 `server/baseline.mjs`（json / jsonl / csv 解析 + 导入校验）。`POST /v1/eval/baseline/validate` 只校验不落库、不返回样本；`GET /v1/eval/baseline/contract` 只返回口径。仓库只保留 `scripts/fixtures/invalid-baseline-sample.json`，每条 id 带 `INVALID-FIXTURE` 前缀，专门用来证明校验器会拒绝。`npm run validate:baseline -- --self-test` 与 `npm run gate` 都会断言这个反例被拒。

**硬约束**：导入校验通过 ≠ 评测通过。响应体 `releaseEligible` 恒为 `false`；`manifest.releaseEligible` 同样恒假，直到模型预测与真实人工标注配对跑过 `/v1/eval/run` 且三项 P0 全部达标才允许改。`LEADPILOT_BASELINE_FILE` 只在显式配置时读取，不扫描目录「找」标注集。

**理由**：标注集是外部人力产物，不是代码可生产的。把契约与校验器先做出来，能让 M0 拿到标注数据时立刻可导入，同时把「用假数据凑数」这条路在 CI 里堵死。

## ADR-021 · 点数账本事务化，范围严格限定为云端任务生命周期（v0.5.0；范围已由 ADR-024 扩展）

> **v0.6.0 修订注**：本节描述的「gateway 仅审计估值」边界在 v0.6.0 已被 ADR-024 有意扩展：
> `judge / write_email` 现在也进入同一本账。本节的账务不变量（`available = granted - held - spent`、
> `idem_key` 幂等、`BEGIN IMMEDIATE`、失败不静默）全部保留，仅 `scope` 与 `auditOnlyConsumers`
> 的取值发生变化；阅读时以 ADR-024 和 `shared/model-protocol.json` 的当前值为准。

**现状**：`pointsUsed` 只在 `orchestrator.finish()` 里赋值，创建任务时 `pointsUsed: 0`；前端另有本地 `pointsBalance: 2000` 自行扣减/退还。服务端没有账本，AC-03 只保证任务游标不重复推进，不保证额度不重复冻结。

**决策**：新增 `server/ledger.mjs` 与 `store.mjs` 的 `ledger_accounts` / `ledger_entries` 表。`available = granted - held - spent` 恒等式不允许为负。四类操作全部幂等：`reserve`（创建任务前预扣）、`settle`（完成/中止按达成比例实扣并退还差额）、`release`（未启动全额退还）、`charge`（保留给未来的单次计费）。SQLite 用 `BEGIN IMMEDIATE` 包住每次写，json/memory 用同步单线程写入；`idem_key` 由 UNIQUE 索引 / 内存映射保证唯一，同 key 不同金额返回 `E4002`。预扣不足返回 `402 E4001` 且**不创建任务**，绝不「先跑起来再补扣」。

**范围边界**：账本只覆盖 `task_reserve / task_settle / task_release`。`gateway` 的 `judge` / `write_email` 审计里的 `points` 仍按 `pointCost()` 折算，是**估值**，不进账本：成功响应带 `billing: { charged:false, scope:'audit-only' }`，`/health.billing.auditOnlyConsumers` 与 `/v1/points` 同步说明，`npm run gate` 会断言 `scope` 没被悄悄扩大。把审计估值扩成真实扣费需单独评审（涉及预扣额度上界、provider 失败退款、缓存命中计费口径）。

**理由**：账本一旦被半接入，最难查的不是「少扣了」，而是「界面显示扣了、账本没扣」这类口径漂移。宁可把范围写窄并显式标注，也不做看起来全覆盖的假账。

**后果**：`scripts/verify-restart.mjs` 新增三条断言：预扣已落盘且只有一条 `reserve` 流水、跨进程 `held/available` 不变、续跑后冻结额不变。前端本地 `pointsBalance` 仍是**演示计数器**，只服务本地运行器，与服务端账本不是同一账本，文档中不得混称。

## ADR-022 · T0 → judge 事实链，规则与模型冲突由代码裁决

**现状**：v0.4.0 的 T0 抽取只服务写信锚点；`judge()` 的 `<facts>` 仍是客户端手填的规则特征，`<context>` 依赖 `sourceTexts`（无 URL / 无抓取时间）。T0 与 judge 是两条平行链路，规则事实没有成为模型判断的输入。

**决策**：`POST /v1/judge` 新增可选 `sources`（`{url,text,fetched_at}`）。传入时：
1. `extractFacts()` 先跑规则抽取；非法来源直接 `E6004`，不向任何 provider 发请求；
2. `<context>` 由 `sources` 清洗后的原文构成，保证 T0 的 `quote` 逐字可核验；
3. `buildJudgeMessages()` 注入 `<t0_facts extractor="rules">`，明确要求模型不得与规则事实矛盾、不得把 `no_signal` 维度改写成确定结论；缓存键加 `:t0:<rulesVersion>` 后缀；
4. 模型返回并通过 `validateSchema` + `verifyEvidence` 后，`reconcileWithT0()` 做代码级裁决：冲突取规则值、置信度归零、证据换成 T0 引用，`notes_for_human` 标待复议；`no_signal` 维度被模型改成确定值时回退 `no_signal` / `unknown`；
5. 所有返回路径带 `t0.used` / `t0.ok` / `t0.reconciliation`，降级时不伪造 `reconciliation`。

**边界**：调用方未提供 `sources` 时如实返回 `t0.used=false`。**前端演示数据的 `sourceTexts` 没有真实 URL 与抓取时间，绝不拿来伪造 `sources`**；「云端判断」按钮保持无事实链，设置页明确显示「已接线，但需调用方提供可核验来源」。真实数据源接入后，由采集层产出 `sources` 再打开这条链。

**理由**：PRD 6.7.1 的 T0 是「检索供事实」，不是与 T1 并行的第二套结论。规则层与模型层必须串成一条可追溯链，且冲突处理必须由代码决定（与 6.7.4 的 α 冲突纪律一致），不能让模型自己解释掉矛盾。

## ADR-023 · 并发上限由唯一启动闸门执行，FIFO 用单调序号

**现状（v0.5.0 缺陷）**：`createTask()` 在 `running >= MAX_CONCURRENT` 时把任务标为 `queued` 并 `emit('queued')`，但 `finish() / pause() / resume() / hydrate()` 后没有任何出队逻辑；`queued` 是永久态。同时 `resume()` 直接 `start()`，可绕过并发上限；排队任务在 `createdAt` 就写入 `startedMs`，排队一小时会让首个 tick 立即触发硬超时。

**决策**：
1. `start(task, opts)` 成为**唯一启动闸门**，`createTask / resume / pumpQueue` 全部经过它；`!opts.dequeued && activeCount() >= maxConcurrent` 一律转 `queued` 并返回 `false`，绝不谎报运行。
2. `pumpQueue()` 在 `finish / pause / abort(→finish)` 释放槽位时按 FIFO 补位；出队不重复预扣（预扣在 `createTask` 已完成）。
3. FIFO 用 `nextSeq()` 单调递增序号并持久化到 `serialize()`；**不用 `createdAt` / `id` 排序**——同一毫秒创建的任务 `createdAt` 相同，而 `id` 带随机后缀会打乱先后（该缺陷由新增单测直接抓出）。
4. 硬超时只统计 `elapsedMs + (now - startedMs)` 的累计运行时长；排队与暂停期间 `startedMs = null`，不消耗预算。重启后 `elapsedMs` 从落盘值恢复，原 queued 任务降为 `paused` 且不自动出队（AC-03）。
5. 前端 `hello` 事件改用快照的权威 `status`，新增 `started / queued` 事件处理；`controlCloudTask` 返回服务端 task 状态，`resumeTask` 不再把 `queued` 乐观标成 `running`。

**边界**：`maxConcurrent` 默认 3，可由 `createOrchestrator({ maxConcurrent })` 注入（仅用于确定性测试），`/health.orchestrator` 如实暴露 `running / queued / maxConcurrent / queueMode`。排队期间不产生任何采集进度，也不会写入客户记录。

**理由**：PRD 9.1 的并发上限若只在创建时检查，就是「看起来有限流、实际会卡死」。状态与真实槽位必须始终一致，且 UI 不得比服务端更乐观。

## ADR-024 · 网关调用计费闭环：一次调用一条生命周期，失败不扣点

**现状**：v0.5.0 账本只覆盖云端任务；`judge / write_email` 审计里的 `points` 是 `pointCost()` 折算估值，成功响应固定带 `billing: { charged:false, scope:'audit-only' }`。点数余额与真实模型调用脱节。

**决策**：`createApp()` 把**同一个 ledger 实例**注入 `createGateway({ store, ledger })`。计费流程：
1. 只有 `chainFor()` 确认存在可用 provider 链之后才 `reserveBilling()`；预扣额度按 `billing.gatewayBilling.reservePoints[T0/T1/T2] = 8/16/40`。无 Key / 未锁快照 / 校验拒绝 / 需同意 / 缓存命中一律不预扣，`billing.charged=false` 且带明确 `reason`。
2. 只有内容通过 `validateSchema + verifyEvidence` / `validateEmailDraft` 的成功响应才 `settleBilling()`；`billingPoints()` 对 PRD 公式结果（T1 可能是 1.6 点）向上取整为整数点，响应同时给出 `estimatedPoints` 与 `chargedPoints`，超额按预扣上限封顶并标 `capped=true`。
3. 降级链耗尽、内容被拒、抛异常一律 `releaseBilling()` 全额退还；失败尝试仍留在调用审计。异常路径也用 `try/catch` 包住，避免 `held` 点数永久冻结。
4. `requestId` 作为计费幂等键；已结算/已释放的键显式返回 `E4005`（HTTP 409），而不是靠 `reserve` 的幂等命中再跑一次 provider 并再次宣称「已扣点」。陈旧预扣超时自动回收。预扣不足返回 `E4001`（HTTP 402），且不发起任何外部请求。
5. 未注入 ledger 的独立网关（部分单测）保持 `billing.scope='audit-only'`，`gateway.health().billingMode` 如实暴露。

**边界**：`pointCost()` 保留原始小数折算作为审计估值；账本只收整数点。`byokChargesPoints=false` 但 BYOK 通道尚未接入，文档不得提前宣称支持。这是**本地测试账本**，不是支付结算系统；`releaseEligible` 与发布门禁不受计费改动影响。

**理由**：把「审计估值」升级成「真实扣点」会立刻暴露一堆边界（失败算不算钱、缓存算不算钱、重试算不算钱、小数点数怎么记）。先把这些口径写死并做成可执行断言，再谈对外计费。

## ADR-025 · 评测版本 diff 用纯函数实现，删掉「需在 CI 中生成」占位说明

**现状**：`evaluateBaseline()` 返回的 `diff` 是字符串——要么「未提供基线版本号」，要么「需在 CI 中读取历史评测归档后生成」。这是一句永远不会被执行的计划，容易被误读成「已有 diff 能力」。

**决策**：新增纯函数 `diffEvalRuns(prev, current)`（无 IO / 无时间 / 无随机 / 不改输入）与 `POST /v1/eval/diff`。逐指标比较 8 项 Eval，给出 `prevValue / currentValue / delta / prevPassed / currentPassed / measurementLost / thresholdCrossed / regression / improvement`；P0 数值下降、跨阈值转失败、已测量变未测量、上一版 `PASSED` 而本次非 `PASSED` 一律判回退。非法归档 → `400 E4006`；任一归档 `NO_DATA` → `NO_BASELINE`，`delta` 全为 `null`，不宣称「无回退」。`evaluateBaseline()` 改为返回可执行的 `diffEndpoint / diffVersion / diffNote`，源码里不得再出现「需在 CI」字符串（`npm run gate` 静态断言）。

**边界**：仓库**不内嵌任何历史评测归档**，diff 只消费调用方显式提交的两份归档；测试里构造的 archive 是纯函数输入夹具，不是 385 家人工标注集。`diffPassed=true` **不等于可发布**，`releaseEligible` 恒 `false`——标注集、双标独立、数据源沙箱与合规项是 diff 无法证明的。

**理由**：占位字符串是「文档债」里最危险的一种：它让看代码的人以为能力已在路线图上落地。宁可返回 `NO_BASELINE`，也不要一句无法执行的承诺。

## ADR-026 · CI action 升级与干净检出清单补全

**决策**：`actions/checkout@v4 → v5`、`actions/setup-node@v4 → v5`，消除 Node 20 弃用提示；`node-version: '22'` 保持不变，与 `node:sqlite` 持久化基线一致。干净检出清单补入此前漏列的 `server/gateway.mjs` / `server/orchestrator.mjs` / `src/store/useAppStore.ts` / `src/types/index.ts` 与两个关键视图组件——v0.3.0 的 `data/` 教训说明「本地全绿」不等于「仓库可构建」，清单必须覆盖所有会被 import 的关键源码。

**边界**：`ubuntu-latest` 的镜像迁移属于 GitHub 平台侧，不锁定镜像版本；依赖漏洞分级维持 ADR-018 结论，不在本轮跨 major 升级 Vite / Vitest。

---

## 性能目标对照（PRD 8.1）

| 指标 | PRD 目标 | 基线状态 |
|---|---|---|
| 首屏可交互 | ≤ 3 s | ✅ 本地构建 300 KB JS / gzip 100 KB，冷启动远低于 3 s |
| 列表筛选响应 | ≤ 150 ms | ✅ 内存过滤 + 排序，48–168 行实测无感 |
| 详情抽屉打开 | ≤ 300 ms | ✅ 本地数据直读，不含网络 |
| 1,000 行渲染 ≤ 200 ms | 目标 | ⚠️ 未压测（演示数据上限 168 家），需 TanStack Virtual 后复测 |
| 首条结果 ≤ 40 s / 全量 ≤ 12 min | 目标 | ❌ 依赖云端采集，Mock 运行器约 5 s 完成，不代表真实性能 |
| 内存 ≤ 500 MB / 安装包 ≤ 60 MB | 目标 | ❌ 依赖 Tauri 外壳，未评估 |

## 安全边界

- 本基线**不保存任何 API Key / token / 凭据**；设置页的 BYOK 只是开关，不落密钥。服务端 Key 只从 `process.env` 读取，不写日志、不回传前端、不进审计记录。`.env.example` 只有空值样板，`.gitignore` 排除 `.env` / `data/` / `*.db` / `.workbuddy/`。
- `mockLlmAdapter.healthCheck()` 返回 `ok: false`；真实网关不可达时 `probeGateway()` 返回 `offline`，顶栏 / 侧栏明确显示，任何依赖它的代码都会走降级分支。
- 调用审计只记元数据（provider / 模型 / 快照版本 / token 数 / 点数 / 延迟 / 是否降级 / `piiRemoved`），**绝不记 prompt、官网原文、客户邮箱或发件人身份**；冒烟脚本会断言审计条目里没有 `prompt` 字段。审计本身落在持久化 store，但内容仍只有元数据。
- HTTP 层：Bearer 鉴权 / CORS 白名单 / 每分钟限流 / 256 KB 请求体上限 / 启动前置安全校验，见 ADR-015。
- 模型层：结构化字段命中 PII 直接 400 `E6004`；官网自由文本先 `sanitizeContext` 清洗再发模型（ADR-011）；浮动模型指针拒绝调用（ADR-014）。
- 所有演示公司带 `demo: true` 标记；界面常驻演示黄条，无关闭入口。
- 日志、CSV 导出、Toast 均不输出本地绝对路径或内部 ID；服务端错误文案用统一模板，不回显堆栈。
