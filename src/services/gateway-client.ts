/**
 * 前端 → 云端网关客户端
 *
 * 明确边界：探测失败 / 未配置 Key 时返回 offline，不抛异常、不重试、不伪造在线状态。
 * 真实判断结果只在通过服务端 schema + 证据校验后才回传，客户端仍会再校验一次。
 */
import type { TaskConfig } from '@/types'

const ENV = (import.meta as ImportMeta & { env?: Record<string, string> }).env ?? {}
const BASE = ENV.VITE_LEADPILOT_API ?? 'http://127.0.0.1:5181'
// 仅本地开发使用；生产应由同源反向代理注入凭据，不要在公网前端下发长期 token
const TOKEN = ENV.VITE_LEADPILOT_TOKEN ?? ''

export const gatewayBaseUrl = BASE

function authHeaders(): Record<string, string> {
  return TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}
}

export interface GatewayHealth {
  online: boolean
  mode: 'configured' | 'unconfigured-demo' | 'offline'
  configuredCount: number
  pinnedCount: number
  readyCount: number
  totalProviders: number
  providers: {
    key: string; name: string; tier: string; region: string; model: string
    modelVersion: string | null; configured: boolean; pinned: boolean; circuitOpen: boolean
  }[]
  cacheEntries: number
  auditEntries: number
  security?: { mode: string; loopback: boolean; cors: string[]; rateLimitPerMinute: number }
  t0?: { extractor: 'rules'; rulesVersion: string; sourceMode: 'provided-text' }
  dataSources?: { mode: 'demo' | 'real'; total: number; configured: number; readyCount: number }
  reason?: string
}

/** T0 规则抽取：输入必须是调用方已经拿到的原文，服务端不联网、不调模型 */
export interface T0Source {
  url: string
  text: string
  fetched_at: string
}

export interface T0ExtractInput {
  companyId: string
  sources: T0Source[]
  keywords?: string[]
  markets?: string[]
}

export interface T0ExtractResult {
  ok: boolean
  code?: string
  errors?: string[]
  extractor?: 'rules'
  rulesVersion?: string
  sourceMode?: 'provided-text'
  sourceCount?: number
  piiRemoved?: number
  facts?: {
    customer_type: { value: string; no_signal: boolean; evidence: unknown[]; candidates: unknown[] }
    import_signal: { value: string; no_signal: boolean; evidence: unknown[]; note?: string }
    size_estimate: { tier: string; no_signal: boolean; evidence: unknown[]; employee_range: unknown }
    product_terms: unknown[]
    negative_flags: string[]
    anchors: { quote: string; source_url: string; fetched_at: string; tags: string[] }[]
  }
  evidence?: { quote: string; source_url: string; fetched_at: string; label?: string }[]
  coverage?: { dimensions: string[]; noSignalFields: string[]; hitFields: string[]; rate: number }
}

export async function extractFactsWithGateway(input: T0ExtractInput): Promise<T0ExtractResult> {
  try {
    return await jsonFetch<T0ExtractResult>('/v1/t0/extract', {
      method: 'POST',
      body: JSON.stringify({
        company_id: input.companyId, sources: input.sources,
        keywords: input.keywords ?? [], markets: input.markets ?? [],
      }),
    }, 6000)
  } catch {
    return { ok: false, code: 'E6005', errors: ['T0 抽取服务不可达：请启动 npm run cloud'] }
  }
}

export interface JudgeInput {
  companyId: string
  domain: string
  country: string
  sourceTexts: string[]
  facts: Record<string, unknown>
  confidence?: number
  conflict?: boolean
  depth?: number
  regionPolicy?: 'domestic_first' | 'quality_first'
  allowOverseas?: boolean
}

export interface JudgeResponse {
  ok: boolean
  degraded?: boolean
  needsConsent?: boolean
  errorCodes?: string[]
  reason?: string
  cached?: boolean
  tier?: string
  clientJudgement?: unknown
  provenanceRate?: number
  passesGate?: boolean
  audit?: { providerKey: string; model: string; input: number; output: number; points: number; latencyMs: number }
}

async function jsonFetch<T>(path: string, init?: RequestInit, timeoutMs = 4000): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
    })
    const body = await res.json() as T & { ok?: boolean }
    if (!res.ok) return { ...body, ok: false } as T
    return body
  } finally {
    clearTimeout(timer)
  }
}

