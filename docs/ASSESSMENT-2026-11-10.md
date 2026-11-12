# LeadPilot v0.9.0 项目再评估

> 评估日期：2026-11-10·基线：`f9bcd69`（`main` / `origin/main` / GitHub API 三处一致）·只读评估，未修改任何源码
> 方法：三路独立代码评审（服务端 / 前端 / 工程化）+ 本地实跑验证 + 关键 P0 活体复现 + 文档交叉核验
> 口径：刻意设计的 `DEMO`、商业数据源 `0/6`、Gmail 未接入、`releaseEligible=false` **不计为缺陷**；「不发布」本身不是扣分理由

---

## 1. 结论先行

**综合 3.0 / 5.0（质量 3.2 + 设计 2.8）。一句话：工程纪律是 4.5 分水准，实现正确性与安全只有 2 分出头，存在「门禁很严、实现有洞」的倒挂。**

- 项目把「诚实」做成了可执行的工程资产：23 条设计纪律、54 项发布门禁、146 个单测、48 项冒烟、AC-03 真实杀进程恢复，`releaseEligible` / `accuracyClaim` 恒假且无绕过路径。这些**全部实跑为真**，不是文档吹嘘。
- 但门禁大多是**静态契约断言**，不是行为验证。三路评审共识别 **66 条可定位问题**（P0 3 / P1 17 / P2 29 / P3 17，归并同因项后约 60 条），其中 **3 个 P0 已活体复现**：一个畸形 HTTP 请求打死服务、IPv4-mapped IPv6 绕过 SSRF、已退订终态客户被建草稿改回 `drafted`。
- 更值得警惕的是：这 3 个 P0 恰好都在现有 146 测试与 54 门禁的**覆盖盲区**里。全绿给出的是虚假保证，而不是质量证明。
- v0.4.0 → v0.9.0 五轮功能扩张（ledger / queue / batch SDR / eval / fetch）速度很快，安全边界与状态机一致性没有同步加固；服务端 `index.mjs` 521 行巨石路由、`useAppStore.ts` 612 行混合职责，是缺陷集中的两个点。

**建议顺序**：先堵 3 个 P0 并补反例测试（约 1 天），再收口计费/缓存/合规链路的 P1（约 2–3 天），最后做文档与 UI/UX 收口（约 2 天）。详见第 8 节。

> **修复进展（B1 → B3 已执行完毕）**：第 1 节的评分与问题清单是**评估当时**的快照，保留不改以留痕。
> - B1（第 11 节）：3 个 P0 全修 + 行为级反例，活体转负例。
> - B2（第 12 节）：17 项 P1 全修 + 18 个反例。
> - B3（第 13 节）：29 项 P2 + 17 项 P3 全修 + 28 个反例，含「门禁假保证」根因、`noUncheckedIndexedAccess` 开启、a11y 基线。
> - 补遗（第 14 节，2026-11-12）：第 9 节 5 项待验证假设全部收口，其中 #2「反向代理免鉴权」确认为真缺口并修复 +3 个反例；#5 截图生成脚本入库可复现。修复后重评 **3.0 → 4.0 / 5.0**。
> - 验证基线：`202` 单测 / `60` 门禁 / `48` 冒烟 / AC-03 PASS；`git archive` + `npm ci` 干净检出终验全绿（第 14.4 节），全部实跑。
> - **未变**：`releaseEligible` 恒 `false`、`accuracyClaim` 恒 `false`、0/6 商业数据源——工程正确性提升不等于产品可发布。

---

## 2. 评分

### 2.1 质量 8 维度（3.2 / 5.0）

| 维度 | 分 | 依据 |
|---|---|---|
| 架构与模块边界 | 3.8 | `protocol / gateway / orchestrator / store / ledger / fetch / batch / eval` 边界清晰，`shared/*.json` 单一真源；扣分在 `server/index.mjs` 521 行巨石路由、鉴权/CORS/限流未抽中间件 |
| 代码正确性 | 2.2 | 实证缺陷密集：畸形 URL 崩溃、游标注入崩溃、缓存串读、证据失败仍扣点、结算后谎报释放、413 不可达、只读接口开户、终态状态机绕过 |
| 安全 | 2.0 | SSRF 可被 IPv4-mapped IPv6 与 DNS 重绑定绕过、`companyId` 绕过 PII 闸门、token 明文 `===`、内部异常回显、CSV 公式注入、robots 3xx fail-open |
| 并发与可靠性 | 3.2 | FIFO 单调 `seq` + 唯一 `start()` 闸门、SQLite `BEGIN IMMEDIATE` + `idem_key` 扎实；扣分在 json/memory 账本无事务、限流 Map 无淘汰、定时器回调无 try/catch |
| 测试与验证 | 4.2 | 146 单测 / 54 门禁 / 48 冒烟 / AC-03 全链路实跑全绿、零空断言；扣分在 SSRF 只测点分 IPv4、启动前置安全无反例、门禁断言字段与实现字段不同源 |
| 可维护性 | 3.2 | 注释/ADR/错误模板详尽；扣分在魔法数字、版本硬编码、T0 抽取重复执行、CSV 与二次确认逻辑各重复 2–3 处 |
| 工程化 / CI / 供应链 | 4.0 | `npm ci`→typecheck→gate→test→build→smoke→AC-03 顺序正确、`permissions: contents: read`、生产依赖仅 4 个；扣分在干净检出清单漏 21 个源码、action 未固定 SHA |
| 文档一致性 | 2.8 | ADR-001–032 体系完整，但发布判据、冒烟端口、阻断项数量、版本硬编码、提交链等 10+ 处可核验矛盾 |

### 2.2 设计 14 维度（2.8 / 5.0）

| 维度 | 分 | 维度 | 分 |
|---|---|---|---|
| 视觉层级 | 3.5 | 信息密度 | 3.2 |
| 色彩与语义 token | 3.2 | 可访问性 | 1.5 |
| 排版与字号 | 2.8 | 键盘与交互反馈 | 2.2 |
| 组件一致性 | 3.5 | 响应式 | 1.8 |
| 空 / 错 / 加载态 | 3.2 | 文案准确性 | 2.2 |
| 降级诚实性 | 2.8 | 导航与状态一致 | 3.5 |
| 表单与校验 | 2.8 | 品牌与版本一致 | 2.5 |

> 设计分按**产品级标准**打分；作为内测工具，a11y / 响应式 / 字号三项可视为可接受的技术债，但「文案声称未实现能力」与「演示数据伪装成模型判断」不属于可接受范围，直接冲击产品「不能假知道」的核心承诺。

