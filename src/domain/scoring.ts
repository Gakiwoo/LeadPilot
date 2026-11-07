/**
 * PRD 第 6 章 + 6.7：五维评分引擎
 *
 * 三层结构：L1 规则（确定性） → L2 模型（离散枚举，不打分） → L3 证据校验 → 代码合成。
 * 硬纪律：同一输入必须得到同一分数；模型只提供判断，分数永远由代码计算。
 */
import type {
  Confidence,
  DimensionKey,
  DimensionResult,
  Evidence,
  RuleFeatures,
  ScoreCard,
  VerifiedJudgement,
} from '@/types'
import {
  ALPHA_HARD_CAP,
  COMPETITOR_IMPORT_MAX,
  COMPETITOR_MATCH_MIN,
  CONFLICT_THRESHOLD,
  CONTACT_SCORE,
  DIMENSION_LABELS,
  DIMENSION_WEIGHTS,
  GRADE_LABELS,
  IMPORT_SIGNAL_SCORE,
  MODEL_PARTICIPATION,
  PROVENANCE_RATE_MIN,
  SIZE_LABELS,
  SIZE_SCORE,
} from './constants'
import { customerTypeImportPrior } from './llm-judgement'

const DIM_KEYS: DimensionKey[] = ['match', 'propensity', 'size', 'import', 'contact']
export const clamp = (v: number, min = 0, max = 100) => Math.max(min, Math.min(max, v))
const round = (v: number) => Math.round(v)

interface RuleDimension {
  score: number
  hasData: boolean
  confidence: Confidence
  conclusion: string
  evidences: Evidence[]
  meta: { label: string; value: string }[]
}

interface ModelHint {
  score: number
  confidence: number
  coverage: number
  source: string
}

function ev(f: RuleFeatures, key: DimensionKey): Evidence[] {
  return f.evidences?.[key] ?? []
}

