# LeadPilot 猎客 · B2B 外贸客户开发工作台

基于资料库 PRD《PRD-LeadPilot-B2B外贸客户开发工作台-v1.1》实现的**可运行基线 v0.9.0**：客户端完整主链路 + 真实服务端 LLM 网关 / 采集编排骨架 + 安全边界 / 模型快照锁定 / 持久化（AC-03 闭环）+ T0 规则事实抽取 / 数据源注册表 + 点数账本事务化 / T0 → judge 事实链 + 发布门禁自检 + 并发队列 / 网关计费闭环 / 评测版本 diff + **批量 SDR 管道（批量导入 → 批量研判 → 批量出信 → 导出草稿与结果回写）** + **integrity + outcome 零人工评测口径** + **用户指定 URL 抓取（robots / 限速 / SSRF 防护）**。

一句话：`输入卖什么、卖给谁，10 分钟拿到一份能直接发信的客户名单`。本仓库把「评分可信度」这条产品假设做成了可运行、可单测、可审计的代码；**不含商业数据源采购（决策不做）、Google OAuth 验证与桌面安装包**。

> **v0.8.0 决策（用户拍板）**：**不做 385 家人工标注基准集、不做商业数据源采购**。评测口径改为 **integrity + outcome**（可溯源 / 合规 / 一致性 + 真实退信率，零人工）：`accuracyClaim` 恒 `false`，没有人工真值就**永久不宣称准确率**。标注契约降级为 legacy 通道（格式与校验器保留）；6 类商业数据源继续如实报 `0/6`，改为用户投喂 + 用户指定抓取。`internalPreviewReady` / `externalValidated` / `releaseEligible` 三状态分离，正式发布仍需 provider 快照 / OAuth / EV 签名 / 法务意见。

> **v0.9.0 抓取落地（ADR-032）**：`server/fetch.mjs` 实现「用户指定 URL 抓取」——只抓调用方显式给出的 URL，robots.txt 遵从、每域 ≤1 req/s、8s 超时、≤512KB、正文 ≤2 万字符、只收 HTML/纯文本、**拒绝回环 / 私网 / link-local 地址（含 DNS 解析到私网）**。抓到的原文经 PII 清洗后进入 T0 → judge，来源标 `user_directed_fetch`，公司 `origin` 仍是 `user_imported`。**抓取 ≠ 采集**：商业 6 类源仍 `0/6`，抓取单独计数；失败逐条 `missing_source`，不编造原文。

> **v0.7.0 定位决策（用户拍板）**：产品定位仍是**「自动获客」**，目标用户是**批量 SDR**，不改为「研判提效」。批量 CSV 导入是这类用户既有的线索投喂通道（展会名录 / 海关导出 / CRM 存量），不是形态降级；四项外部依赖从「阻塞研发」重分类为**「发布门禁」**——内测可跑，但不能正式发布、不能对外宣称指标。`releaseEligible` 恒 `false`，Go / No-Go 四条判据一条未撤。

## 快速开始

需要两个进程（Node 22，零额外服务端依赖）：

```bash
npm install

# 终端 A · 云端网关 + 任务编排器（127.0.0.1:5181）
npm run cloud

# 终端 B · 前端（127.0.0.1:5180，dev server 仅绑定回环）
npm run dev
```

```bash
npm run typecheck       # TS strict（noUnusedLocals / noUnusedParameters）
npm test                # 146 个单元测试（7 文件，前端 32 + 服务端 114）
npm run gate            # 发布门禁自检 54 项（含零人工评测口径 / 禁止准确率宣称 / 导入≠采集 / 导出≠发送 / 熔断）
npm run validate:baseline -- --self-test   # 标注导入校验器反例自检（legacy 通道）
npm run build           # 类型检查 + 生产构建
npm run smoke           # 云端端到端冒烟 48 项（需先启动 npm run cloud）
npm run verify:restart  # AC-03 真实杀进程 → 重启 → 断点续跑（独立端口 5193）
```

`VITE_LEADPILOT_API` 覆盖前端网关地址；`LEADPILOT_PORT` / `LEADPILOT_HOST` 控制服务端监听。完整环境变量样板见 `.env.example`（**不含任何真实 Key**）。

## 先读这句

