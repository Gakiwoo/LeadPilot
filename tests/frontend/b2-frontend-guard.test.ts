import { beforeEach, describe, expect, it } from 'vitest'
import { buildDemoCompanies } from '@/data/demo-data'
import { useAppStore } from '@/store/useAppStore'
import { checkSendGates } from '@/domain/compliance'
import { gatewayDiagnosis, type GatewayHealth } from '@/services/gateway-client'
import type { Company, Outreach } from '@/types'

const baseSettings = useAppStore.getState().settings

const draftFor = (companyId: string, contactId = ''): Outreach => ({
  id: `out_b2_${companyId}`,
  companyId,
  contactId,
  subject: 'Intro',
  bodyText: 'Hello',
  bodyHtml: '<pre>Hello</pre>',
  language: 'en',
  purpose: 'intro',
  status: 'draft',
  personalizationTags: [],
  validation: {
    wordCount: 1, maxWords: 200, bannedHits: [], hasUnsubscribe: true,
    hasSenderIdentity: true, hasPlaceholder: false, hasPersonalization: true,
    passed: true, issues: [],
  },
  createdAt: new Date().toISOString(),
  demo: true,
})

const freshCompany = (): Company => {
  const seed = buildDemoCompanies(1)[0]
  if (!seed) throw new Error('演示数据集为空，测试前置条件不成立')
  return { ...seed, id: 'c_b2', status: 'new', lastContactAt: '2026-11-01T00:00:00.000Z' }
}

/** 测试里凡取 contacts[0] 都走这里：noUncheckedIndexedAccess 下索引访问是 `T | undefined` */
const firstContact = (c: Company) => {
  const contact = c.contacts[0]
  if (!contact) throw new Error('演示客户必须至少有一个联系人')
  return contact
}

const health = (over: Partial<GatewayHealth> = {}): GatewayHealth => ({
  online: true, mode: 'unconfigured-demo', configuredCount: 0, pinnedCount: 0,
  readyCount: 0, totalProviders: 6, providers: [], cacheEntries: 0, auditEntries: 0,
  ...over,
})

beforeEach(() => {
  useAppStore.setState({
    companies: [], outreach: [], undoStack: [],
    settings: { ...baseSettings, blacklist: [] },
  })
})

describe('B2 · 前端合规与降级 P1 行为级反例', () => {
  it('P1-10 · 演示评分卡不伪装模型判断：区间显示、低置信、明确 E6005 降级标注', () => {
    const companies = buildDemoCompanies(12)
    expect(companies.length).toBeGreaterThan(0)
    for (const c of companies) {
      expect(c.scoreCard.modelDegraded).toBe(true)
      expect(c.scoreCard.confidence).toBe('low')
      expect(c.scoreCard.totalRange).not.toBeNull()
      expect(c.scoreCard.totalDisplay).toContain('–')
      expect(c.scoreCard.warnings.join(' ')).toContain('未经模型校验')
      expect(c.scoreCard.warnings.join(' ')).toContain('DEMO')
    }
  })

  it('P1-11 · 黑名单/退订客户的草稿被 G2 硬拦：不入队、不改状态', () => {
    const c = freshCompany()
    const email = firstContact(c).value
    useAppStore.setState({
      companies: [c],
      settings: { ...baseSettings, blacklist: [email] },
    })
    const r = useAppStore.getState().addOutreach(draftFor(c.id, firstContact(c).id))
    expect(r.ok).toBe(false)
    expect(r.message).toContain('G2')
    expect(useAppStore.getState().outreach).toHaveLength(0)
    expect(useAppStore.getState().companies[0]?.status).toBe('new')
  })

  it('P1-12 · 撤销退订同步回滚黑名单，且 lastContactAt 按快照恢复', () => {
    const c = freshCompany()
    useAppStore.setState({ companies: [c] })
    const r = useAppStore.getState().setCompanyStatus(c.id, 'unsubscribed', { confirmed: true })
    expect(r.ok).toBe(true)
    expect(useAppStore.getState().settings.blacklist).toContain(firstContact(c).value)

    useAppStore.getState().undo()
    const after = useAppStore.getState()
    const restored = after.companies[0]
    expect(restored).toBeDefined()
    expect(restored?.status).toBe('new')
    expect(after.settings.blacklist).not.toContain(firstContact(c).value)
    expect(restored?.lastContactAt).toBe(c.lastContactAt)
    expect(restored?.statusLog).toEqual(c.statusLog)
  })

  it('P1-14 · offline / E6005 / E6008 / ready 四态诊断不混淆', () => {
    expect(gatewayDiagnosis(null)).toBe('offline')
    expect(gatewayDiagnosis(health({ online: false, mode: 'offline' }))).toBe('offline')
    expect(gatewayDiagnosis(health())).toBe('no_provider')
    expect(gatewayDiagnosis(health({ configuredCount: 2, pinnedCount: 0 }))).toBe('snapshot_unlocked')
    expect(gatewayDiagnosis(health({ mode: 'configured', configuredCount: 2, pinnedCount: 2, readyCount: 2 }))).toBe('ready')
  })

  it('P1-15 · C 级必须按单条 singleConfirmed 放行，总勾选不能代表逐条确认', () => {
    const c = buildDemoCompanies(8).find((x) => x.contacts[0]?.grade === 'C')
    expect(c).toBeTruthy()
    const input = {
      contact: c ? firstContact(c) : null, blacklist: [], sentToday: 0, dailyLimit: 100,
      bounceRate: 0, consecutiveHardBounces: 0,
    }
    const unconfirmed = checkSendGates({ ...input, singleConfirmed: false })
    expect(unconfirmed.failed.some((f) => f.gate === 'G1' && f.code === 'E3004')).toBe(true)
    const confirmed = checkSendGates({ ...input, singleConfirmed: true })
    expect(confirmed.failed.some((f) => f.gate === 'G1')).toBe(false)
  })
})
