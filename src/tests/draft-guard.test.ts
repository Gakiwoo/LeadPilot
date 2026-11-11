import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store/useAppStore'
import { buildDemoCompanies } from '@/data/demo-data'
import type { Company, Outreach } from '@/types'

const draftFor = (companyId: string): Outreach => ({
  id: `out_${companyId}`,
  companyId,
  contactId: '',
  subject: 'Intro',
  bodyText: 'Hello',
  bodyHtml: '<pre>Hello</pre>',
  language: 'en',
  purpose: 'intro',
  status: 'draft',
  personalizationTags: [],
  validation: {
    wordCount: 1,
    maxWords: 200,
    bannedHits: [],
    hasUnsubscribe: true,
    hasSenderIdentity: true,
    hasPlaceholder: false,
    hasPersonalization: true,
    passed: true,
    issues: [],
  },
  createdAt: new Date().toISOString(),
  demo: true,
})

const companyWithStatus = (status: Company['status']): Company => ({
  ...buildDemoCompanies()[0],
  id: `c_${status}`,
  status,
})

describe('P0-3 · 草稿写入必须过状态机（退订终态不可逆）', () => {
  it('unsubscribed 客户不能被建草稿改回 drafted，且不写入队列、不留痕', () => {
    const c = companyWithStatus('unsubscribed')
    useAppStore.setState({ companies: [c], outreach: [] })

    const r = useAppStore.getState().addOutreach(draftFor(c.id))

    expect(r.ok).toBe(false)
    expect(r.message).toContain('不可逆')
    expect(useAppStore.getState().outreach).toHaveLength(0)
    expect(useAppStore.getState().companies[0].status).toBe('unsubscribed')
    expect(useAppStore.getState().companies[0].statusLog).toHaveLength(c.statusLog.length)
  })

  it('new 客户可正常建草稿，状态自动回写 drafted 并留下自动流转痕迹', () => {
    const c = companyWithStatus('new')
    useAppStore.setState({ companies: [c], outreach: [] })

    const r = useAppStore.getState().addOutreach(draftFor(c.id))

    expect(r.ok).toBe(true)
    expect(useAppStore.getState().outreach).toHaveLength(1)
    const updated = useAppStore.getState().companies[0]
    expect(updated.status).toBe('drafted')
    const last = updated.statusLog[updated.statusLog.length - 1]
    expect(last).toMatchObject({ from: 'new', to: 'drafted', automated: true })
  })

  it('客户不存在时明确拒绝，不产生孤儿草稿', () => {
    useAppStore.setState({ companies: [], outreach: [] })
    const r = useAppStore.getState().addOutreach(draftFor('missing'))
    expect(r.ok).toBe(false)
    expect(r.message).toContain('客户不存在')
    expect(useAppStore.getState().outreach).toHaveLength(0)
  })
})
