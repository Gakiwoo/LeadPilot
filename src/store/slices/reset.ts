/**
 * slice · 演示数据重置
 *
 * 唯一一个会同时改动所有字段的动作，所以单独成片：它必须把「数据 + 会话句柄 + 本地存储」
 * 一起复位，否则会出现「界面回到演示态、但云端 SSE 还挂着上一个任务」这类幽灵状态。
 */
import type { StateCreator } from 'zustand'
import { localRepository } from '@/data/repository'
import { buildDemoCompanies } from '@/data/demo-data'
import { DEFAULT_FILTERS, DEFAULT_SETTINGS } from '../defaults'
import { demoTask } from '../demo-bootstrap'
import { resetTaskRuntime } from '../runtime'
import { builtinTemplates } from './templates'
import { builtinSequences } from './sequences'
import type { AppState } from '../types'

export type ResetSlice = Pick<AppState, 'resetDemo'>

export const createResetSlice: StateCreator<AppState, [], [], ResetSlice> = (set, get) => ({
  resetDemo: () => {
    resetTaskRuntime()
    localRepository.clear()
    const companies = buildDemoCompanies(48)
    set({
      companies, tasks: [demoTask(companies)], outreach: [], settings: DEFAULT_SETTINGS,
      // F11：模板库一并回到出厂集。重置的语义是「回到演示基线」，
      // 留着用户自建模板会让「重置后仍是旧样子」，与用户预期不符。
      templates: builtinTemplates(),
      // F11 同一条：序列也回到出厂集，避免「重置后还留着旧的跟进节奏」
      sequences: builtinSequences(),
      activeTaskId: null, drawerCompanyId: null, composerCompanyId: null, selectedIds: [],
      pointsSource: 'local-demo',
      filters: { ...DEFAULT_FILTERS },
    })
    get().showToast('演示数据已重置', 'ok')
  },
})
