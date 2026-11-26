/**
 * B7 · 合规与验证链路的行为级反例
 *
 * 纪律：每个用例都必须「改坏实现就红」，不写只读常量、不做静态文案比对。
 * 覆盖 P2-1（服务端持久化 G2 抑制表 + domain 必须入库）、P2-2（settle 失败释放 held）、
 * P3-5（reserveFailure 错误文案按 code 分派）、P2-9（OPTIONS 纳入限流）、
 * P2-4（HTTP 解析层 clientError 兜底）。
 */
import { describe, expect, it } from 'vitest'
import { connect } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore, createStore, sqliteAvailable } from '../store.mjs'
import { createLedger } from '../ledger.mjs'
import { createGateway } from '../gateway.mjs'
import { createApp } from '../index.mjs'
import { createBatchPipeline, checkExportGates } from '../batch.mjs'
import { protocol } from '../protocol.mjs'

const SOURCES = [
  'About: Authorized distributor for Parker and Eaton across Benelux.',
  'We stock hydraulic hose fittings, JIC fittings and brass adapters for industrial distributors.',
  'Team of 23 across Rotterdam and Antwerp. FOB Rotterdam, CIF terms available.',
]

const wire = () => ({
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
})

const PINNED_VERSIONS = Object.fromEntries(protocol.providers.map((p) => [
  `LEADPILOT_MODEL_VERSION_${p.key.toUpperCase().replace(/-/g, '_')}`,
  `${p.model}-2026-10-15`,
]))
const env = () => ({ ...PINNED_VERSIONS, DEEPSEEK_API_KEY: 'k' })
const okFetch = () => async () => ({
  status: 200, ok: true,
  json: async () => ({
    choices: [{ message: { content: JSON.stringify(wire()) } }],
    usage: { prompt_tokens: 1000, completion_tokens: 200 },
  }),
})
const judgeInput = (overrides = {}) => ({
  companyId: 'c_0001', domain: 'x.example', country: '美国',
  sourceTexts: SOURCES,
  facts: { keywordHits: [{ term: 'hydraulic fittings', count: 14 }], customsRecords: 9 },
  ...overrides,
})
const makeGateway = (ledger) => createGateway({
  env: env(), fetchImpl: okFetch(), ledger,
  sleep: async () => {}, now: () => 1_700_000_000_000,
})

const SENDER = {
  name: 'Kou', email: 'kou@example.com', company: 'LeadPilot',
  postalAddress: 'Shenzhen, China', unsubscribe: 'Reply unsubscribe to opt out',
}
const FOOTER = [SENDER.name, SENDER.company, SENDER.postalAddress, SENDER.unsubscribe].join(' | ')
const draft = (over = {}) => ({
  domain: 'b7.example', to: 'buyer@b7.example',
  subject: 'Hydraulic fittings supply',
  body: 'We noticed your company distributes industrial fittings across Benelux. We manufacture hydraulic hose fittings and can share our current catalogue and lead times. Would a short specification sheet be useful for your team this quarter?',
  grade: 'B', sender: SENDER, footer: FOOTER, ...over,
})
const seed = (p) => p.importCompanies({ rows: [{ company_name: 'B7 Co', domain: 'b7.example' }] })

async function withApp(opts, run) {
  const app = createApp({ store: createMemoryStore(), ...opts })
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const port = app.server.address().port
  try {
    return await run(`http://127.0.0.1:${port}`, app)
  } finally {
    await new Promise((resolve) => app.server.close(resolve))
    app.store.close?.()
  }
}

/* ───────────────────────── P2-1 · 服务端持久化 G2 抑制表 ───────────────────────── */