### 2.3 实跑验证（本次会话）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | **7 文件 / 146 用例全绿 / 0 skipped**，与 README 一致 |
| `npm run gate` | **54/54**，`releaseBlocked=true·releaseEligible=false·accuracyClaim=false` |
| `npm run build` | exit 0（41.20s，346.72 kB / gzip 116.54 kB） |
| `npm run smoke` | 48/48（工程化评审独立实跑） |
| `npm run verify:restart` | AC-03 全链路 PASS（工程化评审独立实跑） |
| `npm ci --dry-run` / `npm audit` | exit 0；6 项漏洞全在 dev 工具链，需跨 major |

---

## 3. P0（3 项·全部活体复现，建议立即修）

| ID | 问题 | 证据 | 根因与影响 | 修复 | 复现 / 验证 |
|---|---|---|---|---|---|
| **P0-1** | 一个畸形 HTTP 请求远程打死服务 | `server/index.mjs:163`（`new URL` 在 `:176` 的 `try` 之外） | `async` handler 的 `TypeError` 变成未处理拒绝 → Node 进程退出；任意客户端可 DoS，含默认回环开发态 | 把 `:162-174` 整体移入 `try`，注册 `server.on('clientError')` 返回 400，加进程级兜底日志 | 本次实跑：`GET //[ HTTP/1.1` → `ERR_INVALID_URL at index.mjs:163` → **exitCode=1** |
| **P0-2** | IPv4-mapped IPv6 绕过 SSRF 私网拦截 | `server/fetch.mjs:82-86, 120-123` | `isPrivateAddress()` 只认点分十进制 `::ffff:a.b.c.d`；WHATWG URL 把 `[::ffff:127.0.0.1]` 规范化成 `::ffff:7f00:1`，字面量分支直接判公网 → 可访问本机/内网/云元数据 | 用 `net.BlockList` 或 128 位整数展开判定；校验与连接必须 pin 同一 IP | 本次实跑：`assertPublicHost('http://[::ffff:127.0.0.1]/')` → `{"ok":true,"addresses":[{"address":"::ffff:7f00:1"}]}`；`fetch.test.mjs:67` 只测了生产路径永不传入的点分形式 |
| **P0-3** | 已退订终态客户被建草稿强制改回 `drafted` | `src/store/useAppStore.ts:489-494` → `src/domain/state-machine.ts:59-79` | `addOutreach` 直接调 `applyTransition`（只留痕、不做终态校验），绕开 `canTransition` 的 E3001 红线；默认演示数据第 9/19/29/39 家即 `unsubscribed` 且含 B 级邮箱 → 击穿 PRD 11.2「退订全局生效、不可逆」 | `addOutreach` 先过 `canTransition`；把 `applyTransition` 收敛为私有、store 只留一条受控写入口；补 store 层单测 | 全选 →「批量建草稿（≤50）」→ 查 `unsubscribed` 客户的 `status` 与 `statusLog` |

> 这三条分别打穿「可用性」「安全边界」「合规红线」，且修复面都不大（合计约 60 行 + 测试），收益远高于其它项。

---

## 4. P1 高信号清单（17 项，按主题归并）

| ID | 主题 | 关键证据 | 现象与影响 |
|---|---|---|---|
| P1-01 | SSRF·DNS 重绑定 | `fetch.mjs:116-137, 341, 310` | 校验丢弃已解析 `addresses`，真正请求由 undici 二次解析；robots 请求连 `assertPublicHost` 都不做 → TOCTOU |
| P1-02 | 远程 DoS·游标注入 | `index.mjs:481` → `orchestrator.mjs:433, 271, 342` | `resume` 的 `body.cursor` 无校验，`processedDomains:null` 在定时器回调抛错打死进程 |
| P1-03 | 缓存串读 | `gateway.mjs:429-439, 511` / `protocol.mjs:197-199` | 缓存键漏 `facts/keywords/markets/tier`，不同事实命中旧判断；命中分支吞掉 `errorCodes/passesGate` |
| P1-04 | 计费·证据失败仍扣点 | `gateway.mjs:474-479` | `settleBilling()` 在 `verified.passesGate` 判定前执行，返回 `ok:true` 且实扣；违反 `chargeOn="schema_and_content_validation_passed"` |
| P1-05 | 计费·谎报释放 | `gateway.mjs:525-532` | `cache.set` 抛异常时 `releaseBilling` 返回 `E4003`，文案仍写「预扣点数已全额释放」，账本实扣 |
| P1-06 | 只读接口开户 | `index.mjs:318-329` → `ledger.mjs:87-89` | `GET /v1/points?account=X` 内部 `ensureAccount()` 新建账户并写入 2000 点流水，可无限膨胀存储 |
| P1-07 | PII 绕过 | `index.mjs:384, 407-410` / `protocol.mjs:263` | `assertNoPii` 只查 `facts/profile`，`companyId` 原样进 prompt，邮箱可直达 provider |
| P1-08 | 信息泄露 | `index.mjs:487-491` 等 | 统一错误模板把 `String(err.message)` 回显，泄露路径/SQLite 内部状态，与 ADR「不回显堆栈」矛盾 |
| P1-09 | 413 不可达 | `index.mjs:129, 490` | 超限直接 `req.destroy()`，客户端收连接重置而非结构化 `413 E5002`，错误码分支形同虚设 |
| P1-10 | 演示数据伪装模型判断 | `src/data/demo-data.ts:260-292` / `scoring.ts:291-310` | 未配 Key 时初始评分卡仍用合成 `judgement` 且 `modelAvailable:true`，显示确定分数、α>0、「模型判断」、无 E6005 标注 |
| P1-11 | 四道闸门只是展示组件 | `OutreachView.tsx:22-31` / `CompanyList.tsx:46-61` | `checkSendGates` 只在检查器里调用，`addOutreach`/`doExport` 动作链不设卡；G2 黑名单/退订前端无拦截 |
| P1-12 | 撤销不回滚副作用 | `useAppStore.ts:466-472, 569-579` | `undo()` 只恢复 `status/statusLog`，不回滚 `blacklist` 与 `lastContactAt`，撤销退订后状态自相矛盾 |
| P1-13 | 设置页复合字段污染合规尾巴 | `SettingsView.tsx:75, 78` | 「发件人 / 职位」拼接展示却单字段回写，编辑后重复拼接并注入 `injectComplianceFooter` 的真实身份尾巴 |
| P1-14 | 离线误标 E6005 | `App.tsx:75-77` / `SettingsView.tsx:156-163` / `gateway-client.ts:243-247` | 服务未启动时界面称「未配 Key / E6005 降级」并引导配 Key，把「不可达」误诊为「无 provider」 |
| P1-15 | C 级逐条确认降级为批次勾选 | `BatchPipelinePanel.tsx:37, 93, 192-195` | 一个 `confirmC` 复选框覆盖全部 C 级草稿，与 README「逐条人工确认」及 `singleConfirmed` 语义冲突 |
| P1-16 | 编辑器同公司重开状态残留 | `EmailComposer.tsx:29-33` / `App.tsx:83` | 组件常驻挂载、effect 只依赖 `company?.id`，关闭再打开同一家时正文/标注残留，可能误写入草稿 |
| P1-17 | 发布判据口径冲突 | `README.md:61` vs `PM-REVIEW.md:288` vs `check-release-gates.mjs:553` | README 称「Go/No-Go 判据一条未撤」，PM-REVIEW 与 gate 明确「第 1/3 条已取消」；评审者无法判断真正阻塞发布的条件 |

