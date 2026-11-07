# LeadPilot 猎客 · B2B 外贸客户开发工作台

基于资料库 PRD《PRD-LeadPilot-B2B外贸客户开发工作台-v1.1》实现的**可运行基线 v0.2.0**：客户端完整主链路 + 真实服务端 LLM 网关与采集编排骨架。

一句话：`输入卖什么、卖给谁，10 分钟拿到一份能直接发信的客户名单`。本仓库把「评分可信度」这条产品假设做成了可运行、可单测、可审计的代码；**不含真实数据源采购、Google OAuth 验证与桌面安装包**。

## 快速开始

需要两个进程（Node 22，零额外服务端依赖）：

```bash
npm install

# 终端 A · 云端网关 + 任务编排器（127.0.0.1:5181）
npm run cloud

# 终端 B · 前端（127.0.0.1:5180）
npm run dev
```

```bash
npm run typecheck   # TS strict
npm test            # 58 个单元测试（6 文件）
npm run build       # 类型检查 + 生产构建
npm run smoke       # 云端端到端冒烟验证（需先启动 npm run cloud）
```

`VITE_LEADPILOT_API` 可覆盖前端默认网关地址；`LEADPILOT_PORT` / `LEADPILOT_HOST` 控制服务端监听。

## 先读这句

> **演示数据不是真实采集结果，E6005 降级不是成功。**
> 六个数据源适配器、Gmail OAuth 与 Tauri 外壳均未接入；客户记录全部带 `demo: true`，界面常驻黄条。
> 未配置任何 API Key 时，判断与写信请求**明确返回 503 + E6005**，分数改区间显示并标注「未经模型校验」，绝不返回一段看起来像模型写的假正文。这是对 PRD 6.7「不能假知道」的工程落实。

