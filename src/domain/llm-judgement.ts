/**
 * PRD 6.7.3 / 6.7.7：受限输出协议 + 证据校验 + 幻觉防治
 *
 * 纪律：模型只输出「枚举 + 置信度 + 证据引用」，不输出分数。
 * 任何越界值整条作废（不是纠正，是作废）；引用无法在 <context> 中找到的字段整条丢弃。
 */
import type { Evidence, ImportSignal, LlmJudgement, SizeTier, VerifiedJudgement, JudgementField } from '@/types'
import protocol from '../../shared/model-protocol.json'

// 枚举与阈值的单一真源：前端与服务端网关共用 shared/model-protocol.json
const CUSTOMER_TYPE_VALUES = new Set<string>(protocol.enums.customer_type)
const IMPORT_VALUES = new Set<string>(protocol.enums.import_signal)
const SIZE_VALUES = new Set<string>(protocol.enums.size_estimate)
const NEGATIVE_FLAGS = new Set<string>(protocol.enums.negative_flags)
const FORBIDDEN_FIELDS = new Set<string>(protocol.forbiddenFields)
export const PROVENANCE_RATE_MIN = protocol.rules.provenanceRateMin
export const EVIDENCE_HIT_RATE_MIN = protocol.rules.evidenceMinHitRate

export interface SchemaCheck {
  valid: boolean
  errors: string[]
  value: LlmJudgement | null
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 递归检测禁用字段（score / total_score / rating / points）——PRD 6.7.3 硬约束① */
function containsForbiddenField(node: unknown, depth = 0): string | null {
  if (depth > 4 || !isObj(node)) return null
  for (const [key, val] of Object.entries(node)) {
    if (FORBIDDEN_FIELDS.has(key.toLowerCase())) return key
    if (isObj(val)) {
      const nested = containsForbiddenField(val, depth + 1)
      if (nested) return nested
    }
  }
  return null
}

/**
 * Wire 格式按 PRD 6.7.3 用 snake_case（source_url / fetched_at）。
 * 内部表示保持 camelCase；此处做一次归一化，两种写法都能被网关与前端接受。
 */
export function normalizeEvidence(item: Record<string, unknown>): Evidence | { error: string } {
  const quote = item.quote
  const sourceUrl = item.source_url ?? item.sourceUrl
  const fetchedAt = item.fetched_at ?? item.fetchedAt
  const label = item.label
  if (typeof quote !== 'string' || quote.trim().length < 4) return { error: 'evidence.quote 缺失或过短' }
  if (typeof sourceUrl !== 'string' || !/^https?:\/\//.test(sourceUrl)) return { error: 'evidence.source_url 非法' }
  if (typeof fetchedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(fetchedAt)) return { error: 'evidence.fetched_at 非法' }
  return { quote, sourceUrl, fetchedAt, label: typeof label === 'string' ? label : undefined }
}

function checkEvidenceShape(raw: unknown): { ok: boolean; error?: string; value: Evidence[] } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'evidence 为空', value: [] }
  const out: Evidence[] = []
  for (const item of raw) {
    if (!isObj(item)) return { ok: false, error: 'evidence 条目不是对象', value: [] }
    const normalized = normalizeEvidence(item)
    if ('error' in normalized) return { ok: false, error: normalized.error, value: [] }
    out.push(normalized)
  }
  return { ok: true, value: out }
}

/**
 * 固定 schema 校验。越界值整条作废，不做自动纠正。
 * 生产环境应同时用 provider 的 response_format / JSON Schema 在调用侧约束。
 */