export async function probeGateway(): Promise<GatewayHealth> {
  try {
    const h = await jsonFetch<{
      ok: boolean; mode: string; configuredCount: number; pinnedCount: number; readyCount: number
      totalProviders: number;       providers: GatewayHealth['providers']
      cacheEntries: number; auditEntries: number; reason?: string
      security?: GatewayHealth['security']; t0?: GatewayHealth['t0']
      dataSources?: GatewayHealth['dataSources']
    }>('/v1/gateway/health', undefined, 1600)
    if (h.ok === false && (h as { code?: string }).code === 'E6009') {
      return {
        online: false, mode: 'offline', configuredCount: 0, pinnedCount: 0, readyCount: 0,
        totalProviders: 0, providers: [], cacheEntries: 0, auditEntries: 0,
        reason: '网关要求访问令牌：请在前端环境变量配置 VITE_LEADPILOT_TOKEN，或清除服务端的 LEADPILOT_API_TOKEN。',
      }
    }
    return {
      online: true,
      mode: h.mode === 'configured' ? 'configured' : 'unconfigured-demo',
      configuredCount: h.configuredCount ?? 0,
      pinnedCount: h.pinnedCount ?? 0,
      readyCount: h.readyCount ?? 0,
      totalProviders: h.totalProviders,
      providers: h.providers ?? [], cacheEntries: h.cacheEntries, auditEntries: h.auditEntries,
      security: h.security, t0: h.t0, dataSources: h.dataSources, reason: h.reason,
    }
  } catch {
    return {
      online: false, mode: 'offline', configuredCount: 0, pinnedCount: 0, readyCount: 0,
      totalProviders: 0, providers: [], cacheEntries: 0, auditEntries: 0,
      reason: `云端服务未启动或不可达（${BASE}）。启动：npm run cloud`,
    }
  }
}

export async function judgeCompany(input: JudgeInput): Promise<JudgeResponse> {
  try {
    return await jsonFetch<JudgeResponse>('/v1/judge', { method: 'POST', body: JSON.stringify(input) }, 35000)
  } catch {
    return {
      ok: false, degraded: true, errorCodes: ['E6005'],
      reason: '云端网关不可达：本次为规则估算，未经模型校验。请确认服务已启动。',
    }
  }
}

export interface EmailGenerateInput {
  anchor: string
  product: string
  advantages: string[]
  purpose: string
  tone: string
  maxWords: number
  language: string
  country: string
  angle?: string
  regionPolicy?: 'domestic_first' | 'quality_first'
  /** 可选：调用方已抓取的官网原文。传入后服务端用 T0 规则抽取可核验锚点，不联网、不调模型 */
  sources?: T0Source[]
  companyId?: string
}

export interface EmailGenerateResponse {
  ok: boolean
  degraded?: boolean
  needsConsent?: boolean
  errorCodes?: string[]
  reason?: string
  subject?: string
  body?: string
  anchorUsed?: string
  wordCount?: number
  tier?: string
  note?: string
  anchorSource?: 'client' | 't0-rules'
  anchor?: string
  t0?: {
    ok: boolean; extractor?: 'rules'; rulesVersion?: string; sourceCount?: number
    piiRemoved?: number; anchorCount?: number; anchorSource?: string; note?: string
    code?: string; errors?: string[]
  }
  audit?: { providerKey: string; model: string; input: number; output: number; points: number; latencyMs: number }
}

/** T1 真实写信：未配 Key / 降级链耗尽时返回 ok=false，调用方必须回退本地模板并标注 */
export async function generateEmailWithGateway(input: EmailGenerateInput): Promise<EmailGenerateResponse> {
  try {
    return await jsonFetch<EmailGenerateResponse>('/v1/email/generate', {
      method: 'POST', body: JSON.stringify(input),
    }, 35000)
  } catch {
    return {
      ok: false, degraded: true, errorCodes: ['E6005'],
      reason: '云端网关不可达：本次不生成模型正文，已回退本地确定性模板。',
    }
  }
}

/** 云端任务的暂停 / 继续 / 中止（SSE 只做单向推送，控制走独立 POST） */
export async function controlCloudTask(taskId: string, action: 'pause' | 'resume' | 'abort', cursor?: unknown): Promise<boolean> {
  try {
    const res = await jsonFetch<{ ok: boolean }>(`/v1/tasks/${encodeURIComponent(taskId)}/${action}`, {
      method: 'POST', body: JSON.stringify(cursor ? { cursor } : {}),
    }, 4000)
    return Boolean(res.ok)
  } catch {
    return false
  }
}

