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
  t0?: {
    extractor: 'rules'; rulesVersion: string; sourceMode: 'provided-text'
    judgeFactChain?: { enabled: boolean; onConflict: string }
  }
  dataSources?: { mode: 'demo' | 'real'; total: number; configured: number; readyCount: number }
  /** v0.6.0 服务端账本：云端任务与网关真实调用共用一本账 */
  points?: {
    account: string; granted: number; held: number; spent: number; available: number
    ledgerVersion: string; persistence: string; accounts: number; entries: number
    scope: string[]; ledgerConsumers?: string[]; auditOnlyConsumers: string[]; note: string
  }
  billing?: {
    mode: string; version?: string; scope: string[]
    ledgerConsumers?: string[]; auditOnlyConsumers: string[]
    reservePoints?: Record<string, number>; releaseOn?: string[]
  }
  baseline?: {
    contractVersion: string; importStatus: string; requiredSize: number; releaseEligible: boolean
    contractStatus?: string; labelsRequired?: boolean; accuracyClaim?: boolean
    diffEndpoint?: string; diffVersion?: string
  }
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

/** v0.6.0 网关调用计费结果。charged=false 时绝不把审计估值说成已扣点 */
export interface GatewayBillingResult {
  charged: boolean
  scope: string
  reason?: string
  note?: string
  refId?: string
  reserved?: number
  estimatedPoints?: number
  chargedPoints?: number
  refunded?: number
  capped?: boolean
  idempotent?: boolean
  released?: boolean
  available?: number | null
  code?: string | null
  error?: string
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
  /**
   * v0.5.0 T0 → judge 事实链：只有调用方已真实抓取到原文时才传。
   * 演示数据没有可核验来源，前端不得拿 demo 文本伪造 sources。
   */
  sources?: T0Source[]
  keywords?: string[]
  markets?: string[]
  /** v0.6.0：同一 requestId 只允许计费一次；重试请复用同一个 ID */
  requestId?: string
}

export interface JudgeResponse {
  t0?: {
    used: boolean
    ok: boolean
    extractor: 'rules'
    rulesVersion?: string
    sourceCount?: number
    piiRemoved?: number
    noSignalFields?: string[]
    hitFields?: string[]
    coverageRate?: number
    reconciliation?: {
      applied: boolean; extractor: 'rules'; rulesVersion: string; policy: string
      noSignalFields: string[]; consistent: string[]; overrides: string[]
      conflicts: { field: string; kind: string; t0Value?: string; modelValue?: string; resolution: string }[]
      note: string
    } | null
    code?: string
    errors?: string[]
    reason?: string
  }
  billing?: GatewayBillingResult
  code?: string
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
    // P3：`res.json() as T` 是纯编译期断言，服务端返回 HTML 错误页或 null 时会一路
    // 传到渲染层才炸。这里在边界上做最小运行时形状校验，坏响应立刻变成明确异常。
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : {}
    } catch {
      throw new Error(`云端响应不是合法 JSON（HTTP ${res.status}）：${path}`)
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error(`云端响应结构非法（HTTP ${res.status}，期望 JSON 对象，实际 ${parsed === null ? 'null' : typeof parsed}）：${path}`)
    }
    const body = parsed as T & { ok?: boolean }
    if (!res.ok) return { ...body, ok: false } as T
    return body as T
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
      points?: GatewayHealth['points']; billing?: GatewayHealth['billing']
      baseline?: GatewayHealth['baseline']
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
      points: h.points, billing: h.billing, baseline: h.baseline,
    }
  } catch {
    return {
      online: false, mode: 'offline', configuredCount: 0, pinnedCount: 0, readyCount: 0,
      totalProviders: 0, providers: [], cacheEntries: 0, auditEntries: 0,
      reason: `云端服务未启动或不可达（${BASE}）。启动：npm run cloud`,
    }
  }
}

/**
 * P1-14 · 三元诊断：offline（服务不可达）/ E6005（未配 provider）/ E6008（已配 Key 但未锁快照）/ ready。
 * 三者根因与处置动作完全不同，绝不能把「服务没启动」误标成「没配 Key」去引导用户配 Key。
 */
export type GatewayDiagnosis = 'offline' | 'no_provider' | 'snapshot_unlocked' | 'ready'
export function gatewayDiagnosis(health: GatewayHealth | null): GatewayDiagnosis {
  if (!health || !health.online || health.mode === 'offline') return 'offline'
  if (health.configuredCount > 0 && health.pinnedCount === 0) return 'snapshot_unlocked'
  if (health.readyCount === 0) return 'no_provider'
  return 'ready'
}