---

## 5. P2 / P3 主题汇总（46 项）

| 主题 | 代表问题 | 级别 |
|---|---|---|
| 安全加固 | robots 3xx fail-open、每域限速状态跨请求丢失、`maxUrlsPerRequest` 被 `targets.length` 覆盖、token 非恒定时间比较、回环下 `CORS=*` 回显、限流 Map 无淘汰 | P2 |
| 持久化 / 重启语义 | json/memory 账本无事务、`hydrate()` 对历史任务反复追加恢复日志、`/health.recoveredTasks` 虚高 | P2 |
| 服务端状态机漂移 | 非终态可任意回退（`replied→sent→bounced`）、`drafted` 不在 `allowedEvents`、`exportDrafts` 不落 `statusAfterExport` | P2 |
| 门禁假保证 | 门禁断言读 `autoTransitions`，实现执行 `allowedEvents`，改坏实现 CI 仍全绿 | P2 |
| 文档一致性 | `/health.version` 硬编码、侧栏 `v0.1.0`、smoke 端口写成 5199（实际 5181）、阻断项「四条」vs 实跑 5 条、ADR 旧测试数量、构建体积、提交链止于 `e37ac53` | P2/P3 |
| UI/UX / 文案 | 10–11px 小字密集、`body min-width:1024px` 无响应式、DemoBanner 只覆盖 3 个子页、多处文案声称未实现能力（拖拽列、自动重试 3 次、模板库、双语扩展）、CRM 状态/跟进只读却声称可编辑 | P2 |
| 类型与副作用 | `noUncheckedIndexedAccess` 未开导致 `contacts[0]` 隐患、HTTP/SSE 数据大量 `as T`、SSE `close()` 不 `reader.cancel()`、持久化 debounce 被高频 `set` 饿死 | P2 |
| 可访问性 | `Field` 无 `htmlFor`、抽屉/Modal 无 dialog 语义与焦点陷阱、`<tr onClick>` 键盘不可达、Toast 无 `aria-live` | P2 |
| 工程 / 供应链 | 干净检出清单漏 21 个源码、启动前置安全无自动化反例、`it.skipIf` 条件跳过、CI action 未固定 SHA、9 张 4.61 MB 未跟踪旧截图 | P2/P3 |
| 校验细节 | 禁词子串匹配误伤、`hasSenderIdentity` 无词边界、CSV 公式注入、`downloadCsv` 立即 revoke、`undo` 与编辑器边界 | P3 |

---

## 6. 文档与实现不一致（精选 10 条）

| # | 声明 | 出处 | 实际 |
|---|---|---|---|
| 1 | 146 用例 / 54 门禁 / 48 冒烟 | README:89-92 | **一致**（本次实跑） |
| 2 | `releaseEligible` / `accuracyClaim` 恒假 | README:7,60,61 | **一致**，硬编码且无绕过 |
| 3 | `0/6` 数据源、抓取单独计数 | README:67 | **一致** |
| 4 | 5 张真实截图、DEMO + E6005 态 | README:20-47 | **一致**（尺寸/画面已核） |
| 5 | 「版本号从 `package.json` 读取，不再硬编码」 | README:296 | `/health.version` 仍为字面量 `'0.9.0'`；侧栏仍 `v0.1.0` |
| 6 | smoke「隔离端口 5199」 | README:299 | `e2e-smoke.mjs:12` 与 CI 均为 5181，5199 全仓仅此一处 |
| 7 | 「Go / No-Go 判据一条未撤」 | README:61 | PM-REVIEW:288 与 gate 输出说第 1/3 条已取消 |
| 8 | 「四条阻断项」 | PM-REVIEW:171,206 | gate 实跑打印 5 条 `BLOCKED` |
| 9 | 「干净检出清单覆盖所有关键源码」 | ARCHITECTURE:304 | 清单 31 项，tracked 源码 52 项，漏 21 |
| 10 | 「安全活体验证 ✅」 | README:306 | 启动前置拒绝无自动化反例测试，仅一次性人工验证 |
| 11 | 构建体积 300 KB / gzip 100 KB | ARCHITECTURE:381 | 346.72 kB / gzip 116.54 kB |
| 12 | 提交链止于 `e37ac53` | README:304 | 当前 HEAD `f9bcd69` |

---

## 7. 已核实属实、不应扣分的强项

- `releaseEligible` / `accuracyClaim` 全部硬编码 `false`，无绕过；`0/6` 商业数据源如实上报，抓取≠采集。
- FIFO 单调 `seq` + 唯一 `start()` 闸门 + `pumpQueue()`、SQLite `BEGIN IMMEDIATE` + `idem_key` 幂等、AC-03 真实杀进程恢复。
- E6005/E6008 降级链、模型快照锁定（禁 `-latest`）、T0 `quote` 逐字可核验、失败不编造原文。
- 批量直接发送确无 UI 入口与发送实现（`BATCH_DIRECT_SEND_ENABLED=false`），合规尾巴本地注入、CSV 带 BOM。
- TS strict 全开、全仓无 `: any`、`domain/` 纯函数分层、`shared/model-protocol.json` 单一真源。
- 146 单测零空断言，SSRF/鉴权/账本/状态机均有行为级反例（但覆盖不全，见 P0）。
- CI 顺序正确、生产依赖仅 4 个前端库、服务端零额外依赖、无遥测、无密钥入仓。

---

## 8. 建议修复顺序（3 批）

