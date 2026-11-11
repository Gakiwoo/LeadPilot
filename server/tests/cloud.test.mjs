import { describe, expect, it, vi } from 'vitest'
import { createGateway, route, regionDecision } from '../gateway.mjs'
import { createOrchestrator } from '../orchestrator.mjs'
import {
  evaluateBaseline, baselineManifest, diffEvalRuns, EVAL_DIFF_VERSION,
  evaluateIntegrity, evaluateOutcome, evaluateConsistency, releaseStatus,
  integrityManifest, outcomeManifest,
  INTEGRITY_GATE_VERSION, OUTCOME_GATE_VERSION, RELEASE_POLICY_VERSION,
} from '../eval.mjs'
import { protocol, validateSchema, verifyEvidence, assertNoPii, pointCost, quoteMatchesContext, buildEmailMessages, validateEmailDraft, buildJudgeMessages } from '../protocol.mjs'
import { createApp } from '../index.mjs'
import { createStore, createMemoryStore, sqliteAvailable } from '../store.mjs'
import { extractFacts, validateT0Input, T0_RULES_VERSION } from '../t0.mjs'
import { createDataSourceRegistry, SOURCE_DEFS } from '../data-sources.mjs'
import { sanitizeContext } from '../protocol.mjs'
import { createLedger, LEDGER_VERSION } from '../ledger.mjs'
import { validateBaselineImport, BASELINE_CONTRACT_VERSION } from '../baseline.mjs'
import { reconcileWithT0 } from '../t0.mjs'
import {
  createBatchPipeline, normalizeDomain, isDomain, parseCsv, validateRows,
  buildMbox, checkExportGates, computeBounceRate, BATCH_VERSION,
} from '../batch.mjs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync, readFileSync } from 'node:fs'

/** 版本号统一从 package.json 读取，避免每次发版漏改测试里的硬编码 */
const PKG_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version

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
    expect(ids[3].queuePosition).toBe(1)
    expect(ids[3].maxConcurrent).toBe(3)
    o.dispose()
  })
})

