import { describe, expect, it } from 'vitest'
import { createGateway, route, regionDecision } from '../gateway.mjs'
import { createOrchestrator } from '../orchestrator.mjs'
import { evaluateBaseline, baselineManifest } from '../eval.mjs'
import { protocol, validateSchema, verifyEvidence, assertNoPii, pointCost, quoteMatchesContext, buildEmailMessages, validateEmailDraft } from '../protocol.mjs'
import { createApp } from '../index.mjs'
import { createStore, createMemoryStore, sqliteAvailable } from '../store.mjs'
import { extractFacts, validateT0Input, T0_RULES_VERSION } from '../t0.mjs'
import { createDataSourceRegistry, SOURCE_DEFS } from '../data-sources.mjs'
import { sanitizeContext } from '../protocol.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const SOURCES = [
  'About: Authorized distributor for Parker and Eaton across Benelux.',
  'We stock hydraulic hose fittings, JIC fittings and brass adapters for industrial distributors.',
  'Team of 23 across Rotterdam and Antwerp. FOB Rotterdam, CIF terms available.',
]

const wire = (overrides = {}) => ({
  company_id: 'c_0001',
  customer_type: {
    value: 'distributor', confidence: 0.82,
    evidence: [{ quote: 'Authorized distributor for Parker and Eaton across Benelux', source_url: 'https://x.example/about', fetched_at: '2026-11-06' }],
  },
  import_signal: {
    value: 'confirmed', confidence: 0.9,
    evidence: [{ quote: 'We stock hydraulic hose fittings, JIC fittings and brass adapters', source_url: 'https://x.example/products', fetched_at: '2026-11-06' }],
  },
  size_estimate: {
    tier: 'M', employee_range: [11, 50], confidence: 0.61,
    evidence: [{ quote: 'Team of 23 across Rotterdam and Antwerp', source_url: 'https://x.example/team', fetched_at: '2026-11-06' }],
  },
  negative_flags: [],
  model_id: 'deepseek-flash', model_version: '2026-10-15',
  prompt_version: protocol.promptVersion, schema_version: protocol.schemaVersion,
  ...overrides,
})

/** 测试专用：为所有 provider 注入官网可查格式的固定快照，合法通过「快照锁定」门禁 */
const PINNED_VERSIONS = Object.fromEntries(
  protocol.providers.map((p) => [
    `LEADPILOT_MODEL_VERSION_${p.key.toUpperCase().replace(/-/g, '_')}`,
    `${p.model}-2026-10-15`,
  ]),
)
const testEnv = (extra = {}) => ({ ...PINNED_VERSIONS, ...extra })

const okFetch = (raw) => async () => ({
  status: 200, ok: true,
  json: async () => ({
    choices: [{ message: { content: JSON.stringify(raw) } }],
    usage: { prompt_tokens: 1000, completion_tokens: 200 },
  }),
})

const judgeInput = (overrides = {}) => ({
  companyId: 'c_0001', domain: 'x.example', country: '美国',
  sourceTexts: SOURCES,
  facts: { keywordHits: [{ term: 'hydraulic fittings', count: 14 }], customsRecords: 9 },
  ...overrides,
})

describe('共享协议 · PRD 6.7.3 wire 格式', () => {
  it('接受 snake_case 证据字段（source_url / fetched_at）', () => {
    const r = validateSchema(wire())
    expect(r.valid).toBe(true)
    expect(r.value.customer_type.evidence[0].source_url).toBe('https://x.example/about')
  })

  it('拒绝 score 字段、枚举越界与 -latest 浮动指针', () => {
    expect(validateSchema(wire({ customer_type: { ...wire().customer_type, score: 88 } })).valid).toBe(false)
    expect(validateSchema(wire({ import_signal: { ...wire().import_signal, value: 'unicorn' } })).valid).toBe(false)
    expect(validateSchema(wire({ model_version: 'gpt-5-latest' })).valid).toBe(false)
  })

  it('伪造引用整条丢弃并回退 no_signal，可溯源率低于 95% 不通过门禁', () => {
    const fake = { ...wire(), customer_type: { ...wire().customer_type, evidence: [{ quote: 'ISO 9001 certified since 1998 with 40 engineers', source_url: 'https://x.example/cert', fetched_at: '2026-11-06' }] } }
    const checked = validateSchema(fake)
    const verified = verifyEvidence(checked.value, SOURCES)
    expect(verified.fields.customer_type.accepted).toBe(false)
    expect(verified.value.customer_type.value).toBe('unknown')
    expect(verified.provenanceRate).toBeLessThan(0.95)
    expect(verified.passesGate).toBe(false)
  })

  it('真实引用通过门禁，模糊匹配容忍标点差异', () => {
    expect(quoteMatchesContext('Team of 23, across Rotterdam & Antwerp!', SOURCES)).toBe(true)
    const verified = verifyEvidence(validateSchema(wire()).value, SOURCES)
    expect(verified.provenanceRate).toBe(1)
    expect(verified.passesGate).toBe(true)
  })

  it('11.4 数据最小化：含邮箱/电话/Bearer 的请求体直接拒绝', () => {
    expect(assertNoPii({ facts: { keywordHits: 3 } }).ok).toBe(true)
    expect(assertNoPii({ facts: { email: 'a@b.com' } }).ok).toBe(false)
    expect(assertNoPii({ facts: { note: 'call +86 138 0000' } }).ok).toBe(false)
    expect(assertNoPii({ facts: { token: 'Bearer sk-abc' } }).ok).toBe(false)
  })

  it('F0-6 点数折算：T0/T1/T2 层级系数 1 / 1.6 / 4', () => {
    const usage = { input: 1_000_000, output: 1_000_000 }
    const rate = { inUsdPerM: 1, outUsdPerM: 1 }
    const base = pointCost(usage, 'T0', 0, rate)
    expect(pointCost(usage, 'T1', 0, rate)).toBeCloseTo(base * 1.6, 6)
    expect(pointCost(usage, 'T2', 0, rate)).toBeCloseTo(base * 4, 6)
    expect(pointCost(usage, 'T0', 10, rate)).toBeGreaterThan(base)
  })
})

