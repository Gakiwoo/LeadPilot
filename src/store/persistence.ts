/**
 * P3-6 · 节流持久化
 *
 * 采集运行期每 ~420ms 就有一次状态变更，纯 debounce 在「变更间隔 < 400ms」时会被无限重置，
 * 永远不落盘（饿死）。所以这里是 debounce + 最长等待：最多推迟 SAVE_MAX_WAIT_MS 必须真写一次。
 *
 * 从 useAppStore.ts 搬出，逻辑与阈值一字未改；只把「订阅哪个 store」改成参数注入，
 * 避免 persistence ↔ useAppStore 互相 import。
 */
import type { StoreApi } from 'zustand'
import { localRepository } from '@/data/repository'
import type { AppState } from './types'

const SAVE_DEBOUNCE_MS = 400
const SAVE_MAX_WAIT_MS = 1500

let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingState: AppState | null = null
let lastFlushAt = 0

export function flushSave(): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  const state = pendingState
  pendingState = null
  if (!state) return
  lastFlushAt = Date.now()
  try {
    localRepository.save({
      version: 1,
      companies: state.companies,
      tasks: state.tasks,
      outreach: state.outreach,
      settings: state.settings,
    })
  } catch { /* 存储配额满或隐私模式：不因落盘失败打断交互 */ }
}

export function bindPersistence(store: StoreApi<AppState>): void {
  store.subscribe((state) => {
    pendingState = state
    if (Date.now() - lastFlushAt >= SAVE_MAX_WAIT_MS) { flushSave(); return }
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS)
  })

  // 关页/切后台时补一次落盘，避免最后一个 debounce 窗口内的改动丢失
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushSave)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushSave()
    })
  }
}