> **演示数据不是真实采集结果，批量导入也不是采集，用户指定抓取也不是系统采集，mbox 导出更不是发送，E6005 降级不是成功，未锁快照不是可调用，0/6 数据源不是「已接入」，审计里的 points 不是已扣点（只有 `billing.charged=true` 才是），导入校验通过不等于评测通过，diff 通过不等于可发布，integrity 通过不等于判得准，outcome 达标不等于可发布，内测可跑不等于可正式发布。**
> 六个数据源适配器、Gmail OAuth 与 Tauri 外壳均未接入；客户记录全部带 `demo: true`，界面常驻黄条。
> 未配置 API Key → `503 E6005`；只配了 Key 但没锁 `model_version` → `E6008`；两者都满足才发起真实 provider 调用。
> **抓取 ≠ 采集**：`/v1/sources/fetch` 只抓你显式给出的 URL（robots 遵从 / 每域限速 / 拒绝私网），原文标 `user_directed_fetch`；商业 6 类源仍 `0/6`，抓取单独计数。
> **v0.8.0 决策不做人工标注集，因此没有准确率可宣称**：`accuracyClaim` 恒 `false`，任何以人工真值为前提的指标（准确率 / Kappa / AUC）不得出现在产品文案里，门禁会静态扫描。
> 任何降级路径都**不返回一段看起来像模型写的假正文**，分数改区间显示并标注「未经模型校验」。这是对 PRD 6.7「不能假知道」的工程落实。