describe('LLM 网关 · F0-2 路由 / F0-4 降级 / 11.4 地域', () => {
  it('路由判定与前端一致', () => {
    expect(route({ type: 'extract' })).toBe('T0')
    expect(route({ type: 'write_email' })).toBe('T1')
    expect(route({ type: 'judge_import', confidence: 0.4 })).toBe('T2')
    expect(route({ type: 'judge_size', conflict: true })).toBe('T2')
    expect(route({ type: 'extract', t0AllFailed: true })).toBe('T1')
  })

  it('EU/EEA/UK 客户 T2 境外模型默认拒绝，需显式同意', () => {
    expect(regionDecision('德国', 'T0').group).toBe('domestic')
    expect(regionDecision('德国', 'T2').needsConsent).toBe(true)
    expect(regionDecision('德国', 'T2', { allowOverseas: true }).needsConsent).toBe(false)
    expect(regionDecision('美国', 'T2').needsConsent).toBe(false)
  })

  it('未配置 Key 时明确 E6005 降级，不伪造判断', async () => {
    const g = createGateway({ env: {}, fetchImpl: async () => { throw new Error('不应发起请求') } })
    expect(g.health().mode).toBe('unconfigured-demo')
    expect(g.health().ok).toBe(false)
    const r = await g.judge(judgeInput())
    expect(r.degraded).toBe(true)
    expect(r.judgement).toBeNull()
    expect(r.errorCodes).toContain('E6005')
  })

  it('只配 Key 但未锁快照时明确 E6008，且不发起真实调用', async () => {
    let calls = 0
    const g = createGateway({ env: { DEEPSEEK_API_KEY: 'k' }, fetchImpl: async () => { calls++; return okFetch(wire())() } })
    const h = g.health()
    // DEEPSEEK_API_KEY 被 T0 / T1 两个 provider 共用，故为 2
    expect(h.configuredCount).toBe(2)
    expect(h.pinnedCount).toBe(0)
    expect(h.readyCount).toBe(0)
    expect(h.mode).toBe('unconfigured-demo')
    expect(h.reason).toContain('E6008')
    const r = await g.judge(judgeInput())
    expect(r.errorCodes).toContain('E6008')
    expect(r.judgement).toBeNull()
    expect(calls).toBe(0)
    const mail = await g.writeEmail({
      anchor: 'you distribute Parker fittings', product: 'hydraulic fittings',
      advantages: [], purpose: 'intro', tone: 'concise', maxWords: 90, language: 'en', country: '美国',
    })
    expect(mail.errorCodes).toContain('E6008')
    expect(mail.body).toBeNull()
  })

  it('-latest 快照视为未锁定；锁定后 model_version 留痕为具体 ID', async () => {
    const floating = createGateway({
      env: testEnv({ LEADPILOT_MODEL_VERSION_DEEPSEEK_PRO: 'deepseek-latest' }),
    })
    expect(floating.health().providers.find((p) => p.key === 'deepseek-pro').pinned).toBe(false)

    const g = createGateway({ env: testEnv({ DEEPSEEK_API_KEY: 'k' }), fetchImpl: okFetch(wire()), sleep: async () => {}, now: () => 1_700_000_000_000 })
    const r = await g.judge(judgeInput())
    expect(r.ok).toBe(true)
    expect(r.judgement.model_version).not.toMatch(/latest/i)
    expect(r.judgement.model_version).toContain('-2026-10-15')
  })

  it('含 PII 的请求不向任何 provider 发送数据', async () => {
    let calls = 0
    const g = createGateway({ env: testEnv({ DEEPSEEK_API_KEY: 'k' }), fetchImpl: async () => { calls++; return okFetch(wire())() } })
    const r = await g.judge(judgeInput({ facts: { email: 'purchasing@x.example' } }))
    expect(r.errorCodes).toContain('E6004')
    expect(calls).toBe(0)
  })

  it('配置 Key 后走真实调用链，返回 wire + client 双格式判断', async () => {
    const g = createGateway({ env: testEnv({ DEEPSEEK_API_KEY: 'k' }), fetchImpl: okFetch(wire()), sleep: async () => {}, now: () => 1_700_000_000_000 })
    const r = await g.judge(judgeInput())
    expect(r.ok).toBe(true)
    expect(r.judgement.customer_type.value).toBe('distributor')
    expect(r.clientJudgement.customer_type.evidence[0].sourceUrl).toBe('https://x.example/about')
    expect(r.provenanceRate).toBe(1)
    expect(r.passesGate).toBe(true)
    expect(r.audit.points).toBeGreaterThan(0)
    expect(g.getAudit()).toHaveLength(1)
  })

  it('5xx 立即切下一顺位 provider，不重试供应商侧故障', async () => {
    const fetchImpl = async (url) => url.includes('bigmodel')
      ? okFetch(wire())()
      : { status: 503, ok: false, json: async () => ({}) }
    const g = createGateway({ env: testEnv({ DEEPSEEK_API_KEY: 'k', ZHIPU_API_KEY: 'k2' }), fetchImpl, sleep: async () => {}, now: () => 1_700_000_000_000 })
    const r = await g.judge(judgeInput())
    expect(r.ok).toBe(true)
    expect(r.audit.providerKey).toBe('glm-5.3')
  })

  it('30 天结果缓存：同域名 + 同 prompt 版本不重复调用', async () => {
    let calls = 0
    const fetchImpl = async () => { calls++; return okFetch(wire())() }
    const g = createGateway({ env: testEnv({ DEEPSEEK_API_KEY: 'k' }), fetchImpl, sleep: async () => {}, now: () => 1_700_000_000_000 })
    await g.judge(judgeInput())
    const second = await g.judge(judgeInput())
    expect(second.cached).toBe(true)
    expect(calls).toBe(1)
    expect(g.getCacheStats().entries).toBe(1)
  })

  it('连续失败 10 次熔断该 provider', () => {
    const g = createGateway({ env: testEnv({ DEEPSEEK_API_KEY: 'k' }) })
    const p = g._internals.providers.find((x) => x.key === 'deepseek-pro')
    for (let i = 0; i < 10; i++) g._internals.recordFailure(p)
    expect(g.health().providers.find((x) => x.key === 'deepseek-pro').circuitOpen).toBe(true)
    expect(g.getCircuitState().some((x) => x.providerKey === 'deepseek-pro')).toBe(true)
  })
})

