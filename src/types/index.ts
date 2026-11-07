/**
 * LeadPilot 领域类型 · 对齐 PRD v1.1 第 10 章数据模型
 * 说明：本地基线用内存/localStorage 承载；Tauri 侧接入 SQLite 时保持同构。
 */

export type DimensionKey = 'match' | 'propensity' | 'size' | 'import' | 'contact'
export type SizeTier = 'S' | 'M' | 'L' | 'XL' | 'unknown'
export type ContactGrade = 'A' | 'B' | 'C' | 'D'
export type Confidence = 'high' | 'mid' | 'low'
export type Depth = 1 | 2 | 3 | 4

export type CustomerType =
  | 'importer'
  | 'distributor'
  | 'wholesaler'
  | 'brand_owner'
  | 'retailer'
  | 'factory'
  | 'epc'
  | 'trader'

/** PRD F8-1：12 态（末态「退订/无效」合并不可逆状态） */
export type CompanyStatus =
  | 'new'
  | 'drafted'
  | 'sent'
  | 'delivered'
  | 'opened'
  | 'replied'
  | 'interested'
  | 'quoted'
  | 'won'
  | 'not_interested'
  | 'bounced'
  | 'unsubscribed'

export type ImportSignal = 'confirmed' | 'inferred' | 'no_signal' | 'contradicted'

export interface Evidence {
  quote: string
  sourceUrl: string
  fetchedAt: string
  label?: string
}

/** PRD 6.7.3 受限输出协议：模型不打分，只输出枚举 + 置信度 + 证据 */
export interface LlmJudgement {
  company_id: string
  customer_type: {
    value: CustomerType | 'unknown'
    confidence: number
    evidence: Evidence[]
  }
  import_signal: {
    value: ImportSignal
    confidence: number
    evidence: Evidence[]
  }
  size_estimate: {
    tier: SizeTier
    employee_range: [number, number] | null
    confidence: number
    evidence: Evidence[]
  }
  negative_flags: string[]
  notes_for_human?: string
  model_id: string
  model_version: string
  prompt_version: string
  schema_version: string
}

export interface JudgementField<T> {
  value: T
  confidence: number
  evidence: Evidence[]
  /** 证据校验失败 → 整条丢弃，回退 rule_score（PRD 6.7.7） */
  accepted: boolean
  rejectReason?: string
}

export interface VerifiedJudgement {
  companyId: string
  customerType: JudgementField<CustomerType | 'unknown'>
  importSignal: JudgementField<ImportSignal>
  sizeTier: JudgementField<SizeTier>
  negativeFlags: string[]
  notesForHuman?: string
  provenanceRate: number
  model: { id: string; version: string; promptVersion: string; schemaVersion: string }
}

export interface RuleFeatures {
  keywordHits: { term: string; count: number; positionWeight: number }[]
  categoryDistance: 0 | 1 | 2 | 3
  semanticSimilarity: number
  marketMatch: number
  importBatches24m: number | null
  purchaseValueRatio: number | null
  seasonWindow: number
  supplierChangeSignal: number
  activitySignals: number
  employeeCount: number | null
  revenueUsd: number | null
  sizeTier: SizeTier
  sizeEvidenceLevel: Confidence
  customsRecords: number | null
  customsDataAvailable: boolean
  importWording: ImportSignal
  distributedBrands: number
  tradeTermHits: number
  emailGrade: ContactGrade
  mxValid: boolean
  smtpVerified: boolean
  domainMatch: boolean
  hasNamedContact: boolean
  /** 允许证据校验的原文集合（官网快照等），模型不得引用集合外内容 */
  sourceTexts: string[]
  /** 规则层证据：关键词命中原文、海关记录、MX 验证明细等 */
  evidences?: Partial<Record<DimensionKey, Evidence[]>>
}

export interface DimensionResult {
  key: DimensionKey
  ruleScore: number
  modelScore: number | null
  alpha: number
  score: number
  hasData: boolean
  confidence: Confidence
  conflict: boolean
  needsReview: boolean
  conclusion: string
  evidences: Evidence[]
  displayValue: string
  meta: { label: string; value: string }[]
}

export interface ScoreCard {
  dimensions: Record<DimensionKey, DimensionResult>
  totalScore: number
  totalRange: [number, number] | null
  totalDisplay: string
  confidence: Confidence
  coveredDimensions: number
  weights: Record<DimensionKey, number>
  competitorFlag: boolean
  canSend: boolean
  warnings: string[]
  provenanceRate: number
  modelDegraded: boolean
}

