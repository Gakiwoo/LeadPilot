import { describe, expect, it } from 'vitest'
import { buildScoreCard, computeRuleScores } from '@/domain/scoring'
import { acceptModelJudgement } from '@/domain/llm-judgement'
import { DIMENSION_WEIGHTS } from '@/domain/constants'
import { makeFeatures, makeJudgement, SOURCE_TEXTS } from './helpers'

const judged = () => acceptModelJudgement(makeJudgement(), SOURCE_TEXTS).judgement!

describe('PRD 第 6 章 · 五维评分引擎', () => {
  it('五维齐全时权重合计为 1，综合分为加权和', () => {
    const f = makeFeatures()
    const card = buildScoreCard(f, judged())
    const sum = Object.values(card.weights).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1, 6)
    expect(card.coveredDimensions).toBe(5)
    expect(card.confidence).toBe('high')
    expect(card.totalScore).toBeGreaterThan(0)
    expect(card.totalScore).toBeLessThanOrEqual(100)
    expect(card.totalRange).toBeNull()
  })

  it('缺失维度用权重再归一化，不补零', () => {
    const f = makeFeatures({ importBatches24m: null, purchaseValueRatio: null })
    const card = buildScoreCard(f, judged())
    expect(card.dimensions.propensity.hasData).toBe(false)
    expect(card.dimensions.propensity.score).toBe(0)
    expect(card.dimensions.propensity.displayValue).toBe('无数据')
    expect(card.weights.propensity).toBe(0)
    const active = (['match', 'size', 'import', 'contact'] as const).reduce((s, k) => s + DIMENSION_WEIGHTS[k], 0)
    expect(card.weights.match).toBeCloseTo(DIMENSION_WEIGHTS.match / active, 6)
    expect(card.warnings.some((w) => w.includes('4/5 维'))).toBe(true)
    // 若错误地补零，总分会被拉低约 25%
    const withZero = (['match', 'size', 'import', 'contact'] as const).reduce((s, k) => s + card.dimensions[k].score * DIMENSION_WEIGHTS[k], 0)
    expect(card.totalScore).toBeGreaterThan(withZero)
  })

  it('联系方式维度模型完全不参与（PRD 6.7.5：100/0 规则）', () => {
    const card = buildScoreCard(makeFeatures(), judged())
    expect(card.dimensions.contact.alpha).toBe(0)
    expect(card.dimensions.contact.modelScore).toBeNull()
    expect(card.dimensions.contact.meta.some((m) => m.value.includes('不参与'))).toBe(true)
  })

  it('α 不超过分维参与度上限与 0.60 硬上限', () => {
    const card = buildScoreCard(makeFeatures(), judged())
    expect(card.dimensions.match.alpha).toBeLessThanOrEqual(0.4)
    expect(card.dimensions.propensity.alpha).toBeLessThanOrEqual(0.15)
    expect(card.dimensions.import.alpha).toBeLessThanOrEqual(0.25)
    for (const d of Object.values(card.dimensions)) expect(d.alpha).toBeLessThanOrEqual(0.6)
  })

  it('规则/模型相差 > 30 时不取平均，保守取规则值并进入复议队列', () => {
    const f = makeFeatures()
    const raw = makeJudgement({
      import_signal: { value: 'contradicted', confidence: 0.95, evidence: [{ quote: 'We stock hydraulic hose fittings, JIC fittings and brass adapters for industrial distributors.', sourceUrl: 'https://x.example/about', fetchedAt: '2026-11-06' }] },
    })
    const j = acceptModelJudgement(raw, SOURCE_TEXTS).judgement!
    const card = buildScoreCard(f, j)
    const rule = computeRuleScores(f).import.score
    expect(Math.abs(rule - 20)).toBeGreaterThan(30)
    expect(card.dimensions.import.conflict).toBe(true)
    expect(card.dimensions.import.score).toBe(rule)
    expect(card.dimensions.import.needsReview).toBe(true)
    expect(card.dimensions.import.confidence).toBe('low')
    expect(card.confidence).toBe('low')
    expect(card.warnings.some((w) => w.includes('冲突'))).toBe(true)
  })

  it('无海关数据市场做权重转移，不因「无记录」给 0 分', () => {
    const f = makeFeatures({ customsRecords: null, customsDataAvailable: false, importWording: 'inferred', distributedBrands: 3, tradeTermHits: 4 })
    const rule = computeRuleScores(f).import
    expect(rule.score).toBeGreaterThan(50)
    const meta = rule.meta[0]
    expect(meta).toBeDefined()
    expect(meta?.value).toContain('权重转移')
    expect(rule.conclusion).toContain('不公开')
  })

  it('高匹配 + 低进口 → 疑似同行标记，默认折叠', () => {
    const f = makeFeatures({
      keywordHits: [{ term: 'hydraulic fittings', count: 20, positionWeight: 1.5 }],
      customsRecords: null, customsDataAvailable: false, importWording: 'contradicted',
      distributedBrands: 0, tradeTermHits: 0,
    })
    const card = buildScoreCard(f, null, { modelAvailable: false })
    expect(card.dimensions.match.score).toBeGreaterThanOrEqual(92)
    expect(card.dimensions.import.score).toBeLessThan(30)
    expect(card.competitorFlag).toBe(true)
    expect(card.warnings.some((w) => w.includes('疑似同行'))).toBe(true)
  })

  it('D 级邮箱禁止进入发送队列', () => {
    const card = buildScoreCard(makeFeatures({ emailGrade: 'D', mxValid: false, smtpVerified: false }), judged())
    expect(card.canSend).toBe(false)
    expect(card.dimensions.contact.score).toBe(10)
  })

  it('模型网关不可用时把不确定性显式化：区间分数 + 低置信 + E6005 告警', () => {
    const card = buildScoreCard(makeFeatures(), null, { modelAvailable: false })
    expect(card.modelDegraded).toBe(true)
    expect(card.confidence).toBe('low')
    expect(card.totalRange).not.toBeNull()
    expect(card.totalDisplay).toContain('–')
    expect(card.warnings.some((w) => w.includes('E6005'))).toBe(true)
  })

  it('同一输入两次计算完全一致（可复现性纪律）', () => {
    const f = makeFeatures()
    const a = buildScoreCard(f, judged())
    const b = buildScoreCard(f, judged())
    expect(a).toEqual(b)
  })
})