| 批次 | 范围 | 关键依赖 | 验证与回归 |
|---|---|---|---|
| **B1·P0 止血**（约 1 天） | P0-1/2/3 + 三条反例单测：畸形 URL、`::ffff:7f00:1` 与 DNS 重绑定、终态建草稿被拒 | 无前置；改 `index.mjs` / `fetch.mjs` / `useAppStore.ts` + 测试 | `npm test`（新增 3+ 用例）、`npm run gate`、`npm run smoke`、手工把本报告第 3 节复现脚本转成负例；`npm run build` |
| **B2·P1 收口**（约 2–3 天） | 先计费/缓存（P1-03/04/05/06），再安全（P1-01/02/07/08/09），最后前端合规与降级（P1-10~16）+ 治理文档 P1-17 | B1 的 SSRF 重构是 P1-01 的前置；`shared/model-protocol.json` 的 `chargeOn` 是计费口径真源 | 全量 146+ 用例、gate 54、smoke 48、`verify:restart` AC-03；特别验证「证据失败不扣点」「撤销退订后黑名单回滚」「未配 Key 时评分卡为区间且标注未经模型校验」 |
| **B3·P2/P3 收口**（约 2 天） | 文档 10+ 处统一、CI 干净检出清单改全量 `git ls-files` 校验、action 固定 SHA、a11y 基线、字号阶梯、清理 9 张旧截图 | B2 实现定稿后再改文档，避免二次漂移；UI 改动后需重生成 5 张 README 截图 | 干净检出 CI、`npm ci` 全新安装、`npm audit` 复核、截图与文案一致性抽检、README 链接全通 |

**横切要求**：每批修复都必须同时补**行为级反例测试**，不要把新断言又写成「读契约常量」式的静态检查；`npm run gate` 现有 54 项中至少 1 项（`autoTransitions` vs `allowedEvents`）本身需修正，否则会给假保证。

---

## 9. 待验证假设（不进问题清单）

1. 多实例部署下 `orchestrator` 进程内 Map 与共享库/租约问题，ADR 已声明边界，`verify-restart.sh` 只验证单实例。
2. 反向代理把外部流量转发到回环端口时，`authOk()` 基于静态 `sec.loopback` 是否会导致免 token 访问，需具体部署拓扑确认。
3. 云端 `writeEmail` 返回值是否已注入合规尾巴，前端 `EmailComposer` 无条件再注入可能造成双尾巴。
4. 前端 `settings.blacklist` 与服务端 `/v1/export/eml` 是否共享同一黑名单，若不同步则 G2 闸门在导出路径失效。
5. README 声称 5 张截图为「Edge headless 真实运行」，尺寸与画面可核，但生成方式无法从 PNG 本身证明。

### 9.1 假设核查结论（2026-11-12 收口）

| # | 判定 | 处理 / 残留 |
|---|---|---|
| 1 | **成立，但属架构边界而非缺陷** | ADR 已声明单实例部署，`verify-restart.sh` 只验单实例。B3-2 的 `ledgerTransact()` 让单实例事务更完整，但进程内 `tasks` / `timers` Map 与共享库租约在多实例下仍无解。要上多实例必须引入外部租约或 DB 锁，属独立架构决策，不进问题清单 |
| 2 | **成立，是真安全缺口** | 旧 `authOk()` 无 token 时 `return sec.loopback`，只看静态监听地址；Nginx `proxy_pass` 到 `127.0.0.1:5181` 时 socket 与监听都是回环，公网流量对全部 `/v1/*` 免鉴权。已在本次补遗修复：`loopbackPeer(req)` + `looksProxied(req)` 双条件，配 3 个行为级反例。详见第 14 节 |
| 3 | **成立，已在 B3-0 修复** | `injectComplianceFooter()` 改为幂等（已有 `\n--\n` + 退订语句则原样返回），`src/tests/compliance.test.ts` 锁死单尾巴 |
| 4 | **成立，已在 B3-0 修复** | 前端 `exportDrafts({ items, blacklist: settings.blacklist })` 透传；服务端 `checkExportGates` 按邮箱 / `@domain` 全局硬拦并叠加退订终态；门禁补服务端导出链行为级断言 |
| 5 | **成立，已闭环** | README 文案从「Edge headless」改为可核的「Chrome headless / CDP」；生成脚本 `scripts/capture-screenshots.mjs` 已入仓库（`npm run capture:screenshots` 可复现，Node 22 原生 WebSocket，无第三方浏览器自动化依赖），5 张图按定稿 UI 重新捕获并逐张目视核验。脚本不进 CI、不进发布门禁 |

**残留**：#1 的多实例租约、#2 的「代理把 Host 也一并改写成 127.0.0.1 且不加任何代理头」这一极端拓扑。后者无法从请求侧识别，唯一正解是部署规约——凡经反向代理暴露必须设置 `LEADPILOT_API_TOKEN`，已写入 `/health.security.note`、启动告警与 README。

---

## 10. 附录·本次评估的验证动作

- 实跑：`typecheck` / `test` / `gate` / `build`（本会话）+ `smoke` / `verify:restart` / `npm ci --dry-run` / `npm audit` / `npm ls`（工程化评审独立实跑）。
- 活体复现：畸形 URL 请求（独立端口 5197、`LEADPILOT_STORE=memory`，子进程 `exitCode=1`）、`assertPublicHost('http://[::ffff:127.0.0.1]/')` 返回 `ok:true`。
- 静态复核：`index.mjs:163/179/479`、`fetch.mjs:82-137`、`gateway.mjs:474-532`、`useAppStore.ts:489-494`、`state-machine.ts:28-79`、README / PM-REVIEW / gate 关键行。
- 工作区：评估前后 `git status` 均为仅 9 张未跟踪旧截图，未修改、未提交任何文件。

> 本报告不构成法律意见；`internal_preview` 阶段的 5 条发布门禁属刻意自我阻断，不应「修掉」。

---

## 11. B1 修复记录（2026-11-11）

用户批准后完成 P0 止血。范围严格限于 3 个 P0、同根因的 SSRF 校验链与行为级反例测试，**未触碰其余 P1/P2/P3，未改动任何发布门禁**。

| P0 | 修复 | 验证 |
|---|---|---|
| P0-1 | `server/index.mjs`：CORS / URL 解析 / 限流 / 鉴权整体移入 `try`，非法 URL 返回 400 `E5002`；注册 `server.on('clientError')` 返回 400 并关连接 | 活体：`GET //[` → `HTTP/1.1 400`，随后 `/health` 200；`cloud.test.mjs` 新增原始 socket 行为级用例 |
| P0-2 | `server/fetch.mjs`：`isPrivateAddress` 改为 IPv6 128 位展开（覆盖 `::ffff:7f00:1`、IPv4-compatible、`::`、fc00::/7、fe80::/10）；`loadRobots` 与 `followAndFetch` 每次出站前复用 `assertPublicHost` 复核 DNS，robots 主机校验失败即 `ssrf-blocked → E4011` | 活体：`/v1/sources/fetch` 传 `[::ffff:127.0.0.1]` → 400 `E4011`；新增 3 个反例（含两阶段 DNS 重绑定） |
| P0-3 | `src/store/useAppStore.ts`：`addOutreach` 先过 `canTransition({to:'drafted',automated:true})`，拒绝时返回 `{ok:false,message}`；`CompanyList.tsx` / `EmailComposer.tsx` 按返回值统计并如实提示，不再谎报成功 | 新增 `src/tests/draft-guard.test.ts` 3 个 store 行为级用例（终态拒绝、正常放行、客户不存在） |

