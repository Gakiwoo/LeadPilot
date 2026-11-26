/**
 * PRD 9.5 · 模型质量评测与发布门禁
 *
 * v0.8.0 决策（用户拍板）：不做 385 家人工标注基准集。评测口径改为 integrity + outcome：
 *   - integrity：可溯源率 / 规则遵从率 / schema 合法率 / 证据逐字可核验率（零人工）
 *   - outcome：用户真实发送后的硬退信率（客观、无需标注）
 *   - consistency：同一输入跨运行一致率（只证明可复现，不做准确率推断）
 * 计算逻辑真实；无真实样本时明确返回 NO_DATA，绝不编造「通过」。
 * 本模块不做任何准确率断言：没有标注就没有 accuracy，accuracyClaim 恒 false。
 * legacy：385 家人工标注路径保留（evaluateBaseline），仅当将来真的导入人工标注时启用。
 */
import { protocol } from './protocol.mjs'
import {
  contract as baselineContract, BASELINE_CONTRACT_VERSION, checkLabeledBaseline,
} from './baseline.mjs'

const G = protocol.evalGates
const DIFF = protocol.evalDiff
const IG = G.integrity
const OG = G.outcome
const RP = G.releasePolicy
export const EVAL_DIFF_VERSION = DIFF.version
export const INTEGRITY_GATE_VERSION = IG.version
export const OUTCOME_GATE_VERSION = OG.version
export const RELEASE_POLICY_VERSION = RP.version

export function baselineManifest() {
  const imported = checkLabeledBaseline()
  return {
    baselineSize: G.baselineSize,
    composition: G.baselineComposition,
    annotators: '2 名外贸业务背景标注员独立标注 + 第 3 人裁决（研发不得兼任）',
    p0Metrics: G.p0,
    metrics: G.metrics,
    releaseRule: '任一 P0 指标不达标即阻断发布；换模型 / 换版本 / 改 prompt / 改 schema / 改类目树 / 每季度例行必须重跑',
    status: 'NOT_LABELED',
    contractVersion: BASELINE_CONTRACT_VERSION,
    importStatus: imported.status,
    contract: {
      acceptedFormats: baselineContract.acceptedFormats,
      requiredFields: Object.entries(baselineContract.fields).filter(([, f]) => f.required).map(([k]) => k),
      compositionRules: baselineContract.compositionRules.map((r) => r.id),
      annotatorPolicy: baselineContract.annotatorPolicy,
      forbiddenFields: baselineContract.forbiddenFields,
    },
    validateEndpoint: 'POST /v1/eval/baseline/validate',
    contractEndpoint: 'GET /v1/eval/baseline/contract',
    diffEndpoint: DIFF.endpoint,
    diffVersion: EVAL_DIFF_VERSION,
    legacy: true,
    labelsRequired: false,
    accuracyClaim: false,
    evalMode: IG.mode,
    integrityGate: integrityManifest(),
    outcomeGate: outcomeManifest(),
    release: releaseStatus(),
    releaseEligible: false,
    note: 'v0.8.0 决策：不做 385 家人工标注基准集，本契约降级为 legacy（保留格式与校验器，将来导入真实标注才启用）。当前评测口径为 integrity + outcome，无真实证据时返回 NO_DATA；本服务不做任何准确率断言。',
  }
}

function cohenKappa(pairs) {
  if (!pairs.length) return null
  const labels = [...new Set(pairs.flatMap((p) => [p.expected, p.predicted]))]
  const n = pairs.length
  let po = 0
  const row = new Map(), col = new Map()
  for (const p of pairs) {
    if (p.expected === p.predicted) po++
    row.set(p.expected, (row.get(p.expected) ?? 0) + 1)
    col.set(p.predicted, (col.get(p.predicted) ?? 0) + 1)
  }
  po /= n
  let pe = 0
  for (const l of labels) pe += ((row.get(l) ?? 0) / n) * ((col.get(l) ?? 0) / n)
  return pe === 1 ? 1 : (po - pe) / (1 - pe)
}

function pearson(xs, ys) {
  const n = xs.length
  if (n < 2) return null
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my
    num += a * b; dx += a * a; dy += b * b
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null
}

/**
 * @param results 标注样本：[{ expected:{customer_type,size_tier,import_signal,match_rank,propensity_rank},
 *                predicted:{...}, provenance:{matched,total}, signals:{true,found,actual},
 *                rules:{passed,total}, schemaPass:boolean, refused:boolean }]
 */
