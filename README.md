# LeadPilot 猎客 · B2B 外贸客户开发工作台

基于资料库 PRD《PRD-LeadPilot-B2B外贸客户开发工作台-v1.1》实现的**可运行基线 v0.5.0**：客户端完整主链路 + 真实服务端 LLM 网关 / 采集编排骨架 + 安全边界 / 模型快照锁定 / 持久化（AC-03 闭环）+ T0 规则事实抽取 / 数据源注册表 + **点数账本事务化 / T0 → judge 事实链 / 385 家标注契约 / 前端适配器层收敛**。

一句话：`输入卖什么、卖给谁，10 分钟拿到一份能直接发信的客户名单`。本仓库把「评分可信度」这条产品假设做成了可运行、可单测、可审计的代码；**不含真实数据源采购、Google OAuth 验证与桌面安装包**。

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
npm test                # 96 个单元测试（6 文件，前端 32 + 服务端 64）
npm run gate            # 发布门禁自检 23 项（账本 / T0 链 / 基准集 / 适配器边界）
npm run validate:baseline -- --self-test   # 标注导入校验器反例自检
npm run build           # 类型检查 + 生产构建
npm run smoke           # 云端端到端冒烟 27 项（需先启动 npm run cloud）
npm run verify:restart  # AC-03 真实杀进程 → 重启 → 断点续跑（独立端口 5193）
```

`VITE_LEADPILOT_API` 覆盖前端网关地址；`LEADPILOT_PORT` / `LEADPILOT_HOST` 控制服务端监听。完整环境变量样板见 `.env.example`（**不含任何真实 Key**）。

## 先读这句

> **演示数据不是真实采集结果，E6005 降级不是成功，未锁快照不是可调用，0/6 数据源不是「已接入」，审计里的 points 不是已扣点，导入校验通过不等于评测通过。**
> 六个数据源适配器、Gmail OAuth 与 Tauri 外壳均未接入；客户记录全部带 `demo: true`，界面常驻黄条。
> 未配置 API Key → `503 E6005`；只配了 Key 但没锁 `model_version` → `E6008`；两者都满足才发起真实 provider 调用。
> 385 家人工标注基准集**仓库不提供、代码不生成**；`releaseEligible` 恒为 `false`，`/v1/eval/run` 无标注时返回 `NO_DATA`。
> 任何降级路径都**不返回一段看起来像模型写的假正文**，分数改区间显示并标注「未经模型校验」。这是对 PRD 6.7「不能假知道」的工程落实。

| 层 | 状态 | 说明 |
|---|---|---|
| 五维评分引擎（6.7） | ✅ 真实实现 | 规则层确定性计算 → 模型离散枚举 → 证据校验 → 代码合成；权重再归一化、α 上限、冲突保守、疑似同行、置信度区间 |
| 12 态状态机（F8） | ✅ 真实实现 | 自动流转白名单、不可逆保护、批量二次确认、全量留痕、Ctrl+Z 撤销 5 步 |
| 合规红线（11.2 / F6-2 / F7-2） | ✅ 真实实现 | 禁词/字数/占位符/退订尾巴校验、四道发送闸门、批量直接发送硬禁用、请求体数据最小化 |
| 共享模型协议（6.7.3） | ✅ 真实实现 | `shared/model-protocol.json` 为前端 / 网关 / 评测 / T0 抽取 / 账本单一真源 |
| 云端 LLM 网关（F0） | ✅ 服务端真实实现 | 三级路由、超时/429/5xx 降级链、schema + 证据校验、30 天缓存、熔断、点数折算、调用审计、数据出境策略、PII 硬性剔除、**模型快照锁定** |
| 云端任务编排（9.1 / F2） | ✅ 服务端真实实现 | 6 阶段状态机、SSE 单向推流、任务游标、暂停/继续/中止、并发上限 3、硬超时、单源失败显式降级、**跨进程恢复（AC-03）** |
| **点数账本（F0-6 / AC-03）** | ✅ 真实实现 | `server/ledger.mjs` + `store.mjs` 的账户表 / 流水表：创建预扣 → 完成/中止结算（多退少不补）→ 未启动全额释放；`idem_key` 唯一约束保证幂等；SQLite `BEGIN IMMEDIATE` 事务；跨进程不重复扣 |
| **T0 → judge 事实链（6.7.1 / 6.7.4）** | ✅ 真实实现 | 调用方提供可核验 `sources` 时，T0 规则事实注入 judge Prompt；冲突由代码保守取规则值、置信度归零、证据换 T0 引用并留痕；`no_signal` 维度模型不得改写成确定结论。未提供来源时如实返回 `t0.used=false` |
| **385 家标注契约（9.5）** | ✅ 契约与校验器真实实现 | `shared/baseline-contract.json` + `server/baseline.mjs`：字段、构成、双标独立性、PII、禁用评分字段全部校验；**不生产任何标注数据**；导入校验通过 ≠ 评测通过 |
| T0 事实抽取（6.7.1 / F6-1） | ✅ 规则层真实实现 | `server/t0.mjs`：客户类型 / 进口信号 / 规模 / 产品词 / 负面信号 / 开发信锚点；每条 `quote` 逐字可核验；未命中维度 `no_signal` 不补零；不调模型、不联网、不推断 |
| 数据源适配器注册表（9.3） | ✅ 契约真实实现 | 6 类源注册 + 逐源健康；`0/6 已接入` 如实上报；无实现 → `sourceMode=demo` 占位，**即便注入实现也返回 `blocked` 并暂停任务** |
| 服务端安全边界 | ✅ 真实实现 | 本地回环默认免鉴权；设 `LEADPILOT_API_TOKEN` 或非本机监听时强制 Bearer（401 E6009）；CORS 白名单；限流（429 E6010）；不安全组合拒绝启动 |
| 持久化（8.2 / AC-03） | ✅ 真实实现 | `sqlite`（Node 22 内置，WAL）/ `json`（原子 rename）/ `memory`；任务游标、缓存、审计、**账本账户与流水**跨进程恢复 |
| 评测门禁（9.5） | ✅ 服务端真实实现 | 385 家基准集、8 项 Eval、P0 阻断；无标注返回 `NO_DATA` |
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
| **GET** | **`/v1/eval/baseline/contract`** | 385 家标注导入契约（只返回口径，不返回样本） |
| **POST** | **`/v1/eval/baseline/validate`** | 校验导入数据；不合规 → 400 `E4004`；`releaseEligible` 恒 `false` |
| GET | `/v1/eval/gates` | 评测门禁清单（含契约版本与导入状态） |
| POST | `/v1/eval/run` | 跑基准集；无样本返回 `NO_DATA` |
| POST | `/v1/judge` | 五维判断；可传 `sources` 启用 T0 事实链（响应带 `t0.used` / `reconciliation`）；无 Key → `503 E6005`，未锁快照 → `E6008` |
| POST | `/v1/email/generate` | T1 写信；可传 `sources` 走 T0 锚点；降级时正文为 `null` |
| GET/POST | `/v1/tasks` | 创建 / 列出任务；**预扣不足返回 402 `E4001` 且不创建任务**；快照带 `ledger` / `sourceMode` / `dataSources` |
| GET | `/v1/tasks/:id/events` | SSE 流式事件（`hello/stage/progress/source_warning/done/aborted`） |
| POST | `/v1/tasks/:id/pause\|resume\|abort` | 任务控制；收尾时账本结算/释放并写进任务日志 |

`/health` 为探活保留无鉴权；其余 `/v1/*` 在启用 token 或对外监听时一律要求 `Authorization: Bearer <token>`。因为 `EventSource` 不能带 Authorization，前端改用 `fetch` 流式读取 SSE 帧，**绝不把 token 拼进 query**。

错误文案统一「发生了什么 + 可能原因 + 你可以怎么做 + 错误码」（PRD A.2）。错误码：`E6004` PII / 非法来源、`E6005` 无可用 provider、`E6008` 快照未锁定、`E6009` 鉴权失败、`E6010` 限流、`E4001` 点数不足、`E4002` 账本幂等键冲突、`E4003` 账本状态非法、`E4004` 标注导入不合规。

> **点数口径（v0.5.0 明确边界）**：账本只覆盖云端任务的预扣 / 结算 / 释放。`gateway` 的 `judge` / `write_email` 审计里的 `points` 是按 token 折算的**估值**，不进账本、不代表已扣点；成功响应带 `billing: { charged: false, scope: 'audit-only' }`，`/health.billing.auditOnlyConsumers` 也如实列出。把审计估值扩成真实扣费属于后续独立任务，绝不在文档里含糊过去。

## 配置要点

```bash
# 仅本机开发：默认 local-open，无需 token
LEADPILOT_HOST=127.0.0.1
LEADPILOT_STORE=sqlite           # 默认；node:sqlite 不可用时自动降级为 json 文件兜底
LEADPILOT_DB_PATH=./data/leadpilot.db
LEADPILOT_POINTS_BALANCE=2000    # 开户初始点数（v0.5.0）

# 对外部署：以下两项必须同时配置，否则服务拒绝启动
LEADPILOT_HOST=0.0.0.0
LEADPILOT_API_TOKEN=<强随机令牌>
LEADPILOT_CORS=https://your-frontend.example.com
VITE_LEADPILOT_TOKEN=<同上>      # 浏览器端 token 会暴露，生产应改为同源反向代理注入

# 真实模型调用 = Key + 具体快照，二者缺一不可
DEEPSEEK_API_KEY=<key>
LEADPILOT_MODEL_VERSION_DEEPSEEK_PRO=deepseek-chat-<具体快照ID>

# 仅在已有真实人工标注文件时设置；仓库不提供也不生成标注
# LEADPILOT_BASELINE_FILE=./data/baseline-385.jsonl
```

> **模型快照纪律**：`shared/model-protocol.json` 的 `rules.requirePinnedModelVersion = true`。含 `-latest` 的浮动指针一律判未锁定，`/v1/gateway/health` 里 `pinned=false`，且不进入降级链。基线不预置任何猜测版本号——版本号必须由运维从 provider 官网查得后注入。

## 目录

```
shared/
├── model-protocol.json        前后端 + 评测 + T0 + 账本共享单一真源
└── baseline-contract.json     385 家标注导入契约（只定义口径，不含样本）
.github/workflows/ci.yml       GitHub Actions：干净检出 / typecheck / gate / 校验器自检 / test / build / smoke / AC-03
server/
├── protocol.mjs       schema / 证据 / PII / 计费 / 缓存键 / Prompt（含 <t0_facts>）/ wire→client
├── gateway.mjs        三级路由 · 降级链 · 熔断 · 审计 · judge() / writeEmail()
├── orchestrator.mjs   任务状态机 · SSE · 游标 · 并发/硬超时 · 账本预扣与结算 · 重启恢复
├── store.mjs          sqlite / json / memory：任务 / 缓存 / 审计 / 账本账户与流水
├── ledger.mjs         点数账本：reserve / settle / release / charge / grant，事务化 + 幂等
├── baseline.mjs       标注契约解析（json/jsonl/csv）与导入校验器
├── t0.mjs             T0 规则抽取 + reconcileWithT0 冲突裁决
├── data-sources.mjs   6 类数据源注册表 · health · 显式 demo/blocked
├── eval.mjs           8 项评测指标、P0 门禁、基准集 manifest
├── index.mjs          Node 原生 http 入口：鉴权 / CORS / 限流 / 路由
└── tests/             64 个服务端测试
scripts/
├── e2e-smoke.mjs              云端端到端冒烟（27 项）
├── check-release-gates.mjs    发布门禁自检（23 项，含适配器边界与账本重启）
├── validate-baseline.mjs      标注导入校验 CLI（支持 --self-test）
├── fixtures/                  仅 INVALID-FIXTURE 反例，禁止作为评测输入
├── verify-restart.mjs         AC-03 断言（HTTP + SQLite 原文 + 账本流水比对）
└── verify-restart.sh          进程编排：启动 → 强杀 → 同库重启 → 续跑
src/
├── domain/            纯函数领域层（无 React、无 IO）—— 改这里要写测试
├── services/
│   ├── adapters.ts          唯一入口：适配器接口 + 路由 + re-export 三个实现
│   ├── gateway-client.ts    网关探测 / 判断 / T0 / T1 写信 / SSE / 任务控制 / 审计
│   ├── task-runner.ts       本地演示运行器
│   └── email-generator.ts   本地确定性模板 + 可核验个性化锚点
├── store/             Zustand 单一状态源（本地/云端运行器切换）
├── components/        四大页面 · 详情抽屉 · 开发信编辑器
└── tests/             32 个前端测试
docs/
├── PM-REVIEW.md       产品评审、范围裁剪、M0 决策建议
├── ARCHITECTURE.md    技术决策（ADR-001–022）与真实接入清单
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
12. **账本范围不得悄悄扩大。** `billing.ledger.scope` 只有 `task_reserve / task_settle / task_release`；gateway 的 `points` 是审计估值，门禁脚本会断言这条边界。
13. **标注数据不可合成。** 仓库只允许 `INVALID-FIXTURE` 反例；导入校验通过 ≠ 评测通过；`releaseEligible` 未接真实评测前恒 `false`。
14. **业务层不得直连服务实现。** 组件 / store / App 只从 `@/services/adapters` 取能力，由 `npm run gate` 在 CI 中强制校验（ADR-019）。

## 验证记录（2026-11-08 · v0.5.0）

- `npm run typecheck` / `npm run build` 通过；`npm test` → **6 文件 / 96 用例全绿，0 skipped**（前端 32 + 服务端 64）。
- `npm run gate` → **23/23 自检通过**，并明确输出 `releaseBlocked = true` 与 4 条阻断项（标注集未标注、数据源 0/6、模型快照未注入、OAuth/CASA/采购/人工复核未开始）。
- `npm run validate:baseline -- --self-test` → 校验器确实拒绝 22 处非法标注与空基准集。
- `npm run smoke` → **27/27 通过**：含点数账本恒等式、`/v1/points`、基准契约与 400 `E4004`、T0→judge 事实链启用 / 非法来源拒绝、402 `E4001` 拒绝建任务、中止结算留痕。
- `npm run verify:restart` → **AC-03 全链路 PASS**：新增断言「账本预扣已落盘且只有一条 reserve 流水」「跨进程 held/available 不变」「续跑后冻结额不变」。
- 安全活体（v0.3.0 记录）：`HOST=0.0.0.0` 无 token / `CORS=*` → 启动前置拒绝；启用 token 后 401 `E6009` / Bearer 200 / 非白名单 Origin 不回显。
- GitHub Actions `ci.yml` 新增 `Release gate self-check` 与 `Baseline import validator self-test` 两步，并把 v0.5.0 新文件纳入干净检出检查。

> **干净检出才暴露的坑（已修）**：`.gitignore` 里写 `data/` 会匹配**任意层级**的 `data` 目录，把源码 `src/data/` 一并排除，首提交漏掉 `demo-data.ts` 与 `repository.ts`。本地文件都在，所以 typecheck/build/test 全绿；CI 从 git 干净检出时报 `TS2307`。现改为 `/data/` 锚定仓库根，并加 CI 检查。**结论：本地全绿不等于仓库可构建。**

> **Vite/Vitest 注意**：`server/store.mjs` 用 `process.getBuiltinModule('node:sqlite')` 做同步探测，不能用 `await import('node:sqlite')`——Vite 会把动态 import 重写成 `import('sqlite')` 导致 Vitest 下探测失败、`createStore()` 静默退到 JSON 兜底。这个坑已用一个曾经被 skip 的用例锁死。

> **依赖安全（ADR-018）**：`npm audit` 报 6 项（3 moderate / 1 high / 2 critical），**全部在 dev 工具链**（Vite 5.4.21 / Vitest 2.1.9 / esbuild / tinypool / vite-node / @vitest/mocker），生产 `dist/` 不含这些组件。无损 `npm audit fix` 实测零效果，全部需跨 major 到 Vite 8 / Vitest 5，**不执行 `--force`**。升级需单独分支 + 完整回归。

本仓库不构成法律意见；正式上线前需就 PIPL 与 GDPR 取得执业律师专项意见。
