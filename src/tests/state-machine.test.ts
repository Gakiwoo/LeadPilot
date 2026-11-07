import { describe, expect, it } from 'vitest'
import type { Company } from '@/types'
import { applyTransition, AUTO_EVENT, canTransition, suggestFollowup } from '@/domain/state-machine'

const company = (status: Company['status'] = 'new') => ({
  id: 'c1', status, statusLog: [], lastContactAt: null,
}) as unknown as Company

describe('PRD F8 · 12 态状态机', () => {
  it('自动流转仅限草稿 / 发送 / 退信 / 回复四种', () => {
    expect(canTransition({ from: 'new', to: 'drafted', automated: true }).allowed).toBe(true)
    expect(canTransition({ from: 'sent', to: 'bounced', automated: true }).allowed).toBe(true)
    const blocked = canTransition({ from: 'replied', to: 'interested', automated: true })
    expect(blocked.allowed).toBe(false)
    expect(blocked.code).toBe('E3004')
    expect(canTransition({ from: 'replied', to: 'interested', automated: false }).allowed).toBe(true)
    expect(Object.values(AUTO_EVENT)).toEqual(['drafted', 'sent', 'bounced', 'replied'])
  })

  it('退订/无效为不可逆终态，全局生效', () => {
    const r = canTransition({ from: 'unsubscribed', to: 'new', automated: false })
    expect(r.allowed).toBe(false)
    expect(r.code).toBe('E3001')
    expect(canTransition({ from: 'new', to: 'unsubscribed', automated: false }).needsConfirm).toBe(true)
  })

  it('批量流转到关键态需二次确认', () => {
    expect(canTransition({ from: 'sent', to: 'won', automated: false, batch: true }).needsConfirm).toBe(true)
    expect(canTransition({ from: 'sent', to: 'won', automated: false, batch: true, confirmed: true }).allowed).toBe(true)
  })

  it('每次变更留痕：时间 / from / to / 操作人 / 是否自动', () => {
    const next = applyTransition(company(), 'drafted', { operator: '系统', automated: true, note: '建草稿成功' })
    expect(next.status).toBe('drafted')
    expect(next.statusLog).toHaveLength(1)
    expect(next.statusLog[0]).toMatchObject({ from: 'new', to: 'drafted', operator: '系统', automated: true, note: '建草稿成功' })
    expect(next.statusLog[0].createdAt).toBeTruthy()
  })

  it('已发送 3 天无回复 → 建议二次触达', () => {
    const now = new Date('2026-11-06T10:00:00Z')
    const c = { ...company('sent'), lastContactAt: '2026-11-01T10:00:00Z' } as Company
    expect(suggestFollowup(c, now)?.content).toContain('二次触达')
    expect(suggestFollowup({ ...c, lastContactAt: '2026-11-05T10:00:00Z' }, now)).toBeNull()
  })
})