| 层 | 状态 | 说明 |
|---|---|---|
| 五维评分引擎（6.7） | ✅ 真实实现 | 规则层确定性计算 → 模型离散枚举 → 证据校验 → 代码合成；权重再归一化、α 上限、冲突保守、疑似同行、置信度区间 |
| 12 态状态机（F8） | ✅ 真实实现 | 自动流转白名单、不可逆保护、批量二次确认、全量留痕、Ctrl+Z 撤销 5 步 |
| 合规红线（11.2 / F6-2 / F7-2） | ✅ 真实实现 | 禁词/字数/占位符/退订尾巴校验、四道发送闸门、批量直接发送硬禁用、请求体数据最小化 |
| 共享模型协议（6.7.3） | ✅ 真实实现 | `shared/model-protocol.json` 为前端 / 网关 / 评测单一真源：枚举、禁词、阈值、路由、降级、计费、provider |
| 云端 LLM 网关（F0） | ✅ 服务端真实实现 | 三级路由、超时/429/5xx 降级链、schema + 证据校验、30 天缓存、熔断、点数折算、调用审计、数据出境策略、PII 硬性剔除 |
| 云端任务编排（9.1 / F2） | ✅ 服务端真实实现 | 6 阶段状态机、SSE 单向推流、任务游标、暂停/继续/中止、并发上限 3、硬超时、单源失败显式降级 |
| 评测门禁（9.5） | ✅ 服务端真实实现 | 385 家基准集、8 项 Eval、P0 阻断；无标注数据返回 `NO_DATA`，绝不编造通过 |
| 前端接入与降级 | ✅ 真实实现 | 启动探测、顶栏/侧栏状态、详情页云端判断、写信真实 T1 / 本地模板显式切换、云端审核计与门禁、本地/云端运行器切换 |
| 真实 provider 调用 | 🟡 配置即用 | Key 从服务端环境变量读取（如 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY`），配置后重启 `npm run cloud` 即走真实调用链；**本仓库不内置任何 Key** |
| 采集数据源 / Gmail / Tauri+SQLite | ❌ 未接入 | 接口已抽象，见 `docs/ARCHITECTURE.md` |

## 云端 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 服务与网关总览 |
| GET | `/v1/gateway/health` | provider 清单、熔断、缓存与审计计数 |
| GET | `/v1/gateway/audit` | 调用审计（只记元数据）+ 熔断状态 + 缓存统计 |
| GET | `/v1/eval/gates` | 评测门禁清单 |
| POST | `/v1/eval/run` | 跑基准集；无样本返回 `NO_DATA` |
| POST | `/v1/judge` | 五维判断；无 Key → `503 E6005` |
| POST | `/v1/email/generate` | T1 写信；无 Key → `503 E6005` 且正文为 `null` |
| GET/POST | `/v1/tasks` | 创建 / 列出任务 |
| GET | `/v1/tasks/:id/events` | SSE 流式事件（`hello/stage/progress/source_warning/done/aborted`） |
| POST | `/v1/tasks/:id/pause\|resume\|abort` | 任务控制与游标续跑 |

错误文案统一「发生了什么 + 可能原因 + 你可以怎么做 + 错误码」（PRD A.2）。

## 目录

```
shared/model-protocol.json   前后端 + 评测共享的单一真源
server/
├── protocol.mjs       schema / 证据 / PII / 计费 / 缓存键 / Prompt 构造 / wire→client
├── gateway.mjs        三级路由 · 降级链 · 熔断 · 审计 · judge() / writeEmail()
├── orchestrator.mjs   任务状态机 · SSE 事件源 · 游标 · 并发与硬超时
├── eval.mjs           8 项评测指标与 P0 发布门禁
├── index.mjs          Node 原生 http 入口（零依赖）
└── tests/             26 个服务端测试
scripts/e2e-smoke.mjs  云端端到端冒烟验证（11 项）
src/
├── domain/            纯函数领域层（无 React、无 IO）—— 改这里要写测试
├── services/
│   ├── adapters.ts          LLMAdapter / DataSourceAdapter / GmailAdapter + 路由
│   ├── gateway-client.ts    网关探测 / 判断 / T1 写信 / SSE 订阅 / 任务控制 / 审计
│   ├── task-runner.ts       本地演示运行器
│   └── email-generator.ts   本地确定性模板 + 可核验个性化锚点
├── store/             Zustand 单一状态源（本地/云端运行器切换）
├── components/        四大页面 · 详情抽屉 · 开发信编辑器
└── tests/             32 个前端测试
docs/
├── PM-REVIEW.md       产品评审、范围裁剪、M0 决策建议
├── ARCHITECTURE.md    技术决策（ADR-001–012）与真实接入清单
└── PRD-COVERAGE.md    F0–F10 / AC-01–16 兑现度对照
```

## 设计纪律（改代码前先读）

1. **模型不打分。** 受限输出协议出现 `score / total_score / rating / points` 整条作废；分数只由 `scoring.ts` 计算。
2. **证据必须可核验。** 引用无法在 `<context>` 原文中模糊匹配（命中率 < 90%）→ 字段整条丢弃并回退规则分；可溯源率 < 95% 阻断发布。
3. **冲突不平均。** `|rule − model| > 30` 时保守取规则值，标低置信并进入复议队列。
4. **缺失不补零。** 维度无数据 → 权重再归一化，UI 标注「基于 4/5 维」。
5. **合规写进代码。** 真实身份 / 物理地址 / 退订尾巴由客户端注入，模型与服务端都不接触；批量直接发送硬禁用，UI 不提供绕过开关。
6. **不确定性显式化。** 网关不可用时分数变区间、置信度降级、界面写「未经模型校验」；写信回退本地模板时明确标注 DEMO。
7. **真实编排 ≠ 真实采集。** 云端运行器的 SSE 事件是真的，但数据源未接入时不写入任何客户记录，不生成「看起来像真公司」的占位数据。

## 验证记录（2026-11-06）

- `npm run typecheck` / `npm run build` 通过；`npm test` → **6 文件 / 58 用例全绿**。
- `npm run smoke` → **11/11 通过**：健康检查、provider 清单、判断 E6005、写信 E6005（正文为空）、PII 400 E6004、评测门禁 385、空样本 NO_DATA、任务创建、SSE 真实推流、中止保留游标、审计元数据。
- 单元测试另覆盖：配置 Key 后真实调用链、5xx 切顺位、30 天缓存、连续失败熔断、写信 F6-2 硬约束与 HTTP 200/400/503 三态。

本仓库不构成法律意见；正式上线前需就 PIPL 与 GDPR 取得执业律师专项意见。
