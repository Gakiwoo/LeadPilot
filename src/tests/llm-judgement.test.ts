import { describe, expect, it } from 'vitest'
import { acceptModelJudgement, quoteMatchesContext, validateJudgementSchema } from '@/domain/llm-judgement'
import { buildScoreCard, computeRuleScores } from '@/domain/scoring'
import { ev, makeFeatures, makeJudgement, SOURCE_TEXTS } from './helpers'

describe('PRD 6.7.3 / 6.7.7 · 受限输出与幻觉防治', () => {
  it('拒绝任何含 score 字段的响应（模型不得打分）', () => {
    const raw = { ...makeJudgement(), customer_type: { ...makeJudgement().customer_type, score: 88 } }
    const r = validateJudgementSchema(raw)
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.includes('score'))).toBe(true)
  })

  it('枚举越界与缺少版本留痕一律整条作废', () => {
    const badEnum = makeJudgement({ customer_type: { value: 'unicorn' as never, confidence: 0.8, evidence: [ev('Authorized distributor for Parker and Eaton across Benelux.')] } })
    expect(validateJudgementSchema(badEnum).valid).toBe(false)
    expect(validateJudgementSchema({ ...makeJudgement(), model_version: '' }).valid).toBe(false)
    expect(validateJudgementSchema(makeJudgement()).valid).toBe(true)
  })

  it('引用能在原文中核验时全部字段通过，provenanceRate = 1', () => {
    const r = acceptModelJudgement(makeJudgement(), SOURCE_TEXTS)
    expect(r.judgement).not.toBeNull()
    expect(r.judgement!.provenanceRate).toBe(1)
    expect(r.judgement!.customerType.accepted).toBe(true)
    expect(r.judgement!.importSignal.accepted).toBe(true)
    expect(r.judgement!.sizeTier.accepted).toBe(true)
    expect(r.errorCodes).toHaveLength(0)
  })

  it('伪造引用 → E6004，字段整条丢弃并回退规则分（不降权、不中立）', () => {
    const fake = ev('ISO 9001 certified since 1998 with 40 engineers and 12 warehouses')
    const raw = makeJudgement({
      customer_type: { value: 'distributor', confidence: 0.9, evidence: [fake] },
      import_signal: { value: 'confirmed', confidence: 0.9, evidence: [ev('We stock hydraulic hose fittings, JIC fittings and brass adapters for industrial distributors.')] },
      size_estimate: { tier: 'M', employee_range: [11, 50], confidence: 0.6, evidence: [ev('Team of 23 across Rotterdam and Antwerp.')] },
    })
    const r = acceptModelJudgement(raw, SOURCE_TEXTS)
    expect(r.errorCodes).toContain('E6004')
    expect(r.judgement!.customerType.accepted).toBe(false)
    expect(r.judgement!.customerType.rejectReason).toContain('E6004')
    expect(r.judgement!.provenanceRate).toBeLessThan(0.9)
    const f = makeFeatures()
    const card = buildScoreCard(f, r.judgement)
    expect(card.warnings.some((w) => w.includes('Provenance Rate'))).toBe(true)
  })

  it('模糊匹配容忍标点差异，但不容忍语义不同的句子', () => {
    expect(quoteMatchesContext('Team of 23 across Rotterdam and Antwerp', SOURCE_TEXTS)).toBe(true)
    expect(quoteMatchesContext('Team of 23, across Rotterdam & Antwerp!', SOURCE_TEXTS)).toBe(true)
    expect(quoteMatchesContext('ISO 9001 certified since 1998', SOURCE_TEXTS)).toBe(false)
  })

  it('import_signal = no_signal 时沿用规则分，不惩罚', () => {
    const f = makeFeatures()
    const raw = makeJudgement({
      import_signal: { value: 'no_signal', confidence: 0.7, evidence: [ev('We stock hydraulic hose fittings, JIC fittings and brass adapters for industrial distributors.')] },
    })
    const j = acceptModelJudgement(raw, SOURCE_TEXTS).judgement!
    const card = buildScoreCard(f, j)
    const rule = computeRuleScores(f).import.score
    expect(card.dimensions.import.modelScore).toBe(rule)
  })
})