/** L1 规则层：全部输入为可核验的事实特征，无任何模型参与 */
export function computeRuleScores(f: RuleFeatures): Record<DimensionKey, RuleDimension> {
  // ── 6.1 匹配度：关键词 35% / 类目 25% / 语义 20% / 市场 20%
  const hitWeight = f.keywordHits.reduce((s, h) => s + h.count * h.positionWeight, 0)
  const keyword = clamp((hitWeight / 10) * 100)
  const category = [100, 80, 55, 40][f.categoryDistance]
  const semantic = clamp(f.semanticSimilarity * 100)
  const market = clamp(f.marketMatch * 100)
  const match = round(0.35 * keyword + 0.25 * category + 0.2 * semantic + 0.2 * market)
  const topHit = [...f.keywordHits].sort((a, b) => b.count - a.count)[0]
  const matchConclusion = topHit
    ? `官网 ${f.keywordHits.reduce((s, h) => s + h.count, 0)} 次命中「${topHit.term}」等关键词，类目路径距离 ${f.categoryDistance} 级，语义相似度 ${f.semanticSimilarity.toFixed(2)}`
    : '官网未命中产品关键词，仅能依据类目与语义判断'

  // ── 6.2 采购概率：频次 30% / 规模 25% / 季节 15% / 供应商 15% / 活跃 15%
  const b = f.importBatches24m
  const freq = b === null ? 0 : b === 0 ? 0 : b <= 2 ? 45 : b <= 6 ? 70 : b <= 12 ? 85 : 100
  const ratio = f.purchaseValueRatio
  const scale = ratio === null ? 50 : ratio >= 0.5 && ratio <= 3 ? 100 : ratio < 0.5 ? clamp(ratio * 120) : clamp(100 - (ratio - 3) * 18)
  const season = clamp(f.seasonWindow * 100)
  const supplier = clamp(f.supplierChangeSignal * 100)
  const activity = f.activitySignals === 0 ? 30 : clamp(30 + (f.activitySignals / 5) * 70)
  const propensity = round(0.3 * freq + 0.25 * scale + 0.15 * season + 0.15 * supplier + 0.15 * activity)
  const propensityHasData = b !== null
  const propensityConclusion = b !== null
    ? `近 24 个月 ${b} 批次进口，单批货值约为行业中位 ${ratio === null ? '未知' : `${ratio.toFixed(1)}×`}，${f.seasonWindow >= 0.8 ? '当前处于备货窗口' : '当前非历史采购高峰'}`
    : '无海关批次数据，采购时机仅能依据官网活跃信号推断'

  // ── 6.3 公司规模：档位映射，XL 略降（超出中小出口商服务半径）
  const size = SIZE_SCORE[f.sizeTier]
  const sizeHasData = f.sizeTier !== 'unknown'
  const sizeConclusion = sizeHasData
    ? `${f.sizeTier} 档 · ${SIZE_LABELS[f.sizeTier].range} · 年营收估 ${SIZE_LABELS[f.sizeTier].revenue}（置信度${f.sizeEvidenceLevel === 'high' ? '高' : f.sizeEvidenceLevel === 'mid' ? '中' : '低'}）`
    : '规模未知：无官方披露、无第三方登记、官网亦无可推断线索'

  // ── 6.4 进口可能性：无海关数据市场做「权重转移」而非补零
  const customs = f.customsRecords === null ? null : clamp(90 + Math.min(10, f.customsRecords))
  const wording = { confirmed: 100, inferred: 70, no_signal: 30, contradicted: 0 }[f.importWording]
  const brands = clamp((f.distributedBrands / 3) * 100)
  const terms = clamp((f.tradeTermHits / 4) * 100)
  const importScore = customs === null
    ? round((0.25 * wording + 0.2 * brands + 0.15 * terms) / 0.6) // 0.40 权重按比例分摊
    : round(0.4 * customs + 0.25 * wording + 0.2 * brands + 0.15 * terms)
  const importHasData = customs !== null || f.distributedBrands > 0 || f.tradeTermHits > 0 || f.importWording !== 'no_signal'
  const importConclusion = customs !== null
    ? `已证实进口：${f.customsRecords} 条海关记录，官网进口表述「${f.importWording}」，代理品牌 ${f.distributedBrands} 个`
    : f.customsDataAvailable
      ? '该国海关数据可得但未查到记录，进口身份依据官网信号推断'
      : '该国海关数据不公开，本因子权重已转移至官网信号，不给 0 分'

  // ── 6.5 联系方式：100% 规则，模型不参与
  let contact = CONTACT_SCORE[f.emailGrade]
  if (f.emailGrade === 'A' && (!f.smtpVerified || !f.hasNamedContact)) contact = CONTACT_SCORE.B
  if (!f.mxValid) contact = CONTACT_SCORE.D
  const grade = f.emailGrade
  const contactConclusion = `邮箱 ${GRADE_LABELS[grade].name}（${grade} 级）：MX ${f.mxValid ? '有效' : '不存在'} · SMTP ${f.smtpVerified ? '验证通过' : '未通过/不可验证'} · ${f.hasNamedContact ? '关联决策人' : '职位不明'}`

  return {
    match: {
      score: match, hasData: true, confidence: f.keywordHits.length >= 2 ? 'high' : 'mid',
      conclusion: matchConclusion, evidences: ev(f, 'match'),
      meta: [
        { label: '关键词命中', value: `${keyword.toFixed(0)} 分` },
        { label: '类目路径', value: `${category} 分` },
        { label: '语义相似度', value: `${semantic.toFixed(0)} 分` },
        { label: '目标市场', value: `${market.toFixed(0)} 分` },
      ],
    },
    propensity: {
      score: propensity, hasData: propensityHasData, confidence: b !== null && b >= 3 ? 'high' : 'low',
      conclusion: propensityConclusion, evidences: ev(f, 'propensity'),
      meta: [
        { label: '进口频次', value: b === null ? '无数据' : `${freq} 分` },
        { label: '采购规模', value: `${scale.toFixed(0)} 分` },
        { label: '季节窗口', value: `${season.toFixed(0)} 分` },
        { label: '活跃信号', value: `${activity.toFixed(0)} 分` },
      ],
    },
    size: {
      score: size, hasData: sizeHasData, confidence: f.sizeEvidenceLevel,
      conclusion: sizeConclusion, evidences: ev(f, 'size'),
      meta: [{ label: '档位映射', value: `${size} 分` }, { label: '推算来源', value: f.employeeCount ? `官网团队页 ${f.employeeCount} 人` : '第三方登记 / 站点规模粗估' }],
    },
    import: {
      score: importScore, hasData: importHasData, confidence: customs !== null ? 'high' : 'mid',
      conclusion: importConclusion, evidences: ev(f, 'import'),
      meta: [
        { label: '海关记录', value: customs === null ? '不可得（权重转移）' : `${customs.toFixed(0)} 分` },
        { label: '官网表述', value: `${wording} 分` },
        { label: '代理品牌', value: `${brands.toFixed(0)} 分` },
        { label: '贸易条款', value: `${terms.toFixed(0)} 分` },
      ],
    },
    contact: {
      score: contact, hasData: true, confidence: f.smtpVerified ? 'high' : 'mid',
      conclusion: contactConclusion, evidences: ev(f, 'contact'),
      meta: [
        { label: '等级映射', value: `${contact} 分` },
        { label: 'MX', value: f.mxValid ? '有效' : '不存在' },
        { label: 'SMTP', value: f.smtpVerified ? '通过' : '未验证' },
        { label: '域名匹配', value: f.domainMatch ? '企业域名' : '非企业域名' },
      ],
    },
  }
}