/**
 * 云端任务 + SSE 流式订阅；数据源未接入时事件带 demo:true。
 * 用 fetch 流式读取而非 EventSource：EventSource 无法携带 Authorization 头，
 * 把 token 拼进 query 会泄漏到访问日志，这里必须在鉴权开启后仍保持请求头携带凭据。
 */
export function startCloudTask(
  config: TaskConfig,
  onEvent: (event: { type: string; [k: string]: unknown }) => void,
): Promise<{ ok: boolean; taskId?: string; reason?: string; close(): void }> {
  let controller: AbortController | null = null
  const close = () => { controller?.abort(); controller = null }
  return jsonFetch<{ ok: boolean; task: { id: string } }>('/v1/tasks', {
    method: 'POST', body: JSON.stringify(config),
  }, 6000).then(async (res) => {
    if (!res.ok || !res.task?.id) {
      return { ok: false, reason: '云端任务创建失败', close }
    }
    controller = new AbortController()
    let response: Response
    try {
      response = await fetch(`${BASE}/v1/tasks/${encodeURIComponent(res.task.id)}/events`, {
        headers: authHeaders(), signal: controller.signal,
      })
    } catch {
      return { ok: false, reason: 'SSE 连接失败', close }
    }
    if (!response.ok || !response.body) {
      return { ok: false, reason: `SSE 订阅被拒绝（HTTP ${response.status}）`, close }
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const chunks = buffer.split('\n\n')
          buffer = chunks.pop() ?? ''
          for (const chunk of chunks) {
            const lines = chunk.split('\n')
            const data = lines.find((l) => l.startsWith('data: '))
            if (!data) continue
            const type = lines.find((l) => l.startsWith('event: '))?.slice(7).trim() ?? 'message'
            try { onEvent({ type, ...JSON.parse(data.slice(6)) }) } catch { /* 忽略非法事件 */ }
          }
        }
      } catch {
        onEvent({ type: 'error', reason: 'SSE 连接中断' })
      }
    })()
    return { ok: true, taskId: res.task.id, close }
  }).catch(() => ({ ok: false, reason: '云端服务未启动', close }))
}

export interface EvalRunResult {
  ok: boolean
  status: 'NO_DATA' | 'BLOCKED' | 'PASSED' | string
  message?: string
  sampleSize?: number
  metrics?: Record<string, unknown>
  failedGates?: string[]
}

/** 无 385 家人工标注集时返回 NO_DATA，绝不编造「通过」 */
export async function runEvalGate(results: unknown[] = []): Promise<EvalRunResult> {
  try {
    return await jsonFetch<EvalRunResult>('/v1/eval/run', {
      method: 'POST', body: JSON.stringify({ results }),
    }, 6000)
  } catch {
    return { ok: false, status: 'OFFLINE', message: '云端网关不可达，无法运行评测门禁。' }
  }
}

export interface GatewayDiagnostics {
  entries: {
    at: string; taskType?: string; tier?: string; providerKey?: string | null; model?: string
    cached?: boolean; input?: number; output?: number; points?: number
    degraded?: boolean; code?: string; provenanceRate?: number; latencyMs?: number
  }[]
  circuit: { providerKey: string; openUntil: string }[]
  cache: { entries: number; ttlDays: number }
  gates: { baselineSize: number; metrics: Record<string, { name: string; threshold: number; direction: string }>; p0: string[] } | null
}

export async function getGatewayDiagnostics(): Promise<GatewayDiagnostics | null> {
  try {
    const [audit, gates] = await Promise.all([
      jsonFetch<{
        entries: GatewayDiagnostics['entries']; circuit: GatewayDiagnostics['circuit']; cache: GatewayDiagnostics['cache']
      }>('/v1/gateway/audit', undefined, 2500),
      jsonFetch<GatewayDiagnostics['gates']>('/v1/eval/gates', undefined, 2500).catch(() => null),
    ])
    return { entries: audit.entries ?? [], circuit: audit.circuit ?? [], cache: audit.cache ?? { entries: 0, ttlDays: 30 }, gates }
  } catch {
    return null
  }
}
