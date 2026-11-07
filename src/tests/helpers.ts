import type { Evidence, LlmJudgement, RuleFeatures } from '@/types'

export const SOURCE_TEXTS = [
  'About NordHydraulik: Authorized distributor for Parker and Eaton across Benelux.',
  'We stock hydraulic hose fittings, JIC fittings and brass adapters for industrial distributors.',
  'Team of 23 across Rotterdam and Antwerp. FOB Rotterdam, CIF terms available.',
]

export const ev = (quote: string, path = 'nordhydraulik.example/about'): Evidence => ({
  quote, sourceUrl: `https://${path}`, fetchedAt: '2026-11-06', label: '官网原文',
})

export function makeFeatures(patch: Partial<RuleFeatures> = {}): RuleFeatures {
  return {
    keywordHits: [{ term: 'hydraulic hose fittings', count: 14, positionWeight: 1.5 }],
    categoryDistance: 0,
    semanticSimilarity: 0.88,
    marketMatch: 1,
    importBatches24m: 9,
    purchaseValueRatio: 1.2,
    seasonWindow: 1,
    supplierChangeSignal: 0.7,
    activitySignals: 4,
    employeeCount: 23,
    revenueUsd: 8_000_000,
    sizeTier: 'M',
    sizeEvidenceLevel: 'mid',
    customsRecords: 9,
    customsDataAvailable: true,
    importWording: 'confirmed',
    distributedBrands: 2,
    tradeTermHits: 3,
    emailGrade: 'A',
    mxValid: true,
    smtpVerified: true,
    domainMatch: true,
    hasNamedContact: true,
    sourceTexts: SOURCE_TEXTS,
    ...patch,
  }
}

export function makeJudgement(patch: Partial<LlmJudgement> = {}): LlmJudgement {
  return {
    company_id: 'c_test',
    customer_type: { value: 'distributor', confidence: 0.82, evidence: [ev('Authorized distributor for Parker and Eaton across Benelux.')] },
    import_signal: { value: 'confirmed', confidence: 0.9, evidence: [ev('We stock hydraulic hose fittings, JIC fittings and brass adapters for industrial distributors.')] },
    size_estimate: { tier: 'M', employee_range: [11, 50], confidence: 0.61, evidence: [ev('Team of 23 across Rotterdam and Antwerp.')] },
    negative_flags: [],
    model_id: 'deepseek-v4.1-flash',
    model_version: '2026-10-15',
    prompt_version: 'judge-v1.1.0',
    schema_version: 'schema-v1',
    ...patch,
  }
}