/** L2 判断层：把受限枚举映射成离散分数（不是模型给的分数） */
function buildModelHints(
  j: VerifiedJudgement | null,
  rule: Record<DimensionKey, RuleDimension>,
  f: RuleFeatures,
): Partial<Record<DimensionKey, ModelHint>> {
  if (!j) return {}
  const hints: Partial<Record<DimensionKey, ModelHint>> = {}
  const cov = j.provenanceRate

  if (j.customerType.accepted) {
    const prior = customerTypeImportPrior(j.customerType.value)
    const competitor = j.negativeFlags.includes('competitor_suspected')
    hints.match = {
      score: competitor ? 35 : clamp(prior === null ? rule.match.score : 0.6 * f.semanticSimilarity * 100 + 0.4 * prior),
      confidence: j.customerType.confidence, coverage: cov, source: `客户类型=${j.customerType.value}`,
    }
  }
  if (j.importSignal.accepted) {
    const mapped = IMPORT_SIGNAL_SCORE[j.importSignal.value]
    hints.import = {
      score: mapped ?? rule.import.score, // no_signal → 沿用规则值，不惩罚
      confidence: j.importSignal.confidence, coverage: cov, source: `进口信号=${j.importSignal.value}`,
    }
    hints.propensity = {
      score: clamp(55 + (mapped === undefined ? rule.propensity.score : mapped) * 0.25 + f.activitySignals * 4),
      confidence: j.importSignal.confidence * 0.8, coverage: cov, source: '活跃/采购前置信号',
    }
  }
  if (j.sizeTier.accepted) {
    hints.size = {
      score: SIZE_SCORE[j.sizeTier.value] || rule.size.score,
      confidence: j.sizeTier.confidence, coverage: cov, source: `规模档=${j.sizeTier.value}`,
    }
  }
  // contact：MODEL_PARTICIPATION = 0，刻意不生成 hint（PRD 6.7.5）
  return hints
}

export interface BuildOptions {
  /** 模型网关是否可用；false 时按 F0-4「把不确定性显式化」处理 */
  modelAvailable?: boolean
  /** 是否强制复议（T2 疑难样本） */
  forceReview?: boolean
}

/**
 * L3 证据校验 → 代码合成。
 * α = min(分维参与度上限, 0.60, confidence × evidence_coverage)
 * 冲突（|rule − model| > 30）不取平均，保守取规则值并进入复议队列。
 */
