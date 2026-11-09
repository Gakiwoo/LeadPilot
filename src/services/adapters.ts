/**
 * PRD F0 / 9.3：统一适配器与三级路由 · 前端服务层唯一入口（v0.6.0）
 *
 * 本文件同时是业务代码的唯一 import 边界：组件、store、App 一律从这里取能力，
 * 不得直接 import gateway-client / task-runner / email-generator 的具体实现，
 * 由 scripts/check-release-gates.mjs 在 CI 中强制校验（ADR-019）。
 *
 * 真实 / MOCK 边界：
 *  - gateway-client 的 probeGateway / judgeCompany / startCloudTask / T0 抽取 / 写信
 *    是真实 HTTP 调用；服务不可达或未配 Key 时返回显式降级，不伪造结果。
 *  - 下方 mockLlmAdapter / mockDataSourceAdapter / mockGmailAdapter 仍是 MOCK，
 *    不发起任何真实网络请求、不接触任何凭据。
 */
import type { Depth } from '@/types'
import protocol from '../../shared/model-protocol.json'

export type ModelTier = 'T0' | 'T1' | 'T2'
export type TaskKind = 'extract' | 'classify' | 'expand_keywords' | 'judge_import' | 'judge_size' | 'write_email'

export interface RouteRequest {
  type: TaskKind
  confidence?: number
  conflict?: boolean
  depth?: Depth
  valueTier?: 'normal' | 'high'
  t0AllFailed?: boolean
}

/** PRD F0-2 路由判定逻辑：写在网关里，不让业务层决定 */
export function route(task: RouteRequest): ModelTier {
  if (task.t0AllFailed) return 'T1'
  if (task.confidence !== undefined && task.confidence < protocol.rules.confidenceReviewThreshold) return 'T2'
  if (task.conflict) return 'T2'
  if (task.depth === 4 && task.valueTier === 'high') return 'T2'
  if ((protocol.routing.t0Tasks as string[]).includes(task.type)) return 'T0'
  if ((protocol.routing.t1Tasks as string[]).includes(task.type)) return 'T1'
  return 'T0'
}

const VENDOR_NOTE: Record<string, string> = {
  deepseek: 'T0 主力，谷时半价，1M 上下文，JSON Output 稳定',
  zhipu: 'Agentic 工具调用强，国内合规链路清晰',
  minimax: '同价位备选，价格谈判筹码',
  qwen: '中文语义与外贸术语好，多语言覆盖广',
  moonshot: '长文档理解，T1 主力（价格区间需官网核对）',
  openai: '冲突仲裁裁判模型，指令遵循稳定',
  anthropic: '英文长信语感自然，长文抽取质量高',
  google: 'Grounding 有月度免费额度，适合小批量高价值查询',
}

/** PRD F0-1 provider 清单：与服务端网关共用 shared/model-protocol.json */
export const PROVIDERS = protocol.providers.map((p) => ({
  key: p.key,
  name: p.name,
  model: p.model,
  tier: p.tier as ModelTier,
  region: p.region as 'domestic' | 'overseas',
  note: VENDOR_NOTE[p.vendor] ?? '',
  inUsdPerM: p.inUsdPerM,
  outUsdPerM: p.outUsdPerM,
}))

export interface StructuredResult {
  content: string
  usage: { input: number; output: number }
  model: string
  providerKey: string
  cached: boolean
}
export interface SearchHit { title: string; url: string; snippet: string }
export interface PageText { url: string; text: string; fetchedAt: string }
export interface ContactHit { value: string; ownerName?: string; title?: string; source: string }
export interface TradeHit { hsCode: string; productDesc: string; originCountry: string; valueUsd: number; tradeDate: string; source: string }