| 层 | 状态 | 说明 |
|---|---|---|
| 五维评分引擎（6.7） | ✅ 真实实现 | 规则层确定性计算 → 模型离散枚举 → 证据校验 → 代码合成；权重再归一化、α 上限、冲突保守、疑似同行、置信度区间 |
| 12 态状态机（F8） | ✅ 真实实现 | 自动流转白名单、不可逆保护、批量二次确认、全量留痕、Ctrl+Z 撤销 5 步 |
| 合规红线（11.2 / F6-2 / F7-2） | ✅ 真实实现 | 禁词/字数/占位符/退订尾巴校验、四道发送闸门、批量直接发送硬禁用、请求体数据最小化 |
| 共享模型协议（6.7.3） | ✅ 真实实现 | `shared/model-protocol.json` 为前端 / 网关 / 评测 / T0 抽取 / 账本单一真源 |
| 云端 LLM 网关（F0） | ✅ 服务端真实实现 | 三级路由、超时/429/5xx 降级链、schema + 证据校验、30 天缓存、熔断、点数折算、调用审计、数据出境策略、PII 硬性剔除、**模型快照锁定** |
| 云端任务编排（9.1 / F2） | ✅ 服务端真实实现 | 6 阶段状态机、SSE 单向推流、任务游标、暂停/继续/中止、硬超时、单源失败显式降级、**跨进程恢复（AC-03）** |
| **并发队列（v0.6.0）** | ✅ 真实实现 | 并发上限 3 由唯一 `start()` 闸门强制执行，`queued` 按单调序号 FIFO 自动出队；完成/暂停/中止/重启释放槽位即补位；排队与暂停时长不计入硬超时；前端用服务端权威状态，不把排队谎报成运行中 |
| **点数账本（F0-6 / AC-03）** | ✅ 真实实现 | `server/ledger.mjs` + `store.mjs` 的账户表 / 流水表：创建预扣 → 完成/中止结算（多退少不补）→ 未启动全额释放；`idem_key` 唯一约束保证幂等；SQLite `BEGIN IMMEDIATE` 事务；跨进程不重复扣 |
| **网关调用计费闭环（v0.6.0）** | ✅ 真实实现 | `judge / write_email` 有可用 provider 才预扣、内容校验通过才按 token 折算结算整数点，失败/降级/缓存命中/校验拒绝一律全额释放；`requestId` 防重复计费；未注入账本的独立网关仍如实标 `audit-only` |
| **T0 → judge 事实链（6.7.1 / 6.7.4）** | ✅ 真实实现 | 调用方提供可核验 `sources` 时，T0 规则事实注入 judge Prompt；冲突由代码保守取规则值、置信度归零、证据换 T0 引用并留痕；`no_signal` 维度模型不得改写成确定结论。未提供来源时如实返回 `t0.used=false` |
| **标注契约（9.5 · v0.8.0 降级 legacy）** | ✅ 契约与校验器保留 | `shared/baseline-contract.json` + `server/baseline.mjs`：字段、构成、双标独立性、PII、禁用评分字段全部校验；**不生产任何标注数据**。v0.8.0 决策后标 `status=legacy` / `enabled=false`，不参与当前判定；将来真导入人工标注可直接复用 |
| **评测口径 integrity + outcome（v0.8.0）** | ✅ 纯函数真实实现 | `server/eval.mjs`：`evaluateIntegrity()`（可溯源率 / 规则遵从 / schema / 证据逐字核验，`minSamples=100`）、`evaluateOutcome()`（真实发送硬退信率 ≤3%，`minSamples=30`）、`evaluateConsistency()`（跨运行一致率）、`releaseStatus()`（`internalPreviewReady` / `externalValidated` / `releaseEligible` 三分离）；无真实样本一律 `NO_DATA`，`accuracyClaim` 恒 `false` |
| T0 事实抽取（6.7.1 / F6-1） | ✅ 规则层真实实现 | `server/t0.mjs`：客户类型 / 进口信号 / 规模 / 产品词 / 负面信号 / 开发信锚点；每条 `quote` 逐字可核验；未命中维度 `no_signal` 不补零；不调模型、不联网、不推断 |
| 数据源适配器注册表（9.3） | ✅ 契约真实实现 | 6 类源注册 + 逐源健康；`0/6 已接入` 如实上报；无实现 → `sourceMode=demo` 占位，**即便注入实现也返回 `blocked` 并暂停任务** |
| 服务端安全边界 | ✅ 真实实现 | 本地回环默认免鉴权；设 `LEADPILOT_API_TOKEN` 或非本机监听时强制 Bearer（401 E6009）；CORS 白名单；限流（429 E6010）；不安全组合拒绝启动 |
| 持久化（8.2 / AC-03） | ✅ 真实实现 | `sqlite`（Node 22 内置，WAL）/ `json`（原子 rename）/ `memory`；任务游标、缓存、审计、**账本账户与流水**跨进程恢复 |
| 评测门禁（9.5） | ✅ 服务端真实实现 | 8 项 Eval 计算、P0 门禁、`NO_DATA` 保护；legacy 标注导入路径保留；当前口径为 integrity + outcome |
| **评测版本 diff（v0.6.0）** | ✅ 纯函数真实实现 | `diffEvalRuns(prev, current)` 逐指标算 delta、判 P0 回退 / 跨阈值 / 测量丢失 / 门禁回退；`POST /v1/eval/diff` 可用；无基线返回 `NO_BASELINE` 不伪造 delta；`releaseEligible` 恒 `false` |
| **批量 SDR 管道（v0.7.0）** | ✅ 内测可用 | `server/batch.mjs`：CSV / JSON 批量导入（域名规范化去重、逐行错误聚合、`origin=user_imported`、PII 登记并在发模型前剥离）→ T0 + 真实 `judge()` 批量研判（`succeeded/degraded/failed` 分桶）→ mbox 草稿导出（D 级禁发 / C 级逐条确认 / 合规尾巴校验 / 100 封日限）→ 发送结果回写（自动流转白名单 + 不可逆终态 + 退信率 3% 熔断）；`companies` / `outcomes` 落 sqlite / json |
| **用户指定 URL 抓取（v0.9.0）** | ✅ 真实实现 | `server/fetch.mjs`：只抓调用方显式指定的 URL；robots.txt 遵从（Disallow → `E4013`）、每域 ≤1 req/s、8s 超时、≤512KB、正文 ≤2 万字符、只收 HTML/纯文本、重定向上限 3 且逐跳重做 SSRF 校验；**拒绝回环 / 私网 / link-local（含 DNS 解析到私网）→ `E4011` 且不发起请求**；HTML→纯文本 + PII 清洗 + `sha256`；来源标 `user_directed_fetch`，公司 `origin` 仍 `user_imported`；失败逐条 `missing_source` |
| 前端服务层边界 | ✅ 真实实现 | `src/services/adapters.ts` 为唯一入口，re-export `gateway-client` / `task-runner` / `email-generator`；`npm run gate` 强制校验组件与 store 不得直连实现 |
| 前端接入与降级 | ✅ 真实实现 | 启动探测、云端网关状态、详情云端判断、写信真实 T1 / 本地模板显式切换、设置页展示账本 / T0 链 / 基准契约、SSE 带 Bearer、执行页逐源「未接入」 |
| 真实 provider 调用 | 🟡 配置即用 | Key 从服务端环境变量读取，**且必须锁定 `LEADPILOT_MODEL_VERSION_*` 快照**；本仓库不内置 Key、不预置猜测版本号 |
| 采集数据源 / Gmail / Tauri+DPAPI/EV 签名 | ❌ 未接入 | 接口已抽象，见 `docs/ARCHITECTURE.md` ADR-017 |