describe('任务编排器 · F2 SSE / 断点续跑 / 并发', () => {
  const config = { keywords: ['hydraulic fittings'], markets: ['德国'], depth: 2, targetCount: 20 }

  it('创建任务返回游标与点数预估，事件带 demo 标记', () => {
    const o = createOrchestrator({ tickMs: 10000 })
    const task = o.createTask(config)
    expect(task.status).toBe('running')
    expect(task.pointsEstimated).toBe(40)
    expect(task.cursor).toMatchObject({ stageIndex: 0, offset: 0 })
    const events = []
    o.subscribe(task.id, (e) => events.push(e))
    o.emit(task.id, 'progress', { note: 'test' })
    expect(events[0].demo).toBe(true)
    o.dispose()
  })

  it('暂停 / 带游标继续 / 中止后保留已用点数', () => {
    const o = createOrchestrator({ tickMs: 10000 })
    const t = o.createTask(config)
    expect(o.pause(t.id).status).toBe('paused')
    const resumed = o.resume(t.id, { offset: 12, stageIndex: 2 })
    expect(resumed.status).toBe('running')
    expect(resumed.cursor.offset).toBe(12)
    const aborted = o.abort(t.id)
    expect(aborted.status).toBe('aborted')
    expect(aborted.pointsUsed).toBeLessThanOrEqual(aborted.pointsEstimated)
    o.dispose()
  })

  it('单机最多同时运行 3 个任务，其余排队', () => {
    const o = createOrchestrator({ tickMs: 10000 })
    const ids = Array.from({ length: 4 }, () => o.createTask(config))
    expect(ids.filter((t) => t.status === 'running')).toHaveLength(3)
    expect(ids[3].status).toBe('queued')
    o.dispose()
  })
})

