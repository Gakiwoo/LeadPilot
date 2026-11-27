/**
 * slice · 设置与点数镜像
 *
 * 余额的唯一权威是服务端账本，本地 `pointsBalance` 只是展示镜像：
 * 离线 / 未启动云端时保持原值并保留 `pointsSource='local-demo'`，**不假装已同步**。
 */
import type { StateCreator } from 'zustand'
import type { Settings } from '@/types'
import { getPointsSnapshot } from '@/services/adapters'
import type { AppState } from '../types'

export type SettingsSlice = Pick<AppState,
  | 'pointsSource'
  | 'updateSettings' | 'addBlacklist' | 'syncPoints'>

export const createSettingsSlice: StateCreator<AppState, [], [], SettingsSlice> = (set) => ({
  // settings 的初始值由 demo-bootstrap 统一提供（持久化恢复或 DEFAULT_SETTINGS），slice 不造数据
  pointsSource: 'local-demo',

  updateSettings: (patch: Partial<Settings>) => set((s) => ({ settings: { ...s.settings, ...patch } })),

  addBlacklist: (value: string) => set((s) => ({
    settings: { ...s.settings, blacklist: Array.from(new Set([...s.settings.blacklist, value])) },
  })),

  syncPoints: async () => {
    const snap = await getPointsSnapshot()
    // `!snap.ok` 是有意防御：服务端可能返回 ok:false 却带着 available（如 409 幂等冲突），
    // 那种响应同样不能拿来覆盖镜像余额。特征测试覆盖不到这条分支（离线桩不带 available），
    // 但它不是死代码，别删。
    if (!snap.ok || typeof snap.available !== 'number') return
    const available = snap.available
    set((s) => ({ settings: { ...s.settings, pointsBalance: available }, pointsSource: 'server' }))
  },
})