export async function judgeCompany(input: JudgeInput): Promise<JudgeResponse> {
  try {
    return await jsonFetch<JudgeResponse>('/v1/judge', { method: 'POST', body: JSON.stringify(input) }, 35000)
  } catch {
    return {
      ok: false, degraded: true, errorCodes: [],
      reason: '云端服务未启动或不可达（offline）：本次为规则估算，未经模型校验。这不属于 E6005 未配 Key，也不属于 E6008 未锁快照；请先启动 npm run cloud。',
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
  /** v0.6.0：同一 requestId 只允许计费一次；重试请复用同一个 ID */
  requestId?: string
}

export interface EmailGenerateResponse {
  ok: boolean
  degraded?: boolean
  needsConsent?: boolean
  errorCodes?: string[]
  code?: string
  billing?: GatewayBillingResult
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
      ok: false, degraded: true, errorCodes: [],
      reason: '云端服务未启动或不可达（offline，不是 E6005/E6008）：本次不生成模型正文，已回退本地确定性模板。请先启动 npm run cloud。',
    }
  }
}

/** 服务端任务权威状态（v0.6.0：排队位次 / 并发上限一并回传，前端不得自行乐观猜测） */
export interface CloudTaskStatus {
  status: 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'aborted'
  queuePosition: number
  maxConcurrent: number
  activeCount: number
  queuedCount: number
}

/**
 * 云端任务的暂停 / 继续 / 中止（SSE 只做单向推送，控制走独立 POST）。
 * 返回服务端权威 task 状态：v0.5.0 前端把「继续」一律乐观标成 running，
 * 在并发已满、服务端实际仍为 queued 时会撒谎，v0.6.0 改为以响应为准。
 */
