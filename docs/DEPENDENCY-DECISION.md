# 依赖漏洞与升级决策记录

> 记录日期：2026-11-16 · 基线 `d0dc2e2` · 决策状态：**待用户拍板，本轮不升级**

---

## 0. 结论先行

- **生产依赖 0 漏洞**：`npm audit --omit=dev` → `info 0 / low 0 / moderate 0 / high 0 / critical 0`。已固化进 CI（`npm audit --omit=dev --audit-level=low`），每次 push 在干净检出里实跑。
- **dev 工具链 6 条漏洞**：2 critical / 1 high / 3 moderate，全部来自 `vite 5.x` + `vitest 2.x` 及其传递依赖。
- **全部需要跨 major 升级**（`vite 5 → 8`、`vitest 2 → 5`）。这不是「跑一条 npm update」能解决的事，涉及构建工具、测试运行器、插件兼容与全链路回归，**需要产品/工程决策后再动**。
- 本轮不动版本号，只做：把生产 0 漏洞变成 CI 硬断言、把 dev 漏洞的影响面与验收标准写清楚、给出可选路径。

---

## 1. 现状清单

`npm audit` 实测（2026-11-16）：

| 包 | 严重度 | 受影响范围 | 修复建议 | 主要风险 |
|---|---|---|---|---|
| `vitest` | **critical** | `<=4.1.10`（当前 2.1.4） | `vitest 5.1.0`（跨 major） | Vitest UI 监听时任意文件可读/执行；@vitest/mocker 路径穿越 |
| `tinypool` | **critical** | `<=2.1.1` | 随 `vitest 5.1.0` | worker options 原型污染 gadget → 潜在 RCE |
| `vite` | **high** | `<=6.4.3`（当前 5.4.21） | `vite 8.3.8`（跨 major） | 优化依赖 `.map` 路径穿越；`launch-editor` UNC 路径 NTLMv2 哈希泄露 |
| `@vitest/mocker` | moderate | `<=4.1.11` | 随 `vitest 5.1.0` | redirect mock 任意文件读、代码注入 |
| `esbuild` | moderate | `<=0.24.2` | 随 `vite 8.3.8` | 任意网站可向 dev server 发请求并读取响应 |
| `vite-node` | moderate | `<=2.2.0-beta.2` | 随 `vitest 5.1.0` | 由 vite 传递引入 |

| 范围 | 依赖 | 漏洞数 |
|---|---|---|
| 生产 `dependencies` | `lucide-react` / `react` / `react-dom` / `zustand` | **0** |
| 开发 `devDependencies` | `vite` / `vitest` / `@vitejs/plugin-react` / `typescript` / `tailwindcss` / `postcss` / `autoprefixer` / `@types/*` | **6（均为 vite / vitest 传递链）** |

---

## 2. 实际风险边界（不夸大，也不淡化）

**不受影响**：生产构建产物 `dist/`、服务端运行时（Node 22 原生 `node:http` ESM，零额外依赖）、用户数据、发布门禁判定。这些漏洞不在运行时依赖里。

**受影响**：开发机与 CI 上启动的 `vite dev server` / `vitest` 进程。

| 场景 | 风险 |
|---|---|
| 在不可信网络 / 公共 WiFi 下开 `npm run dev` | esbuild CVE：任意网页可对 dev server 发请求并读响应（源码、环境变量片段） |
| 打开不可信仓库并跑测试 / 启动 Vitest UI | 任意文件读、代码注入、tinypool 原型污染 |
| CI（ubuntu-latest，一次性干净检出，无外部网页同机） | 实际暴露面很低，但**不等于 0**，不能据此宣称「无风险」 |

**当前缓解**（已在代码里的，不是本轮新增的承诺）：
- `vite dev / preview` 只绑定回环（见 `vite.config.ts` 与 README）；
- CI 使用 `npm ci` 干净检出、固定 action SHA；
- 不启用 Vitest UI、不对不可信仓库执行测试。

---

## 3. 为什么不能一键升级

| 阻碍 | 说明 |
|---|---|
| 跨多个 major | `vite 5.4 → 8.3`、`vitest 2.1 → 5.1`，中间各隔 2–3 个 major；配置 API、插件接口、Node 版本要求都变了 |
| 插件兼容 | `@vitejs/plugin-react 4.x` 需同步升级；Tailwind / PostCSS / autoprefixer 链路要重验 |
| 测试运行器 | Vitest 5 的配置项、mock 行为、快照格式可能与现有 12 个测试文件不兼容 |
| 验证成本 | 必须重跑：干净检出 `npm ci` → typecheck → 236 单测 → 66 门禁 → build → 51 冒烟 → AC-03 → 5 张截图重生成；任何一步红了都要定位是升级导致还是原有问题 |
| 收益边界 | 升级只改善开发机安全，不改变 `releaseEligible`（发布门禁由真实样本与外部合规卡住） |

**不做的事**：不把 `npm audit --audit-level=critical` 之类参数放宽来「让 CI 变绿」；不在 CI 里把 dev 漏洞静默忽略；不把「生产 0 漏洞」写成「全项目 0 漏洞」。

---

## 4. 决策选项

| 选项 | 做法 | 代价 | 适用 |
|---|---|---|---|
| **A · 保持现状 + 缓解**（本轮默认） | 维持版本，靠回环绑定 / 不跑 Vitest UI / 不打开不可信仓库控制风险；生产 0 漏洞由 CI 硬断言锁定 | 开发机在不可信环境下仍有暴露面；审计报告持续显示 6 条 | 当前内测阶段、开发机可信、无合规审计要求 |
| **B · 分阶段跨 major 升级** | 先 `vite 5→6→7→8` 逐档回归，再 `vitest 2→5` + `@vitejs/plugin-react` 同步；每档跑完整验证 | 1–2 个工作日，可能需改配置与少数测试 | 需要对外部审计/客户交付「dev 链无漏洞」证明 |
| **C · 换工具链** | 用不含该传递链的运行器/构建器替换 | 架构级改动，收益不确定 | 一般不推荐 |

**建议**：当前阶段选 A，把 B 留到「准备对外交付 / 接受外部安全审计」之前。**A 不是「漏洞已解决」，是「风险已限定且已知」**，措辞必须如实。

---

## 5. 若选择升级，验收标准（一条不能少）

1. `npm audit`（不加 `--omit=dev`）→ `total 0`；
2. `npm audit --omit=dev --audit-level=low` → 仍然 0（CI 已固化）；
3. 干净检出 `git archive HEAD | tar -x` → `npm ci` → 15 步 CI 全绿；
4. `npm run typecheck` / `npm test`（0 skipped）/ `npm run gate`（66 项）/ `npm run evidence:check -- --self-test` / `npm run check:tracked`；
5. `npm run build` 产物可启动；`npm run smoke`（51 项）/ `npm run verify:restart`（AC-03）；
6. `npm run capture:screenshots` 重生成 5 张截图并目视核验，README 不出现旧 UI；
7. 更新本文与 README / 评估报告，注明升级前后版本、回归结果与残余风险。

---

## 6. 纪律

- 生产依赖 0 漏洞是**每次 CI 实跑的结论**，不是文档里的历史陈述；
- dev 链 6 条漏洞在任何对外材料里都按「已知、待决策、有缓解」表述，不得写成「0 漏洞」或「已修复」；
- 任何升级都必须由用户明确批准后执行；升级失败要如实回滚并说明原因，不留半升级状态。
