/**
 * PRD 9.5 · 模型质量评测（8 项 Eval）与发布门禁
 *
 * 计算逻辑是真实的；基准集标注数据不是代码能生产的——没有标注数据时明确返回
 * NO_DATA，绝不编造「通过」。385 家基准集需要 2 名外贸背景标注员 + 第 3 人裁决。
 */
import { protocol } from './protocol.mjs'

const G = protocol.evalGates

export function baselineManifest() {
  return {
    baselineSize: G.baselineSize,
    composition: G.baselineComposition,
    annotators: '2 名外贸业务背景标注员独立标注 + 第 3 人裁决（研发不得兼任）',
    p0Metrics: G.p0,
    metrics: G.metrics,
    releaseRule: '任一 P0 指标不达标即阻断发布；换模型 / 换版本 / 改 prompt / 改 schema / 改类目树 / 每季度例行必须重跑',
    status: 'NOT_LABELED',
    note: '本服务不提供标注数据。M0 需先完成 385 家基准集标注，CI 才能执行全量评测。',
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
    diff: baselineVersion === 'unversioned'
      ? '未提供基线版本号，无法生成与上一版本的 diff 报告'
      : `与基线 ${baselineVersion} 的 diff 报告需在 CI 中读取历史评测归档后生成`,
  }
}