export function evaluateBaseline(results, baselineVersion = 'unversioned') {
  if (!Array.isArray(results) || results.length === 0) {
    return {
      ok: false, status: 'NO_DATA', baselineVersion,
      message: `未提供标注样本，无法评测。需 ≥ ${G.baselineSize} 家人工标注基准集（${G.baselineComposition}）。`,
      diffEndpoint: DIFF.endpoint,
      diffVersion: EVAL_DIFF_VERSION,
      manifest: baselineManifest(),
    }
  }

  const sum = (get) => results.reduce((s, r) => s + (Number(get(r)) || 0), 0)
  const provMatched = sum((r) => r.provenance?.matched)
  const provTotal = sum((r) => r.provenance?.total)
  const signalTrue = sum((r) => r.signals?.true)
  const signalFalse = sum((r) => r.signals?.false)
  const signalFound = sum((r) => r.signals?.found)
  const signalActual = sum((r) => r.signals?.actual)
  const rulesPassed = sum((r) => r.rules?.passed)
  const rulesTotal = sum((r) => r.rules?.total)
  const schemaPass = results.filter((r) => r.schemaPass === true).length
  const refusals = results.filter((r) => r.refused === true).length

  const kappaPairs = results
    .filter((r) => r.expected?.customer_type && r.predicted?.customer_type)
    .map((r) => ({ expected: r.expected.customer_type, predicted: r.predicted.customer_type }))
  const rankPairs = results.filter((r) => typeof r.expected?.match_rank === 'number' && typeof r.predicted?.match_rank === 'number')

  const metrics = {
    provenance_rate: provTotal ? provMatched / provTotal : null,
    signal_precision: (signalTrue + signalFalse) ? signalTrue / (signalTrue + signalFalse) : null,
    extraction_recall: signalActual ? signalFound / signalActual : null,
    rule_compliance: rulesTotal ? rulesPassed / rulesTotal : null,
    kappa: cohenKappa(kappaPairs),
    spearman_rho: pearson(rankPairs.map((r) => r.expected.match_rank), rankPairs.map((r) => r.predicted.match_rank)),
    schema_pass_rate: results.length ? schemaPass / results.length : null,
    refusal_rate: results.length ? refusals / results.length : null,
  }

  const checks = Object.entries(G.metrics).map(([key, def]) => {
    const value = metrics[key]
    const measured = value !== null && value !== undefined
    const passed = measured && (def.direction === '>=' ? value >= def.threshold : value <= def.threshold)
    return { key, name: def.name, value, threshold: def.threshold, direction: def.direction, measured, passed, p0: G.p0.includes(key) }
  })

  const p0Failures = checks.filter((c) => c.p0 && (!c.measured || !c.passed))
  const sampleTooSmall = results.length < G.baselineSize
  const releaseBlocked = p0Failures.length > 0 || sampleTooSmall

  return {
    ok: !releaseBlocked,
    status: releaseBlocked ? 'BLOCKED' : 'PASSED',
    baselineVersion,
    sampleSize: results.length,
    sampleTooSmall,
    baselineRequired: G.baselineSize,
    metrics,
    checks,
    p0Failures: p0Failures.map((c) => `${c.name}：${c.value ?? '未测量'} ${c.direction} ${c.threshold}`),
    releaseRule: '任一 P0 指标不达标即阻断发布（PRD 9.5.3）',
    diffEndpoint: DIFF.endpoint,
    diffVersion: EVAL_DIFF_VERSION,
    diffNote: '单次评测不生成版本 diff；把上一版本与本次评测归档显式提交到 /v1/eval/diff，由纯函数 diffEvalRuns 计算。',
  }
}

/** 只有「两次真实评测归档」才算合法输入；绝不拿占位对象或空 metrics 凑一份 diff */
function isEvalRun(run) {
  return Boolean(run) && typeof run === 'object' && !Array.isArray(run)
    && typeof run.status === 'string'
    && run.metrics && typeof run.metrics === 'object' && !Array.isArray(run.metrics)
}

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v)
const passed = (v, def) => isNumber(v) && (def.direction === '>=' ? v >= def.threshold : v <= def.threshold)

