import { describe, expect, it } from 'vitest'
import { createGateway, route, regionDecision } from '../gateway.mjs'
import { createOrchestrator } from '../orchestrator.mjs'
import { evaluateBaseline, baselineManifest } from '../eval.mjs'
import { protocol, validateSchema, verifyEvidence, assertNoPii, pointCost, quoteMatchesContext, buildEmailMessages, validateEmailDraft } from '../protocol.mjs'
import { createApp } from '../index.mjs'

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

  it('含 PII 的请求不向任何 provider 发送数据', async () => {
    let calls = 0
    const g = createGateway({ env: { DEEPSEEK_API_KEY: 'k' }, fetchImpl: async () => { calls++; return okFetch(wire())() } })
    const r = await g.judge(judgeInput({ facts: { email: 'purchasing@x.example' } }))
    expect(r.errorCodes).toContain('E6004')
    expect(calls).toBe(0)
  })

  it('配置 Key 后走真实调用链，返回 wire + client 双格式判断', async () => {
    const g = createGateway({ env: { DEEPSEEK_API_KEY: 'k' }, fetchImpl: okFetch(wire()), sleep: async () => {}, now: () => 1_700_000_000_000 })
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
    const g = createGateway({ env: { DEEPSEEK_API_KEY: 'k', ZHIPU_API_KEY: 'k2' }, fetchImpl, sleep: async () => {}, now: () => 1_700_000_000_000 })
    const r = await g.judge(judgeInput())
    expect(r.ok).toBe(true)
    expect(r.audit.providerKey).toBe('glm-5.3')
  })

  it('30 天结果缓存：同域名 + 同 prompt 版本不重复调用', async () => {
    let calls = 0
    const fetchImpl = async () => { calls++; return okFetch(wire())() }
    const g = createGateway({ env: { DEEPSEEK_API_KEY: 'k' }, fetchImpl, sleep: async () => {}, now: () => 1_700_000_000_000 })
    await g.judge(judgeInput())
    const second = await g.judge(judgeInput())
    expect(second.cached).toBe(true)
    expect(calls).toBe(1)
    expect(g.getCacheStats().entries).toBe(1)
  })

  it('连续失败 10 次熔断该 provider', () => {
    const g = createGateway({ env: { DEEPSEEK_API_KEY: 'k' } })
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

  it('含 PII 的写信请求不转发给任何 provider', async () => {
    let calls = 0
    const g = createGateway({ env: { DEEPSEEK_API_KEY: 'k' }, fetchImpl: async () => { calls++; return okFetch(draft)() } })
    const r = await g.writeEmail(emailInput({ anchor: 'write to purchasing@x.example' }))
    expect(r.errorCodes).toContain('E6004')
    expect(calls).toBe(0)
  })

  it('配置 Key 后生成两版之一的真实正文，审计记 write_email 与点数', async () => {
    const g = createGateway({ env: { DEEPSEEK_API_KEY: 'k' }, fetchImpl: okFetch(draft), sleep: async () => {}, now: () => 1_700_000_000_000 })
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
    const g = createGateway({ env: { DEEPSEEK_API_KEY: 'k' }, fetchImpl: okFetch(bad), sleep: async () => {}, now: () => 1_700_000_000_000 })
    const r = await g.writeEmail(emailInput())
    expect(r.ok).toBe(false)
    expect(r.body).toBeNull()
    expect(r.errorCodes).toContain('E6005')
  })

  it('HTTP /v1/email/generate：E6004 / E6005 / 200 三种返回都可核验', async () => {
    // 显式传空 env，避免开发机全局 Key 影响「无 Key 降级」断言
    const app = createApp({ gateway: createGateway({ env: {}, fetchImpl: async () => { throw new Error('不应发起请求') } }) })
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
      env: { DEEPSEEK_API_KEY: 'k' }, fetchImpl: okFetch(draft),
      sleep: async () => {}, now: () => 1_700_000_000_000,
    })
    const app2 = createApp({ gateway: realGateway })
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