export interface Contact {
  id: string
  type: 'email' | 'phone' | 'social'
  value: string
  ownerName?: string
  title?: string
  grade: ContactGrade
  verified: boolean
  verifyCode?: string
  source: string
  isBlacklisted: boolean
}

export interface TradeRecord {
  id: string
  hsCode: string
  productDesc: string
  originCountry: string
  valueUsd: number
  tradeDate: string
  dataSource: string
}

export interface StatusLogEntry {
  id: string
  from: CompanyStatus | null
  to: CompanyStatus
  operator: string
  automated: boolean
  note?: string
  createdAt: string
}

export interface Company {
  id: string
  domain: string
  name: string
  nameLocal?: string
  country: string
  city?: string
  flag: string
  website: string
  foundedYear: number | null
  employeeRange?: string
  revenueRange?: string
  sizeTier: SizeTier
  categories: string[]
  description: string
  brands: string[]
  customerTypes: CustomerType[]
  features: RuleFeatures
  judgement: LlmJudgement | null
  scoreCard: ScoreCard
  contacts: Contact[]
  tradeRecords: TradeRecord[]
  status: CompanyStatus
  sourceTaskId: string
  firstSeenAt: string
  lastContactAt: string | null
  nextFollowAt: string | null
  note: string
  statusLog: StatusLogEntry[]
  followups: { id: string; dueDate: string; content: string; channel: string; done: boolean }[]
  /** 演示数据标记：绝不允许把 mock 结果呈现为真实采集 */
  demo?: boolean
}

export interface TaskConfig {
  keywords: string[]
  excludeKeywords: string[]
  markets: string[]
  customerTypes: CustomerType[]
  depth: Depth
  targetCount: number
  sizeTiers: SizeTier[]
  foundedYearsMin: number | null
  onlyVerifiedEmails: boolean
  hsCode: string
  name: string
}

export type TaskStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'aborted'

export interface TaskProgress {
  stage: string
  stageIndex: number
  candidates: number
  stored: number
  qualified: number
  etaRange: [number, number]
  sources: { name: string; hits: number; failures: number; status: 'ok' | 'warn' | 'fail'; reason?: string }[]
  log: { at: string; level: 'info' | 'warn' | 'error'; text: string }[]
}

export interface DevTask {
  id: string
  name: string
  status: TaskStatus
  config: TaskConfig
  pointsEstimated: number
  pointsUsed: number
  createdAt: string
  finishedAt?: string
  progress: TaskProgress
  companyIds: string[]
  /** local=本地演示运行器（会写入演示客户）；cloud=云端编排器（真实 SSE，数据源未接入故不产生客户记录） */
  mode?: 'local' | 'cloud'
}

export interface Outreach {
  id: string
  companyId: string
  contactId: string
  subject: string
  bodyText: string
  bodyHtml: string
  language: string
  purpose: string
  status: 'draft' | 'queued' | 'sent' | 'bounced' | 'replied'
  personalizationTags: string[]
  validation: EmailValidation
  createdAt: string
  sentAt?: string
  gmailDraftId?: string
  /** 演示模式：未真实调用 Gmail API */
  demo?: boolean
}

export interface EmailValidation {
  wordCount: number
  maxWords: number
  bannedHits: string[]
  hasUnsubscribe: boolean
  hasSenderIdentity: boolean
  hasPlaceholder: boolean
  hasPersonalization: boolean
  passed: boolean
  issues: string[]
}

export interface CompanyProfile {
  companyNameEn: string
  companyNameZh: string
  address: string
  website: string
  mainProducts: string
  advantages: string[]
  certifications: string
  moq: string
  leadTime: string
  caseStudies: string
  senderName: string
  senderTitle: string
  phone: string
}

export interface Settings {
  profile: CompanyProfile
  pointsBalance: number
  plan: string
  llm: {
    t0: string
    t1: string
    t2: string
    byokEnabled: boolean
    byokProvider: string
    regionPolicy: 'domestic_first' | 'quality_first'
  }
  gmail: { connected: boolean; email: string; scope: string; dailyLimit: number; sentToday: number; warmupDay: number }
  blacklist: string[]
  demoMode: boolean
}