/**
 * PRD 9.5.3 · 评测版本 diff（纯函数，无 IO、无时间依赖、无随机数）。
 *
 * 只比较调用方显式提交的两份评测归档；仓库没有、也不会伪造历史归档。
 * P0 数值下降 / 跨阈值转失败 / 已测量变未测量，任一命中即 regression。
 * 无论 diff 结论如何，releaseEligible 恒为 false：外部阻断项（385 家标注、
 * 双标独立、数据源沙箱、OAuth/CASA）不是 diff 能证明的。
 */
export function diffEvalRuns(prev, current) {
  if (!isEvalRun(prev) || !isEvalRun(current)) {
    return {
      ok: false, code: 'E4006', status: 'INVALID_INPUT', version: EVAL_DIFF_VERSION,
      reason: `需要两次真实评测归档（各自含 status 与 metrics）。${DIFF.endpoint} 不接受占位对象，本仓库也不内嵌历史归档。`,
      releaseEligible: false,
    }
  }

  const summaryOf = (run) => ({
    baselineVersion: String(run.baselineVersion ?? 'unversioned'),
    status: run.status,
    sampleSize: Number.isInteger(run.sampleSize) ? run.sampleSize : null,
    ok: Boolean(run.ok),
  })
  const noBaseline = prev.status === 'NO_DATA' || current.status === 'NO_DATA'

  const rows = Object.entries(G.metrics).map(([key, def]) => {
    const a = prev.metrics[key]
    const b = current.metrics[key]
    const aMeasured = isNumber(a)
    const bMeasured = isNumber(b)
    const aPassed = passed(a, def)
    const bPassed = passed(b, def)
    const delta = aMeasured && bMeasured ? Number((b - a).toFixed(6)) : null
    const valueRegression = aMeasured && bMeasured && (def.direction === '>=' ? b < a : b > a)
    const measurementLost = aMeasured && !bMeasured
    const thresholdCrossed = aPassed && !bPassed
    return {
      key, name: def.name, p0: G.p0.includes(key),
      threshold: def.threshold, direction: def.direction,
      prevValue: aMeasured ? a : null,
      currentValue: bMeasured ? b : null,
      delta, measured: bMeasured,
      prevPassed: aPassed, currentPassed: bPassed,
      regression: !noBaseline && (valueRegression || measurementLost || Boolean(thresholdCrossed)),
      improvement: !noBaseline && aMeasured && bMeasured && (def.direction === '>=' ? b > a : b < a),
      measurementLost, thresholdCrossed: Boolean(thresholdCrossed),
    }
  })

  const regressions = rows.filter((r) => r.regression)
  const p0Regressions = regressions.filter((r) => r.p0)
  const improvements = rows.filter((r) => r.improvement).map((r) => r.key)
  const gateRegression = prev.status === 'PASSED' && current.status !== 'PASSED'
  const diffPassed = !noBaseline && !gateRegression && p0Regressions.length === 0
    && prev.status === 'PASSED' && current.status === 'PASSED'

  let status
  if (noBaseline) status = DIFF.noBaselineStatus
  else if (gateRegression || p0Regressions.length > 0) status = 'REGRESSION'
  else if (current.status !== 'PASSED' || prev.status !== 'PASSED') status = 'BLOCKED'
  else if (improvements.length > 0) status = 'IMPROVED'
  else status = 'STABLE'

  return {
    ok: !noBaseline,
    status,
    version: EVAL_DIFF_VERSION,
    prev: summaryOf(prev), current: summaryOf(current),
    statusTransition: `${prev.status} → ${current.status}`,
    sampleSizeDelta: Number.isInteger(prev.sampleSize) && Number.isInteger(current.sampleSize)
      ? current.sampleSize - prev.sampleSize : null,
    rows,
    regressions: regressions.map((r) => r.key),
    p0Regressions: p0Regressions.map((r) => r.key),
    improvements,
    gateRegression,
    diffPassed,
    releaseBlocked: !diffPassed,
    releaseEligible: false,
    baseline: {
      importStatus: checkLabeledBaseline().status,
      requiredSize: G.baselineSize,
    },
    note: noBaseline
      ? '至少一份评测归档为 NO_DATA：没有真实证据可比，绝不生成数值 delta，也不宣称无回退。'
      : diffPassed
        ? '两次评测均为 PASSED 且无 P0 回退；但 diff 通过 ≠ 可发布，integrity / outcome 与外部合规项仍需独立验收。'
        : `检测到回退或门禁未通过：${[...p0Regressions.map((r) => r.key), ...(gateRegression ? ['status_transition'] : [])].join('、') || current.status}；禁止发布。`,
  }
}

