/**
 * 前端 → 云端网关客户端
 *
 * 明确边界：探测失败 / 未配置 Key 时返回 offline，不抛异常、不重试、不伪造在线状态。
 * 真实判断结果只在通过服务端 schema + 证据校验后才回传，客户端仍会再校验一次。
 */
import type { TaskConfig } from '@/types'

const BASE = ((import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_LEADPILOT_API)
  ?? 'http://127.0.0.1:5181'

export const gatewayBaseUrl = BASE

export interface GatewayHealth {
  online: boolean
  mode: 'configured' | 'unconfigured-demo' | 'offline'
  configuredCount: number
  totalProviders: number
  providers: { key: string; name: string; tier: string; region: string; configured: boolean; circuitOpen: boolean }[]
  cacheEntries: number
  auditEntries: number
  reason?: string
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
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
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
      ok: boolean; mode: string; configuredCount: number; totalProviders: number
      providers: GatewayHealth['providers']; cacheEntries: number; auditEntries: number
    }>('/v1/gateway/health', undefined, 1600)
    return {
      online: true,
      mode: h.mode === 'configured' ? 'configured' : 'unconfigured-demo',
      configuredCount: h.configuredCount, totalProviders: h.totalProviders,
      providers: h.providers ?? [], cacheEntries: h.cacheEntries, auditEntries: h.auditEntries,
    }
  } catch {
    return {
      online: false, mode: 'offline', configuredCount: 0, totalProviders: 0,
      providers: [], cacheEntries: 0, auditEntries: 0,
      reason: `云端服务未启动或不可达（${BASE}）。启动：node server/index.mjs`,
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

/** 云端任务 + SSE 流式订阅；数据源未接入时事件带 demo:true */
export function startCloudTask(
  config: TaskConfig,
  onEvent: (event: { type: string; [k: string]: unknown }) => void,
): Promise<{ ok: boolean; taskId?: string; reason?: string; close(): void }> {
  let source: EventSource | null = null
  const close = () => { source?.close(); source = null }
  return jsonFetch<{ ok: boolean; task: { id: string } }>('/v1/tasks', {
    method: 'POST', body: JSON.stringify(config),
  }, 6000).then((res) => {
    if (!res.ok || !res.task?.id) {
      return { ok: false, reason: '云端任务创建失败', close }
    }
    source = new EventSource(`${BASE}/v1/tasks/${res.task.id}/events`)
    source.onmessage = (e) => { try { onEvent(JSON.parse(e.data)) } catch { /* 忽略非法事件 */ } }
    for (const type of ['hello', 'stage', 'progress', 'source_warning', 'done', 'aborted', 'paused', 'resumed', 'queued']) {
      source.addEventListener(type, (e) => {
        try { onEvent({ type, ...JSON.parse((e as MessageEvent).data) }) } catch { /* 忽略 */ }
      })
    }
    source.onerror = () => onEvent({ type: 'error', reason: 'SSE 连接中断' })
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