describe('B7 / P2-1 · G2 抑制名单服务端持久化，导出不依赖调用方传参', () => {
  it('登记抑制后，完全不传 blacklist 的导出仍被硬拦（旧实现会放行）', () => {
    const store = createMemoryStore()
    const p = createBatchPipeline({ store, gateway: null })
    seed(p)
    expect(p.exportDrafts({ items: [draft()] }).ok).toBe(true) // 基线：合规草稿可导出
    const registered = p.importSuppressions({ entries: [{ domain: 'b7.example', reason: 'unsubscribed' }] })
    expect(registered.ok).toBe(true)
    expect(registered.total).toBe(1)
    const blocked = p.exportDrafts({ items: [draft()] })
    expect(blocked.ok).toBe(false)
    expect(JSON.stringify(blocked.blocked)).toContain('服务端持久化')
  })

  it('同一持久化库新建管道实例（模拟进程重启）后仍拦截，名单不是内存局部变量', () => {
    const store = createMemoryStore()
    const first = createBatchPipeline({ store, gateway: null })
    seed(first)
    first.importSuppressions({ entries: [{ domain: 'b7.example', reason: 'manual_blacklist' }] })
    const second = createBatchPipeline({ store, gateway: null })
    expect(second.listSuppressions().count).toBe(1)
    expect(second.exportDrafts({ items: [draft()] }).ok).toBe(false)
  })

  it('persistent store（sqlite / json 兜底）跨进程实例恢复抑制表', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leadpilot-b7-'))
    try {
      const dbPath = join(dir, 'b7.db')
      const a = createStore({ mode: sqliteAvailable ? 'sqlite' : 'json', dbPath })
      const p1 = createBatchPipeline({ store: a, gateway: null })
      seed(p1)
      p1.importSuppressions({ entries: [{ domain: 'b7.example', reason: 'invalid' }] })
      a.close?.()
      const b = createStore({ mode: sqliteAvailable ? 'sqlite' : 'json', dbPath })
      const p2 = createBatchPipeline({ store: b, gateway: null })
      expect(p2.listSuppressions().count).toBe(1)
      expect(p2.exportDrafts({ items: [draft()] }).ok).toBe(false)
      b.close?.()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('不可逆终态回写自动登记抑制表，换实例后仍不能导出', () => {
    const store = createMemoryStore()
    const p = createBatchPipeline({ store, gateway: null })
    seed(p)
    const applied = p.importOutcomes({ events: [{ domain: 'b7.example', event: 'unsubscribed', confirmed: true }] })
    expect(applied.applied).toHaveLength(1)
    expect(store.suppressionGet('b7.example')).toMatchObject({ reason: 'unsubscribed', source: 'outcome' })
    const next = createBatchPipeline({ store, gateway: null })
    expect(next.exportDrafts({ items: [draft()], blacklist: [] }).ok).toBe(false)
  })

  it('domain 未导入客户库一律拒绝；纯函数缺 knownDomains 也 fail-closed', () => {
    const store = createMemoryStore()
    const p = createBatchPipeline({ store, gateway: null })
    seed(p)
    const unknown = p.exportDrafts({ items: [draft({ domain: 'unknown.example', to: 'buyer@unknown.example' })] })
    expect(unknown.ok).toBe(false)
    expect(JSON.stringify(unknown.blocked)).toContain('未导入客户库')
    const noCtx = checkExportGates([draft()])
    expect(noCtx.allowed).toHaveLength(0)
    expect(noCtx.blocked[0].reasons.join()).toContain('fail-closed')
  })

  it('抑制登记拒绝未知域名与非法 reason，不产生静默写入', () => {
    const store = createMemoryStore()
    const p = createBatchPipeline({ store, gateway: null })
    seed(p)
    const r = p.importSuppressions({ entries: [
      { domain: 'ghost.example', reason: 'unsubscribed' },
      { domain: 'b7.example', reason: 'whatever' },
      { domain: 'b7.example', reason: 'unsubscribed' },
    ] })
    expect(r.applied).toHaveLength(1)
    expect(r.rejected).toHaveLength(2)
    expect(r.total).toBe(1)
  })

  it('HTTP 端点：POST 登记 → GET 可查 → 不传 blacklist 的导出被 400 拒绝', async () => {
    await withApp({ security: { loopback: true } }, async (base) => {
      const imported = await fetch(`${base}/v1/import/companies`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rows: [{ company_name: 'B7 Co', domain: 'b7.example' }] }),
      })
      expect(imported.status).toBe(200)
      const reg = await fetch(`${base}/v1/import/suppressions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entries: [{ domain: 'b7.example', reason: 'unsubscribed' }] }),
      })
      expect(reg.status).toBe(200)
      const list = await fetch(`${base}/v1/suppressions`)
      expect((await list.json()).count).toBe(1)
      const exp = await fetch(`${base}/v1/export/eml`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [draft()] }),
      })
      expect(exp.status).toBe(400)
      expect(JSON.stringify(await exp.json())).toContain('服务端持久化')
    })
  })
})

/* ───────────────────────── P2-2 / P3-5 · 账本结算失败与错误文案 ───────────────────────── */

describe('B7 / P2-2 · 结算失败必须释放冻结额，绝不谎报已结算', () => {
  it('settle 抛回失败：held 归零、spent 归零、流水只有 reserve + release', async () => {
    const store = createMemoryStore()
    const real = createLedger({ store, openingBalance: 200 })
    const ledger = Object.create(real)
    ledger.settle = () => ({ ok: false, code: 'E4003', reason: '注入的结算失败' })
    const r = await makeGateway(ledger).judge(judgeInput({ requestId: 'b7-settle-fail-1' }))
    expect(r.ok).toBe(true) // provider 内容与证据校验确实通过，不能谎称调用失败
    expect(r.billing).toMatchObject({ charged: false, settleFailed: true, released: true, error: 'E4003' })
    expect(r.billing.note).toContain('预扣已全额释放')
    expect(real.state()).toMatchObject({ held: 0, spent: 0, available: 200 })
    expect(real.entries('gw:judge:b7-settle-fail-1').map((e) => e.kind)).toEqual(['reserve', 'release'])
  })

  it('settle 与 release 都失败：如实标注需人工核对，不释放也不宣称未扣点后已归还', async () => {
    const store = createMemoryStore()
    const real = createLedger({ store, openingBalance: 200 })
    const ledger = Object.create(real)
    ledger.settle = () => ({ ok: false, code: 'E4003', reason: '注入的结算失败' })
    ledger.release = () => ({ ok: false, code: 'E4003', reason: '注入的释放失败' })
    const r = await makeGateway(ledger).judge(judgeInput({ requestId: 'b7-settle-fail-2' }))
    expect(r.billing).toMatchObject({ charged: false, settleFailed: true, released: false, releaseCode: 'E4003' })
    expect(r.billing.note).toContain('人工核对')
    expect(r.billing.note).not.toContain('已全额释放')
  })

  it('reserveFailure 文案按账本真实 code 分派（E4002 / E4003 / E4005 不再一律说成已结算）', async () => {
    const cases = [
      ['E4001', '点数不足', '已结算'],
      ['E4002', '金额不一致', '已结算'],
      ['E4003', '账本预扣校验失败', '已结算'],
      ['E4005', '拒绝重复调用与重复扣点', '点数不足'],
    ]
    for (const [code, mustContain, mustNotContain] of cases) {
      const store = createMemoryStore()
      const real = createLedger({ store, openingBalance: 200 })
      const ledger = Object.create(real)
      ledger.reserve = () => ({ ok: false, code, reason: `注入的 ${code} 失败` })
      const r = await makeGateway(ledger).judge(judgeInput({ requestId: `b7-reserve-${code}` }))
      expect(r.code).toBe(code)
      expect(r.reason).toContain(mustContain)
      expect(r.reason).not.toContain(mustNotContain)
      expect(real.state().held).toBe(0)
    }
  })
})

/* ───────────────────────── P2-9 / P2-4 · HTTP 层健壮性 ───────────────────────── */

describe('B7 / P2-9 · OPTIONS 预检纳入限流', () => {
  it('连续预检超过阈值返回 429 E6010（旧实现在第 4 次仍 204）', async () => {
    await withApp({ security: { loopback: true, rateLimit: 3 } }, async (base) => {
      const statuses = []
      for (let i = 0; i < 4; i++) {
        const res = await fetch(`${base}/health`, { method: 'OPTIONS' })
        statuses.push(res.status)
      }
      expect(statuses).toEqual([204, 204, 204, 429])
      const res = await fetch(`${base}/health`, { method: 'OPTIONS' })
      expect((await res.json()).code).toBe('E6010')
    })
  })
})

describe('B7 / P2-4 · HTTP 解析层 clientError 兜底反例', () => {
  it('畸形请求头返回裸 400 且带 Content-Length: 0，删掉业务 handler 就会红', async () => {
    await withApp({ security: { loopback: true } }, async (base, app) => {
      const port = app.server.address().port
      const raw = await new Promise((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => {
          socket.write('GET /health HTTP/1.1\r\nHost: x\r\nBad Header: y\r\nConnection: close\r\n\r\n')
        })
        let data = ''
        socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('socket timeout')) })
        socket.on('data', (d) => { data += d.toString('utf8') })
        socket.on('end', () => resolve(data))
        socket.on('error', reject)
      })
      // Node 默认 clientError 响应不含 Content-Length: 0；这是业务兜底的可观测特征
      expect(raw).toMatch(/^HTTP\/1\.1 400 Bad Request/)
      expect(raw).toContain('Content-Length: 0')
      expect(raw).not.toContain('E5002') // 与「非法 URL」的 JSON 400 路径区分开
      const health = await fetch(`${base}/health`)
      expect(health.status).toBe(200)
      expect((await health.json()).ok).toBe(true)
    })
  })
})