/* =========================================================================
 * v0.8.0 · integrity + outcome 评测口径（零人工标注）
 *
 * 决策背景：385 家人工标注基准集与商业数据源采购不做（用户拍板）。
 * 替代方案只能换「拿什么当验收证据」，不能换「证据必须是真的」：
 *   - integrity：代码可算的完整性 / 可溯源 / 合规，证明「没编造、没违规」
 *   - consistency：同一输入跨运行一致率，证明「可复现」而非「判得准」
 *   - outcome：用户真实发送后的硬退信率，客观、无需任何标注
 * 三者都不产生 accuracy（准确率），accuracyClaim 恒 false；无真实样本一律 NO_DATA。
 * ========================================================================= */

const RATIO = (num, den) => (den > 0 ? num / den : null)

function metricChecks(metrics, defs, p0Keys) {
  return Object.entries(defs).map(([key, def]) => {
    const value = isNumber(metrics[key]) ? metrics[key] : null
    const measured = value !== null
    const ok = measured && (def.direction === '>=' ? value >= def.threshold : value <= def.threshold)
    return {
      key, name: def.name, value, threshold: def.threshold, direction: def.direction,
      measured, passed: ok, p0: p0Keys.includes(key),
    }
  })
}

const fmtFailures = (checks) => checks
  .filter((c) => c.p0 && (!c.measured || !c.passed))
  .map((c) => `${c.name}：${c.value ?? '未测量'} ${c.direction} ${c.threshold}`)

export function integrityManifest() {
  return {
    gateVersion: INTEGRITY_GATE_VERSION,
    mode: IG.mode,
    labelsRequired: IG.labelsRequired,
    accuracyClaim: IG.accuracyClaim,
    minSamples: IG.minSamples,
    consistency: IG.consistency,
    p0: IG.p0,
    metrics: IG.metrics,
    endpoint: 'POST /v1/eval/integrity',
    note: '完整性 / 可溯源 / 一致性门禁：零人工标注。它证明「没编造、没违规、可复现」，不证明「判得准」；产品文案不得宣称准确率。',
  }
}

export function outcomeManifest() {
  return {
    gateVersion: OUTCOME_GATE_VERSION,
    labelsRequired: OG.labelsRequired,
    minSamples: OG.minSamples,
    windowSize: OG.windowSize,
    metrics: OG.metrics,
    endpoint: 'POST /v1/eval/outcome',
    note: '业务结果门禁：用用户自己的真实发送结果验证（退信率客观、无需标注）。样本不足返回 NO_DATA / INSUFFICIENT；不生成任何准确率断言。',
  }
}

/**
 * 一致性：比较两次运行的结果序列（规范化 JSON 序列化后逐项相等）。
 * 只证明可复现，不做准确率推断；调用方须保证对象键序稳定（同一代码路径天然稳定）。
 */
export function evaluateConsistency(prevRun, currentRun, opts = {}) {
  const threshold = isNumber(opts.threshold) ? opts.threshold : IG.consistency.threshold
  const a = Array.isArray(prevRun) ? prevRun : []
  const b = Array.isArray(currentRun) ? currentRun : []
  if (!a.length || !b.length) {
    return {
      ok: false, status: 'NO_DATA', gateVersion: INTEGRITY_GATE_VERSION,
      threshold, total: 0, identical: 0, rate: null, lengthMismatch: false,
      accuracyClaim: false, note: '没有两次运行结果，一致性无法测量（不等于一致）。',
    }
  }
  const total = Math.min(a.length, b.length)
  let identical = 0
  for (let i = 0; i < total; i++) {
    if (JSON.stringify(a[i]) === JSON.stringify(b[i])) identical++
  }
  const rate = total ? identical / total : null
  const lengthMismatch = a.length !== b.length
  const ok = !lengthMismatch && isNumber(rate) && rate >= threshold
  return {
    ok, status: ok ? 'PASSED' : 'BLOCKED', gateVersion: INTEGRITY_GATE_VERSION,
    threshold, total, identical, rate, lengthMismatch,
    accuracyClaim: false,
    note: ok
      ? '两次运行结果一致：只能说明可复现，不能说明判断正确。'
      : `两次运行不一致（${identical}/${total}${lengthMismatch ? '，且长度不同' : ''}）：不得对外宣称稳定。`,
  }
}