## 云端 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 服务 / 网关 / 安全 / 持久化 / `points` 账本 / `billing` 范围 / `baseline` 导入状态 / `t0.judgeFactChain` / 数据源 |
| GET | `/v1/gateway/health` | provider 清单（`pinned` / `modelVersion`）、熔断、缓存、审计、账本、基准契约、T0 事实链、数据源 |
| GET | `/v1/gateway/audit` | 调用审计（只记元数据）+ 熔断状态 + 缓存统计 |
| **GET** | **`/v1/points`** | **账本只读**：余额 / 冻结 / 已结算 / 流水；`?refId=` 过滤单个任务流水。无充值写接口 |
| **POST** | **`/v1/t0/extract`** | T0 规则事实抽取；非法来源或 PII → 400 `E6004` |
| **GET** | **`/v1/eval/baseline/contract`** | legacy 标注导入契约（只返回口径，不返回样本；v0.8.0 起不参与判定） |
| **POST** | **`/v1/eval/baseline/validate`** | 校验 legacy 导入数据；不合规 → 400 `E4004`；`releaseEligible` 恒 `false` |
| GET | `/v1/eval/gates` | 评测门禁清单：legacy 标注契约 + `integrityGate` / `outcomeGate` / `release`（`accuracyClaim=false`） |
| POST | `/v1/eval/run` | 跑 legacy 基准集；无样本返回 `NO_DATA` |
| **GET** | **`/v1/eval/integrity/gates`** | integrity 门禁契约（`integrity-gate-v1`：零标注、`accuracyClaim=false`） |
| **GET** | **`/v1/eval/outcome/gates`** | outcome 门禁契约（`outcome-gate-v1`：真实退信率，`minSamples=30`） |
| **POST** | **`/v1/eval/integrity`** | 完整性门禁：入参 `records`（provenance / rules / schemaPass / quote+sourceText）+ 可选 `consistency`；无真实证据返回 `NO_DATA` |
| **POST** | **`/v1/eval/outcome`** | 业务结果门禁：入参 `events`（`sent/bounced/replied`）；无样本 `NO_DATA`，样本不足 `INSUFFICIENT`；不生成任何准确率断言 |
| **POST** | **`/v1/eval/diff`** | **两次评测归档的版本 diff**（纯函数）；非法归档 400 `E4006`；`NO_DATA` 归档返回 `NO_BASELINE`，不生成数值 delta |
| POST | `/v1/judge` | 五维判断；可传 `sources` 启用 T0 事实链（响应带 `t0.used` / `reconciliation`）、`requestId` 启用计费幂等；无 Key → `503 E6005`，未锁快照 → `E6008`，点数不足 → `402 E4001`，重复 requestId → `409 E4005`；成功响应带 `billing` |
| POST | `/v1/email/generate` | T1 写信；可传 `sources` 走 T0 锚点、`requestId` 启用计费幂等；降级时正文为 `null`；成功响应带 `billing` |
| GET/POST | `/v1/tasks` | 创建 / 列出任务；**预扣不足返回 402 `E4001` 且不创建任务**；快照带 `ledger` / `queuePosition` / `activeCount` / `maxConcurrent` / `sourceMode` / `dataSources` |
| GET | `/v1/tasks/:id/events` | SSE 流式事件（`hello/queued/started/stage/progress/source_warning/paused/resumed/done/aborted`） |
| POST | `/v1/tasks/:id/pause\|resume\|abort` | 任务控制；收尾时账本结算/释放并写进任务日志 |
| **GET** | **`/v1/batch/health`** | 批量管道状态：定位 / 阶段 / 客户数 / 已研判 / 今日导出 / 退信率 / 熔断，`releaseEligible` 恒 `false` |
| **GET/POST** | **`/v1/import/companies`** | 只读清单 / 批量导入（`{csv}` 或 `{rows}`）；逐行 `accepted/rejected/duplicates`；伪称 `system_collected` 的行直接拒绝；无可接受行 → 400 `E4007` |
| **POST** | **`/v1/batch/judge`** | 批量研判（`batchSize` ≤ 50 / 可指定 `domains`）；T0 规则事实 + 真实 `judge()`；未配 Key 如实 `E6005` 并计入 `degraded`，**不写回 judgement** |
| **POST** | **`/v1/export/eml`** | 批量草稿导出为 mbox；`exportedIsNotSent=true`、状态 `drafted`；D 级禁发 / C 级需确认 / 尾巴缺失 / 超额 → 400 `E4009`；熔断中 → 423 `E4010` |
| **POST** | **`/v1/import/outcomes`** | 发送结果回写；仅 `sent/bounced/replied` 自动流转，`unsubscribed/invalid` 需逐条确认且不可逆；退信率 > 3% 触发熔断 |
| **GET** | **`/v1/sources/health`** | 用户指定抓取器健康：`user-directed-fetch-v1`、robots / 限速 / SSRF 策略、单进程抓取计数；**单独计数，不并入商业数据源 0/6** |
| **POST** | **`/v1/sources/fetch`** | 临时抓取（`{urls:[]}`，单次 ≤10）：逐条返回 `fetched/failed`；私网/回环 → `E4011`、robots 禁止 → `E4013`、超时/内容类型 → `E4012`；不写库、不发现 URL |
| **POST** | **`/v1/batch/fetch-sources`** | 为已导入且缺原文的公司抓取官网（`{domains?,limit?}`，≤50）：成功写回 `rawText/sourceUrl/fetchedAt` 并标 `sourceOrigin=user_directed_fetch`，公司 `origin` 仍 `user_imported`；无候选 → 400 `E4008` |