**修复后全量回归**：`npm test` 8 文件 / **153 用例全绿 / 0 skipped**；`npm run typecheck` exit 0；`npm run gate` **54/54**（`releaseBlocked=true` 不变）；`npm run build` exit 0；`npm run smoke` **48/48**；`npm run verify:restart` **AC-03 全链路 PASS**；P0-1 / P0-2 活体转负例通过。README 两处测试数量已同步为 153，避免制造新的文档不一致。

**残余风险（属 B2）**：DNS 重绑定目前靠「连接前二次解析」缓解，彻底消除需把连接 pin 到已验证 IP（自定义 dispatcher / lookup），并补 robots 3xx 逐跳重判。P1 其余各项、29 项 P2、17 项 P3 均未动，按第 8 节 B2/B3 推进。

---

## 12. B2 修复记录（2026-11-11）

**通道修复**：B1 提交 `4bccea9` 的 HTTPS push 被代理污染（`info/refs` 返回 `OK\r\n`，git 报 `not valid`）。改用已验证可用的 SSH over 443 推送成功，并把 `origin` 切到 `ssh://git@ssh.github.com:443/Gakiwoo/LeadPilot.git`；复核 local / origin / GitHub API 三处 HEAD 一致后才开始 B2。

| 批次 | ID | 修复 |
|---|---|---|
| B2-1 计费/缓存 | P1-03 | `cacheKey()` 第三参数纳入 `facts / keywords / markets / tier / country / regionPolicy / t0 版本`（稳定序列化后散列）；旧格式缓存无 `passesGate` 一律失效；命中分支回传 `passesGate / errorCodes / evidenceFields` |
| | P1-04 | 证据门禁未通过按 `chargeOn = schema_and_content_validation_passed` 走 `releaseBilling`，不 `settle`、不写缓存、不计 provider 成功，如实标 `E6004` 与未扣点 |
| | P1-05 | `cache.set` 单独 try/catch，落盘失败不再把已结算调用打成异常；`settled` 跟踪异常前是否已结算；所有「已全额释放」文案由 `releaseNote()` 按账本真实状态生成 |
| | P1-06 | 新增 `ledger.peek()` 纯读（`exists:false` 零值快照），默认账户只在 `createApp` 启动时初始化一次；`GET /v1/points?account=任意值` 不再开户写 2000 点流水 |
| B2-2 安全 | P1-01 | 新增 `pinnedFetch()`：Node 原生 http/https + 固定 `lookup`，连接 pin 到 SSRF 校验阶段已验证的 IP（Host / TLS SNI 仍用原域名）；B1 的「连接前二次校验」保留作纵深防御 |
| | P1-02 | `sanitizeCursor()` 白名单收敛 `offset / stageIndex / processedDomains`；`setInterval` 回调包 try/catch，异常只安全暂停任务并发 `task_error`，不再终结进程 |
| | P1-07 | 新增 `assertNoPiiInMessages()`，对最终 prompt 全文做 PII 终检并前移到 `reserveBilling` 之前，堵住 `companyId` / 未清洗锚点直达 provider 且不留冻结点数 |
| | P1-08 | 统一 500 模板不再回显 `String(err.message)`，只记服务端日志；网关 judge / write_email 异常文案同样脱敏 |
| | P1-09 | `readBody` 超限改 `req.resume()` 排空而非 `req.destroy()`，413 `E5002` 结构化响应可达 |
| B2-3 前端合规与降级 | P1-10 | 演示评分卡不再把合成 `judgement` 喂给 `buildScoreCard`：α 归零、区间显示、置信度低、明确 `DEMO + E6005 降级` 标注；合成判断只作为本地演示证据链保留 |
| | P1-11 | G2 黑名单/退订接入 `addOutreach` 硬拦；四道闸门接入 `BatchPipelinePanel.doExport` 逐封裁决（G3 入队不拦，服务端 `checkExportGates` 仍是最终闸门） |
| | P1-12 | `undoStack` 快照 `prevBlacklist / prevLastContactAt`，撤销状态变更时同步回滚副作用 |
| | P1-13 | 设置页「认证 / MOQ / 交期」「发件人 / 职位」两个复合输入框拆成 5 个独立字段，杜绝拼接值单字段回写污染合规尾巴 |
| | P1-14 | 新增 `gatewayDiagnosis()` 四态诊断（offline / E6005 / E6008 / ready）；页脚、设置页、`judgeCompany` / `generateEmailWithGateway` 的不可达分支不再误标 E6005 或引导配 Key |
| | P1-15 | 批次总勾选 `confirmC` 改为 `confirmedC: Record<string, boolean>`，C 级草稿逐条 checkbox，导出按单条 `singleConfirmed` 判定 |
| | P1-16 | `EmailComposer` 增加 `key={composerCompanyId ?? 'composer-closed'}` 强制重挂载，effect 无条件重置，关闭再打开同一家公司不残留正文/标注 |
| | P1-17 | README「Go / No-Go 判据一条未撤」改为与 `PM-REVIEW` / gate 一致：第 1/3 条已取消、第 2/4/5 条继续有效、实跑 5 条 `BLOCKED` |

**行为级反例**：共新增 **18 个**（`server/tests/cloud.test.mjs` 11 个、`server/tests/fetch.test.mjs` 2 个、`src/tests/b2-frontend-guard.test.ts` 5 个），覆盖缓存串读、证据失败实扣、释放失败谎报、任意 account 开户、pin 到已验证 IP（本地 server 验证不可解析域名仍连到 pin 地址）、非法 cursor、PII 终检、413、演示评分卡、撤销副作用回滚与 C 级逐条确认语义。

**修复后全量回归**：`npm test` **9 文件 / 171 用例全绿 / 0 skipped**；`npm run typecheck` exit 0；`npm run gate` **54/54**（`releaseBlocked=true` 不变）；`npm run build` exit 0（`349.71 kB / gzip 117.62 kB`）；`npm run smoke` **48/48**；`npm run verify:restart` **AC-03 全链路 PASS**；`npm run validate:baseline -- --self-test` **SELF-TEST PASSED**。README 两处测试数量已同步为 171 / 9 文件。