/**
 * integrity 门禁。入参是「每个真实样本的代码可算证据」，不是标注：
 *   [{ provenance:{matched,total}, rules:{passed,total}, schemaPass:boolean,
 *      refused:boolean, quote?:string, sourceText?:string }, ...]
 * 没有真实样本 → NO_DATA；样本数不足 minSamples → BLOCKED（不拿小样本凑 PASSED）。
 */
export function evaluateIntegrity(records, opts = {}) {
  const minSamples = Number.isInteger(opts.minSamples) ? opts.minSamples : IG.minSamples
  const accuracyClaim = false
  if (!Array.isArray(records) || records.length === 0) {
    return {
      ok: false, status: 'NO_DATA', gateVersion: INTEGRITY_GATE_VERSION, mode: IG.mode,
      labelsRequired: false, accuracyClaim, sampleSize: 0, minSamples,
      metrics: {}, checks: [], p0Failures: [], consistency: null, warnings: [],
      message: '未提供任何真实证据：integrity 门禁返回 NO_DATA，绝不拿合成样本凑 PASSED。',
    }
  }

  const sum = (pick) => records.reduce((s, r) => s + (Number(pick(r)) || 0), 0)
  const provMatched = sum((r) => r.provenance?.matched)
  const provTotal = sum((r) => r.provenance?.total)
  const rulesPassed = sum((r) => r.rules?.passed)
  const rulesTotal = sum((r) => r.rules?.total)
  const schemaPass = records.filter((r) => r.schemaPass === true || r.schema_pass === true).length
  const refusals = records.filter((r) => r.refused === true).length
  const quoteChecked = records.filter((r) => typeof r.quote === 'string' && r.quote.length > 0
    && typeof (r.sourceText ?? r.source_text) === 'string')
  const quoteOk = quoteChecked.filter((r) => (r.sourceText ?? r.source_text).includes(r.quote)).length

  const metrics = {
    provenance_rate: RATIO(provMatched, provTotal),
    rule_compliance: RATIO(rulesPassed, rulesTotal),
    schema_pass_rate: records.length ? schemaPass / records.length : null,
    evidence_quote_rate: quoteChecked.length ? quoteOk / quoteChecked.length : null,
    refusal_rate: records.length ? refusals / records.length : null,
  }

  const warnings = []
  if (!quoteChecked.length) warnings.push('没有任何样本携带 quote + sourceText：证据逐字可核验率未测量，不得宣称"可溯源"')
  let consistency = null
  if (opts.consistency && typeof opts.consistency === 'object') {
    consistency = opts.consistency
    if (isNumber(consistency.rate)) metrics.consistency_rate = consistency.rate
  } else {
    warnings.push('未提供两次运行一致性结果：一致性未测量（不等于一致）')
  }

  const checks = metricChecks(metrics, IG.metrics, IG.p0)
  const p0Failures = fmtFailures(checks)
  if (consistency) {
    const consistencyOk = typeof consistency.ok === 'boolean'
      ? consistency.ok
      : isNumber(consistency.rate) && consistency.rate >= IG.consistency.threshold
    if (!consistencyOk) p0Failures.push(`运行一致率：${consistency.rate ?? '未测量'} >= ${IG.consistency.threshold}`)
  }
  const sampleTooSmall = records.length < minSamples
  const releaseBlocked = p0Failures.length > 0 || sampleTooSmall

  return {
    ok: !releaseBlocked,
    status: releaseBlocked ? 'BLOCKED' : 'PASSED',
    gateVersion: INTEGRITY_GATE_VERSION,
    mode: IG.mode,
    labelsRequired: false,
    accuracyClaim,
    sampleSize: records.length,
    minSamples,
    sampleTooSmall,
    metrics,
    checks,
    p0Failures,
    consistency,
    warnings,
    releaseRule: `P0 全绿且样本数 ≥ ${minSamples} 才可内部预览；本门禁不产生任何准确率断言。`,
    note: releaseBlocked
      ? 'integrity 门禁未通过：不得宣称「已验证」或「准确」。'
      : 'integrity 门禁通过：可进入内测，但仍不得对外宣称准确率；业务结果需由 outcome 门禁独立验证。',
  }
}

/**
 * outcome 门禁。入参是用户自己的真实发送事件：[{event:'sent'|'bounced'|'replied'|...}] 或字符串数组。
 * 样本不足 → NO_DATA / INSUFFICIENT；退信率超阈值 → BLOCKED。永不生成准确率。
 */