describe('任务队列 · v0.6.0 queued 自动出队 / 并发闸门 / 硬超时不误算', () => {
  const config = { keywords: ['hydraulic fittings'], markets: ['德国'], depth: 2, targetCount: 20 }

  it('槽位释放后按 FIFO 自动出队，位次前移，并发上限任何时刻不越界', () => {
    const o = createOrchestrator({ tickMs: 10000, maxConcurrent: 2 })
    const t1 = o.createTask(config)
    const t2 = o.createTask(config)
    const t3 = o.createTask(config)
    const t4 = o.createTask(config)
    expect([t1, t2, t3, t4].map((t) => t.status)).toEqual(['running', 'running', 'queued', 'queued'])
    expect(o.getTask(t3.id).queuePosition).toBe(1)
    expect(o.getTask(t4.id).queuePosition).toBe(2)
    expect(o.getTask(t3.id)).toMatchObject({ activeCount: 2, queuedCount: 2, maxConcurrent: 2 })

    const started = []
    o.subscribe(t3.id, (e) => { if (e.type === 'started') started.push({ id: t3.id, dequeued: e.dequeued }) })
    o.subscribe(t4.id, (e) => { if (e.type === 'started') started.push({ id: t4.id, dequeued: e.dequeued }) })

    o.abort(t1.id)
    expect(o.getTask(t3.id).status).toBe('running')
    expect(o.getTask(t4.id).status).toBe('queued')
    expect(o.getTask(t4.id).queuePosition).toBe(1)
    expect(o.listTasks().filter((t) => t.status === 'running')).toHaveLength(2)

    o.abort(t2.id)
    expect(o.getTask(t4.id).status).toBe('running')
    expect(o.getTask(t4.id).queuePosition).toBe(0)
    expect(o.listTasks().filter((t) => t.status === 'running')).toHaveLength(2)
    expect(started).toEqual([
      { id: t3.id, dequeued: true },
      { id: t4.id, dequeued: true },
    ])
    // 出队日志必须可见，不能悄悄启动
    expect(o.getTask(t4.id).progress.log.some((l) => l.text.includes('队列出队'))).toBe(true)
    o.dispose()
  })

  it('暂停释放槽位并补位；续跑不能绕过并发上限，被挡回时如实保留 queued', () => {
    const o = createOrchestrator({ tickMs: 10000, maxConcurrent: 1 })
    const t1 = o.createTask(config)
    const t2 = o.createTask(config)
    expect(t2.status).toBe('queued')

    o.pause(t1.id)
    expect(o.getTask(t1.id).status).toBe('paused')
    expect(o.getTask(t2.id).status).toBe('running')

    const resumed = o.resume(t1.id)
    expect(resumed.status).toBe('queued') // 绝不谎报 running
    expect(o.listTasks().filter((t) => t.status === 'running')).toHaveLength(1)
    // 对 queued 再点「继续」也不能插队或伪造启动
    expect(o.resume(t1.id).status).toBe('queued')

    o.abort(t2.id)
    expect(o.getTask(t1.id).status).toBe('running')
    o.dispose()
  })

  it('排队等待 1 小时不占用硬超时预算，出队后的第一个 tick 不会被误判超时', () => {
    vi.useFakeTimers()
    let clock = 1_700_000_000_000
    const o = createOrchestrator({ now: () => clock, tickMs: 10, maxConcurrent: 1 })
    try {
      const t1 = o.createTask(config)
      const t2 = o.createTask(config)
      expect(t2.status).toBe('queued')
      // 排队等待期间没有任何 tick，但墙钟前进一小时
      clock += 60 * 60 * 1000
      // t1 的第一个 tick 会因真实运行 1 小时触发硬超时收尾，从而释放槽位
      vi.advanceTimersByTime(10)
      expect(o.getTask(t2.id).status).toBe('running')
      expect(o.getTask(t2.id).elapsedMs).toBe(0)
      // t2 从出队时刻重新计时：下一个 tick 只累计 10ms，不应被上一任务的 1h 拖成硬超时
      clock += 10
      vi.advanceTimersByTime(10)
      expect(o.getTask(t2.id).status).toBe('running')
      expect(o.getTask(t1.id).status).toBe('done')
    } finally {
      o.dispose()
      vi.useRealTimers()
    }
  })

  it('排队任务未启动即中止：全额释放预扣，不影响其它运行任务', () => {
    const store = createMemoryStore()
    const ledger = createLedger({ store, openingBalance: 200 })
    const o = createOrchestrator({ store, ledger, tickMs: 10000, maxConcurrent: 1 })
    const t1 = o.createTask(config)
    const t2 = o.createTask(config)
    expect(ledger.state().held).toBe(80)
    const aborted = o.abort(t2.id)
    expect(aborted.status).toBe('aborted')
    expect(aborted.pointsUsed).toBe(0)
    expect(aborted.ledger.settled).toBe('released')
    expect(ledger.state()).toMatchObject({ held: 40, spent: 0, available: 160 })
    expect(o.getTask(t1.id).status).toBe('running')
    expect(ledger.entries(t2.id).filter((e) => e.kind === 'reserve')).toHaveLength(1)
    o.dispose()
  })

  it('进程重启后原排队任务恢复为 paused，不自动出队、不二次预扣', () => {
    const store = createMemoryStore()
    const ledger = createLedger({ store, openingBalance: 200 })
    const o1 = createOrchestrator({ store, ledger, tickMs: 10000, maxConcurrent: 1 })
    o1.createTask(config)
    const queued = o1.createTask(config)
    expect(queued.status).toBe('queued')
    o1.dispose()

    const o2 = createOrchestrator({ store, ledger, tickMs: 10000, maxConcurrent: 1 })
    expect(o2.getTask(queued.id).status).toBe('paused')
    expect(o2.getTask(queued.id).activeCount).toBe(0) // 没有自动出队
    expect(o2.getTask(queued.id).progress.log.some((l) => l.text.includes('不会自动启动'))).toBe(true)
    expect(ledger.state().held).toBe(80)
    // 显式继续后槽位空闲 → 正常启动，但绝不二次预扣
    expect(o2.resume(queued.id).status).toBe('running')
    expect(ledger.state().held).toBe(80)
    expect(ledger.entries(queued.id).filter((e) => e.kind === 'reserve')).toHaveLength(1)
    o2.dispose()
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

describe('点数账本事务化 · 预扣 / 结算 / 释放 / 幂等', () => {
  const make = (openingBalance = 100) => {
    const store = createMemoryStore()
    return { store, ledger: createLedger({ store, openingBalance }) }
  }

  it('开户额度、余额恒等式与版本如实暴露', () => {
    const { ledger } = make()
    const s = ledger.state()
    expect(s.granted).toBe(100)
    expect(s.available).toBe(100)
    expect(s.ledgerVersion).toBe(LEDGER_VERSION)
    expect(s.available + s.held + s.spent).toBe(s.granted)
    expect(ledger.health().ledgerConsumers).toContain('judge')
    expect(ledger.health().auditOnlyConsumers).toHaveLength(0)
  })

  it('同一 refId 预扣幂等，金额不同报 E4002，余额不足报 E4001', () => {
    const { ledger } = make()
    const a = ledger.reserve({ refId: 'task_a', amount: 40 })
    const b = ledger.reserve({ refId: 'task_a', amount: 40 })
    const c = ledger.reserve({ refId: 'task_a', amount: 41 })
    const d = ledger.reserve({ refId: 'task_b', amount: 61 })
    expect(a.ok && a.held === 40).toBe(true)
    expect(b.ok && b.idempotent === true).toBe(true)
    expect(ledger.state().held).toBe(40)
    expect(c.code).toBe('E4002')
    expect(d.code).toBe('E4001')
    expect(ledger.state().held).toBe(40)
  })

  it('结算实扣 + 退还差额且幂等；已结算不得重复释放；无预扣不得结算', () => {
    const { ledger } = make()
    ledger.reserve({ refId: 'task_a', amount: 40 })
    const s1 = ledger.settle({ refId: 'task_a', amount: 25 })
    const s2 = ledger.settle({ refId: 'task_a', amount: 25 })
    expect(s1.charged).toBe(25)
    expect(s1.refunded).toBe(15)
    expect(s2.idempotent).toBe(true)
    expect(ledger.state()).toMatchObject({ held: 0, spent: 25, available: 75 })
    expect(ledger.release({ refId: 'task_a' }).code).toBe('E4003')
    expect(ledger.settle({ refId: 'task_c', amount: 1 }).code).toBe('E4003')
    // 同一个已结算 refId 换成不同金额 → 幂等键冲突（E4002），不是重新结算
    expect(ledger.settle({ refId: 'task_a', amount: 99 }).code).toBe('E4002')
    ledger.reserve({ refId: 'task_d', amount: 10 })
    expect(ledger.settle({ refId: 'task_d', amount: 11 }).code).toBe('E4003')
  })

  it('未启动任务全额释放，账本流水完整可追溯', () => {
    const { ledger } = make()
    ledger.reserve({ refId: 'task_x', amount: 30 })
    const r = ledger.release({ refId: 'task_x' })
    expect(r.ok && r.refunded === 30 && ledger.release({ refId: 'task_x' }).idempotent).toBe(true)
    expect(ledger.state().available).toBe(100)
    const kinds = ledger.entries('task_x').map((e) => e.kind)
    expect(kinds).toEqual(['reserve', 'release'])
  })

  it.skipIf(!sqliteAvailable)('SQLite 账本在两个独立 store 实例之间恢复，重启不重复扣', () => {
    const dir = join(tmpdir(), `leadpilot-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const dbPath = join(dir, 'ledger.db')
    const stores = []
    try {
      const s1 = createStore({ mode: 'sqlite', dbPath }); stores.push(s1)
      const l1 = createLedger({ store: s1, openingBalance: 80 })
      l1.reserve({ refId: 'persisted', amount: 30 })
      s1.close()

      const s2 = createStore({ mode: 'sqlite', dbPath }); stores.push(s2)
      const l2 = createLedger({ store: s2, openingBalance: 80 })
      expect(l2.state().held).toBe(30)
      expect(l2.reserve({ refId: 'persisted', amount: 30 }).idempotent).toBe(true)
      expect(l2.settle({ refId: 'persisted', amount: 12 }).charged).toBe(12)
      expect(l2.state()).toMatchObject({ held: 0, spent: 12, available: 68 })
    } finally {
      // Windows 上 SQLite 句柄未关闭会导致 unlink EBUSY
      for (const s of stores) { try { s.close() } catch { /* 已关闭 */ } }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('编排器：创建预扣、未启动中止全额释放、点数不重复扣', () => {
    const store = createMemoryStore()
    const ledger = createLedger({ store, openingBalance: 200 })
    const o = createOrchestrator({ store, ledger, tickMs: 10000 })
    const t = o.createTask({ keywords: ['fittings'], markets: ['德国'], depth: 2, targetCount: 20 })
    expect(t.ledger).toMatchObject({ reserved: 40, settled: null })
    expect(ledger.state().held).toBe(40)
    const aborted = o.abort(t.id)
    expect(aborted.pointsUsed).toBe(0)
    expect(aborted.ledger.settled).toBe('released')
    expect(ledger.state()).toMatchObject({ held: 0, spent: 0, available: 200 })
    o.dispose()
  })

  it('编排器：余额不足时拒绝创建任务，绝不先跑再补扣', () => {
    const store = createMemoryStore()
    const ledger = createLedger({ store, openingBalance: 10 })
    const o = createOrchestrator({ store, ledger, tickMs: 10000 })
    const r = o.createTask({ keywords: ['fittings'], markets: ['德国'], depth: 2, targetCount: 20 })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('E4001')
    expect(o.listTasks()).toHaveLength(0)
    expect(ledger.state().held).toBe(0)
    o.dispose()
  })

  it('AC-03：重启恢复的任务从持久化游标续跑，不再二次预扣', () => {
    const store = createMemoryStore()
    const ledger = createLedger({ store, openingBalance: 200 })
    const o1 = createOrchestrator({ store, ledger, tickMs: 10000 })
    const t = o1.createTask({ keywords: ['fittings'], markets: ['德国'], depth: 2, targetCount: 20 })
    o1.pause(t.id)
    o1.dispose()
    const o2 = createOrchestrator({ store, ledger, tickMs: 10000 })
    expect(o2.recoveredIds).toContain(t.id)
    expect(o2.getTask(t.id).status).toBe('paused')
    expect(ledger.state().held).toBe(40)
    const resumed = o2.resume(t.id)
    expect(resumed.status).toBe('running')
    expect(ledger.state().held).toBe(40)
    expect(ledger.entries(t.id).filter((e) => e.kind === 'reserve')).toHaveLength(1)
    o2.dispose()
  })
})

describe('T0 → judge 事实链 · 规则事实进 Prompt / 冲突代码裁决', () => {
  const doc = (text) => ({ url: 'https://chain.example/about', text, fetched_at: '2026-11-08' })
  const rich = 'About us: Authorized distributor for Parker and Eaton across Benelux. '
    + 'We import hydraulic hose fittings from Asia. Our team has 85 employees across Rotterdam and Antwerp.'
  const blind = 'Welcome to our website. We value long term cooperation and quality service for every partner.'

  it('buildJudgeMessages 只在提供 T0 结果时注入 <t0_facts>，绝不伪装规则事实', () => {
    const t0 = extractFacts({ company_id: 'c_chain', sources: [doc(rich)], keywords: ['hydraulic hose fittings'] })
    const withT0 = buildJudgeMessages({ companyId: 'c_chain', sourceTexts: [rich], facts: {}, t0 })
    const without = buildJudgeMessages({ companyId: 'c_chain', sourceTexts: [rich], facts: {} })
    expect(withT0[0].content).toContain('<t0_facts')
    expect(withT0[0].content).toContain(t0.rulesVersion)
    expect(withT0[1].content).toContain('优先引用 <t0_facts>')
    expect(without[0].content).not.toContain('<t0_facts')
  })

  it('未提供 sources 时 judge 如实返回 t0.used=false', async () => {
    const g = createGateway({ env: {}, fetchImpl: async () => { throw new Error('不应发起请求') } })
    const r = await g.judge(judgeInput())
    expect(r.t0.used).toBe(false)
    expect(r.t0.reason).toContain('不拿演示文本伪造来源')
    expect(r.errorCodes).toContain('E6005')
  })

  it('非法 sources 一律 E6004，且不向任何 provider 发请求', async () => {
    let calls = 0
    const g = createGateway({ env: testEnv({ DEEPSEEK_API_KEY: 'k' }), fetchImpl: async () => { calls++; return okFetch(wire())() } })
    const r = await g.judge(judgeInput({ sources: [{ url: 'not-a-url', text: 'x', fetched_at: '2026-11-08' }] }))
    expect(r.errorCodes).toContain('E6004')
    expect(r.t0.used).toBe(true)
    expect(r.t0.ok).toBe(false)
    expect(calls).toBe(0)
  })

  it('规则与模型冲突时代码保守取规则值、置信度归零、全程留痕', async () => {
    const raw = wire({ customer_type: { ...wire().customer_type, value: 'retailer' } })
    const g = createGateway({
      env: testEnv({ DEEPSEEK_API_KEY: 'k' }), fetchImpl: okFetch(raw),
      sleep: async () => {}, now: () => 1_700_000_000_000,
    })
    const r = await g.judge(judgeInput({ sources: [doc(rich)], sourceTexts: [], keywords: ['hydraulic hose fittings'] }))
    expect(r.ok).toBe(true)
    expect(r.t0.used).toBe(true)
    expect(r.t0.reconciliation.conflicts.some((c) => c.field === 'customer_type')).toBe(true)
    expect(r.judgement.customer_type.value).toBe('distributor')
    expect(r.judgement.customer_type.confidence).toBe(0)
    expect(r.judgement.notes_for_human).toContain('待人工复议')
    expect(r.billing).toMatchObject({ charged: false, scope: 'audit-only' })
  })

  it('T0 标 no_signal 的维度，模型给出确定结论也被代码回退', () => {
    const t0 = extractFacts({ company_id: 'c_chain', sources: [doc(blind)], keywords: [] })
    expect(t0.coverage.noSignalFields).toHaveLength(3)
    const j = wire({
      customer_type: { ...wire().customer_type, evidence: [{ quote: blind.slice(9), source_url: 'https://chain.example/about', fetched_at: '2026-11-08' }] },
      import_signal: { ...wire().import_signal, evidence: [{ quote: blind.slice(9), source_url: 'https://chain.example/about', fetched_at: '2026-11-08' }] },
      size_estimate: { ...wire().size_estimate, evidence: [{ quote: blind.slice(9), source_url: 'https://chain.example/about', fetched_at: '2026-11-08' }] },
    })
    const rec = reconcileWithT0(j, t0)
    expect(rec.conflicts.every((c) => c.kind === 'no_signal_overridden')).toBe(true)
    expect(j.customer_type.value).toBe('unknown')
    expect(j.import_signal.value).toBe('no_signal')
    expect(j.size_estimate.tier).toBe('unknown')
  })
})

describe('385 家基准集标注契约 · 只校验不伪造', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../scripts/fixtures/invalid-baseline-sample.json', import.meta.url), 'utf8'))

  it('导入校验器拒绝非法反例，且导入校验通过 ≠ 评测通过', () => {
    const r = validateBaselineImport(fixture)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('E4004')
    expect(r.releaseEligible).toBe(false)
    expect(r.note).toContain('导入校验通过 ≠ 评测通过')
    expect(r.errors.some((e) => e.includes('独立双标'))).toBe(true)
  })

  it('manifest 暴露契约与导入状态，评测无数据仍为 NO_DATA', () => {
    const m = baselineManifest()
    expect(m.contractVersion).toBe(BASELINE_CONTRACT_VERSION)
    expect(m.status).toBe('NOT_LABELED')
    expect(m.releaseEligible).toBe(false)
    expect(m.contract.requiredFields).toContain('sample_id')
    expect(evaluateBaseline([]).status).toBe('NO_DATA')
  })

  it('HTTP：契约可读、非法导入 400、点数账本只读', async () => {
    const store = createMemoryStore()
    const app = createApp({ store, ledger: createLedger({ store, openingBalance: 60 }), orchestratorOptions: { tickMs: 10000 } })
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${app.server.address().port}`
    const post = (path, body) => fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json() }))
    try {
      const contract = await (await fetch(`${base}/v1/eval/baseline/contract`)).json()
      expect(contract.baselineSize).toBe(385)
      const bad = await post('/v1/eval/baseline/validate', fixture)
      expect(bad.status).toBe(400)
      expect(bad.body.code).toBe('E4004')
      const points = await (await fetch(`${base}/v1/points`)).json()
      expect(points.available).toBe(60)
      expect(points.scope).toContain('task_reserve')

      const tooBig = await post('/v1/tasks', { keywords: ['fittings'], markets: ['德国'], depth: 4, targetCount: 100 })
      expect(tooBig.status).toBe(402)
      expect(tooBig.body.code).toBe('E4001')

      const created = await post('/v1/tasks', { keywords: ['fittings'], markets: ['德国'], depth: 1, targetCount: 10 })
      expect(created.status).toBe(201)
      expect(created.body.task.ledger.reserved).toBe(10)
      const aborted = await post(`/v1/tasks/${created.body.task.id}/abort`, {})
      expect(aborted.body.task.ledger.settled).toBe('released')
      const after = await (await fetch(`${base}/v1/points`)).json()
      expect(after.available).toBe(60)

      const health = await (await fetch(`${base}/health`)).json()
      expect(health.version).toBe(PKG_VERSION)
      expect(health.points.ledgerVersion).toBe(LEDGER_VERSION)
      expect(health.billing.ledgerConsumers).toContain('judge')
      expect(health.billing.ledgerConsumers).toContain('write_email')
      expect(health.billing.auditOnlyConsumers).toHaveLength(0)
      expect(health.baseline.releaseEligible).toBe(false)
      expect(health.t0.judgeFactChain.enabled).toBe(true)
    } finally { await new Promise((resolve) => app.server.close(resolve)) }
  })
})

describe('网关调用计费闭环 · v0.6.0 reserve / settle / release', () => {
  const env = () => testEnv({ DEEPSEEK_API_KEY: 'k' })
  const emailDraft = {
    subject: 'Hydraulic fittings supply for Rotex',
    body: 'Saw that you distribute Parker fittings across Benelux, so I am writing to your team directly. We supply hydraulic hose fittings with stable lead times on repeat orders. Would it help if I sent a short quote sheet with FOB terms?',
    anchor_used: 'you distribute Parker fittings',
  }
  const emailReq = (overrides = {}) => ({
    anchor: 'you distribute Parker fittings across Benelux', product: 'hydraulic hose fittings',
    advantages: ['stable lead times on repeat orders'], purpose: 'intro', tone: 'concise',
    maxWords: 90, language: 'en', country: '美国', ...overrides,
  })
  const makeLedger = (balance = 200) => {
    const store = createMemoryStore()
    return { store, ledger: createLedger({ store, openingBalance: balance }) }
  }
  const makeGateway = (ledger, fetchImpl = okFetch(wire())) => createGateway({
    env: env(), fetchImpl, ledger, sleep: async () => {}, now: () => 1_700_000_000_000,
  })
  const failFetch = async () => ({ status: 500, ok: false, json: async () => ({}) })

  it('成功判断：按 token 折算结算整数点，预扣差额退还，流水只有 reserve + settle', async () => {
    const { ledger } = makeLedger()
    const g = makeGateway(ledger)
    const r = await g.judge(judgeInput({ requestId: 'judge-ok-1' }))
    expect(r.ok).toBe(true)
    expect(r.billing).toMatchObject({
      charged: true, scope: 'ledger-v2', refId: 'gw:judge:judge-ok-1', capped: false,
    })
    expect(r.billing.estimatedPoints).toBeGreaterThan(0)
    expect(Number.isInteger(r.billing.chargedPoints)).toBe(true)
    expect(r.billing.chargedPoints).toBe(r.billing.estimatedPoints)
    expect(ledger.state()).toMatchObject({ held: 0, spent: r.billing.chargedPoints })
    expect(ledger.state().available + ledger.state().spent).toBe(200)
    expect(ledger.entries('gw:judge:judge-ok-1').map((e) => e.kind)).toEqual(['reserve', 'settle'])
    expect(g.getAudit()[0]).toMatchObject({ billingCharged: true, billingScope: 'ledger-v2' })
  })

  it('成功写信同样进入账本，且响应不把审计估值说成已扣点', async () => {
    const { ledger } = makeLedger()
    const g = makeGateway(ledger, okFetch(emailDraft))
    const r = await g.writeEmail(emailReq({ requestId: 'email-ok-1' }))
    expect(r.ok).toBe(true)
    expect(r.billing).toMatchObject({ charged: true, scope: 'ledger-v2', refId: 'gw:write_email:email-ok-1' })
    expect(ledger.entries('gw:write_email:email-ok-1').map((e) => e.kind)).toEqual(['reserve', 'settle'])
  })

  it('未配置 Key：无可用 provider，不预扣、不扣点、如实标 no_provider', async () => {
    const { ledger } = makeLedger()
    const g = createGateway({ env: {}, ledger, fetchImpl: okFetch(wire()) })
    const r = await g.judge(judgeInput())
    expect(r.errorCodes).toContain('E6005')
    expect(r.billing).toMatchObject({ charged: false, reason: 'no_provider' })
    expect(ledger.state()).toMatchObject({ held: 0, spent: 0, available: 200 })
  })

  it('降级链耗尽 / 内容未过硬约束：预扣全额释放，失败尝试仍留审计', async () => {
    const { ledger } = makeLedger()
    const g = makeGateway(ledger, failFetch)
    const r = await g.judge(judgeInput({ requestId: 'judge-fail-1' }))
    expect(r.ok).toBe(false)
    expect(r.billing).toMatchObject({ charged: false, released: true, scope: 'ledger-v2' })
    expect(ledger.state()).toMatchObject({ held: 0, spent: 0, available: 200 })
    expect(ledger.entries('gw:judge:judge-fail-1').map((e) => e.kind)).toEqual(['reserve', 'release'])
    expect(g.getAudit().some((e) => e.degraded && e.billingCharged === false)).toBe(true)

    const g2 = makeGateway(ledger, okFetch({ ...emailDraft, body: emailDraft.body + ' Act now for a free quote!' }))
    const r2 = await g2.writeEmail(emailReq({ requestId: 'email-fail-1' }))
    expect(r2.ok).toBe(false)
    expect(r2.billing.released).toBe(true)
    expect(ledger.state().spent).toBe(0)
  })

  it('30 天缓存命中不二次扣点，响应明确标 cache_hit', async () => {
    const { ledger } = makeLedger()
    const g = makeGateway(ledger)
    const r1 = await g.judge(judgeInput({ requestId: 'cache-a' }))
    const r2 = await g.judge(judgeInput({ requestId: 'cache-b' }))
    expect(r2.cached).toBe(true)
    expect(r2.billing).toMatchObject({ charged: false, reason: 'cache_hit' })
    expect(ledger.state().spent).toBe(r1.billing.chargedPoints)
    expect(ledger.allEntries().filter((e) => e.kind === 'settle')).toHaveLength(1)
  })

  it('点数不足：E4001 且不向任何 provider 发起请求', async () => {
    const { ledger } = makeLedger(1)
    let calls = 0
    const g = createGateway({
      env: env(), ledger, sleep: async () => {},
      fetchImpl: async () => { calls++; return okFetch(wire())() },
    })
    const r = await g.judge(judgeInput({ requestId: 'poor-1' }))
    expect(r.code).toBe('E4001')
    expect(r.errorCodes).toContain('E4001')
    expect(r.billing.charged).toBe(false)
    expect(calls).toBe(0)
    expect(ledger.state()).toMatchObject({ held: 0, spent: 0, available: 1 })
  })

  it('同一 requestId 已结算时拒绝重复调用，绝不二次扣点', async () => {
    const { ledger } = makeLedger()
    const g = makeGateway(ledger, okFetch(emailDraft))
    const r1 = await g.writeEmail(emailReq({ requestId: 'email-idem' }))
    const r2 = await g.writeEmail(emailReq({ requestId: 'email-idem' }))
    expect(r1.ok).toBe(true)
    expect(r2.code).toBe('E4005')
    expect(r2.errorCodes).toContain('E4005')
    expect(r2.billing.charged).toBe(false)
    expect(ledger.state().spent).toBe(r1.billing.chargedPoints)
    expect(ledger.allEntries().filter((e) => e.kind === 'settle')).toHaveLength(1)
  })

  it('未注入账本的独立网关仍为 audit-only，不谎报已扣点', async () => {
    const g = createGateway({ env: env(), fetchImpl: okFetch(wire()), sleep: async () => {} })
    const r = await g.judge(judgeInput())
    expect(r.ok).toBe(true)
    expect(r.billing).toMatchObject({ charged: false, scope: 'audit-only' })
    expect(g.health().billingMode).toBe('audit-only')
  })

  it('HTTP：点数不足返回 402（不是可重试的 503 降级）', async () => {
    const store = createMemoryStore()
    const ledger = createLedger({ store, openingBalance: 1 })
    const gateway = createGateway({
      env: env(), ledger, fetchImpl: okFetch(wire()), sleep: async () => {},
    })
    const app = createApp({
      store, ledger, gateway,
      orchestratorOptions: { tickMs: 10000 },
    })
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${app.server.address().port}`
    try {
      const res = await fetch(`${base}/v1/judge`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(judgeInput({ requestId: 'http-poor-1' })),
      })
      const body = await res.json()
      expect(res.status).toBe(402)
      expect(body.code).toBe('E4001')
      expect(body.billing.charged).toBe(false)
      const health = await (await fetch(`${base}/health`)).json()
      expect(health.billing.ledgerConsumers).toContain('judge')
      expect(health.billing.reservePoints.T1).toBeGreaterThan(0)
    } finally { await new Promise((resolve) => app.server.close(resolve)) }
  })
})

describe('评测版本 diff · v0.6.0 纯函数 / 去掉占位字符串', () => {
  /**
   * 注意：这里构造的是「纯函数的输入归档」，仅用于验证 diff 算法本身。
   * 它们不是 385 家人工标注基准集，不写回仓库、不参与任何发布判定。
   */
  const run = (overrides = {}) => ({
    ok: true, status: 'PASSED', baselineVersion: 'eval-fixture-v1', sampleSize: 385,
    metrics: {
      provenance_rate: 0.97, signal_precision: 0.93, extraction_recall: 0.8,
      rule_compliance: 1, kappa: 0.72, spearman_rho: 0.81,
      schema_pass_rate: 0.995, refusal_rate: 0.02,
    },
    ...overrides,
  })
  const noData = () => ({ ok: false, status: 'NO_DATA', baselineVersion: 'none', metrics: {}, manifest: baselineManifest() })

  it('占位对象 / 空输入被 E4006 拒绝，不凑出一份假 diff', () => {
    expect(diffEvalRuns(null, run())).toMatchObject({ ok: false, code: 'E4006', status: 'INVALID_INPUT' })
    expect(diffEvalRuns(run(), { status: 'PASSED' })).toMatchObject({ ok: false, code: 'E4006' })
    expect(diffEvalRuns('placeholder', run())).toMatchObject({ ok: false, code: 'E4006' })
    expect(diffEvalRuns(run(), run())).not.toHaveProperty('code', 'E4006')
  })

  it('任一归档为 NO_DATA 时是 NO_BASELINE：不生成数值 delta、不宣称无回退', () => {
    const r = diffEvalRuns(noData(), run())
    expect(r).toMatchObject({ ok: false, status: 'NO_BASELINE', version: EVAL_DIFF_VERSION, releaseEligible: false })
    expect(r.rows.every((x) => x.delta === null && !x.regression)).toBe(true)
    expect(r.statusTransition).toBe('NO_DATA → PASSED')
  })

  it('两次 PASSED 且指标上升：逐指标 delta 可核验，diff 通过但仍不可发布', () => {
    const prev = run()
    const current = run({ baselineVersion: 'eval-fixture-v2', metrics: { ...run().metrics, provenance_rate: 0.99, kappa: 0.75 } })
    const r = diffEvalRuns(prev, current)
    expect(r.status).toBe('IMPROVED')
    expect(r.diffPassed).toBe(true)
    expect(r.releaseEligible).toBe(false) // 外部阻断项不是 diff 能证明的
    expect(r.p0Regressions).toHaveLength(0)
    expect(r.improvements).toContain('provenance_rate')
    const row = r.rows.find((x) => x.key === 'provenance_rate')
    expect(row).toMatchObject({ prevValue: 0.97, currentValue: 0.99, delta: 0.02, p0: true })
    expect(r.sampleSizeDelta).toBe(0)
  })

  it('P0 指标下降 / 跨阈值 / 已测量变未测量，全部判 regression', () => {
    const prev = run()
    const dropped = diffEvalRuns(prev, run({ metrics: { ...run().metrics, provenance_rate: 0.90 } }))
    expect(dropped.status).toBe('REGRESSION')
    expect(dropped.p0Regressions).toContain('provenance_rate')
    expect(dropped.diffPassed).toBe(false)
    expect(dropped.rows.find((x) => x.key === 'provenance_rate')).toMatchObject({ delta: -0.07, thresholdCrossed: true })

    const lost = diffEvalRuns(prev, run({ metrics: { ...run().metrics, kappa: null } }))
    expect(lost.rows.find((x) => x.key === 'kappa')).toMatchObject({ measurementLost: true, regression: true })
  })

  it('门禁状态回退（PASSED → BLOCKED）即使数值全升也判 regression', () => {
    const r = diffEvalRuns(run(), run({ ok: false, status: 'BLOCKED', metrics: { ...run().metrics, provenance_rate: 1 } }))
    expect(r.gateRegression).toBe(true)
    expect(r.status).toBe('REGRESSION')
    expect(r.diffPassed).toBe(false)
  })

  it('是纯函数：不修改输入、同输入结果稳定、无时间/随机依赖', () => {
    const a = run(), b = run({ baselineVersion: 'eval-fixture-v2' })
    const snapshot = JSON.stringify({ a, b })
    const r1 = diffEvalRuns(a, b)
    const r2 = diffEvalRuns(a, b)
    expect(JSON.stringify({ a, b })).toBe(snapshot)
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2))
    expect(r1.status).toBe('STABLE')
  })

  it('evaluateBaseline 不再返回「需在 CI 中生成」占位字符串，改为可执行端点', () => {
    const empty = evaluateBaseline([], 'v1')
    expect(JSON.stringify(empty)).not.toContain('需在 CI')
    expect(empty.diffEndpoint).toBe('POST /v1/eval/diff')
    const manifest = baselineManifest()
    expect(manifest.diffVersion).toBe(EVAL_DIFF_VERSION)
    const filled = evaluateBaseline([{ provenance: { matched: 1, total: 1 }, schemaPass: true }], 'v1')
    expect(JSON.stringify(filled)).not.toContain('需在 CI')
    expect(filled.diffEndpoint).toBe('POST /v1/eval/diff')
  })

  it('HTTP：/v1/eval/diff 非法输入 400 E4006，两份空归档返回 NO_BASELINE', async () => {
    const app = createApp({ store: createMemoryStore(), orchestratorOptions: { tickMs: 10000 } })
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${app.server.address().port}`
    const post = (body) => fetch(`${base}/v1/eval/diff`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json() }))
    try {
      const bad = await post({ prev: {}, current: {} })
      expect(bad.status).toBe(400)
      expect(bad.body.code).toBe('E4006')
      const okRes = await post({ prev: noData(), current: noData() })
      expect(okRes.status).toBe(200)
      expect(okRes.body.status).toBe('NO_BASELINE')
      expect(okRes.body.releaseEligible).toBe(false)
      const gates = await (await fetch(`${base}/v1/eval/gates`)).json()
      expect(gates.diffEndpoint).toBe('POST /v1/eval/diff')
      expect(gates.diffVersion).toBe(EVAL_DIFF_VERSION)
    } finally { await new Promise((resolve) => app.server.close(resolve)) }
  })
})