**残余风险（属 B3）**：第 5 节的 29 项 P2、17 项 P3 均未动，包括 robots 3xx 逐跳重判、token `timingSafeEqual`、每域限速状态跨请求丢失、门禁 `autoTransitions` vs `allowedEvents` 的假保证、其余 9 条文档不一致、干净检出清单漏 21 个源码、a11y 基线、9 张未跟踪旧截图。另：`pinnedFetch` 只作用于默认出站实现，注入式 `fetchImpl`（测试用）仍按原契约工作，不参与生产路径。

---

## 13. B3 修复记录（2026-11-11）

基线 `000a8c0`（local / origin/main / GitHub API 三处一致）。B3 分 6 个子批次，按「先修假保证，再修安全与持久化，最后修体验与类型」的顺序推进。

### 13.1 B3-0 · 修掉「门禁很严、实现有洞」的假保证

问题成因很具体：`check-release-gates.mjs` 断言读的是协议里的 `autoTransitions`，而 `importOutcomes()` 实际执行的是 `allowedEvents`。两者不同，把实现改坏后 CI 依然全绿。

| 修复 | 说明 |
|---|---|
| 门禁改行为级断言 | 直接 `createBatchPipeline().importOutcomes()` 打真实事件：`drafted` 被拒、`unsubscribed` 未确认被拒、`sent` 放行。断言的是行为，不再抄常量 |
| 导出链 G2 行为级断言 | 直接调 `exportDrafts()`，黑名单与退订终态都必须被服务端硬拦，绕不过去 |
| 导出闸门补上下文 | `checkExportGates(items, ctx)` 接收 `blacklist` / `terminalDomains`；`exportDrafts()` 从 store 查终态域名并把黑名单一起传入 |
| `statusAfterExport` 真实落盘 | 导出成功后客户库状态落为 `drafted`（`exported-not-sent`），不可逆终态不改写，绝不写成 `sent` |
| 合规尾巴幂等 | `injectComplianceFooter()` 检测到已有 `--` + 退订语句时原样返回，堵住双尾巴 |
| 两项合规假设核查 | ① 服务端导出链原先不校验黑名单 → 已修；② 前端 `AUTOMATIC_TRANSITIONS` 含 `drafted` 而服务端 `allowedEvents` 不含 → 二者语义不同（前者是「可自动到达的状态」，后者是「外部可回写的 outcome 事件」），已在协议里写清 `$note`，不是缺陷 |

### 13.2 B3-1 · 安全 P2（6 项）

| 修复 | 说明 |
|---|---|
| token 恒定时间比较 | 新增 `verifyToken()`：先各自 SHA-256 再 `timingSafeEqual`。直接比裸 Buffer 在长度不等时抛 `RangeError`（401 变 500），摘要后长度恒定、不泄漏前缀；超长 header 直接拒绝，避免 CPU DoS |
| 限流表有界 | `createRateLimiter()`：过期项优先淘汰，仍超 4096 条按插入顺序淘汰最旧项；淘汰时保护正在计数的来源，避免淘汰把活跃计数清零绕过限流；淘汰次数可被反例断言 |
| 回环下不再回显 `ACAO:*` | 启动前置校验只拦「非回环 + `*`」；本机无 token 时通配等于任意网页可读本机 API。现在把 `*` 从有效白名单剔除并 `corsWildcardRejected:true` 如实上报，不静默放行 |
| robots 3xx 不再 fail-open | 3xx 逐跳重判：缺 Location / 目标非法 / 超 `maxRedirects` 一律 fail-closed（`E4013`），仅网络失败与 5xx 放行且标 `unavailable` |
| 每域限速状态跨请求保留 | 限速状态原先是 `fetchMany()` 内的局部变量，第二次调用即清零。改为 `createFetcher()` 闭包级共享 |
| `maxUrlsPerRequest` 不再被覆盖 | `batch.mjs` 原先把 `targets.length` 当上限传入，等于把配置项架空；改为按配置取值并在超限时明确报错 |

### 13.3 B3-2 · 持久化与服务端状态机 P2

| 修复 | 说明 |
|---|---|
| json / memory 账本事务 | `ledgerTransact()` 从 `fn()` 直通改为「内存快照 → 失败回滚 → 事务末单次落盘」，杜绝「账户已改、流水没写」的半写状态，也避免把半写状态刷盘 |
| `hydrate()` 幂等 | 恢复日志只对本次真正恢复的任务追加，连续重启不再反复堆积；历史任务不再被算成本次恢复 |
| `/health.recoveredTasks` 不再虚高 | 暴露本次实际恢复条数（`recoveredIds`），而非历史任务总数 |
| 状态机单向收敛 | 协议新增 `allowedFrom`：`sent` 只能从 `new`/`drafted`，`bounced` 只能从 `sent`/`drafted`，`replied` 从 `sent`/`drafted`/`delivered`/`opened`，终态 `*` 另走不可逆硬拦。禁止 `replied→sent→bounced` 这类任意回退 |

### 13.4 B3-3 · 工程与供应链 P2

| 修复 | 说明 |
|---|---|
| 干净检出全量校验 | 新增 `scripts/check-clean-checkout.mjs`（`npm run check:tracked`），`src` / `server` / `shared` / `scripts` 与 `git ls-files` 全量对账，替代原来手写的 21 条漏项清单。当前 60 个源码/配置全部纳入版本控制 |
| 启动前置安全自动化反例 | 新增 `server/tests/startup-security.test.mjs`：真实子进程验证「对外监听 + 无令牌」与「对外监听 + CORS 通配」两种配置直接拒绝启动，不再靠手工验证 |
| CI action 固定 SHA | `actions/checkout` / `actions/setup-node` 从浮动 tag 改为固定 commit SHA，防上游 tag 被移动 |
| 消除条件跳过 | 默认内存存储环境下的两个 SQLite 用例改为显式断言分支，不再 `it.skipIf` 静默跳过 |

### 13.5 B3-4 · 文档统一与截图重生成

| 修复 | 说明 |
|---|---|
| `/health.version` | 从 `package.json` 读，删除硬编码 `'0.9.0'` |
| 侧栏版本号 | `v0.1.0 · M1/M2 客户端基线` → 读 `package.json`，与 `/health.version` 同源 |
| smoke 端口 | 文档写 5199、实际 5181，统一为 5181 |
| 阻断项口径 | 「四条阻断」改为实跑 5 条 `BLOCKED`，与 `PM-REVIEW` / gate 输出一致 |
| ADR / 构建体积 / 提交链 | 测试数量、`353.78 kB / gzip 119.45 kB`、提交链均按实跑数据重写，不再写死过期数字 |
| 旧截图清理 | 9 张未被引用、共 4.61 MB 的 `2880×1800` 旧图移入 `.workbuddy/backup/screenshots-legacy-2026-11-11/`（`.workbuddy` 已被 gitignore），仓库只保留 README 引用的 5 张 |
| 截图重生成 | 5 张全部按当前 UI 重新捕获（1600×1000，DevTools CDP 实际操作导航），并抽检 README 相对链接无失效 |