describe('T1 写信链路 · F6-2 硬约束 / F6-5 合规尾巴 / E6005 降级', () => {
  const draft = {
    subject: 'Hydraulic fittings supply for Rotex',
    body: 'Saw that you distribute Parker fittings across Benelux, so I am writing to your team directly. We supply hydraulic hose fittings with stable lead times on repeat orders. Would it help if I sent a short quote sheet with FOB terms?',
    anchor_used: 'you distribute Parker fittings',
  }
  const emailInput = (overrides = {}) => ({
    anchor: 'you distribute Parker fittings across Benelux',
    product: 'hydraulic hose fittings',
    advantages: ['stable lead times on repeat orders', 'small-batch customization'],
    purpose: 'intro', tone: 'concise', maxWords: 90, language: 'en', country: '美国',
    ...overrides,
  })

  it('Prompt 把事实装进 <context>，并禁止模型输出身份/退订/占位符/打分', () => {
    const [system, user] = buildEmailMessages(emailInput())
    expect(system.role).toBe('system')
    expect(system.content).toContain('Use ONLY the facts inside <context>')
    expect(system.content).toContain('unsubscribe line')
    expect(system.content).toContain('Never output a score')
    expect(user.content).toContain('<context>')
    expect(user.content).toContain('hydraulic hose fittings')
  })

  it('服务端硬约束拒绝禁词 / 占位符 / 退订尾巴 / 超字数，接受合规正文', () => {
    expect(validateEmailDraft(draft).valid).toBe(true)
    expect(validateEmailDraft({ ...draft, body: draft.body + ' Act now for a free quote!' }).valid).toBe(false)
    expect(validateEmailDraft({ ...draft, body: draft.body + ' [insert company name]' }).valid).toBe(false)
    expect(validateEmailDraft({ ...draft, body: draft.body + " Reply STOP and I won't contact you again." }).valid).toBe(false)
    expect(validateEmailDraft({ ...draft, body: draft.body.repeat(4) }).valid).toBe(false)
    expect(validateEmailDraft(null).valid).toBe(false)
  })

  it('未配置 Key 时写信明确 E6005，正文为空（不返回伪装的模板）', async () => {
    const g = createGateway({ env: {}, fetchImpl: async () => { throw new Error('不应发起请求') } })
    const r = await g.writeEmail(emailInput())
    expect(r.ok).toBe(false)
    expect(r.degraded).toBe(true)
    expect(r.errorCodes).toContain('E6005')
    expect(r.body).toBeNull()
  })

  it('传入官网原文时 T0 规则抽取接管个性化锚点，降级仍如实上报且正文为空', async () => {
    const text = 'Authorized distributor for Parker fittings across Benelux. '
      + 'We stock hydraulic hose fittings for industrial buyers.'
    const g = createGateway({ env: {}, fetchImpl: async () => { throw new Error('不应发起请求') } })
    const r = await g.writeEmail(emailInput({
      sources: [{ url: 'https://acme.example/about', text, fetched_at: '2026-11-08' }],
    }))
    expect(r.anchorSource).toBe('t0-rules')
    expect(r.t0.ok).toBe(true)
    expect(r.t0.extractor).toBe('rules')
    expect(r.t0.anchorCount).toBeGreaterThan(0)
    expect(text.includes(r.anchor)).toBe(true)
    expect(r.anchor).toContain('hydraulic hose fittings')
    expect(r.errorCodes).toContain('E6005')
    expect(r.body).toBeNull()
  })

  it('T0 输入非法时如实回退调用方 anchor，不伪造抽取结果', async () => {
    const g = createGateway({ env: {}, fetchImpl: async () => { throw new Error('不应发起请求') } })
    const r = await g.writeEmail(emailInput({
      sources: [{ url: 'not-a-url', text: 'x', fetched_at: '2026-11-08' }],
    }))
    expect(r.anchorSource).toBe('client')
    expect(r.t0.ok).toBe(false)
    expect(r.t0.code).toBe('E6004')
    expect(r.anchor).toBe('you distribute Parker fittings across Benelux')
  })

  it('含 PII 的写信请求不转发给任何 provider', async () => {
    let calls = 0
    const g = createGateway({ env: testEnv({ DEEPSEEK_API_KEY: 'k' }), fetchImpl: async () => { calls++; return okFetch(draft)() } })
    const r = await g.writeEmail(emailInput({ anchor: 'write to purchasing@x.example' }))
    expect(r.errorCodes).toContain('E6004')
    expect(calls).toBe(0)
  })

  it('配置 Key 后生成两版之一的真实正文，审计记 write_email 与点数', async () => {
    const g = createGateway({ env: testEnv({ DEEPSEEK_API_KEY: 'k' }), fetchImpl: okFetch(draft), sleep: async () => {}, now: () => 1_700_000_000_000 })
    const r = await g.writeEmail(emailInput({ angle: 'technical_and_customization' }))
    expect(r.ok).toBe(true)
    expect(r.subject).toBe(draft.subject)
    expect(r.body).toBe(draft.body)
    expect(r.tier).toBe('T1')
    expect(r.audit.points).toBeGreaterThan(0)
    expect(g.getAudit()[0].taskType).toBe('write_email')
  })

  it('模型正文未过硬约束时降级，不把未校验正文交给用户', async () => {
    const bad = { ...draft, body: draft.body + ' We guarantee the best price, click here!' }
    const g = createGateway({ env: testEnv({ DEEPSEEK_API_KEY: 'k' }), fetchImpl: okFetch(bad), sleep: async () => {}, now: () => 1_700_000_000_000 })
    const r = await g.writeEmail(emailInput())
    expect(r.ok).toBe(false)
    expect(r.body).toBeNull()
    expect(r.errorCodes).toContain('E6005')
  })

  it('HTTP /v1/email/generate：E6004 / E6005 / 200 三种返回都可核验', async () => {
    // 显式传空 env，避免开发机全局 Key 影响「无 Key 降级」断言
    const app = createApp({ store: createMemoryStore(), gateway: createGateway({ env: {}, fetchImpl: async () => { throw new Error('不应发起请求') } }) })
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${app.server.address().port}`
    const post = (body) => fetch(`${base}/v1/email/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json() }))
    try {
      const pii = await post(emailInput({ anchor: 'mail to buyer@x.example' }))
      expect(pii.status).toBe(400)
      expect(pii.body.code).toBe('E6004')
      const noKey = await post(emailInput())
      expect(noKey.status).toBe(503)
      expect(noKey.body.errorCodes).toContain('E6005')
      expect(noKey.body.body).toBeNull()
    } finally {
      await new Promise((resolve) => app.server.close(resolve))
    }

    const realGateway = createGateway({
      env: testEnv({ DEEPSEEK_API_KEY: 'k' }), fetchImpl: okFetch(draft),
      sleep: async () => {}, now: () => 1_700_000_000_000,
    })
    const app2 = createApp({ store: createMemoryStore(), gateway: realGateway })
    await new Promise((resolve) => app2.server.listen(0, '127.0.0.1', resolve))
    const base2 = `http://127.0.0.1:${app2.server.address().port}`
    try {
      const ok = await fetch(`${base2}/v1/email/generate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(emailInput()),
      }).then(async (res) => ({ status: res.status, body: await res.json() }))
      expect(ok.status).toBe(200)
      expect(ok.body.ok).toBe(true)
      expect(ok.body.note).toContain('合规尾巴')
      // 合规尾巴由客户端注入：服务端响应里绝不能出现退订说明
      expect(ok.body.body).not.toContain('unsubscribe')
    } finally {
      await new Promise((resolve) => app2.server.close(resolve))
    }
  })
})

describe('HTTP 安全边界 · 鉴权 / CORS / 限流', () => {
  const start = async (opts) => {
    const app = createApp({ store: createMemoryStore(), ...opts })
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    return {
      base: `http://127.0.0.1:${app.server.address().port}`,
      close: () => new Promise((resolve) => app.server.close(resolve)),
    }
  }
  const bareGateway = () => createGateway({ env: {}, fetchImpl: async () => { throw new Error('不应发起请求') } })

  it('本地回环默认免鉴权；非白名单 Origin 绝不被回显', async () => {
    const s = await start({
      gateway: bareGateway(),
      security: { token: '', loopback: true, cors: ['http://127.0.0.1:5180'], rateLimit: 100 },
    })
    try {
      const evil = await fetch(`${s.base}/v1/gateway/health`, { headers: { origin: 'https://evil.example' } })
      expect(evil.status).toBe(200)
      expect(evil.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5180')
      const local = await fetch(`${s.base}/v1/gateway/health`, { headers: { origin: 'http://127.0.0.1:5180' } })
      expect(local.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5180')
      const h = await (await fetch(`${s.base}/health`)).json()
      expect(h.security.mode).toBe('local-open')
      expect(h.security.cors).not.toContain('*')
    } finally { await s.close() }
  })

  it('配置 token 后 /v1/* 必须 Bearer 鉴权，/health 仍可探活', async () => {
    const s = await start({
      gateway: bareGateway(),
      security: { token: 's3cr3t', loopback: false, cors: ['http://127.0.0.1:5180'], rateLimit: 100 },
    })
    try {
      const denied = await fetch(`${s.base}/v1/gateway/health`)
      expect(denied.status).toBe(401)
      expect((await denied.json()).code).toBe('E6009')
      const allowed = await fetch(`${s.base}/v1/gateway/health`, { headers: { authorization: 'Bearer s3cr3t' } })
      expect(allowed.status).toBe(200)
      const h = await (await fetch(`${s.base}/health`)).json()
      expect(h.security.mode).toBe('token')
      expect(h.security.loopback).toBe(false)
    } finally { await s.close() }
  })

  it('超过限流阈值返回 429 + E6010，并带 Retry-After', async () => {
    const s = await start({
      gateway: bareGateway(),
      security: { token: '', loopback: true, cors: ['http://127.0.0.1:5180'], rateLimit: 2 },
    })
    try {
      const a = await fetch(`${s.base}/health`)
      const b = await fetch(`${s.base}/health`)
      const c = await fetch(`${s.base}/health`)
      expect(a.status).toBe(200)
      expect(b.status).toBe(200)
      expect(c.status).toBe(429)
      expect((await c.json()).code).toBe('E6010')
      expect(c.headers.get('retry-after')).not.toBeNull()
    } finally { await s.close() }
  })
})

describe('持久化 · AC-03 跨进程续跑与额度不重复扣', () => {
  const config = { keywords: ['hydraulic fittings'], markets: ['德国'], depth: 2, targetCount: 20 }

  it('memory store 契约：任务 CRUD / 缓存 TTL / 审计顺序', () => {
    let clock = 1000
    const s = createMemoryStore({ now: () => clock })
    s.taskUpsert('t1', { cursor: { offset: 6 } })
    expect(s.taskGet('t1').cursor.offset).toBe(6)
    expect(s.taskList()).toHaveLength(1)
    s.cacheSet('k', { v: 1 }, 500)
    expect(s.cacheGet('k')).toEqual({ v: 1 })
    clock = 1600
    expect(s.cacheGet('k')).toBeNull()
    s.auditAppend({ n: 1 })
    s.auditAppend({ n: 2 })
    expect(s.auditList().map((x) => x.n)).toEqual([1, 2])
    s.taskDelete('t1')
    expect(s.taskGet('t1')).toBeNull()
  })

  it.skipIf(!sqliteAvailable)('sqlite 文件在两个独立 store 实例之间恢复任务 / 缓存 / 审计', () => {
    const dir = join(tmpdir(), `leadpilot-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const dbPath = join(dir, 'leadpilot.db')
    try {
      const s1 = createStore({ mode: 'sqlite', dbPath })
      expect(s1.mode).toBe('sqlite')
      s1.taskUpsert('task_x', { id: 'task_x', status: 'running', cursor: { offset: 9 }, progress: { log: [] } })
      s1.cacheSet('cache_x', { judgement: 'ok' }, 86400000)
      s1.auditAppend({ taskType: 'judge', points: 3 })
      s1.close()

      const s2 = createStore({ mode: 'sqlite', dbPath })
      expect(s2.taskGet('task_x').cursor.offset).toBe(9)
      expect(s2.cacheGet('cache_x')).toEqual({ judgement: 'ok' })
      expect(s2.auditList()[0]).toMatchObject({ taskType: 'judge', points: 3 })
      expect(s2.cacheStats().entries).toBe(1)
      s2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('进程重启后活跃任务降为 paused，游标与已用点数保留，续跑不重复扣点', () => {
    const store = createMemoryStore()
    const o1 = createOrchestrator({ store, tickMs: 10000 })
    const t = o1.createTask(config)
    expect(t.status).toBe('running')
    const saved = store.taskGet(t.id)
    store.taskUpsert(t.id, {
      ...saved,
      cursor: { ...saved.cursor, offset: 9 },
      pointsUsed: 12,
      progress: { ...saved.progress, qualified: 6 },
    })
    o1.dispose()

    const o2 = createOrchestrator({ store, tickMs: 10000 })
    expect(o2.recoveredIds).toContain(t.id)
    const restored = o2.getTask(t.id)
    expect(restored.status).toBe('paused')
    expect(restored.recovered).toBe(true)
    expect(restored.persistence).toBe('memory')
    expect(restored.cursor.offset).toBe(9)
    expect(restored.pointsUsed).toBe(12)
    expect(restored.progress.qualified).toBe(6)
    expect(restored.progress.log.at(-1).text).toContain('额度不重复扣减')

    const resumed = o2.resume(t.id, restored.cursor)
    expect(resumed.status).toBe('running')
    expect(resumed.pointsUsed).toBe(12)
    expect(resumed.cursor.offset).toBe(9)
    o2.dispose()
  })

  it('网关缓存与审计走持久化存储，新网关实例命中 30 天缓存', async () => {
    const store = createMemoryStore()
    const baseOpts = {
      env: testEnv({ DEEPSEEK_API_KEY: 'k' }),
      sleep: async () => {}, now: () => 1_700_000_000_000, store,
    }
    const g1 = createGateway({ ...baseOpts, fetchImpl: okFetch(wire()) })
    await g1.judge(judgeInput())
    expect(g1.persistence).toBe('memory')
    expect(store.cacheStats().entries).toBe(1)
    expect(store.auditList()[0].taskType).toBe('judge')

    const g2 = createGateway({
      ...baseOpts,
      fetchImpl: async () => { throw new Error('缓存命中不应发起 provider 请求') },
    })
    const r = await g2.judge(judgeInput())
    expect(r.cached).toBe(true)
    expect(r.ok).toBe(true)
    expect(g2.getAudit().length).toBeGreaterThanOrEqual(2)
  })
})

describe('模型评测门禁 · PRD 9.5', () => {
  const sample = (i, patch = {}) => ({
    expected: { customer_type: 'distributor', match_rank: i },
    predicted: { customer_type: 'distributor', match_rank: i },
    provenance: { matched: 1, total: 1 },
    signals: { true: 1, false: 0, found: 1, actual: 1 },
    rules: { passed: 1, total: 1 },
    schemaPass: true, refused: false,
    ...patch,
  })

  it('无标注数据时返回 NO_DATA，绝不编造通过', () => {
    const r = evaluateBaseline([])
    expect(r.status).toBe('NO_DATA')
    expect(baselineManifest().status).toBe('NOT_LABELED')
    expect(baselineManifest().baselineSize).toBe(385)
  })

  it('385 家理想样本通过；P0 指标失守阻断发布', () => {
    const good = Array.from({ length: 385 }, (_, i) => sample(i))
    const passed = evaluateBaseline(good, 'baseline-2026-11')
    expect(passed.status).toBe('PASSED')
    const bad = good.map((s, i) => i === 0 ? { ...s, provenance: { matched: 0, total: 100 } } : s)
    const blocked = evaluateBaseline(bad, 'baseline-2026-11')
    expect(blocked.status).toBe('BLOCKED')
    expect(blocked.p0Failures.some((x) => x.includes('可溯源率'))).toBe(true)
  })
})

describe('T0 规则抽取 · 可核验引用 / 不补零 / 不伪造', () => {
  const doc = (text, url = 'https://acme.example/about') => ({ url, text, fetched_at: '2026-11-08' })
  const input = (sources, keywords = ['hydraulic hose fittings']) => ({ company_id: 'c_t0_01', sources, keywords })

  it('非法输入一律 400 E6004，绝不拿缺失来源硬凑事实', () => {
    expect(extractFacts({}).ok).toBe(false)
    expect(extractFacts(input([])).code).toBe('E6004')
    expect(validateT0Input(input([{ url: 'ftp://x', text: 'abc', fetched_at: '2026-11-08' }])).ok).toBe(false)
    expect(validateT0Input(input([doc('abc')], [])).ok).toBe(true)
    const noDate = { ...doc('some text') }
    delete noDate.fetched_at
    expect(validateT0Input(input([noDate])).ok).toBe(false)
    const pii = input([doc('Authorized distributor')])
    pii.contact_email = 'sales@acme.example'
    expect(validateT0Input(pii).ok).toBe(false)
    expect(extractFacts({ ...input([doc('x')]), keywords: ['sk-abcdefghijk'] }).ok).toBe(false)
  })

  it('从原文抽客户类型 / 进口信号 / 规模 / 产品词 / 锚点，且每条 quote 逐字可核验', () => {
    const text = 'About us: Authorized distributor for Parker and Eaton across Benelux. '
      + 'We import hydraulic hose fittings from Asia. Our team has 85 employees across Rotterdam and Antwerp.'
    const r = extractFacts(input([doc(text)]))
    expect(r.ok).toBe(true)
    expect(r.extractor).toBe('rules')
    expect(r.sourceMode).toBe('provided-text')
    expect(r.rulesVersion).toBe(T0_RULES_VERSION)
    expect(r.facts.customer_type.candidates.length).toBeGreaterThan(0)
    expect(r.facts.import_signal.value).toBe('confirmed')
    expect(r.facts.size_estimate.tier).toBe('M')
    expect(r.facts.size_estimate.employee_count_from_text).toBe(85)
    expect(r.facts.product_terms.some((p) => p.term === 'hydraulic hose fittings')).toBe(true)
    expect(r.facts.anchors.length).toBeGreaterThan(0)
    expect(r.coverage.noSignalFields).toEqual([])

    const clean = sanitizeContext([text]).texts[0]
    for (const e of r.evidence) {
      expect(clean.includes(e.quote)).toBe(true)
      expect(e.source_url).toMatch(/^https?:\/\//)
      expect(e.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}/)
    }
  })

  it('无命中维度明确 no_signal，绝不补零，且 no_signal 不等于「确认没进口」', () => {
    const r = extractFacts(input([doc('Welcome to our website. We value long term cooperation and quality.')], []))
    expect(r.ok).toBe(true)
    expect(r.coverage.noSignalFields).toEqual(['customer_type', 'import_signal', 'size_estimate'])
    expect(r.coverage.rate).toBe(0)
    expect(r.facts.customer_type.value).toBe('unknown')
    expect(r.facts.import_signal.value).toBe('no_signal')
    expect(r.facts.import_signal.note).toContain('无记录 ≠ 没进口')
    expect(r.facts.size_estimate.tier).toBe('unknown')
    expect(r.facts.negative_flags).not.toContain('no_import_evidence')
    expect(r.evidence).toEqual([])
    expect(r.facts.anchors).toEqual([])
  })

  it('contradicted 优先于 confirmed；负面信号只在原文命中时出现', () => {
    const r = extractFacts(input([doc('We import hydraulic hose fittings. We do not import any components. We manufacture our own products.')]))
    expect(r.facts.import_signal.value).toBe('contradicted')
    expect(r.facts.negative_flags).toContain('competitor_suspected')
    expect(r.facts.negative_flags).not.toContain('shell_company')
  })

  it('规模分档与 PII 清洗：quote 不泄漏邮箱/电话，且仍是清洗后原文子串', () => {
    const raw = 'Our factory has 2400 employees. Contact sales@acme.example or call +49 30 12345678. We manufacture hydraulic fittings.'
    const r = extractFacts(input([doc(raw)], ['hydraulic fittings']))
    expect(r.facts.size_estimate.tier).toBe('XL')
    expect(r.piiRemoved).toBeGreaterThan(0)
    const clean = sanitizeContext([raw]).texts[0]
    expect(clean).not.toContain('sales@acme.example')
    const serialized = JSON.stringify(r)
    expect(serialized).not.toContain('sales@acme.example')
    expect(serialized).not.toMatch(/"score"|"total_score"|"rating"|"points"/)
    for (const e of r.evidence) expect(clean.includes(e.quote)).toBe(true)
  })

  it('HTTP /v1/t0/extract：200 返回规则事实与 t0 版本；400 拒绝非法来源', async () => {
    const app = createApp({ store: createMemoryStore(), gateway: createGateway({ env: {}, fetchImpl: async () => { throw new Error('不应发起请求') } }) })
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${app.server.address().port}`
    try {
      const ok = await fetch(`${base}/v1/t0/extract`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input([doc('Authorized distributor for hydraulic hose fittings.')])),
      })
      expect(ok.status).toBe(200)
      const body = await ok.json()
      expect(body.extractor).toBe('rules')
      expect(body.facts.customer_type.value).toBe('distributor')
      const bad = await fetch(`${base}/v1/t0/extract`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ company_id: 'x', sources: [{ url: 'not-a-url', text: 't', fetched_at: '2026-11-08' }] }),
      })
      expect(bad.status).toBe(400)
      expect((await bad.json()).code).toBe('E6004')
      const health = await (await fetch(`${base}/health`)).json()
      expect(health.t0.extractor).toBe('rules')
    } finally { await new Promise((resolve) => app.server.close(resolve)) }
  })
})

