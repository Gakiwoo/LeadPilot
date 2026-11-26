/**
 * B8 / P2-6 · 三步管道打通的行为级反例
 *
 * 核心断言：导入 → 研判 → 批量出信 → mbox 导出全程共用服务端客户库同一批 domain，
 * 导出项不再来自前端演示草稿库；降级项 body=null 不伪造；本地模板必须显式标 DEMO。
 */
import { describe, expect, it } from 'vitest'
import { createMemoryStore } from '../../server/persistence/store.mjs'
import { createGateway } from '../../server/services/gateway.mjs'
import { createApp } from '../../server/index.mjs'
import {
  createBatchPipeline, validateRows, checkExportGates, buildMbox, normalizeDomain,
} from '../../server/services/batch.mjs'
import { validateEmailDraft } from '../../server/core/protocol.mjs'
// 跨层反例：前端本地模板的正文必须能通过服务端 F6-2 硬校验，不能各写一套口径
import { buildImportedTemplateDraft } from '../../src/services/email-generator.ts'

const SENDER = {
  name: 'Kou', email: 'kou@example.com', company: 'LeadPilot',
  postalAddress: 'Shenzhen, China', unsubscribe: 'Reply unsubscribe to opt out',
}
const FOOTER = [SENDER.name, SENDER.company, SENDER.postalAddress, SENDER.unsubscribe].join(' | ')
const BODY = 'We noticed your company distributes industrial fittings across Benelux. We manufacture hydraulic hose fittings and can share our current catalogue and lead times. Would a short specification sheet be useful for your team this quarter?'

const row = (i, over = {}) => ({
  company_name: `B8 Co ${i}`,
  domain: `c${i}.example`,
  source_url: `https://c${i}.example/about`,
  fetched_at: '2026-11-09',
  raw_text: `About: We import hydraulic hose fittings from Asia. Team of ${20 + i} across Rotterdam.`,
  country: 'Germany',
  product_hint: 'hydraulic fittings',
  contact_email: `buyer@c${i}.example`,
  ...over,
})
const draft = (over = {}) => ({
  domain: 'c0.example', to: 'buyer@c0.example',
  subject: 'Hydraulic fittings supply', body: BODY,
  grade: 'B', sender: SENDER, footer: FOOTER, ...over,
})
const fakeGateway = (over = {}) => {
  const real = createGateway({ env: {}, fetchImpl: async () => { throw new Error('不应发起请求') } })
  const g = Object.create(real)
  g.writeEmail = async () => ({
    ok: true, subject: 'Hydraulic fittings supply', body: BODY,
    anchorUsed: 'We import hydraulic hose fittings from Asia',
    errorCodes: [], billing: null,
  })
  return Object.assign(g, over)
}
const seeded = (gateway, rows = [row(0)]) => {
  const store = createMemoryStore()
  const p = createBatchPipeline({ store, gateway })
  p.importCompanies({ rows })
  return { store, p }
}

