# LeadPilot 技术架构与决策记录（ADR）

> 对应 PRD v1.1 第 9 章 · 基线版本 v0.3.0 · 2026-11-07（ADR-013–015 为本次新增）

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

**后果**：所有模型结果以「已验证的离散枚举」形式从外部传入 `buildScoreCard(features, judgement, options)`；引擎本身不知道模型存在。前端 32 个测试里没有任何 mock server；服务端 35 个测试才负责验证网关、编排器、安全边界与持久化。

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

`vite.config.ts` 设 `fileParallelism: false`，`cacheDir` 指向项目内。原因：当前 Windows 会话的 fs 代理不允许多个 Vitest worker 并发写 SSR 转换缓存（报 EPERM，且会随机漏跑一个测试文件）。改为顺序执行后 6 个文件 / 67 个测试稳定全绿、0 skipped。这是环境适配，不是产品约束；CI 环境可去掉。

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