export function evaluateOutcome(events, opts = {}) {
  const windowSize = Number.isInteger(opts.windowSize) ? opts.windowSize : OG.windowSize
  const minSamples = Number.isInteger(opts.minSamples) ? opts.minSamples : OG.minSamples
  const p0Keys = Object.entries(OG.metrics).filter(([, d]) => d.p0 === true).map(([k]) => k)
  const list = Array.isArray(events) ? events.slice(-windowSize) : []
  const counts = { sent: 0, bounced: 0, replied: 0 }
  for (const e of list) {
    const key = typeof e === 'string' ? e : e?.event
    if (key in counts) counts[key]++
  }
  const sampleSize = counts.sent + counts.bounced
  const metrics = {
    bounce_rate: RATIO(counts.bounced, sampleSize),
    reply_rate: RATIO(counts.replied, counts.sent),
  }

  if (!sampleSize) {
    return {
      ok: false, status: 'NO_DATA', gateVersion: OUTCOME_GATE_VERSION,
      labelsRequired: false, accuracyClaim: false,
      sampleSize: 0, minSamples, windowSize, counts, metrics, checks: [], p0Failures: [],
      message: '没有任何真实发送结果：outcome 门禁返回 NO_DATA，不伪造退信率或回复率。',
    }
  }

  const checks = metricChecks(metrics, OG.metrics, p0Keys)
  const p0Failures = fmtFailures(checks)
  const sampleTooSmall = sampleSize < minSamples
  const releaseBlocked = p0Failures.length > 0 || sampleTooSmall
  const status = p0Failures.length > 0 ? 'BLOCKED' : sampleTooSmall ? 'INSUFFICIENT' : 'PASSED'

  return {
    ok: !releaseBlocked,
    status,
    gateVersion: OUTCOME_GATE_VERSION,
    labelsRequired: false,
    accuracyClaim: false,
    sampleSize,
    minSamples,
    windowSize,
    counts,
    metrics,
    checks,
    p0Failures,
    sampleTooSmall,
    releaseRule: `退信率 ≤ ${OG.metrics.bounce_rate.threshold} 且样本数 ≥ ${minSamples}；回复率仅观测、不阻断。`,
    note: status === 'PASSED'
      ? '业务结果门禁通过：只说明真实发送的退信率达标，不等于判断准确率。'
      : status === 'INSUFFICIENT'
        ? `样本不足（${sampleSize} < ${minSamples}）：不判定通过，也不宣称任何比率。`
        : '业务结果门禁未通过：退信率超阈值，必须先修数据/邮箱质量再继续。',
  }
}

/**
 * 发布状态。三件事分清楚：
 *  - internalPreviewReady：integrity 门禁 PASSED（可拿去内测）
 *  - externalValidated：outcome 门禁 PASSED（业务结果有真实证据）
 *  - releaseEligible：正式发布资格，恒 false（provider 快照 / OAuth / EV / 法务未完成）
 * accuracyClaim 永远 false：没有人工标注就没有准确率。
 */
export function releaseStatus({ integrity, outcome } = {}) {
  const internalPreviewReady = Boolean(integrity && integrity.ok === true && integrity.status === 'PASSED')
  const externalValidated = Boolean(outcome && outcome.ok === true && outcome.status === 'PASSED')
  return {
    version: RELEASE_POLICY_VERSION,
    internalPreviewReady,
    externalValidated,
    releaseEligible: false,
    accuracyClaim: false,
    labelsRequired: false,
    remainingExternalBlockers: RP.remainingExternalBlockers,
    droppedByDecision: RP.droppedByDecision,
    reasons: [
      internalPreviewReady
        ? 'integrity 门禁 PASSED：完整性 / 可溯源 / 一致性达标'
        : 'integrity 门禁未通过：无真实原文证据或 P0 指标未达标',
      externalValidated
        ? 'outcome 门禁 PASSED：真实发送退信率达标'
        : 'outcome 门禁未通过：真实发送样本不足或退信率超阈值',
      '正式发布仍需 provider 快照 / OAuth / EV 签名 / 法务意见：releaseEligible 恒 false',
    ],
    note: 'internalPreviewReady 只表示「可内测」，externalValidated 只表示「业务结果有真实证据」；两者都不等于准确率，也不等于可发布。',
  }
}