/* ================================================================= v0.7.0 批量 SDR 管道 */
const BATCH_SENDER = {
  name: 'Wu Jiaqi', email: 'sales@example.com', company: 'Example Trading Co',
  postalAddress: 'Room 301, 12 Industrial Road, Shenzhen, China',
  unsubscribe: 'Reply STOP to unsubscribe / 退订',
}
const batchFooter = () => [BATCH_SENDER.name, BATCH_SENDER.company, BATCH_SENDER.postalAddress, BATCH_SENDER.unsubscribe].join(' | ')
const validDraft = (over = {}) => ({
  domain: 'acme.example', to: 'buyer@acme.example',
  subject: 'Hydraulic fittings supply',
  body: 'We noticed your company distributes industrial fittings across Benelux. We manufacture hydraulic hose fittings and can share our current catalogue and lead times. Would a short specification sheet be useful for your team this quarter?',
  grade: 'B', sender: BATCH_SENDER, footer: batchFooter(), ...over,
})
const csvSample = () => [
  'company_name,domain,source_url,fetched_at,raw_text,country,product_hint,contact_email',
  'Acme Trading,https://WWW.Acme.example:443/about,https://acme.example/about,2026-11-09,"We import hydraulic hose fittings from Asia, Benelux stock.",Germany,hydraulic fittings,buyer@acme.example',
  'Beta GmbH,beta.example,,,,, buyer@beta.example',
].join('\n')

