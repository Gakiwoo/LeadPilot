/**
 * P3-6 · 演示数据与初始 state 的引导逻辑
 *
 * 纪律（原样保留）：演示数据集只在非生产构建、或显式 `VITE_LEADPILOT_DEMO=1` 时加载。
 * 生产构建默认零演示客户 —— 演示数据一旦被当成真实线索，就是最严重的产品事故。
 */
import type { Company, DevTask } from '@/types'
import { buildDemoCompanies, DEMO_TASK_ID } from '@/data/demo-data'
import { localRepository } from '@/data/repository'
import { DEFAULT_SETTINGS } from './defaults'

export function demoTask(companies: Company[]): DevTask {
  return {
    id: DEMO_TASK_ID,
    name: '液压接头 · 德国+荷兰 · 进口商 · L2',
    status: 'done',
    config: {
      keywords: ['hydraulic fittings', 'brass fittings'], excludeKeywords: ['repair'],
      markets: ['德国', '荷兰'], customerTypes: ['importer', 'distributor'],
      depth: 2, targetCount: 48, sizeTiers: ['S', 'M', 'L', 'XL'],
      foundedYearsMin: 3, onlyVerifiedEmails: false, hsCode: '7307.19', name: '',
    },
    pointsEstimated: 96, pointsUsed: 96,
    createdAt: '2026-11-06T02:12:00.000Z',
    finishedAt: '2026-11-06T02:21:00.000Z',
    progress: {
      stage: '完成', stageIndex: 5, candidates: 386, stored: 48, qualified: 48, etaRange: [0, 0],
      sources: [
        { name: '搜索引擎（SerpAPI 兼容）', hits: 214, failures: 0, status: 'ok' },
        { name: '公开企业注册库', hits: 98, failures: 0, status: 'ok' },
        { name: '官网抓取器', hits: 61, failures: 0, status: 'ok' },
        { name: '邮箱发现', hits: 52, failures: 0, status: 'ok' },
        { name: '海关数据（授权）', hits: 11, failures: 0, status: 'warn', reason: '配额用尽 · 完整性约 78%' },
      ],
      log: [{ at: '10:21:00', level: 'warn', text: '演示模式：本任务使用本地预置数据，未发起任何真实采集或模型调用' }],
    },
    companyIds: companies.map((c) => c.id),
  }
}

const ENV = (import.meta as ImportMeta & { env?: Record<string, string> }).env ?? {}

export const DEMO_ENABLED = ENV.MODE !== 'production' || ENV.VITE_LEADPILOT_DEMO === '1'

export const persisted = localRepository.load()

export const initialCompanies: Company[] = persisted?.companies?.length
  ? persisted.companies
  : (DEMO_ENABLED ? buildDemoCompanies(48) : [])

export const initialTasks: DevTask[] = persisted?.tasks?.length
  ? persisted.tasks
  : (DEMO_ENABLED ? [demoTask(initialCompanies)] : [])

export const initialOutreach = persisted?.outreach ?? []

export const initialSettings = persisted?.settings ?? DEFAULT_SETTINGS