`/health` 为探活保留无鉴权；其余 `/v1/*` 在启用 token 或对外监听时一律要求 `Authorization: Bearer <token>`。因为 `EventSource` 不能带 Authorization，前端改用 `fetch` 流式读取 SSE 帧，**绝不把 token 拼进 query**。

错误文案统一「发生了什么 + 可能原因 + 你可以怎么做 + 错误码」（PRD A.2）。错误码：`E6004` PII / 非法来源、`E6005` 无可用 provider、`E6008` 快照未锁定、`E6009` 鉴权失败、`E6010` 限流、`E4001` 点数不足、`E4002` 账本幂等键冲突、`E4003` 账本状态非法、`E4004` 标注导入不合规、`E4005` 网关计费键已结算、`E4006` 评测 diff 归档非法、`E4007` 批量导入校验失败、`E4008` 批量研判输入非法、`E4009` 草稿导出被合规闸门拒绝、`E4010` 结果回写非法或熔断中。

> **批量管道口径（v0.7.0）**：`POST /v1/import/companies` 接收的每一行都标 `origin=user_imported`，**导入 ≠ 采集**；联系人邮箱/姓名允许本地持久化，但登记 `piiFields` 并在发往模型前剥离（`assertNoPii` 是硬闸门）。`POST /v1/export/eml` 只生成 mbox 草稿文件，**导出 ≠ 发送**，不调用任何邮件 API、不自动置 `sent`；合规尾巴（真实身份 / 物理地址 / 退订）由调用方在本地注入，服务端只校验存在性。退信率窗口取最近 100 条 `sent/bounced` 事件，样本为 0 时 `rate=null` 而非伪造 0%。

> **点数口径（v0.6.0）**：云端任务与网关真实调用**共用一本账**。有可用 provider 才预扣（T0/T1/T2 上限 8/16/40 点，见 `billing.gatewayBilling.reservePoints`），内容校验通过才按 token 折算 `ceil` 成整数点结算；失败 / 降级 / 缓存命中 / 校验拒绝一律全额释放，**不扣点**。审计里的 `points` 仍是 token 折算估值，只有 `billing.charged=true` 才代表实际扣点。未注入账本的独立网关（部分单测）仍如实标 `billing.scope='audit-only'`。这是本地测试账本，不是真实支付结算系统。

## 配置要点