export function buildScoreCard(
  features: RuleFeatures,
  judgement: VerifiedJudgement | null,
  options: BuildOptions = {},
): ScoreCard {
  const { modelAvailable = true, forceReview = false } = options
  const rule = computeRuleScores(features)
  const hints = buildModelHints(judgement, rule, features)
  const modelDegraded = modelAvailable === false || !judgement

  const dimensions = {} as Record<DimensionKey, DimensionResult>
  const warnings: string[] = []

  for (const key of DIM_KEYS) {
    const r = rule[key]
    const hint = hints[key]
    const cap = Math.min(MODEL_PARTICIPATION[key], ALPHA_HARD_CAP)
    // α = min(0.60, 分维参与度上限, confidence × evidence_coverage)
    const alpha = hint ? Math.min(cap, Math.max(0, hint.confidence * hint.coverage)) : 0
    const conflict = hint !== undefined && Math.abs(r.score - hint.score) > CONFLICT_THRESHOLD
    const score = !r.hasData ? 0 : conflict ? r.score : hint ? round(r.score * (1 - alpha) + hint.score * alpha) : r.score

    // 只展示本维度、且通过证据校验的模型引用；被丢弃的伪造引用不得进入证据链
    const modelEvidences: Evidence[] = !hint || !judgement ? [] :
      key === 'match' && judgement.customerType.accepted ? judgement.customerType.evidence :
      (key === 'import' || key === 'propensity') && judgement.importSignal.accepted ? judgement.importSignal.evidence :
      key === 'size' && judgement.sizeTier.accepted ? judgement.sizeTier.evidence : []
    const evidences = [...r.evidences, ...modelEvidences]
      .filter((e, idx, arr) => arr.findIndex((x) => x.quote === e.quote) === idx)

    let confidence: Confidence = r.confidence
    if (!r.hasData) confidence = 'low'
    if (alpha > 0 && alpha < 0.15) confidence = confidence === 'high' ? 'mid' : confidence
    if (conflict) confidence = 'low'
    if (modelDegraded && key !== 'contact') confidence = 'low'

    const displayValue = !r.hasData
      ? '无数据'
      : key === 'size' ? features.sizeTier
        : key === 'contact' ? features.emailGrade
          : String(score)

    dimensions[key] = {
      key, ruleScore: r.score, modelScore: hint ? hint.score : null, alpha: Number(alpha.toFixed(3)),
      score, hasData: r.hasData, confidence, conflict,
      needsReview: conflict || forceReview,
      conclusion: r.hasData ? r.conclusion : '该维度无可用公开数据，已按权重再归一化处理，不按 0 分计入',
      evidences,
      displayValue,
      meta: [
        ...r.meta,
        { label: '规则分', value: `${r.score}` },
        { label: '模型判断', value: hint ? hint.source : key === 'contact' ? '不参与（纯技术验证）' : '无（规则估算）' },
        { label: '模型权重 α', value: alpha.toFixed(2) },
        ...(conflict ? [{ label: '冲突处理', value: '规则/模型相差 > 30，保守取规则值并标记待复议' }] : []),
      ],
    }
    if (conflict) warnings.push(`${DIMENSION_LABELS[key].zh}：规则分 ${r.score} 与模型判断 ${hint?.score} 冲突，已保守取规则值并进入复议队列`)
  }

  // 权重再归一化（PRD 6.6：缺失维度不补零）
  const active = DIM_KEYS.filter((k) => dimensions[k].hasData)
  const weightSum = active.reduce((s, k) => s + DIMENSION_WEIGHTS[k], 0)
  const weights = {} as Record<DimensionKey, number>
  for (const k of DIM_KEYS) weights[k] = dimensions[k].hasData ? DIMENSION_WEIGHTS[k] / weightSum : 0
  const totalScore = round(active.reduce((s, k) => s + dimensions[k].score * weights[k], 0))

  const coveredDimensions = active.length
  let overallConfidence: Confidence = coveredDimensions >= 5 ? 'high' : coveredDimensions === 4 ? 'mid' : 'low'
  if (modelDegraded) overallConfidence = 'low'
  if (DIM_KEYS.filter((k) => dimensions[k].conflict).length > 0) overallConfidence = 'low'

  const competitorFlag = dimensions.match.score >= COMPETITOR_MATCH_MIN && dimensions.import.score < COMPETITOR_IMPORT_MAX
  if (competitorFlag) warnings.push('疑似同行：匹配度极高但无进口信号，默认折叠，建议人工复核后再联系')

  const missing = DIM_KEYS.filter((k) => !dimensions[k].hasData)
  if (missing.length) warnings.push(`综合分基于 ${coveredDimensions}/5 维（缺失：${missing.map((k) => DIMENSION_LABELS[k].zh).join('、')}），权重已再归一化`)
  if (modelDegraded) warnings.push('E6005 模型网关不可用：本次为规则估算，未经模型校验，分数以区间显示')
  if (judgement && judgement.provenanceRate < PROVENANCE_RATE_MIN) warnings.push(`Provenance Rate ${(judgement.provenanceRate * 100).toFixed(0)}% < ${(PROVENANCE_RATE_MIN * 100).toFixed(0)}%，未通过证据校验的字段已丢弃`)

  const totalRange: [number, number] | null = overallConfidence === 'low'
    ? [clamp(totalScore - 8), clamp(totalScore + 8)] : null

  return {
    dimensions,
    totalScore,
    totalRange,
    totalDisplay: totalRange ? `${totalRange[0]}–${totalRange[1]}` : String(totalScore),
    confidence: overallConfidence,
    coveredDimensions,
    weights,
    competitorFlag,
    canSend: features.emailGrade !== 'D',
    warnings,
    provenanceRate: judgement?.provenanceRate ?? 0,
    modelDegraded,
  }
}