describe('v0.7.0 · 批量 SDR 管道（定位不变：自动获客）', () => {
  it('共享契约显式锁定定位与目标用户，origin 绝不写成系统采集', () => {
    const cfg = protocol.batchPipeline
    expect(cfg.version).toBe('batch-pipeline-v1')
    expect(BATCH_VERSION).toBe(cfg.version)
    expect(cfg.positioning).toBe('auto_prospecting')
    expect(cfg.targetUser).toBe('bulk_sdr')
    expect(cfg.stage).toBe('internal_preview')
    expect(cfg.import.origin).toBe('user_imported')
    expect(cfg.import.forbiddenOrigins).toContain('system_collected')
    expect(cfg.export.exportedIsNotSent).toBe(true)
    expect(cfg.export.forbidDirectSend).toBe(true)
  })

  it('域名规范化、CSV 引号解析与逐行校验：不静默丢数据', () => {
    expect(normalizeDomain('https://WWW.Acme.example:443/about?x=1')).toBe('acme.example')
    expect(isDomain('acme.example')).toBe(true)
    expect(isDomain('not-a-domain')).toBe(false)
    const matrix = parseCsv('a,b\n"x, y","He said ""hi"""\n')
    expect(matrix[1]).toEqual(['x, y', 'He said "hi"'])

    const v = validateRows([
      { company_name: 'Acme', domain: 'acme.example', contact_email: 'a@acme.example' },
      { company_name: 'Acme again', domain: 'https://www.acme.example/' },
      { company_name: 'Fake', domain: 'fake.example', origin: 'system_collected' },
      { company_name: 'Bad', domain: 'nope' },
    ], { existingDomains: new Set() })
    expect(v.summary).toEqual({ received: 4, accepted: 1, rejected: 2, duplicates: 1 })
    expect(v.accepted[0].origin).toBe('user_imported')
    expect(v.accepted[0].piiFields).toEqual(['contact_email'])
    expect(v.rejected.some((r) => r.reason.includes('伪称系统采集'))).toBe(true)
  })

  it('导入 ≠ 采集：逐行结果、缺失原文标记、PII 登记，且跨实例持久化', () => {
    const store = createMemoryStore()
    const p = createBatchPipeline({ store, gateway: null })
    const r = p.importCompanies({ csv: csvSample() })
    expect(r.ok).toBe(true)
    expect(r.origin).toBe('user_imported')
    expect(r.summary.accepted).toBe(2)
    const list = p.listCompanies()
    expect(list.companies.find((c) => c.domain === 'acme.example').missingSource).toBe(false)
    expect(list.companies.find((c) => c.domain === 'beta.example').missingSource).toBe(true)
    expect(list.companies.find((c) => c.domain === 'acme.example').piiFields).toContain('contact_email')
    expect(list.note).toContain('不代表系统采集结果')
    const again = createBatchPipeline({ store, gateway: null })
    expect(again.state().companies).toBe(2)
  })

  it('批量研判：无 provider 时 T0 真实执行但降级 E6005，不写回 judgement', async () => {
    const store = createMemoryStore()
    const p = createBatchPipeline({ store, gateway: null })
    p.importCompanies({ csv: csvSample() })
    const r = await p.runJudgeBatch({ batchSize: 5 })
    expect(r.ok).toBe(true)
    expect(r.summary.total).toBe(2)
    expect(r.summary.succeeded).toBe(0)
    expect(r.summary.degraded).toBe(2)
    expect(r.allSucceeded).toBe(false)
    expect(r.releaseEligible).toBe(false)
    const acme = r.items.find((i) => i.domain === 'acme.example')
    expect(acme.t0.used).toBe(true)
    expect(acme.t0.extractor).toBe('rules')
    expect(acme.modelJudgement).toBeNull()
    expect(acme.codes).toContain('E6005')
    expect(p.listCompanies().companies.every((c) => !c.hasJudgement)).toBe(true)
  })

  it('批量研判：注入可用 provider 才计入 succeeded 并写回判断', async () => {
    const store = createMemoryStore()
    const fake = { judge: async () => ({ ok: true, clientJudgement: { company_id: 'x' }, judgement: { company_id: 'x' }, billing: { charged: true } }) }
    const p = createBatchPipeline({ store, gateway: fake })
    p.importCompanies({ rows: [{ company_name: 'Acme', domain: 'acme.example' }] })
    const r = await p.runJudgeBatch({})
    expect(r.summary.succeeded).toBe(1)
    expect(r.allSucceeded).toBe(true)
    expect(p.listCompanies().companies[0].hasJudgement).toBe(true)
  })

  it('导出合规闸门：D 级禁发 / C 级需确认 / 尾巴缺失 / 熔断，mbox 明确未发送', () => {
    const gates = checkExportGates([
      validDraft({ grade: 'D' }),
      validDraft({ grade: 'C' }),
      validDraft({ footer: '' }),
      validDraft(),
    ])
    expect(gates.allowed).toHaveLength(1)
    expect(gates.blocked).toHaveLength(3)
    expect(gates.blocked[0].reasons.join()).toContain('D 级')
    expect(gates.blocked[1].reasons.join()).toContain('人工确认')
    expect(gates.blocked[2].reasons.join()).toContain('footer')
    const mbox = buildMbox(gates.allowed, { now: Date.UTC(2026, 10, 9) })
    expect(mbox).toContain('X-LeadPilot-Status: drafted')
    expect(mbox).toContain('X-LeadPilot-Origin: user_imported')
    expect(mbox).toContain('exported-not-sent')
    expect(mbox).toContain('unsubscribe')
    const circuit = checkExportGates([validDraft()], { circuitOpen: true })
    expect(circuit.allowed).toHaveLength(0)
    expect(circuit.blocked[0].reasons.join()).toContain('熔断')
  })

  it('结果回写：不可逆终态需确认，退信率触发熔断后导出被 E4010 阻断', () => {
    expect(computeBounceRate([]).rate).toBeNull()
    const store = createMemoryStore()
    const p = createBatchPipeline({ store, gateway: null })
    p.importCompanies({ rows: [{ company_name: 'Acme', domain: 'acme.example' }] })
    const first = p.exportDrafts({ items: [validDraft()] })
    expect(first.ok).toBe(true)
    expect(first.exportedIsNotSent).toBe(true)
    expect(first.statusAfterExport).toBe('drafted')
    expect(p.state().exportedToday).toBe(1)
    expect(p.state().circuitOpen).toBe(false) // 导出不是发送，不进退信率

    const out = p.importOutcomes({ events: [
      { domain: 'acme.example', event: 'sent' },
      { domain: 'acme.example', event: 'bounced' },
      { domain: 'acme.example', event: 'unsubscribed' },
    ] })
    expect(out.applied).toHaveLength(2)
    expect(out.rejected[0].reasons.join()).toContain('人工确认')
    expect(out.state.bounce.rate).toBe(0.5)
    expect(out.state.circuitOpen).toBe(true)
    expect(p.exportDrafts({ items: [validDraft()] }).code).toBe('E4010')
    expect(p.state().releaseEligible).toBe(false)
  })

  it('HTTP：导入 / 研判 / 导出 / 回写全链路，/health 如实标 releaseEligible=false', async () => {
    const app = createApp({ store: createMemoryStore(), orchestratorOptions: { tickMs: 10000 } })
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${app.server.address().port}`
    const post = (path, body) => fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json() }))
    try {
      const health = await (await fetch(`${base}/health`)).json()
      expect(health.batch.positioning).toBe('auto_prospecting')
      expect(health.batch.releaseEligible).toBe(false)
      expect(health.dataSources.readyCount).toBe(0)

      const imp = await post('/v1/import/companies', { csv: csvSample() })
      expect(imp.status).toBe(200)
      expect(imp.body.origin).toBe('user_imported')
      const judge = await post('/v1/batch/judge', { batchSize: 5 })
      expect(judge.status).toBe(200)
      expect(judge.body.summary.succeeded).toBe(0) // 未配 Key，绝不伪造
      const badImport = await post('/v1/import/companies', { rows: [{ company_name: 'X', domain: 'bad' }] })
      expect(badImport.status).toBe(400)
      expect(badImport.body.code).toBe('E4007')

      const exp = await post('/v1/export/eml', { items: [validDraft()] })
      expect(exp.status).toBe(200)
      expect(exp.body.exportedIsNotSent).toBe(true)
      expect(exp.body.content).toContain('X-LeadPilot-Status: drafted')

      await post('/v1/import/outcomes', { events: [
        { domain: 'acme.example', event: 'sent' }, { domain: 'acme.example', event: 'bounced' },
      ] })
      const blocked = await post('/v1/export/eml', { items: [validDraft()] })
      expect(blocked.status).toBe(423)
      expect(blocked.body.code).toBe('E4010')
    } finally { await new Promise((resolve) => app.server.close(resolve)) }
  })
})

/* ============================================================ v0.8.0 integrity + outcome */
describe('v0.8.0 · 不做人工标注集：integrity + outcome 零人工评测口径', () => {
  const evidence = (i) => ({
    provenance: { matched: 1, total: 1 },
    rules: { passed: 2, total: 2 },
    schemaPass: true,
    refused: false,
    quote: `we import fittings ${i}`,
    sourceText: `api: we import fittings ${i} from asia`,
  })

  it('评测契约版本与 accuracyClaim=false 固化', () => {
    expect(INTEGRITY_GATE_VERSION).toBe('integrity-gate-v1')
    expect(OUTCOME_GATE_VERSION).toBe('outcome-gate-v1')
    expect(RELEASE_POLICY_VERSION).toBe('release-policy-v2')
    expect(integrityManifest().labelsRequired).toBe(false)
    expect(integrityManifest().accuracyClaim).toBe(false)
    expect(outcomeManifest().labelsRequired).toBe(false)
    expect(protocol.evalGates.integrity.accuracyClaim).toBe(false)
    expect(protocol.evalGates.releasePolicy.releaseEligible).toBe(false)
  })

  it('legacy 标注契约降级：enabled=false 且 manifest 如实标 legacy', () => {
    const m = baselineManifest()
    expect(m.legacy).toBe(true)
    expect(m.labelsRequired).toBe(false)
    expect(m.accuracyClaim).toBe(false)
    expect(m.evalMode).toBe('integrity+outcome')
    expect(m.releaseEligible).toBe(false)
    expect(m.integrityGate.gateVersion).toBe(INTEGRITY_GATE_VERSION)
    const contract = JSON.parse(readFileSync(new URL('../../shared/baseline-contract.json', import.meta.url), 'utf8'))
    expect(contract.status).toBe('legacy')
    expect(contract.enabled).toBe(false)
  })

  it('integrity：无样本 NO_DATA；证据齐全 + 一致 PASSED；P0 失守 BLOCKED', () => {
    expect(evaluateIntegrity([]).status).toBe('NO_DATA')
    const consistent = evaluateConsistency([{ a: 1 }, { b: 2 }], [{ a: 1 }, { b: 2 }])
    expect(consistent.ok).toBe(true)
    expect(consistent.rate).toBe(1)
    const good = evaluateIntegrity(
      Array.from({ length: protocol.evalGates.integrity.minSamples }, (_, i) => evidence(i)),
      { consistency: consistent },
    )
    expect(good.status).toBe('PASSED')
    expect(good.metrics.provenance_rate).toBe(1)
    expect(good.metrics.evidence_quote_rate).toBe(1)
    expect(good.accuracyClaim).toBe(false)

    const bad = evaluateIntegrity(
      Array.from({ length: protocol.evalGates.integrity.minSamples }, () => ({
        provenance: { matched: 0, total: 1 },
        rules: { passed: 1, total: 2 },
        schemaPass: false,
        refused: false,
        quote: 'not in source',
        sourceText: 'something else',
      })),
      { consistency: evaluateConsistency([{ a: 1 }], [{ a: 2 }]) },
    )
    expect(bad.status).toBe('BLOCKED')
    expect(bad.p0Failures.length).toBeGreaterThan(0)

    const small = evaluateIntegrity([evidence(0)], { consistency: consistent })
    expect(small.ok).toBe(false)
    expect(small.sampleTooSmall).toBe(true)
  })

  it('outcome：无样本 NO_DATA；退信率达标 PASSED；超阈值 BLOCKED；样本不足 INSUFFICIENT', () => {
    expect(evaluateOutcome([]).status).toBe('NO_DATA')
    const sent = (n) => Array.from({ length: n }, () => 'sent')
    const ok = evaluateOutcome([...sent(40), 'replied'])
    expect(ok.status).toBe('PASSED')
    expect(ok.metrics.bounce_rate).toBe(0)
    expect(ok.accuracyClaim).toBe(false)
    const bad = evaluateOutcome([...sent(40), 'bounced', 'bounced'])
    expect(bad.status).toBe('BLOCKED')
    expect(evaluateOutcome(sent(10)).status).toBe('INSUFFICIENT')
  })

  it('发布状态三分离：内测 / 外部验证 / 正式发布，accuracyClaim 恒 false', () => {
    const consistent = evaluateConsistency([{ a: 1 }], [{ a: 1 }])
    const integrity = evaluateIntegrity(
      Array.from({ length: protocol.evalGates.integrity.minSamples }, (_, i) => evidence(i)),
      { consistency: consistent },
    )
    const outcome = evaluateOutcome(Array.from({ length: 40 }, () => 'sent'))
    const release = releaseStatus({ integrity, outcome })
    expect(release.internalPreviewReady).toBe(true)
    expect(release.externalValidated).toBe(true)
    expect(release.releaseEligible).toBe(false)
    expect(release.accuracyClaim).toBe(false)
    expect(release.droppedByDecision.join()).toMatch(/385/)
    expect(releaseStatus().releaseEligible).toBe(false)
  })

  it('HTTP：/v1/eval/integrity、/v1/eval/outcome 与 /v1/eval/gates 如实暴露零标注口径', async () => {
    const app = createApp({ store: createMemoryStore(), orchestratorOptions: { tickMs: 10000 } })
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${app.server.address().port}`
    const post = (path, body) => fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json() }))
    try {
      const health = await (await fetch(`${base}/health`)).json()
      expect(health.version).toBe(PKG_VERSION)
      expect(health.evalGates.labelsRequired).toBe(false)
      expect(health.evalGates.accuracyClaim).toBe(false)
      expect(health.evalGates.releaseEligible).toBe(false)
      expect(health.baseline.contractStatus).toBe('legacy')

      const gates = await (await fetch(`${base}/v1/eval/gates`)).json()
      expect(gates.accuracyClaim).toBe(false)
      expect(gates.integrityGate.gateVersion).toBe(INTEGRITY_GATE_VERSION)
      expect(gates.outcomeGate.gateVersion).toBe(OUTCOME_GATE_VERSION)

      const integrity = await post('/v1/eval/integrity', { records: [] })
      expect(integrity.status).toBe(200)
      expect(integrity.body.status).toBe('NO_DATA')
      expect(integrity.body.accuracyClaim).toBe(false)

      const outcome = await post('/v1/eval/outcome', { events: [] })
      expect(outcome.status).toBe(200)
      expect(outcome.body.status).toBe('NO_DATA')
    } finally { await new Promise((resolve) => app.server.close(resolve)) }
  })
})