### 13.6 B3-5 · a11y、UI 文案与 P3 细节

| 修复 | 说明 |
|---|---|
| 表单可访问性 | `Field` 生成 `id` 并 `htmlFor` 关联；`Drawer` / `Modal` 补 `role="dialog"` + `aria-modal` + `aria-labelledby`、Esc 关闭、Tab 焦点陷阱（关闭后焦点回原位） |
| 键盘可达 | 客户列表 `<tr onClick>` 加 `tabIndex` / `role="row"` / Enter 打开，双击与键盘两条路径一致 |
| 状态播报 | Toast 加 `role="status"` + `aria-live="polite"`，不再只有视觉反馈 |
| 最小字号 | 全仓 `text-[10px]` → `text-[11px]`（10 个文件），密集小字不再低于可读下限 |
| DEMO 提示条全覆盖 | `CompanyList` / `CrmView` / `ExecutionView` 补齐 `DemoBanner`，此前只有设置页、任务配置、发信中心 3 个子页有 |
| 文案不再承诺未实现能力 | 删除/改写「拖拽列」「Gmail 失败自动重试 3 次」「模板库最多 3 步序列」「自动做双语与同义词扩展」；CRM 明确「状态与备注可编辑，下次跟进与归属任务只读」 |
| CSV 公式注入 | `toCsv` 对以 `= + - @` 开头的单元格加前导 `'`，并保留 UTF-8 BOM 与引号转义 |
| 下载时机 | `downloadCsv` 改为 DOM 挂载再点击、`setTimeout` 后再 `revokeObjectURL`，避免部分浏览器取消下载 |
| 禁词匹配 | 子串匹配（`cost` 命中 `cost-effective`）改为词边界匹配，减少误伤 |
| 发件人身份判定 | `hasSenderIdentity` 补词边界，避免 `Inc.` 命中任意含该串的单词 |
| **`noUncheckedIndexedAccess` 开启** | 全仓 56 处索引访问隐患逐个显式判空后开启；`contacts[0]` / `tasks[0]` / `followups[0]` 不再被推断为非空。门禁新增静态断言锁死该选项，禁止后续静默关闭 |
| 无收件人必须硬拦 | `SendGateInput.contact` 改为可选，`checkSendGates()` 在无收件人时走 G1 `E3004` 硬拦（此前调用方用非空断言硬塞，客户没有联系人时读 `undefined.value` 直接抛错）；同时修掉 `@` 黑名单规则在空 domain 下的误命中 |
| SSE 连接释放 | `close()` 追加 `reader.cancel()` + `releaseLock()`；流结束时补发残留缓冲区里的最后一个事件；主动关闭不再误报「连接中断」 |
| 持久化不再饿死 | 纯 debounce 在变更间隔 < 400ms 时永不落盘，改为「debounce + 最长等待 1.5s 强制落盘」，并在 `pagehide` / `visibilitychange` 补一次落盘 |
| HTTP 响应形状校验 | `jsonFetch()` 不再 `res.json() as T` 直接断言：非法 JSON 与 `null` 响应在边界上就抛出明确错误，而不是一路传到渲染层才崩 |

### 13.7 B3 验证（全部实跑）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | exit 0（`strict` + `noUncheckedIndexedAccess`） |
| `npm test` | **199 / 199 全绿，0 skipped**（10 文件：cloud 126 / fetch 25 / compliance 14 / scoring 10 / llm-judgement 6 / b2-frontend-guard 5 / state-machine 5 / draft-guard 3 / startup-security 2 / routing 3） |
| `npm run gate` | **60 / 60 自检通过**，`releaseBlocked=true` 不变，5 条 `BLOCKED` |
| `npm run check:tracked` | 60 个源码/配置全部纳入版本控制，83 个 tracked 文件无缺失 |
| `npm run build` | exit 0，`353.78 kB / gzip 119.45 kB` |
| `npm run smoke` | **48 / 48** |
| `npm run verify:restart` | **AC-03 全链路 PASS** |
| `npm run validate:baseline -- --self-test` | SELF-TEST PASSED |
| `npm audit --omit=dev` | **0 vulnerabilities** |
| `npm audit`（含 dev） | 6 条（3 moderate / 1 high / 2 critical），全部落在 `vitest → tinypool` 开发链；修复需 `vitest@5` 跨大版本，按 ADR-018 不在本轮处理，且不进入生产依赖 |

### 13.8 B3 之后仍存在的已知边界

- **发布状态不变**：`releaseEligible` 恒 `false`、`accuracyClaim` 恒 `false`、0/6 商业数据源。B3 修的是实现正确性与体验，不缩短任何一条外部关键路径。
- **依赖漏洞**：开发链 6 条需跨 major 升级 Vitest，属独立决策项。
- **注入式 `fetchImpl`**：仅测试路径，不参与生产出站。
- **a11y 已修到基线**（表单关联、dialog 语义、键盘可达、状态播报），未做完整 WCAG 2.1 AA 审计与屏幕阅读器实测。

---

## 14. 补遗与修复后评分（2026-11-12）

### 14.1 本次补遗（假设 #2 的活体缺口）

基线与第 13 节相同（`febf7be`），变更范围 3 类：

| 类型 | 内容 |
|---|---|
| 运行时 | `server/index.mjs` 新增 `loopbackPeer(req)` / `looksProxied(req)`；`authOk()` 在无 token 时要求「回环监听 + 回环对端 + 无代理标记」三者同时成立；401 诊断区分「代理暴露」与「token 无效」；`/health.security` 增加 `proxyAware` 与部署规约；启动日志对「回环 + 无 token」打印 `SECURITY_NOTICE` |
| 反例 | `server/tests/cloud.test.mjs` +3：5 种代理标记头逐一 401、伪造代理头 + 乱填凭据仍 401、原始 TCP 只改 Host 仍 401、配好 token 后代理流量正常工作（正反例齐全） |
| 可复现性 | `scripts/capture-screenshots.mjs` 入库 + `npm run capture:screenshots`，README 补复现步骤；Chrome 路径自动探测、CDP 冷启动等待 30s + stderr 诊断 |

