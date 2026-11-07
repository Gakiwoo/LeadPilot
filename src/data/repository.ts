/**
 * 仓储抽象：本地基线用 localStorage；Tauri 侧换成 SQLite 时只需实现同一接口。
 * PRD 第 10 章的 9 张表在此以聚合形式持久化，字段保持同构。
 */
import type { Company, DevTask, Outreach, Settings } from '@/types'

export interface PersistedState {
  version: 1
  companies: Company[]
  tasks: DevTask[]
  outreach: Outreach[]
  settings: Settings
}

export interface Repository {
  load(): PersistedState | null
  save(state: PersistedState): void
  clear(): void
}

const KEY = 'leadpilot.state.v1'

export const localRepository: Repository = {
  load() {
    if (typeof localStorage === 'undefined') return null
    try {
      const raw = localStorage.getItem(KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as PersistedState
      if (parsed.version !== 1 || !Array.isArray(parsed.companies)) return null
      return parsed
    } catch {
      return null
    }
  },
  save(state) {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(KEY, JSON.stringify(state))
    } catch {
      // 配额超限：降级为只保存用户操作产生的数据，不阻塞交互
      try {
        localStorage.setItem(KEY, JSON.stringify({
          ...state,
          companies: state.companies.map((c) => ({
            ...c, features: { ...c.features, sourceTexts: [], evidences: {} }, judgement: null,
          })),
        }))
      } catch { /* 静默失败，不伪造成功 */ }
    }
  },
  clear() {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY)
  },
}
