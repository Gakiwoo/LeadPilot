/**
 * PRD 9.5 · 模型质量评测（8 项 Eval）与发布门禁
 *
 * 计算逻辑是真实的；基准集标注数据不是代码能生产的——没有标注数据时明确返回
 * NO_DATA，绝不编造「通过」。385 家基准集需要 2 名外贸背景标注员 + 第 3 人裁决。
 */
import { protocol } from './protocol.mjs'
import {
  contract as baselineContract, BASELINE_CONTRACT_VERSION, checkLabeledBaseline,
} from './baseline.mjs'

const G = protocol.evalGates
const DIFF = protocol.evalDiff
export const EVAL_DIFF_VERSION = DIFF.version

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
    releaseEligible: false,
    note: '本服务不提供标注数据。M0 需先完成 385 家基准集标注并通过导入校验，CI 才能执行全量评测。导入校验通过 ≠ 评测通过。',
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
      ? '至少一份评测归档为 NO_DATA：没有真实标注样本可比，绝不生成数值 delta，也不宣称无回退。'
      : diffPassed
        ? '两次评测均为 PASSED 且无 P0 回退；但 diff 通过 ≠ 可发布，385 家人工标注集与外部合规项仍需独立验收。'
        : `检测到回退或门禁未通过：${[...p0Regressions.map((r) => r.key), ...(gateRegression ? ['status_transition'] : [])].join('、') || current.status}；禁止发布。`,
  }
}