**设计取舍**：只判断代理标记头是否**存在**，绝不采信头里的 IP 值。伪造这些头只会让自己被要求 token（fail-closed），不可能用来绕过鉴权；同时本机直连 200 保持不变，48 项冒烟与本地开发零影响。

### 14.2 修复后重新评分

评价口径不变：产品级标准，不是「测试能不能跑过」。修复前分数来自第 2 节（评估当时快照），保留不改以留痕。

**质量 8 维度：3.2 → 4.3**

| 维度 | 前 | 后 | 依据 |
|---|---|---|---|
| 架构与模块边界 | 3.8 | 3.9 | 抽出 `verifyToken` / `createRateLimiter` 两个可测模块；`index.mjs` 巨石路由未拆，仍扣分 |
| 代码正确性 | 2.2 | 4.2 | 66 项问题全收口，28 个行为级反例，`noUncheckedIndexedAccess` 开启；扣分在 `as T` 边界仍靠运行时形状校验兜底、注入式 `fetchImpl` 不覆盖生产路径 |
| 安全 | 2.0 | 4.3 | SSRF pin IP、token 恒定时间、限流有界、CORS 通配剔除、robots 3xx fail-closed、PII 终检、错误脱敏、CSV 公式注入、代理拓扑鉴权；扣分在代理把 Host 也改写且不带标记头的极端拓扑（无解，只能靠部署规约） |
| 并发与可靠性 | 3.2 | 4.3 | `ledgerTransact` 快照回滚、tick try/catch、限流淘汰、持久化防饿死、SSE reader cancel；扣分在多实例 Map / 租约未解 |
| 测试与验证 | 4.2 | 4.8 | 199 单测 / 60 门禁（行为级，不抄常量）/ 启动安全真子进程 / 干净检出全量对账 / CI 15 步；扣分在无真实 provider E2E、无 WCAG 审计 |
| 可维护性 | 3.2 | 4.0 | 版本同源、文档统一、旧截图归档；扣分在魔法数字、重复逻辑、巨石路由仍在 |
| 工程化 / CI / 供应链 | 4.0 | 4.7 | 干净检出清单改为文件系统全量对账、action 固定 SHA、`npm audit --omit=dev` 0 漏洞；扣分在 dev 链 6 条漏洞需跨 major |
| 文档一致性 | 2.8 | 4.5 | 10+ 处矛盾全修、5 张截图可复现、三批修复记录落盘；扣分在 ADR 历史数字保留（已明确标注为历史记录） |

**设计 14 维度：2.8 → 3.6**

| 维度 | 前 | 后 | 维度 | 前 | 后 |
|---|---|---|---|---|---|
| 视觉层级 | 3.5 | 3.6 | 信息密度 | 3.2 | 3.2 |
| 色彩与语义 token | 3.2 | 3.3 | 可访问性 | 1.5 | 3.6 |
| 排版与字号 | 2.8 | 3.4 | 键盘与交互反馈 | 2.2 | 3.5 |
| 组件一致性 | 3.5 | 3.8 | 响应式 | 1.8 | 2.0 |
| 空 / 错 / 加载态 | 3.2 | 3.5 | 文案准确性 | 2.2 | 4.2 |
| 降级诚实性 | 2.8 | 4.3 | 导航与状态一致 | 3.5 | 3.7 |
| 表单与校验 | 2.8 | 3.7 | 品牌与版本一致 | 2.5 | 4.3 |

> 设计分抬升主要来自「降级诚实性 +1.5」「文案准确性 +2.0」「品牌与版本一致 +1.8」「可访问性 +2.1」——正好是原评估判定「不属于可接受技术债、直接冲击『不能假知道』承诺」的那几项。
> **响应式仍只有 2.0**：只放宽了 `min-width`，布局本身没做响应式重构；**信息密度 3.2 未动**：没做信息架构重排。这两项是明确的未做项，不粉饰。

**综合 3.0 → 4.0 / 5.0（质量 4.3 + 设计 3.6）。** 原评估的结论「工程纪律是 4.5 分水准、实现正确性与安全只有 2 分出头」已经不成立：现在两侧基本对齐，倒挂消除。

### 14.3 分数不是发布判据

`releaseEligible` 恒 `false`、`accuracyClaim` 恒 `false`、0/6 商业数据源、`npm run gate` 实跑 5 条 `BLOCKED` —— **这些一条都没变**。4.0 分描述的是「代码与界面作为内测工具的质量」，不是「可以对外发布」。要真正解禁，仍需外部数据源合同、真实发送样本与准确率证据，与工程修复无关。

### 14.4 干净检出终验（B3 承诺项，本次补跑）

「本地全绿不等于仓库可构建」是第 6 节反复强调的教训。B3 之前只靠远端 CI 的干净检出间接证明，本地一直没独立跑过 `npm ci`。本次补齐：

| 步骤 | 结果 |
|---|---|
| `git archive 37f65c2` | 84 个文件，无 `node_modules` / `dist` / `data` / `.git` |
| `npm ci` | 全新安装 169 packages（2m），0 编译错误 |
| `typecheck` / `test` / `gate` / `build` | exit 0 / **202/202** / **60/60** / `353.78 kB · gzip 119.45 kB` |
| `smoke` / `verify:restart` / `validate:baseline` | **48/48** / **AC-03 PASS** / SELF-TEST PASSED |
| 远端 CI | `37f65c2` run `43180916709` 15 步全绿 |

**顺带抓到两个只在特定环境暴露的问题**：

1. **`curl` 走系统代理（真缺陷，已修）**：开发机设置 `http_proxy` 后，`verify-restart.sh` 把 `127.0.0.1:5193` 的探活也转发给代理，代理回 502，脚本误判「服务启动失败」；CI（ubuntu-latest）无代理所以一直全绿。已给探活 curl 加 `--noproxy '*'`（提交 `37f65c2`）——探活目标永远是本机回环，没有理由走代理。`verify-restart.mjs` 用 Node `fetch`（不读 `http_proxy`），无需改动。
2. **`/tmp` 下后台进程被会话沙箱终止（环境限制，非代码缺陷）**：把 archive 解到 `/tmp` 时，`verify-restart.sh` 派生的后台 node 被杀（日志只有 SQLite ExperimentalWarning、无错误、进程 dead），AC-03 无法完成；移到工作区内 `.workbuddy/clean-checkout/`（已被 gitignore）后全链路 PASS。如实记录，不把环境限制算成代码问题，也不拿 CI 的绿去掩盖本地这次失败。

这条终验本身也再次印证第 6 节的判断：**验证脚本对被验证环境之外的假设（代理、沙箱、临时目录）同样会给出假保证**，和 B3-0 修掉的「门禁假保证」是同一类问题。