async function withHttp(store, gateway, run) {
  const app = createApp({ store, gateway, security: { loopback: true }, orchestratorOptions: { tickMs: 10000 } })
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${app.server.address().port}`
  try {
    return await run(base)
  } finally {
    await new Promise((resolve) => app.server.close(resolve))
    store.close?.()
  }
}
const post = (base, path, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }))

/* ───────────────────────── 导入契约：联系人评级 ───────────────────────── */

describe('B8 / P2-6 · contact_grade 导入与保守默认', () => {
  it('未评级行按 C 处理并标 gradeSource=default_conservative，不让未评级草稿静默放行', () => {
    const v = validateRows([row(0), row(1, { contact_grade: 'A' })])
    expect(v.ok).toBe(true)
    expect(v.accepted[0]).toMatchObject({ contactGrade: 'C', gradeSource: 'default_conservative' })
    expect(v.accepted[1]).toMatchObject({ contactGrade: 'A', gradeSource: 'imported' })
  })

  it('非法评级整行拒绝且不静默丢弃', () => {
    const v = validateRows([row(0, { contact_grade: 'Z' }), row(1)])
    expect(v.summary.rejected).toBe(1)
    expect(v.rejected[0].reason).toContain('contact_grade 非法')
    expect(v.summary.accepted).toBe(1)
  })

  it('客户清单回传评级与能力标记，但不回传邮箱本身', () => {
    const { p } = seeded(null)
    const c = p.listCompanies().companies[0]
    expect(c).toMatchObject({ contactGrade: 'C', hasContactEmail: true, hasSource: true })
    expect(JSON.stringify(c)).not.toContain('buyer@')
  })
})

/* ───────────────────────── 批量出信：同源、分桶、不伪造 ───────────────────────── */

describe('B8 / P2-6 · generateDrafts 与导入共用客户库', () => {
  it('空客户库 / 不存在的域名返回 E4014，不产出任何草稿', async () => {
    const empty = createBatchPipeline({ store: createMemoryStore(), gateway: fakeGateway() })
    expect((await empty.generateDrafts({})).code).toBe('E4014')
    const { p } = seeded(fakeGateway())
    expect((await p.generateDrafts({ domains: ['ghost.example'] })).code).toBe('E4014')
  })

  it('缺原文 / 缺邮箱 / 缺产品逐条 failed，且完全不调用 provider', async () => {
    let calls = 0
    const gateway = fakeGateway({ writeEmail: async () => { calls += 1; return { ok: true, subject: 'x', body: BODY } } })
    const store = createMemoryStore()
    const p = createBatchPipeline({ store, gateway })
    p.importCompanies({ rows: [
      row(0, { source_url: '', fetched_at: '', raw_text: '' }),
      row(1, { contact_email: '' }),
      row(2, { product_hint: '' }),
    ] })
    const r = await p.generateDrafts({})
    expect(r.summary).toMatchObject({ total: 3, failed: 3, succeeded: 0 })
    expect(calls).toBe(0)
    expect(r.items.every((i) => i.body === null && i.draftSource === null)).toBe(true)
    expect(r.items[0].reason).toContain('missing_source')
  })

  it('真实 T1 成功项带 draftSource=provider，domain 与客户库逐条一致', async () => {
    const { p } = seeded(fakeGateway(), [row(0), row(1), row(2)])
    const r = await p.generateDrafts({})
    expect(r.summary).toMatchObject({ total: 3, succeeded: 3, degraded: 0, failed: 0 })
    expect(r.items.map((i) => i.domain)).toEqual(['c0.example', 'c1.example', 'c2.example'])
    expect(r.items.every((i) => i.draftSource === 'provider' && i.subject && i.body)).toBe(true)
    expect(r.items.every((i) => i.grade === 'C' && i.gradeSource === 'default_conservative')).toBe(true)
    expect(r.items[0].anchor).toContain('We import hydraulic hose fittings')
  })

  it('provider 降级时 body=null、不写正文、不计入 succeeded', async () => {
    const gateway = fakeGateway({
      writeEmail: async () => ({ ok: false, degraded: true, errorCodes: ['E6005'], reason: '未配置 provider' }),
    })
    const { p } = seeded(gateway)
    const r = await p.generateDrafts({})
    expect(r.summary.succeeded).toBe(0)
    expect(r.items[0]).toMatchObject({ bucket: 'degraded', body: null, subject: null, draftSource: null })
    expect(r.items[0].codes).toContain('E6005')
  })

  it('batchSize 超上限 / 非法值显式 E4014，不静默截断、不调用 provider', async () => {
    let calls = 0
    const gateway = fakeGateway({ writeEmail: async () => { calls += 1; return { ok: true, subject: 'x', body: BODY } } })
    const { p } = seeded(gateway, Array.from({ length: 51 }, (_, i) => row(i)))
    for (const batchSize of [51, 'abc', 0, -1]) {
      const r = await p.generateDrafts({ batchSize })
      expect(r.code).toBe('E4014')
      expect(r.ok).toBe(false)
    }
    expect(calls).toBe(0)
  })

  it('requestId 按 batchId:domain:email 生成，重复批次可复用网关幂等键', async () => {
    const seen = []
    const gateway = fakeGateway({ writeEmail: async (input) => { seen.push(input.requestId); return { ok: true, subject: 'x', body: BODY } } })
    const { p } = seeded(gateway, [row(0)])
    await p.generateDrafts({ batchId: 'b8-fixed' })
    expect(seen[0]).toBe('b8-fixed:c0.example:email')
  })
})

/* ───────────────────────── 来源标识：不把模板伪装成模型输出 ───────────────────────── */

describe('B8 / P2-6 · draftSource 白名单与 mbox 显式标注', () => {
  it('非法 draftSource 被 E4015 原因拦下；未标注按 unspecified 如实写头', () => {
    const bad = checkExportGates([draft({ draftSource: 'provider-fake' })], { knownDomains: ['c0.example'] })
    expect(bad.allowed).toHaveLength(0)
    expect(bad.blocked[0].reasons.join()).toContain('E4015')
    const mbox = buildMbox([draft()], { now: Date.UTC(2026, 10, 9) })
    expect(mbox).toContain('X-LeadPilot-Draft-Source: unspecified')
    expect(mbox).not.toContain('X-LeadPilot-Demo')
  })

  it('local-template 草稿的 mbox 必带 DEMO 头，provider 草稿不带', () => {
    const template = buildMbox([draft({ draftSource: 'local-template' })], { now: Date.UTC(2026, 10, 9) })
    expect(template).toContain('X-LeadPilot-Draft-Source: local-template')
    expect(template).toContain('X-LeadPilot-Demo: template-not-model')
    const provider = buildMbox([draft({ draftSource: 'provider' })], { now: Date.UTC(2026, 10, 9) })
    expect(provider).toContain('X-LeadPilot-Draft-Source: provider')
    expect(provider).not.toContain('template-not-model')
  })

  it('导入的 domain 规范化后可用于同源校验', () => {
    expect(normalizeDomain('https://WWW.C0.example:443/about')).toBe('c0.example')
  })

  it('HTTP 层真返回 E4015（不是笼统 E4009），且不产出任何 mbox 内容', async () => {
    const store = createMemoryStore()
    const p = createBatchPipeline({ store, gateway: fakeGateway() })
    p.importCompanies({ rows: [row(0, { contact_grade: 'B' })] })
    await withHttp(store, fakeGateway(), async (base) => {
      const exported = await post(base, '/v1/export/eml', { items: [draft({ draftSource: 'provider-fake' })] })
      expect(exported.status).toBe(400)
      expect(exported.body.code).toBe('E4015')
      expect(exported.body.blocked[0].code).toBe('E4015')
      expect(exported.body.content).toBeUndefined()
    })
  })
})

describe('B8 / P2-6 · 前端本地模板 → 服务端硬校验 → 导出（跨层口径一致）', () => {
  it('模板正文能通过服务端 F6-2 校验，且导出链真写 DEMO 头 / drafted 状态', () => {
    const d = buildImportedTemplateDraft({
      companyName: 'B8 Co 0', productHint: 'hydraulic fittings',
      anchor: 'We import hydraulic hose fittings from Asia',
    })
    expect(d).not.toBeNull()
    expect(d?.draftSource).toBe('local-template')
    const check = validateEmailDraft({ subject: d.subject, body: d.body })
    expect(check.valid).toBe(true)

    const store = createMemoryStore()
    const p = createBatchPipeline({ store, gateway: fakeGateway() })
    p.importCompanies({ rows: [row(0)] })
    const result = p.exportDrafts({ items: [{
      domain: 'c0.example', to: 'buyer@c0.example',
      subject: d.subject, body: d.body, grade: 'B', confirmed: true,
      draftSource: d.draftSource, sender: SENDER, footer: FOOTER,
    }] })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('X-LeadPilot-Draft-Source: local-template')
    expect(result.content).toContain('X-LeadPilot-Demo: template-not-model')
    expect(store.companyGet('c0.example').status).toBe('drafted')
  })
})

/* ───────────────────────── HTTP 端到端：14 家真实批次 ───────────────────────── */

describe('B8 / P2-6 · 真实 HTTP 端到端（导入 → 研判 → 出信 → mbox）', () => {
  it('14 家同一批 domain 全程贯通，导出 14 封且状态落盘 drafted，绝不发送', async () => {
    const store = createMemoryStore()
    const gateway = fakeGateway()
    const rows = Array.from({ length: 14 }, (_, i) => row(i, { contact_grade: 'B' }))
    await withHttp(store, gateway, async (base) => {
      const imported = await post(base, '/v1/import/companies', { rows })
      expect(imported.status).toBe(200)
      expect(imported.body.summary.accepted).toBe(14)

      const judged = await post(base, '/v1/batch/judge', { batchSize: 20 })
      expect(judged.status).toBe(200)
      expect(judged.body.summary.total).toBe(14)

      const generated = await post(base, '/v1/batch/generate-drafts', { batchSize: 20 })
      expect(generated.status).toBe(200)
      expect(generated.body.summary).toMatchObject({ total: 14, succeeded: 14 })
      const listed = (await (await fetch(`${base}/v1/import/companies`)).json()).companies
      expect(generated.body.items.map((i) => i.domain).sort())
        .toEqual(listed.map((c) => c.domain).sort())

      // 导出项完全来自上一步的批量出信结果，不掺任何演示草稿
      const items = generated.body.items.map((i) => ({
        domain: i.domain, to: i.to, subject: i.subject, body: i.body,
        grade: i.grade, draftSource: i.draftSource, sender: SENDER, footer: FOOTER,
      }))
      const exported = await post(base, '/v1/export/eml', { items })
      expect(exported.status).toBe(200)
      expect(exported.body).toMatchObject({ ok: true, count: 14, exportedIsNotSent: true, statusAfterExport: 'drafted' })
      expect((exported.body.content.match(/From leadpilot-export/g) ?? []).length).toBe(14)
      expect((exported.body.content.match(/X-LeadPilot-Draft-Source: provider/g) ?? []).length).toBe(14)
      expect(exported.body.content).not.toContain('template-not-model')
      expect(store.companyGet('c0.example').status).toBe('drafted')
      expect(store.companyGet('c0.example').status).not.toBe('sent')
    })
  })

  it('无 provider 时端到端如实停在 degraded：导出 0 封，不拿模板正文冒充', async () => {
    const store = createMemoryStore()
    const real = createGateway({ env: {}, fetchImpl: async () => { throw new Error('不应发起请求') } })
    await withHttp(store, real, async (base) => {
      await post(base, '/v1/import/companies', { rows: [row(0)] })
      const generated = await post(base, '/v1/batch/generate-drafts', {})
      expect(generated.status).toBe(200)
      expect(generated.body.summary.succeeded).toBe(0)
      expect(generated.body.items[0].body).toBeNull()
      const exported = await post(base, '/v1/export/eml', {
        items: generated.body.items.map((i) => ({
          ...i, body: i.body ?? '', sender: SENDER, footer: FOOTER,
          draftSource: i.draftSource ?? 'unspecified',
        })),
      })
      expect(exported.status).toBe(400)
    })
  })

  it('模型降级后显式本地模板草稿也能走完导出链，mbox 必带 DEMO 头', async () => {
    const store = createMemoryStore()
    const real = createGateway({ env: {}, fetchImpl: async () => { throw new Error('不应发起请求') } })
    await withHttp(store, real, async (base) => {
      await post(base, '/v1/import/companies', { rows: [row(0)] })
      const generated = await post(base, '/v1/batch/generate-drafts', {})
      expect(generated.body.items[0].bucket).toBe('degraded')
      expect(generated.body.items[0].body).toBeNull()
      const exported = await post(base, '/v1/export/eml', { items: [{
        domain: 'c0.example', to: 'buyer@c0.example',
        subject: 'Hydraulic fittings supply', body: BODY,
        grade: 'B', confirmed: true, draftSource: 'local-template',
        sender: SENDER, footer: FOOTER,
      }] })
      expect(exported.status).toBe(200)
      expect(exported.body.content).toContain('X-LeadPilot-Draft-Source: local-template')
      expect(exported.body.content).toContain('X-LeadPilot-Demo: template-not-model')
      expect(exported.body.content).toContain('X-LeadPilot-Status: drafted')
      expect(store.companyGet('c0.example').status).toBe('drafted')
      expect(store.companyGet('c0.example').status).not.toBe('sent')
    })
  })

  it('/health 与 /v1/batch/health 如实暴露三步管道能力，releaseEligible 恒 false', async () => {
    const store = createMemoryStore()
    await withHttp(store, fakeGateway(), async (base) => {
      const h = await (await fetch(`${base}/health`)).json()
      const bh = await (await fetch(`${base}/v1/batch/health`)).json()
      expect(h.batch.generateDrafts.endpoint).toContain('/v1/batch/generate-drafts')
      expect(h.batch.generateDrafts.draftSources).toEqual(['provider', 'local-template', 'unspecified'])
      expect(h.batch.generateDrafts.releaseEligible).toBe(false)
      expect(bh.generateDrafts.batchSizeMax).toBe(50)
      expect(bh.releaseEligible).toBe(false)
    })
  })
})