export function validateJudgementSchema(raw: unknown): SchemaCheck {
  const errors: string[] = []
  if (!isObj(raw)) return { valid: false, errors: ['响应不是对象'], value: null }
  const forbidden = containsForbiddenField(raw)
  if (forbidden) errors.push(`响应中出现禁用字段 ${forbidden}（模型不得打分）`)

  const companyId = raw.company_id
  if (typeof companyId !== 'string' || !companyId) errors.push('company_id 缺失')

  const ct = raw.customer_type
  const im = raw.import_signal
  const sz = raw.size_estimate
  if (!isObj(ct) || !isObj(im) || !isObj(sz)) {
    return { valid: false, errors: [...errors, '缺少 customer_type / import_signal / size_estimate'], value: null }
  }

  if (typeof ct.value !== 'string' || !CUSTOMER_TYPE_VALUES.has(ct.value)) errors.push('customer_type.value 越界')
  if (typeof im.value !== 'string' || !IMPORT_VALUES.has(im.value)) errors.push('import_signal.value 越界')
  if (typeof sz.tier !== 'string' || !SIZE_VALUES.has(sz.tier)) errors.push('size_estimate.tier 越界')

  // 用固定键对象而非 Record<string, …>：后者在 noUncheckedIndexedAccess 下读出来是
  // `Evidence[] | undefined`，会让「证据必填」的类型约束形同虚设。
  const evs: { customer_type: Evidence[]; import_signal: Evidence[]; size_estimate: Evidence[] } = {
    customer_type: [], import_signal: [], size_estimate: [],
  }
  for (const [name, holder] of [['customer_type', ct], ['import_signal', im], ['size_estimate', sz]] as const) {
    const c = holder.confidence
    if (typeof c !== 'number' || c < 0 || c > 1) errors.push(`${name}.confidence 越界（应为 0–1）`)
    const ev = checkEvidenceShape(holder.evidence)
    if (!ev.ok) errors.push(`${name}.${ev.error}`)
    evs[name] = ev.value
  }

  if (!Array.isArray(raw.negative_flags)) errors.push('negative_flags 不是数组')
  else for (const f of raw.negative_flags) {
    if (typeof f !== 'string' || !NEGATIVE_FLAGS.has(f)) errors.push(`negative_flags 含越界值: ${String(f)}`)
  }

  for (const k of ['model_id', 'model_version', 'prompt_version', 'schema_version']) {
    if (typeof raw[k] !== 'string' || !raw[k]) errors.push(`${k} 缺失（版本留痕强制）`)
  }

  if (errors.length) return { valid: false, errors, value: null }

  const value: LlmJudgement = {
    company_id: companyId as string,
    customer_type: { value: ct.value as LlmJudgement['customer_type']['value'], confidence: ct.confidence as number, evidence: evs.customer_type },
    import_signal: { value: im.value as ImportSignal, confidence: im.confidence as number, evidence: evs.import_signal },
    size_estimate: {
      tier: sz.tier as SizeTier,
      employee_range: Array.isArray(sz.employee_range) ? (sz.employee_range as [number, number]) : null,
      confidence: sz.confidence as number,
      evidence: evs.size_estimate,
    },
    negative_flags: raw.negative_flags as string[],
    notes_for_human: typeof raw.notes_for_human === 'string' ? raw.notes_for_human : undefined,
    model_id: raw.model_id as string,
    model_version: raw.model_version as string,
    prompt_version: raw.prompt_version as string,
    schema_version: raw.schema_version as string,
  }
  return { valid: true, errors: [], value }
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

/** 字符串模糊匹配：整句命中，或 token 覆盖率 ≥ 0.9（PRD 6.7.3 硬约束②） */
export function quoteMatchesContext(quote: string, sources: string[]): boolean {
  const q = normalize(quote)
  if (q.length < 4) return false
  const corpus = normalize(sources.join(' \n '))
  if (corpus.includes(q)) return true
  const tokens = q.split(' ').filter((t) => t.length > 1)
  if (!tokens.length) return false
  const hit = tokens.filter((t) => corpus.includes(t)).length
  return hit / tokens.length >= EVIDENCE_HIT_RATE_MIN
}

function verifyField<T>(
  value: T,
  confidence: number,
  evidence: Evidence[],
  sources: string[],
): { field: JudgementField<T>; matched: number; total: number } {
  const matched = evidence.filter((e) => quoteMatchesContext(e.quote, sources)).length
  const hitRate = evidence.length ? matched / evidence.length : 0
  const accepted = hitRate >= EVIDENCE_HIT_RATE_MIN
  return {
    field: {
      value,
      confidence,
      evidence,
      accepted,
      rejectReason: accepted ? undefined : 'E6004 证据校验不通过：引用无法在原文中核验（伪造引用或页面已变更）',
    },
    matched,
    total: evidence.length,
  }
}

/** 证据校验：命中率 < 90% 的字段整条丢弃，回退 rule_score，不降权、不中立 */
export function verifyJudgement(j: LlmJudgement, sources: string[]): VerifiedJudgement {
  const ct = verifyField(j.customer_type.value, j.customer_type.confidence, j.customer_type.evidence, sources)
  const im = verifyField(j.import_signal.value, j.import_signal.confidence, j.import_signal.evidence, sources)
  const sz = verifyField(j.size_estimate.tier, j.size_estimate.confidence, j.size_estimate.evidence, sources)
  const matched = ct.matched + im.matched + sz.matched
  const total = ct.total + im.total + sz.total
  return {
    companyId: j.company_id,
    customerType: ct.field,
    importSignal: im.field,
    sizeTier: sz.field,
    negativeFlags: j.negative_flags,
    notesForHuman: j.notes_for_human,
    provenanceRate: total ? matched / total : 0,
    model: {
      id: j.model_id,
      version: j.model_version,
      promptVersion: j.prompt_version,
      schemaVersion: j.schema_version,
    },
  }
}

/** 网关入口：schema 校验 → 证据校验；任一失败返回 null，由调用方走降级姿态 */
export function acceptModelJudgement(raw: unknown, sources: string[]): {
  judgement: VerifiedJudgement | null
  errorCodes: string[]
  reason?: string
} {
  const check = validateJudgementSchema(raw)
  if (!check.valid || !check.value) {
    return { judgement: null, errorCodes: ['E6003'], reason: `schema 校验失败：${check.errors.join('；')}` }
  }
  const verified = verifyJudgement(check.value, sources)
  if (verified.provenanceRate < PROVENANCE_RATE_MIN) {
    return {
      judgement: verified,
      errorCodes: ['E6004'],
      reason: `可溯源率 ${(verified.provenanceRate * 100).toFixed(0)}% < ${(PROVENANCE_RATE_MIN * 100).toFixed(0)}%（9.5.2 P0 门槛），未通过证据校验的字段已丢弃`,
    }
  }
  return { judgement: verified, errorCodes: [] }
}

/** 从已抓取材料中抽取客户类型的枚举先验 → 供 import 维度使用 */
export function customerTypeImportPrior(type: string): number | null {
  const priors: Record<string, number> = {
    importer: 92, distributor: 85, wholesaler: 78, brand_owner: 60,
    retailer: 45, factory: 35, epc: 40, trader: 70, unknown: 50,
  }
  return priors[type] ?? null
}