/* ==================================================== v0.9.0 用户指定 URL 抓取 */
describe('v0.9.0 · 用户指定 URL 抓取（抓取 ≠ 采集）', () => {
  it('HTTP：抓取器健康、SSRF 拒绝、批量无候选 E4008，商业数据源仍 0/6', async () => {
    const app = createApp({ store: createMemoryStore(), orchestratorOptions: { tickMs: 10000 } })
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${app.server.address().port}`
    const post = (path, body) => fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json() }))
    try {
      const health = await (await fetch(`${base}/v1/sources/health`)).json()
      expect(health.version).toBe('user-directed-fetch-v1')
      expect(health.origin).toBe('user_directed_fetch')
      expect(health.policy.respectRobots).toBe(true)
      expect(health.counters.fetched).toBe(0)

      const ssrf = await post('/v1/sources/fetch', { urls: ['http://127.0.0.1/secret', 'https://localhost/'] })
      expect(ssrf.status).toBe(400)
      expect(ssrf.body.failed.map((f) => f.code)).toEqual(['E4011', 'E4011'])
      expect(ssrf.body.summary.fetched).toBe(0)

      const bad = await post('/v1/sources/fetch', { urls: [] })
      expect(bad.status).toBe(400)
      expect(bad.body.code).toBe('E4011')

      const noCandidate = await post('/v1/batch/fetch-sources', { domains: ['no-such.example'] })
      expect(noCandidate.status).toBe(400)
      expect(noCandidate.body.code).toBe('E4008')

      const all = await (await fetch(`${base}/health`)).json()
      expect(all.dataSources.readyCount).toBe(0)
      expect(all.dataSources.total).toBe(6)
      expect(all.fetch.version).toBe('user-directed-fetch-v1')
      expect(all.batch.userDirectedFetch.origin).toBe('user_directed_fetch')
    } finally { await new Promise((resolve) => app.server.close(resolve)) }
  })
})

describe('P0-1 · 畸形请求不得终结服务进程', () => {
  it('非法 URL 返回 400 E5002，之后 /health 仍可正常响应', async () => {
    const app = createApp({ store: createMemoryStore(), security: { loopback: true } })
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    const port = app.server.address().port
    try {
      // 必须用原始 socket：fetch / http.request 会在客户端先把路径规范化掉
      const raw = await new Promise((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => {
          socket.write('GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
        })
        let data = ''
        socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('socket timeout')) })
        socket.on('data', (d) => { data += d.toString('utf8') })
        socket.on('end', () => resolve(data))
        socket.on('error', reject)
      })
      expect(raw).toMatch(/^HTTP\/1\.1 400/)
      expect(raw).toContain('E5002')
      const health = await fetch(`http://127.0.0.1:${port}/health`)
      expect(health.status).toBe(200)
      expect((await health.json()).ok).toBe(true)
    } finally {
      await new Promise((resolve) => app.server.close(resolve))
      app.store.close?.()
    }
  })
})