```bash
# 仅本机开发：默认 local-open，无需 token
LEADPILOT_HOST=127.0.0.1
LEADPILOT_STORE=sqlite           # 默认；node:sqlite 不可用时自动降级为 json 文件兜底
LEADPILOT_DB_PATH=./data/leadpilot.db
LEADPILOT_POINTS_BALANCE=2000    # 开户初始点数（v0.6.0：任务 + 网关共用）

# 对外部署：以下两项必须同时配置，否则服务拒绝启动
LEADPILOT_HOST=0.0.0.0
LEADPILOT_API_TOKEN=<强随机令牌>
LEADPILOT_CORS=https://your-frontend.example.com
VITE_LEADPILOT_TOKEN=<同上>      # 浏览器端 token 会暴露，生产应改为同源反向代理注入

# 真实模型调用 = Key + 具体快照，二者缺一不可
DEEPSEEK_API_KEY=<key>
LEADPILOT_MODEL_VERSION_DEEPSEEK_PRO=deepseek-chat-<具体快照ID>

# legacy：仅当将来真导入人工标注时设置；v0.8.0 决策不要求标注，仓库不提供也不生成
# LEADPILOT_BASELINE_FILE=./data/baseline-legacy.jsonl
```

> **模型快照纪律**：`shared/model-protocol.json` 的 `rules.requirePinnedModelVersion = true`。含 `-latest` 的浮动指针一律判未锁定，`/v1/gateway/health` 里 `pinned=false`，且不进入降级链。基线不预置任何猜测版本号——版本号必须由运维从 provider 官网查得后注入。

## 目录

```
shared/
├── model-protocol.json        前后端 + 评测 + T0 + 账本共享单一真源（含 integrity / outcome / releasePolicy）
└── baseline-contract.json     legacy 标注导入契约（只定义口径，不含样本，不参与当前判定）
.github/workflows/ci.yml       GitHub Actions：干净检出 / typecheck / gate / 校验器自检 / test / build / smoke / AC-03
server/
├── protocol.mjs       schema / 证据 / PII / 计费 / 缓存键 / Prompt（含 <t0_facts>）/ wire→client
├── gateway.mjs        三级路由 · 降级链 · 熔断 · 审计 · 计费 reserve/settle/release · judge() / writeEmail()
├── orchestrator.mjs   任务状态机 · SSE · 游标 · FIFO 并发闸门/硬超时 · 账本预扣与结算 · 重启恢复
├── store.mjs          sqlite / json / memory：任务 / 缓存 / 审计 / 账本 / companies / outcomes
├── ledger.mjs         点数账本：reserve / settle / release / charge / grant，事务化 + 幂等
├── batch.mjs          批量 SDR 管道：CSV 解析 / 域名去重 / T0+judge 批处理 / mbox 导出 / 结果回写与熔断
├── fetch.mjs          用户指定 URL 抓取：robots / 每域限速 / SSRF 防护 / HTML→文本 / PII 清洗 / 内容哈希
├── baseline.mjs       标注契约解析（json/jsonl/csv）与导入校验器
├── t0.mjs             T0 规则抽取 + reconcileWithT0 冲突裁决
├── data-sources.mjs   6 类数据源注册表 · health · 显式 demo/blocked
├── eval.mjs           integrity / outcome / consistency / releaseStatus 纯函数 + 8 项评测指标、legacy 基准集 manifest、diffEvalRuns()
├── index.mjs          Node 原生 http 入口：鉴权 / CORS / 限流 / 路由
└── tests/             114 个服务端测试
scripts/
├── e2e-smoke.mjs              云端端到端冒烟（48 项）
├── check-release-gates.mjs    发布门禁自检（54 项，含零人工评测口径 / 禁止准确率宣称 / 白名单一致性 / 熔断）
├── validate-baseline.mjs      标注导入校验 CLI（支持 --self-test）
├── fixtures/                  仅 INVALID-FIXTURE 反例，禁止作为评测输入
├── verify-restart.mjs         AC-03 断言（HTTP + SQLite 原文 + 账本流水比对）
└── verify-restart.sh          进程编排：启动 → 强杀 → 同库重启 → 续跑
src/
├── domain/            纯函数领域层（无 React、无 IO）—— 改这里要写测试
├── services/
│   ├── adapters.ts          唯一入口：适配器接口 + 路由 + re-export 三个实现
│   ├── gateway-client.ts    网关探测 / 判断 / T0 / T1 写信 / SSE / 任务控制 / 审计 / 批量管道客户端
│   ├── task-runner.ts       本地演示运行器
│   └── email-generator.ts   本地确定性模板 + 可核验个性化锚点
├── store/             Zustand 单一状态源（本地/云端运行器切换）
├── components/        四大页面 · 详情抽屉 · 开发信编辑器 · 批量 SDR 管道面板
└── tests/             32 个前端测试
docs/
├── PM-REVIEW.md       产品评审、范围裁剪、M0 决策建议
├── ARCHITECTURE.md    技术决策（ADR-001–032）与真实接入清单
└── PRD-COVERAGE.md    F0–F10 / AC-01–16 兑现度对照
```

