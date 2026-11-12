# 发布证据与合规清单

> 版本：v0.9.0 补遗（B4） · 契约 `release-evidence-v1` / `release-compliance-v1`
> 定位：**把「哪些条件真的达标了」变成可执行判定**，而不是文档里的一句话。
> 当前结论：`releaseBlocked=true` · `releaseEligible=false` · `accuracyClaim=false`。

---

## 0. 先说清楚边界（最重要）

| 代码能做 | 代码**不能**做 |
|---|---|
| 校验证据格式、逐字自洽、去重、来源声明、人工签署是否齐备 | 证明证据是真实的——`attestation` 是签署人的责任声明，不是机器证明 |
| 用 `server/eval.mjs` 真实计算 integrity / outcome / consistency | 生成、补全、推断任何样本 |
| 读真实环境变量判断模型快照是否锁定 | 替运维去官网查版本号 |
| 读合规清单判断「字段是否填齐」 | 替法务取得意见书、替安全通过 CASA 审计、替发布工程申请 EV 证书 |

**发布前必须独立审计证据真实性。** 门禁全绿只说明「没有明显伪造且指标达标」，不说明「证据属实」，更不说明「产品可发布」。

---

## 1. 证据通道（integrity + outcome + consistency）

### 1.1 目录

默认 `<repo>/.evidence/`，可用 `LEADPILOT_EVIDENCE_DIR` 指向仓库外的受控目录。
`.evidence/` 已被 `.gitignore` 排除：真实原文与发送结果可能含个人信息，**绝不入库**。

三个文件都可选；**没有文件就是 `NO_DATA`**，这是正常且诚实的状态：

| 文件 | 用途 | 缺失时 |
|---|---|---|
| `integrity.json` | 用户指定 URL 抓取的真实原文与模型判断证据 | integrity `NO_DATA` |
| `outcome.json` | 用户真实发送后的退信 / 回复事件 | outcome `NO_DATA` |
| `consistency.json` | 同一输入两次真实运行的结果序列 | 一致性未测量，就算 integrity PASSED 也不算「可内测」 |

### 1.2 每份文件都必须带人工签署

```json
"attestation": {
  "attestedReal": true,
  "signedBy": "真实姓名 / 工号",
  "signedAt": "2026-11-12T09:30:00.000Z",
  "statement": "本人确认本文件内证据来自真实运行与真实发送结果，非合成、非推测，愿承担签署责任。"
}
```

缺 `attestation`、缺 `signedBy`、日期非法、`statement` 过短、或 `attestedReal !== true` → **整份不采信**。

### 1.3 会被拒绝的情形（行为级反例已入库）

- 任何 `synthetic` / `generated` / `mock` / `fixture` / `fake` / `dummy` / `placeholder` 标记；
- `quote` 不是 `sourceText` 的逐字子串（伪造引用）；
- 复制同一条证据凑 `minSamples`（按 `sourceUrl + quote + sourceText` 哈希去重）；
- `sourceUrl` 指向回环 / 私网字面量，或 `capturedAt` 非法；
- outcome 事件类型不是 `sent / bounced / replied`、缺 `source`、缺 `refId`、`refId` 重复；
- consistency 两次运行数组长度不等（不许用长度差掩盖不一致）；
- 提交空数组：没有证据时请**不要创建该文件**，保持 `NO_DATA`。

### 1.4 `integrity.json` 最小结构

```json
{
  "attestation": { "...": "见 1.2" },
  "records": [
    {
      "sourceUrl": "https://vendor.example/about",
      "capturedAt": "2026-11-12",
      "sourceOrigin": "user_directed_fetch",
      "quote": "we import hydraulic fittings",
      "sourceText": "about: we import hydraulic fittings from asia",
      "provenance": { "matched": 1, "total": 1 },
      "rules": { "passed": 2, "total": 2 },
      "schemaPass": true,
      "refused": false
    }
  ]
}
```

`sourceOrigin: "user_directed_fetch"` 决定「真实站点抓取样本是否已进入 integrity」这条阻断项。
阈值来自协议单一真源：`integrity minSamples=100`、可溯源率 ≥0.95、规则遵从率 =1、schema ≥0.99、逐字核验 ≥0.95、一致率 ≥0.98。

### 1.5 `outcome.json` 最小结构

