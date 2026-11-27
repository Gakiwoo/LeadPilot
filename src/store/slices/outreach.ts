/**
 * slice · 本地草稿队列
 *
 * 建草稿是**自动流转**，必须过状态机白名单，否则会把已退订 / 无效的不可逆终态客户
 * 强行改回 drafted（P0-3）。同时 G2（黑名单 / 退订，全局无忽略开关）在入队这一步就硬拦，
 * 不能等到导出时才检查。
 */
import type { StateCreator } from 'zustand'
import type { Outreach } from '@/types'
import { checkSendGates } from '@/domain/compliance'
import { applyTransition, canTransition } from '@/domain/state-machine'
import type { AppState } from '../types'

export type OutreachSlice = Pick<AppState,
  | 'addOutreach' | 'updateOutreach'>

export const createOutreachSlice: StateCreator<AppState, [], [], OutreachSlice> = (set, get) => ({
  // 草稿队列的初始值由 demo-bootstrap 统一提供，slice 不造数据
  addOutreach: (o: Outreach) => {
    const company = get().companies.find((c) => c.id === o.companyId)
    if (!company) return { ok: false, message: '客户不存在，草稿未创建' }
    // P0-3：建草稿是自动流转，必须过状态机。直接 applyTransition 会绕开 canTransition 的
    // E3001，把已退订/无效的不可逆终态客户强行改回 drafted。
    const check = canTransition({ from: company.status, to: 'drafted', automated: true })
    if (!check.allowed) return { ok: false, message: check.message ?? '当前状态不允许创建草稿' }
    // P1-11：四道闸门必须接进动作链，不能只在检查器里展示。
    // 建草稿是入队动作，G2（黑名单/退订，全局无忽略开关）在此硬拦；
    // G1 的 C 级逐条确认在导出面板完成，G3/G4 由导出闸门按队列/熔断语义处理。
    const s0 = get()
    const contact = company.contacts.find((c) => c.id === o.contactId) ?? company.contacts[0]
    if (contact) {
      const gates = checkSendGates({
        contact, blacklist: s0.settings.blacklist,
        sentToday: s0.settings.gmail.sentToday, dailyLimit: s0.settings.gmail.dailyLimit,
        bounceRate: 0, consecutiveHardBounces: 0, singleConfirmed: true,
      })
      const g2 = gates.failed.filter((f) => f.gate === 'G2')
      if (g2.length) {
        return { ok: false, message: `四道闸门拦截：${g2.map((f) => `${f.gate} ${f.code} ${f.message}`).join('；')}（草稿未创建）` }
      }
    }
    set((s) => ({
      outreach: [o, ...s.outreach],
      companies: s.companies.map((c) => c.id === o.companyId
        ? applyTransition(c, 'drafted', { operator: '系统', automated: true, note: '本地草稿队列已创建（演示）' })
        : c),
    }))
    return { ok: true }
  },

  updateOutreach: (id: string, patch: Partial<Outreach>) => set((s) => ({
    outreach: s.outreach.map((o) => o.id === id ? { ...o, ...patch } : o),
  })),
})