## 设计纪律（改代码前先读）

1. **模型不打分。** 受限输出协议出现 `score / total_score / rating / points` 整条作废；分数只由 `scoring.ts` 计算。
2. **证据必须可核验。** 引用无法在 `<context>` 原文中模糊匹配（命中率 < 90%）→ 字段整条丢弃并回退规则分；可溯源率 < 95% 阻断发布。T0 抽取更严格：`quote` 必须是原文连续子串。
3. **冲突不平均。** `|rule − model| > 30` 保守取规则值；T0 规则事实与模型判断冲突同样由代码保守裁决、置信度归零并标待复议，绝不静默覆盖。
4. **缺失不补零。** 维度无数据 → 权重再归一化，UI 标注「基于 4/5 维」；`no_signal` 不等于「确认没进口」。
5. **合规写进代码。** 真实身份 / 物理地址 / 退订尾巴由客户端注入，模型与服务端都不接触；批量直接发送硬禁用。
6. **不确定性显式化。** 网关不可用时分数变区间、置信度降级、界面写「未经模型校验」；写信回退本地模板时明确标注 DEMO。
7. **真实编排 ≠ 真实采集。** 云端 SSE 事件是真的，但数据源未接入时不写入任何客户记录。
8. **持久化与账本如实上报。** `memory` 不得说成「已持久化」；重启后活跃任务降为 `paused`、游标与冻结额保留，续跑不重复扣点（AC-03）。
9. **禁止浮动模型指针。** 无具体快照不发起真实调用；评审无数据用 `NO_DATA`，不编造通过。
10. **可插拔不等于可放行。** 注册表有 ready 实现也只是 `blocked`（ADR-017）。
11. **忽略本地产物一律锚定根目录。** `.gitignore` 写 `data/` 会连源码 `src/data/` 一起排除（ADR-008 教训）。
12. **账本范围必须显式登记。** `billing.ledger.scope` 明列 6 类操作（任务 + 网关各 reserve/settle/release）；`points` 是审计估值，只有 `billing.charged=true` 才是实际扣点；未注入账本时不得宣称已扣点，门禁脚本会断言。
13. **标注数据不可合成，也不强求。** v0.8.0 决策不做人工标注：契约降级 legacy，仓库只允许 `INVALID-FIXTURE` 反例；没有真实样本就返回 `NO_DATA`，任何人不得用合成样本凑通过。
14. **业务层不得直连服务实现。** 组件 / store / App 只从 `@/services/adapters` 取能力，由 `npm run gate` 在 CI 中强制校验（ADR-019）。
15. **排队状态以服务端为准。** 禁止把 `queued` 乐观标成 `running`；FIFO 用单调序号，不得用带随机后缀的 `id` 排先后（ADR-023）。
16. **失败调用不扣点，且不留下冻结额。** 任何异常 / 降级 / 内容拒绝路径都必须 `release`；`requestId` 已结算必须显式拒绝而不是幂等重放（ADR-024）。
17. **diff 只比较真实归档。** 无历史归档就返回 `NO_BASELINE`，不生成数值 delta、不写「需在 CI 中生成」占位说明（ADR-025）。
18. **定位不因分批交付而漂移。** 批量导入是线索投喂通道，不是「研判提效」形态降级；`origin` 只能是 `user_imported`，出现 `system_collected` / `auto_collected` 一律拒行（ADR-027）。
19. **导入 ≠ 采集，导出 ≠ 发送。** 未接数据源就如实 `0/6`；导出只产 mbox 草稿，状态停在 `drafted`，禁止批量直接发送；identity footer 由调用方注入，服务端不代生成、不落库（ADR-028）。
20. **降级不进成功桶。** 批量研判中 T0 规则事实可以交付，但 `E6005` / `E6008` 一律 `degraded`，不写回 `judgement`；退信样本为 0 时 `rate=null`，不伪造 0%（ADR-029）。
21. **没有标注就没有准确率。** v0.8.0 决策不做 385 人工标注集，`accuracyClaim` 恒 `false`；产品文案不得出现准确率数字断言，由 `npm run gate` 静态扫描 `src/` 与 README（ADR-031）。
22. **不做采购不伪造来源。** 商业数据源保持 `0/6`；用户投喂 `origin=user_imported`、用户指定抓取标 `user_directed_fetch`，任何路径都不得写成系统采集（ADR-032）。
23. **抓取只抓用户给的 URL。** 不发现、不爬全站、不猜地址；robots 遵从、每域限速、拒绝私网 / 回环（含 DNS 解析到私网）、失败逐条 `missing_source`、不编造原文（ADR-032）。