describe('数据源适配器注册表 · 6 类源契约 / 显式未接入 / 不伪造候选', () => {
  it('默认 0/6 已接入，health 如实报 demo，planBatch 给占位标识且标明不代表真实采集', () => {
    const reg = createDataSourceRegistry()
    const h = reg.health()
    expect(SOURCE_DEFS).toHaveLength(6)
    expect(h.total).toBe(6)
    expect(h.configured).toBe(0)
    expect(h.readyCount).toBe(0)
    expect(h.mode).toBe('demo')
    expect(h.sources.every((s) => s.mode === 'unconfigured' && s.ok === false)).toBe(true)
    const plan = reg.planBatch({ count: 3, cursorOffset: 10 })
    expect(plan.sourceMode).toBe('demo')
    expect(plan.realHits).toBe(0)
    expect(plan.completeness).toBe(0)
    expect(plan.domains).toEqual(['candidate-11.demo.local', 'candidate-12.demo.local', 'candidate-13.demo.local'])
    expect(plan.note).toContain('不代表真实采集结果')
  })

  it('注入健康实现后仍显式 blocked：绝不生成「看起来像真公司」的候选', () => {
    const reg = createDataSourceRegistry()
    reg.register('search', {
      search: async () => ({ hits: [{ domain: 'real.example.com', url: 'https://real.example.com' }], failures: 0 }),
      healthCheck: () => ({ ok: true, latencyMs: 1 }),
    })
    const h = reg.health()
    expect(h.configured).toBe(1)
    expect(h.readyCount).toBe(1)
    expect(h.mode).toBe('real')
    const plan = reg.planBatch({ count: 3, cursorOffset: 0 })
    expect(plan.sourceMode).toBe('blocked')
    expect(plan.domains).toEqual([])
    expect(plan.note).toContain('尚未接入')
  })

  it('collect() 聚合去重真实命中，单源失败显式计入，非法域名不采信', async () => {
    const reg = createDataSourceRegistry({
      implementations: {
        search: {
          healthCheck: () => ({ ok: true }),
          search: async () => ({ hits: [{ domain: 'a.example.com' }, { domain: 'a.example.com' }, { domain: 'not a domain' }], failures: 1 }),
        },
        website: {
          healthCheck: () => ({ ok: true }),
          search: async () => { throw new Error('upstream 500') },
        },
      },
    })
    const r = await reg.collect('hydraulic fittings', { count: 10 })
    expect(r.ok).toBe(true)
    expect(r.sourceMode).toBe('real')
    expect(r.hits.map((x) => x.domain)).toEqual(['a.example.com'])
    expect(r.failures.some((f) => f.key === 'website')).toBe(true)
    expect(r.skipped).not.toContain('search')

    const empty = await createDataSourceRegistry().collect('q')
    expect(empty.ok).toBe(false)
    expect(empty.sourceMode).toBe('demo')
    expect(empty.hits).toEqual([])
  })

  it('编排器消费注册表：源带 mode、事件带 sourceMode；有 ready 源时显式暂停而非假装进度', async () => {
    const config = { keywords: ['hydraulic fittings'], markets: ['德国'], depth: 2, targetCount: 100 }
    const reg = createDataSourceRegistry()
    const o1 = createOrchestrator({ store: createMemoryStore(), dataSources: reg, tickMs: 10000 })
    const t1 = o1.createTask(config)
    expect(t1.sourceMode).toBe('demo')
    expect(t1.dataSources).toEqual({ ready: 0, total: 6 })
    expect(t1.progress.sources.every((s) => s.mode === 'unconfigured')).toBe(true)
    expect(t1.progress.log[0].text).toContain('0/6 已接入')
    const seen = []
    o1.subscribe(t1.id, (e) => seen.push(e))
    o1.dispose()

    const ready = createDataSourceRegistry({
      implementations: { search: { healthCheck: () => ({ ok: true }), search: async () => ({ hits: [], failures: 0 }) } },
    })
    const o2 = createOrchestrator({ store: createMemoryStore(), dataSources: ready, tickMs: 10 })
    const t2 = o2.createTask(config)
    expect(t2.sourceMode).toBe('blocked')
    const blockedEvents = []
    o2.subscribe(t2.id, (e) => blockedEvents.push(e))
    await new Promise((resolve) => setTimeout(resolve, 60))
    const after = o2.getTask(t2.id)
    expect(after.status).toBe('paused')
    expect(after.cursor.offset).toBe(0)
    expect(blockedEvents.some((e) => e.type === 'source_warning' && e.sourceMode === 'blocked')).toBe(true)
    expect(after.progress.log.some((l) => l.text.includes('尚未接入'))).toBe(true)
    o2.dispose()
    // 显式断言 demo 分支不会误发 blocked 事件
    expect(seen.length).toBe(0)
  })

  it('HTTP /health 与 /v1/gateway/health 如实暴露数据源接入状态', async () => {
    const app = createApp({ store: createMemoryStore(), gateway: createGateway({ env: {}, fetchImpl: async () => { throw new Error('不应发起请求') } }) })
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${app.server.address().port}`
    try {
      const h = await (await fetch(`${base}/health`)).json()
      expect(h.dataSources).toMatchObject({ mode: 'demo', total: 6, configured: 0, readyCount: 0 })
      const gh = await (await fetch(`${base}/v1/gateway/health`)).json()
      expect(gh.dataSources.readyCount).toBe(0)
      expect(gh.t0.extractor).toBe('rules')
    } finally { await new Promise((resolve) => app.server.close(resolve)) }
  })
})