export async function controlCloudTask(
  taskId: string,
  action: 'pause' | 'resume' | 'abort',
  cursor?: unknown,
): Promise<{ ok: boolean; task?: CloudTaskStatus }> {
  try {
    const res = await jsonFetch<{ ok: boolean; task?: CloudTaskStatus }>(`/v1/tasks/${encodeURIComponent(taskId)}/${action}`, {
      method: 'POST', body: JSON.stringify(cursor ? { cursor } : {}),
    }, 4000)
    return { ok: Boolean(res.ok), task: res.task }
  } catch {
    return { ok: false }
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
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  // P3：仅 abort 不 cancel reader 时，Chromium 会继续持有流锁与解码缓冲直到 GC；
  // 这里显式 cancel + releaseLock，保证关闭弹窗/切换任务后连接与内存真正释放。
  const close = () => {
    controller?.abort()
    controller = null
    if (activeReader) {
      const r = activeReader
      activeReader = null
      void r.cancel().catch(() => { /* 已结束的流 cancel 会抛，忽略 */ })
      try { r.releaseLock() } catch { /* 未持锁时 releaseLock 会抛，忽略 */ }
    }
  }
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
    activeReader = reader
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
        // 流结束时缓冲区可能残留最后一个未以空行收尾的事件，不能丢
        buffer += decoder.decode()
        const tailLines = buffer.split('\n')
        const tailData = tailLines.find((l) => l.startsWith('data: '))
        if (tailData) {
          const tailType = tailLines.find((l) => l.startsWith('event: '))?.slice(7).trim() ?? 'message'
          try { onEvent({ type: tailType, ...JSON.parse(tailData.slice(6)) }) } catch { /* 忽略非法事件 */ }
        }
      } catch {
        // 主动 close() 触发的 abort 不是异常，不该向上报「连接中断」
        if (controller === null) return
        onEvent({ type: 'error', reason: 'SSE 连接中断' })
      } finally {
        if (activeReader === reader) activeReader = null
        try { reader.releaseLock() } catch { /* 忽略 */ }
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

/** legacy 评测入口：v0.8.0 决策不做人工标注，无标注样本时固定返回 NO_DATA，绝不编造「通过」 */
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
  gates: {
    baselineSize: number
    metrics: Record<string, { name: string; threshold: number; direction: string }>
    p0: string[]
    legacy?: boolean
    labelsRequired?: boolean
    accuracyClaim?: boolean
    evalMode?: string
    integrityGate?: {
      gateVersion: string; mode?: string; labelsRequired: boolean; accuracyClaim: boolean
      minSamples: number; p0: string[]
      metrics: Record<string, { name: string; threshold: number; direction: string }>
    }
    outcomeGate?: {
      gateVersion: string; labelsRequired: boolean; minSamples: number; windowSize: number
      metrics: Record<string, { name: string; threshold: number; direction: string; p0?: boolean }>
    }
    release?: {
      internalPreviewReady: boolean; externalValidated: boolean
      releaseEligible: boolean; accuracyClaim: boolean
    }
  } | null
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

/* ------------------------------------------------------------------ v0.7.0 批量 SDR 管道 */
/**
 * 定位仍是「自动获客」：CSV 是批量 SDR 既有的线索投喂通道，不是产品形态降级。
 * 服务端一律标 origin=user_imported；导入 ≠ 采集，导出 ≠ 发送。
 */
export interface BatchSummary { received: number; accepted: number; rejected: number; duplicates: number }
export interface BatchImportResult {
  ok: boolean; code?: string; errors?: string[]; version?: string; origin?: string
  summary?: BatchSummary
  rejected?: { rowIndex: number; reason: string }[]
  duplicates?: { rowIndex: number; domain: string; reason: string }[]
  companies?: { domain: string; companyName: string; missingSource: boolean }[]
  partial?: boolean; note?: string
}
export interface ImportedCompany {
  domain: string; companyName: string; country: string; status: string
  missingSource: boolean; hasJudgement: boolean; piiFields: string[]
  hasSource?: boolean; sourceOrigin?: string | null; sourceUrl?: string | null
}
export interface BatchJudgeResult {
  ok: boolean; code?: string; reason?: string; batchId?: string
  summary?: { total: number; succeeded: number; degraded: number; failed: number }
  items?: {
    domain: string; bucket: 'succeeded' | 'degraded' | 'failed'; missingSource: boolean
    t0: { used: boolean; reason?: string; rulesVersion?: string; evidenceCount?: number; coverage?: unknown }
    modelJudgement: unknown | null; codes: string[]; reason: string; note: string
  }[]
  allSucceeded?: boolean; releaseEligible?: boolean; note?: string
}
export interface DraftSender {
  name: string; email: string; company: string; postalAddress: string; unsubscribe: string
}
export interface ExportDraftItem {
  domain: string; to: string; subject: string; body: string
  grade: 'A' | 'B' | 'C' | 'D'; confirmed?: boolean
  sender: DraftSender; footer: string
}
export interface ExportDraftsResult {
  ok: boolean; code?: string; reason?: string; errors?: string[]
  format?: 'mbox'; filename?: string; content?: string; count?: number
  blocked?: { index: number; domain: string | null; code: string; reasons: string[] }[]
  statusAfterExport?: string; exportedIsNotSent?: boolean
  note?: string; disclaimer?: string
}
export interface BatchState {
  ok?: boolean; version?: string; positioning?: string; targetUser?: string; stage?: string
  companies?: number; judged?: number; exportedToday?: number; circuitOpen?: boolean
  bounce?: { sent: number; bounced: number; rate: number | null; sampleSize: number; threshold: number }
  draftExportDailyLimit?: number; releaseEligible?: boolean
  userDirectedFetch?: {
    version?: string; origin?: string
    counters?: { fetched: number; failed: number; robotsBlocked: number; ssrfBlocked: number; lastFetchAt?: string | null }
    policy?: { respectRobots?: boolean; perDomainMinIntervalMs?: number; maxUrlsPerBatch?: number }
  }
}

/* ------------------------------------------------- v0.9.0 用户指定 URL 抓取（ADR-032） */
export interface UserDirectedFetchHealth {
  version?: string; enabled?: boolean; origin?: string
  policy?: {
    version?: string; respectRobots?: boolean; timeoutMs?: number; maxBytes?: number
    maxTextChars?: number; maxRedirects?: number; perDomainMinIntervalMs?: number
    maxUrlsPerRequest?: number; maxUrlsPerBatch?: number
    allowedContentTypes?: string[]; userAgent?: string
  }
  counters?: { fetched: number; failed: number; robotsBlocked: number; ssrfBlocked: number; lastFetchAt: string | null }
  note?: string
}
export interface SourceFetchItem {
  ok: boolean; url: string; finalUrl?: string; fetchedAt?: string
  textChars?: number; hash?: string; truncated?: boolean; piiRemoved?: number
  contentType?: string; redirects?: string[]
  code?: string; reason?: string
}
export interface SourceFetchResult {
  ok: boolean; code?: string; reason?: string; version?: string; origin?: string
  fetched?: SourceFetchItem[]; failed?: SourceFetchItem[]
  summary?: { requested: number; fetched: number; failed: number }
  policy?: UserDirectedFetchHealth['policy']; note?: string
}
export interface BatchFetchSourcesResult {
  ok: boolean; code?: string; reason?: string; version?: string; fetchVersion?: string
  origin?: string; sourceOrigin?: string
  summary?: { requested: number; fetched: number; failed: number }
  items?: {
    domain: string; url: string; ok: boolean; finalUrl?: string; fetchedAt?: string
    textChars?: number; hash?: string; truncated?: boolean; piiRemoved?: number
    code?: string; reason?: string; missingSource?: boolean; origin?: string
  }[]
  releaseEligible?: boolean; note?: string
}
export interface OutcomeResult {
  ok: boolean; code?: string; reason?: string
  applied?: { domain: string; event: string; from: string; to: string }[]
  rejected?: { index: number; domain: string; event: string; code: string; reasons: string[] }[]
  state?: BatchState; note?: string
}

const offlineBatch = <T>(code = 'E6005'): T => ({ ok: false, code, reason: '云端批量管道不可达：请启动 npm run cloud' } as T)

export async function importCompanies(payload: { csv: string } | { rows: Record<string, string>[] }): Promise<BatchImportResult> {
  try {
    return await jsonFetch<BatchImportResult>('/v1/import/companies', { method: 'POST', body: JSON.stringify(payload) }, 15000)
  } catch { return offlineBatch<BatchImportResult>() }
}

export async function listImportedCompanies(): Promise<{ ok: boolean; count: number; companies: ImportedCompany[]; note?: string }> {
  try {
    return await jsonFetch('/v1/import/companies', undefined, 5000)
  } catch { return { ok: false, count: 0, companies: [], note: '云端批量管道不可达' } }
}

export async function runJudgeBatch(payload: { batchSize?: number; domains?: string[] } = {}): Promise<BatchJudgeResult> {
  try {
    return await jsonFetch<BatchJudgeResult>('/v1/batch/judge', { method: 'POST', body: JSON.stringify(payload) }, 60000)
  } catch { return offlineBatch<BatchJudgeResult>() }
}

export async function exportDrafts(payload: { items: ExportDraftItem[]; blacklist?: string[] }): Promise<ExportDraftsResult> {
  try {
    return await jsonFetch<ExportDraftsResult>('/v1/export/eml', { method: 'POST', body: JSON.stringify(payload) }, 15000)
  } catch { return offlineBatch<ExportDraftsResult>() }
}

export async function importOutcomes(payload: {
  events: { domain: string; event: 'sent' | 'bounced' | 'replied' | 'unsubscribed' | 'invalid'; confirmed?: boolean; operator?: string }[]
}): Promise<OutcomeResult> {
  try {
    return await jsonFetch<OutcomeResult>('/v1/import/outcomes', { method: 'POST', body: JSON.stringify(payload) }, 10000)
  } catch { return offlineBatch<OutcomeResult>() }
}

export async function getBatchHealth(): Promise<BatchState> {
  try { return await jsonFetch<BatchState>('/v1/batch/health', undefined, 3000) }
  catch { return { ...offlineBatch<BatchState>(), releaseEligible: false } }
}

export async function getSourceFetchHealth(): Promise<UserDirectedFetchHealth> {
  try { return await jsonFetch<UserDirectedFetchHealth>('/v1/sources/health', undefined, 3000) }
  catch { return { enabled: false, note: '云端抓取器不可达：请启动 npm run cloud' } }
}

/** 临时抓取：只由调用方显式给出 URL，不发现、不爬全站；返回逐条成功/失败，绝不编造原文 */
export async function fetchSourceUrls(urls: string[]): Promise<SourceFetchResult> {
  try {
    return await jsonFetch<SourceFetchResult>('/v1/sources/fetch', { method: 'POST', body: JSON.stringify({ urls }) }, 90000)
  } catch { return { ok: false, code: 'E4012', reason: '云端抓取器不可达：请启动 npm run cloud' } }
}

/** 批量抓取：把已导入线索缺的原文补上（origin=user_directed_fetch），抓取 ≠ 采集 */
export async function fetchCompanySources(payload: { domains?: string[]; limit?: number } = {}): Promise<BatchFetchSourcesResult> {
  try {
    return await jsonFetch<BatchFetchSourcesResult>('/v1/batch/fetch-sources', { method: 'POST', body: JSON.stringify(payload) }, 120000)
  } catch { return { ok: false, code: 'E4012', reason: '云端批量抓取不可达：请启动 npm run cloud' } }
}

/** 由调用方在本地拼装合规尾巴；服务端只校验存在性，不代生成、不代存 */
export function buildComplianceFooter(sender: DraftSender): string {
  return `${sender.name} · ${sender.company}\n${sender.postalAddress}\n${sender.unsubscribe}`
}

/** 触发浏览器下载，纯前端动作；不代表已发送 */
export function downloadMbox(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/mbox;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