/** PRD F0-3：业务代码只依赖此接口；capabilities 决定网关是否做兼容降级 */
export interface LLMAdapter {
  chat(messages: unknown[], options?: {
    schema?: unknown
    temperature?: number
    seed?: number
    maxTokens?: number
  }): Promise<StructuredResult>
  embed?(texts: string[]): Promise<number[][]>
  search?(query: string, opts: { count: number; lang?: string; region?: string }): Promise<SearchHit[]>
  fetch?(url: string): Promise<PageText>
  capabilities: { jsonMode: boolean; toolCall: boolean; webSearch: boolean; maxContext: number }
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; quotaLeft: number }>
}

/** PRD 9.3：统一 DataSourceAdapter，任何源失效可秒级切换备选 */
export interface DataSourceAdapter {
  name: string
  search(query: string, opts: { count: number; lang?: string; region?: string }): Promise<{ hits: number; failures: number }>
  detail(url: string): Promise<PageText>
  contacts?(domain: string): Promise<ContactHit[]>
  tradeRecords?(domain: string, hsCode?: string): Promise<TradeHit[]>
  healthCheck?(): Promise<{ ok: boolean; latencyMs: number }>
}

export interface GmailAdapter {
  createDraft(input: { to: string; subject: string; body: string }): Promise<{ draftId: string; demo: boolean }>
}

export const mockLlmAdapter: LLMAdapter = {
  capabilities: { jsonMode: true, toolCall: false, webSearch: false, maxContext: 1_000_000 },
  async chat() {
    // 明确返回空内容与零用量，任何调用方都会走降级，不会误以为模型可用
    return { content: '', usage: { input: 0, output: 0 }, model: 'mock', providerKey: 'mock', cached: false }
  },
  async healthCheck() {
    return { ok: false, latencyMs: 0, quotaLeft: 0 }
  },
}

export const mockDataSourceAdapter: DataSourceAdapter = {
  name: '演示数据源（未接入真实采集）',
  async search() { return { hits: 0, failures: 0 } },
  async detail(url: string) { return { url, text: '', fetchedAt: new Date().toISOString() } },
  async contacts() { return [] },
  async tradeRecords() { return [] },
  async healthCheck() { return { ok: false, latencyMs: 0 } },
}

export const mockGmailAdapter: GmailAdapter = {
  async createDraft() {
    return { draftId: `demo_draft_${Date.now()}`, demo: true }
  },
}

/** 供 UI 展示的接入状态：绝不允许把 mock 结果说成真实结果 */
export const ADAPTER_STATUS = {
  llm: { mode: 'mock' as const, label: '演示判断（未调用模型）' },
  datasource: { mode: 'mock' as const, label: '演示采集（未接入数据源）' },
  gmail: { mode: 'mock' as const, label: '本地草稿队列（未调用 Gmail API）' },
}

/** PRD 11.4.2：EU/EEA/UK 客户默认境内组，境外 T2 需显式同意且默认拒绝 */
export const EEA_UK = new Set(['德国', '法国', '荷兰', '英国', '西班牙', '意大利', '波兰', '挪威', '瑞典', '丹麦', '比利时', '奥地利', '爱尔兰'])

export function resolveRegionPolicy(country: string, tier: ModelTier, policy: 'domestic_first' | 'quality_first'): {
  group: 'domestic' | 'overseas'
  needsConsent: boolean
  reason: string
} {
  const isEea = EEA_UK.has(country)
  if (isEea && tier !== 'T2') return { group: 'domestic', needsConsent: false, reason: 'EU/EEA/UK 客户数据：T0/T1 强制境内组' }
  if (isEea && tier === 'T2') return { group: 'overseas', needsConsent: true, reason: 'T2 境外模型：需显式知情同意，界面默认拒绝' }
  if (policy === 'domestic_first' && tier !== 'T2') return { group: 'domestic', needsConsent: false, reason: '默认境内组' }
  return { group: 'overseas', needsConsent: false, reason: '按质量最优路由（非 EU 客户）' }
}

/**
 * 服务层统一 re-export：真实云端网关客户端的全部类型与函数。
 * 业务侧只依赖 '@/services/adapters'，替换实现时无需改动任何组件。
 */
export * from './gateway-client'
export * from './task-runner'
export * from './email-generator'