## 验证记录（2026-11-09 · v0.9.0）

- `npm run typecheck` / `npm run build` 通过；`npm test` → **7 文件 / 146 用例全绿，0 skipped**（前端 32 + 服务端 114）。版本号从 `package.json` 读取，不再硬编码。
- `npm run gate` → **54/54 自检通过**：在 v0.8.0 的 48 项基础上新增 6 项抓取断言——抓取契约（只抓用户指定 URL / robots / 限速 / 拒绝私网）、SSRF 命中不发起任何请求、robots 命中 Disallow → `E4013` 且目标页不被抓取、批量抓取 `origin=user_directed_fetch`、批量管道写入后公司 `origin` 仍 `user_imported`、ADR-032 文档口径在场。
- `npm run gate` 输出 `releaseBlocked = true`（`releaseEligible=false`、`accuracyClaim=false`），阻断项为 integrity / outcome 无真实样本、抓取器尚无真实站点样本、provider 快照未注入、OAuth·EV·法务必办。
- `npm run smoke` → **48/48 通过**（隔离端口 5199）：新增 `/v1/sources/health`、`/v1/sources/fetch` 回环地址 `E4011`、`/v1/batch/fetch-sources` 无候选 `E4008` 断言。
- `npm run verify:restart` → **AC-03 全链路 PASS**：杀进程 → 同库重启 → 任务降为 `paused`、游标 / 点数 / 账本冻结额与落盘一致、显式继续从原游标续跑、只有一条预扣流水。
- `npm run validate:baseline -- --self-test` → 校验器继续拒绝非法标注与空基准集（legacy 通道保留）。
- v0.9.0 新增 14 个服务端测试：URL 校验 / 私网判定 / HTML→文本 / SSRF 不发起请求 / robots 裁决 / 内容类型 / 大小上限 / 重定向上限与重定向到私网 / 批量去重与限速 / 抓取接口空数组拒绝 / 批量管道成功写回 / 失败标 `missing_source` / 无候选 `E4008` / HTTP 端点。
- 历史专项（v0.6.0–v0.8.0，仍全绿）：网关计费 9 个单测、评测 diff 8 个单测、并发队列 FIFO 与硬超时、批量管道 8 个单测、integrity / outcome 6 个单测。
- 本轮为本地改动，未推送远端；CI 与提交链在推送后补记（当前远端仍为 v0.7.0 `be7918d`）。
- 安全活体（v0.3.0 记录）：`HOST=0.0.0.0` 无 token / `CORS=*` → 启动前置拒绝；启用 token 后 401 `E6009` / Bearer 200 / 非白名单 Origin 不回显。

> **干净检出才暴露的坑（已修）**：`.gitignore` 里写 `data/` 会匹配**任意层级**的 `data` 目录，把源码 `src/data/` 一并排除，首提交漏掉 `demo-data.ts` 与 `repository.ts`。本地文件都在，所以 typecheck/build/test 全绿；CI 从 git 干净检出时报 `TS2307`。现改为 `/data/` 锚定仓库根，并加 CI 检查。**结论：本地全绿不等于仓库可构建。**

> **Vite/Vitest 注意**：`server/store.mjs` 用 `process.getBuiltinModule('node:sqlite')` 做同步探测，不能用 `await import('node:sqlite')`——Vite 会把动态 import 重写成 `import('sqlite')` 导致 Vitest 下探测失败、`createStore()` 静默退到 JSON 兜底。这个坑已用一个曾经被 skip 的用例锁死。

> **依赖安全（ADR-018）**：`npm audit` 报 6 项（3 moderate / 1 high / 2 critical），**全部在 dev 工具链**（Vite 5.4.21 / Vitest 2.1.9 / esbuild / tinypool / vite-node / @vitest/mocker），生产 `dist/` 不含这些组件。无损 `npm audit fix` 实测零效果，全部需跨 major 到 Vite 8 / Vitest 5，**不执行 `--force`**。升级需单独分支 + 完整回归。

本仓库不构成法律意见；正式上线前需就 PIPL 与 GDPR 取得执业律师专项意见。
