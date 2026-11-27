/**
 * slice · 客户状态与撤销
 *
 * 红线都在这里落地：终态（退订 / 无效）不可逆、退订写全局黑名单、撤销必须把
 * 状态变更的**副作用**一起回滚（P1-12：否则「撤销退订」后黑名单还留着该客户）。
 */
import type { StateCreator } from 'zustand'
import type { Company, CompanyStatus } from '@/types'
import { applyTransition, canTransition } from '@/domain/state-machine'
import type { AppState } from '../types'

/** PRD 8.4：撤销栈保留最近 5 步（含当前这一步） */
const UNDO_STACK_LIMIT = 5

export type CompanySlice = Pick<AppState,
  | 'undoStack'
  | 'updateCompany' | 'setCompanyStatus' | 'batchSetStatus' | 'undo'>

export const createCompanySlice: StateCreator<AppState, [], [], CompanySlice> = (set, get) => ({
  // 客户列表的初始值由 demo-bootstrap 统一提供，slice 不造数据
  undoStack: [],

  updateCompany: (id: string, patch: Partial<Company>) => set((s) => ({
    companies: s.companies.map((c) => c.id === id ? { ...c, ...patch } : c),
  })),

  setCompanyStatus: (id, to: CompanyStatus, opts) => {
    const company = get().companies.find((c) => c.id === id)
    if (!company) return { ok: false, message: '客户不存在' }
    const check = canTransition({ from: company.status, to, automated: false, batch: opts?.batch, confirmed: opts?.confirmed })
    if (!check.allowed) return { ok: false, message: check.message }
    if (check.needsConfirm) return { ok: false, needsConfirm: true, message: check.message }
    const updated = applyTransition(company, to, { operator: '本地用户', note: opts?.note })
    set((s) => ({
      companies: s.companies.map((c) => c.id === id ? updated : c),
      // PRD 8.4：状态变更支持 Ctrl+Z，保留 5 步
      // P1-12：把状态变更带来的副作用一并快照，撤销时才能完整回滚，
      // 否则「撤销退订」后黑名单仍留着该客户、lastContactAt 也自相矛盾。
      undoStack: [...s.undoStack.slice(-(UNDO_STACK_LIMIT - 1)), {
        companyId: id, prevStatus: company.status, prevStatusLog: company.statusLog,
        prevBlacklist: s.settings.blacklist, prevLastContactAt: company.lastContactAt,
      }],
      settings: to === 'unsubscribed' ? {
        ...s.settings,
        blacklist: Array.from(new Set([...s.settings.blacklist, ...company.contacts.map((ct) => ct.value)])),
      } : s.settings,
    }))
    return { ok: true }
  },

  batchSetStatus: (ids, to, confirmed) => {
    const check = canTransition({ from: 'new', to, automated: false, batch: true, confirmed })
    if (check.needsConfirm) return { ok: false, needsConfirm: true, message: check.message }
    let changed = 0
    for (const id of ids) {
      const r = get().setCompanyStatus(id, to, { batch: true, confirmed: true })
      if (r.ok) changed += 1
    }
    get().showToast(`已批量更新 ${changed} 家客户状态`, 'ok')
    return { ok: true }
  },

  undo: () => {
    const stack = get().undoStack
    const last = stack[stack.length - 1]
    if (!last) { get().showToast('没有可撤销的状态变更', 'info'); return }
    set((s) => ({
      companies: s.companies.map((c) => c.id === last.companyId
        ? { ...c, status: last.prevStatus, statusLog: last.prevStatusLog, lastContactAt: last.prevLastContactAt } : c),
      settings: { ...s.settings, blacklist: last.prevBlacklist },
      undoStack: s.undoStack.slice(0, -1),
    }))
    get().showToast('已撤销上一次状态变更', 'ok')
  },
})
