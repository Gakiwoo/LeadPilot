/**
 * slice · 视图 / 抽屉 / 筛选 / 选中 / Toast
 *
 * 全部是纯 UI 态，不碰任务、不碰网络。`showToast` 是唯一带副作用的（定时器），
 * 句柄放 runtime 而不是 state，避免把 Timer 当成数据持久化。
 */
import type { StateCreator } from 'zustand'
import { runtime } from '../runtime'
import type { AppState, Filters, ToastTone, ViewKey } from '../types'

/** Toast 停留时长：4.2s 是既有行为，特征测试锁死（改它会让测试变红，属于有意变更） */
const TOAST_DURATION_MS = 4200

export type UiSlice = Pick<AppState,
  | 'activeView' | 'drawerCompanyId' | 'composerCompanyId' | 'filters' | 'selectedIds' | 'toast'
  | 'setActiveView' | 'openCompany' | 'openComposer' | 'setFilters'
  | 'toggleSelect' | 'selectAll' | 'clearSelection' | 'showToast' | 'clearToast'>

export const createUiSlice: StateCreator<AppState, [], [], UiSlice> = (set, get) => ({
  activeView: 'developer',
  drawerCompanyId: null,
  composerCompanyId: null,
  filters: { quick: 'all', search: '', sort: 'default', minScore: 0, hideCompetitors: true, grade: 'ALL' },
  selectedIds: [],
  toast: null,

  // 切视图必须清空选中：否则跨页残留的选中态会被另一个页面的批量操作误用
  setActiveView: (activeView: ViewKey) => set({ activeView, selectedIds: [] }),
  openCompany: (drawerCompanyId) => set({ drawerCompanyId }),
  openComposer: (composerCompanyId) => set({ composerCompanyId }),
  setFilters: (patch: Partial<Filters>) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  toggleSelect: (id, shift) => set((s) => {
    if (shift && s.selectedIds.length) return { selectedIds: Array.from(new Set([...s.selectedIds, id])) }
    return { selectedIds: s.selectedIds.includes(id) ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id] }
  }),
  selectAll: (ids) => set({ selectedIds: ids }),
  clearSelection: () => set({ selectedIds: [] }),

  showToast: (message, tone: ToastTone = 'info') => {
    const id = Date.now()
    set({ toast: { id, message, tone } })
    if (runtime.toastTimer) clearTimeout(runtime.toastTimer)
    runtime.toastTimer = setTimeout(() => {
      // 只清自己那条：后来写入的提示不能被上一条的定时器误清
      if (get().toast?.id === id) set({ toast: null })
    }, TOAST_DURATION_MS)
  },
  clearToast: () => set({ toast: null }),
})