```json
{
  "attestation": { "...": "见 1.2" },
  "events": [
    { "event": "sent", "refId": "smtp-20261112-001", "occurredAt": "2026-11-12", "source": "smtp-log" },
    { "event": "bounced", "refId": "smtp-20261112-002", "occurredAt": "2026-11-12", "source": "smtp-bounce-log" }
  ]
}
```

`minSamples=30`（sent + bounced）、`windowSize=100`、硬退信率 ≤3%；回复率只观测、不阻断。
**服务端已锁死绕过口**：`minSamples` 只能抬高不能下调，`windowSize` 只能缩小不能放大（放大窗口会把历史 `sent` 拉进来稀释退信率）。

### 1.6 操作

```bash
npm run evidence:check -- --self-test     # 证明校验器真的会拒绝伪造证据
npm run evidence:check                    # 查看当前证据目录的真实判定
npm run evidence:check -- --dir <path>   # 指定目录
npm run evidence:check -- --strict       # 要求内测资格证据达标，否则退出 1
LEADPILOT_REQUIRE_BASELINE=1 npm run gate # CI 里要求证据达标（放行 ≠ 可发布）
```

`GET /v1/release/status` 返回同一份判定的**摘要**（状态、计数、阻断项），不回传证据原文。
`/v1/gateway/health` 的 `evalGates.evidence` 也读同一来源，不再用无参默认值假装恒 false。

---

## 2. 外部合规清单（代码不能代替完成）

机器可读真源：`shared/release-compliance.json`。
只有 `status: "completed"` **且** `evidence` / `verifiedBy` / `verifiedAt` 三项齐备才算完成；只改状态不填证据仍计入阻断项。严禁由脚本自动改为 `completed`。

| # | 项目 | 需要什么证据 | 当前 |
|---|---|---|---|
| 1 | `provider_snapshot` · 模型快照锁定 | 运维注入官网可查的具体版本 ID，附版本页链接与变更记录；`-latest` 一律不算 | `not_started` |
| 2 | `oauth_casa` · Google OAuth + CASA Tier 2 | Google 审核通过函、CASA 第三方安全评估报告编号 | `not_started` |
| 3 | `ev_signature` · EV 代码签名 | 证书指纹、签名时间戳、可验证的安装包哈希 | `not_started` |
| 4 | `legal_pipl_gdpr` · 法律意见 | PIPL / GDPR 与数据源授权意见书编号、适用地域、留存与删除策略 | `not_started` |

这四项是**真实世界流程**：需要采购、审核、法务签字与外部机构出具报告。AI / 脚本不能代办，更不能伪造「已完成」。

---

## 3. 发布判据（三分离，任何一项都不能混用）

| 状态 | 由什么决定 | 当前 |
|---|---|---|
| `internalPreviewReady` | integrity PASSED + 两次运行一致性 PASSED（≥100 条真实原文） | `false` · `NO_DATA` |
| `externalValidated` | outcome PASSED（≥30 条真实发送结果，退信率 ≤3%） | `false` · `NO_DATA` |
| `releaseEligible` | 前两项 + 外部合规 4 项 + 产品决策 | **恒 `false`** |
| `accuracyClaim` | 无人工标注即无准确率 | **恒 `false`** |

`releaseEligible` 由 `releaseStatus()` 锁定为 `false`，是**当前阶段的产品决策**，不是算法算出来的结论。
即使三份证据全部达标、快照全部锁定、合规清单全部签字，也不会自动变成可发布——解除需要独立审计与明确的产品决策。

`npm run gate` 打印的 5 条 `BLOCKED` 全部由真实判定生成（旧版本是硬编码字符串）：

1. integrity 门禁状态；2. 业务结果门禁状态；3. 抓取来源样本数；4. provider 快照锁定数；5. 外部合规完成数。

`npm run gate` 退出码 0 **只代表自检断言没被伪造**，不代表可发布；`LEADPILOT_REQUIRE_BASELINE=1` 才要求内测证据达标。

---

## 4. 纪律

- 仓库不提供、不生成、不内嵌任何真实或合成的评测样本；
- 单元测试与门禁自检里的夹具只写在 `.tmp/` 临时目录、用完即删，绝不入库、绝不进入 `.evidence/`；
- 不自称准确率、不把「导入」写成「采集」、不把「导出草稿」写成「已发送」；
- 任何「已完成」都必须能指向仓库外的可核验证据，否则按未完成处理。
