import { create } from 'zustand'
import type {
  Company, CompanyStatus, DevTask, Outreach, Settings, StatusLogEntry, TaskConfig, TaskProgress, TaskStatus,
} from '@/types'
import { buildDemoCompanies, DEMO_TASK_ID } from '@/data/demo-data'
import { localRepository } from '@/data/repository'
import { DEPTH_CONFIG } from '@/domain/constants'
import { applyTransition, canTransition } from '@/domain/state-machine'
import { acceptModelJudgement } from '@/domain/llm-judgement'
import { buildScoreCard } from '@/domain/scoring'
import {
  createTaskRunner, type TaskRunner,
  probeGateway, judgeCompany, startCloudTask, controlCloudTask,
  type GatewayHealth,
} from '@/services/adapters'

export type ViewKey = 'developer' | 'crm' | 'outreach' | 'settings'
export type SortKey = 'default' | 'total' | 'propensity' | 'import' | 'name' | 'discovered'
export type QuickFilter = 'all' | 'high_match' | 'sendable' | 'with_customs' | 'uncontacted' | 'replied'

export interface Filters {
  quick: QuickFilter
  search: string
  sort: SortKey
  minScore: number
  hideCompetitors: boolean
  grade: 'ALL' | 'A' | 'B' | 'C' | 'D'
}

const DEFAULT_SETTINGS: Settings = {
  profile: {
    companyNameEn: 'Shenzhen Koude Precision Co., Ltd.',
    companyNameZh: '深圳寇德精密制品有限公司',
    address: 'Building 4, Longhua Industrial Park, Shenzhen, Guangdong, China',
    website: 'https://www.koude.example',
    mainProducts: 'hydraulic hose fittings, brass fittings, JIC adapters',
    advantages: ['15-day lead time on repeat SKUs', 'small-batch customization from 500 pcs'],
    certifications: 'ISO 9001:2015',
    moq: '500 pcs',
    leadTime: '15 days',
    caseStudies: 'Distributor in Rotterdam, 3 years, 12 containers/year',
    senderName: 'Jiaqi Wu',
    senderTitle: 'Export Manager',
    phone: '+86 138 0000 0000',
  },
  pointsBalance: 2000,
  plan: '专业版 · ¥199/月',
  llm: {
    t0: 'DeepSeek V4.1-Flash（谷时）', t1: 'DeepSeek V4-Pro（谷时）', t2: 'OpenAI GPT-5',
    byokEnabled: false, byokProvider: 'DeepSeek', regionPolicy: 'domestic_first',
  },
  gmail: { connected: false, email: '', scope: 'gmail.compose（MVP 仅草稿）', dailyLimit: 100, sentToday: 18, warmupDay: 7 },
  blacklist: ['blacklisted-company.example'],
  demoMode: true,
}

function demoTask(companies: Company[]): DevTask {
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

const persisted = localRepository.load()
const initialCompanies = persisted?.companies?.length ? persisted.companies : buildDemoCompanies(48)

interface AppState {
  companies: Company[]
  tasks: DevTask[]
  outreach: Outreach[]
  settings: Settings
  activeView: ViewKey
  drawerCompanyId: string | null
  composerCompanyId: string | null
  activeTaskId: string | null
  runnerMode: 'local' | 'cloud'
  filters: Filters
  selectedIds: string[]
  toast: { id: number; message: string; tone: 'info' | 'warn' | 'error' | 'ok' } | null
  gateway: GatewayHealth | null
  probing: boolean
  judgingCompanyId: string | null
  lastGatewayResult: {
    companyId: string; at: string; provider?: string; model?: string; cached: boolean
    provenance: number; points?: number; degraded: boolean; reason?: string
  } | null
  undoStack: { companyId: string; prevStatus: CompanyStatus; prevStatusLog: StatusLogEntry[] }[]

  setActiveView(v: ViewKey): void
  openCompany(id: string | null): void
  openComposer(id: string | null): void
  setFilters(patch: Partial<Filters>): void
  toggleSelect(id: string, shift?: boolean): void
  selectAll(ids: string[]): void
  clearSelection(): void
  showToast(message: string, tone?: 'info' | 'warn' | 'error' | 'ok'): void
  clearToast(): void

  startTask(config: TaskConfig): { ok: boolean; message?: string }
  setRunnerMode(mode: 'local' | 'cloud'): void
  pauseTask(): void
  resumeTask(): void
  abortTask(): void

  updateCompany(id: string, patch: Partial<Company>): void
  setCompanyStatus(id: string, to: CompanyStatus, opts?: { batch?: boolean; confirmed?: boolean; note?: string }): { ok: boolean; needsConfirm?: boolean; message?: string }
  batchSetStatus(ids: string[], to: CompanyStatus, confirmed?: boolean): { ok: boolean; needsConfirm?: boolean; message?: string }
  addOutreach(o: Outreach): { ok: boolean; message?: string }
  updateOutreach(id: string, patch: Partial<Outreach>): void
  updateSettings(patch: Partial<Settings>): void
  addBlacklist(value: string): void
  probeGateway(): Promise<void>
  judgeWithGateway(companyId: string): Promise<void>
  undo(): void
  resetDemo(): void
}

let runner: TaskRunner | null = null
let toastTimer: ReturnType<typeof setTimeout> | null = null
let cloudClose: (() => void) | null = null
let cloudTaskId: string | null = null
let cloudCursor: unknown = null

interface CloudEvent { type: string; [k: string]: unknown }

function logLine(text: string, level: 'info' | 'warn' | 'error' = 'info'): TaskProgress['log'][number] {
  return { at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level, text }
}

/**
 * 把云端 SSE 事件映射进本地任务进度。
 * 纪律：编排器数据源未接入 → 绝不往客户库写入任何「看起来像真公司」的记录，
 *      事件里的候选域名是占位标识，只在日志里说明。
 */
function applyCloudEvent(taskId: string, evt: CloudEvent): void {
  useAppStore.setState((s) => {
    const task = s.tasks.find((t) => t.id === taskId)
    if (!task) return s
    let progress = task.progress
    let status: TaskStatus = task.status
    let queuePosition = task.queuePosition ?? 0
    let maxConcurrent = task.maxConcurrent

    switch (evt.type) {
      case 'hello': {
        const snap = evt.snapshot as {
          status?: TaskStatus; progress?: TaskProgress; cursor?: unknown
          queuePosition?: number; maxConcurrent?: number
        } | undefined
        if (snap?.progress) {
          progress = {
            ...snap.progress,
            log: [...snap.progress.log, logLine('SSE 已连接：阶段/统计为云端真实推送；数据源适配器未接入，本任务不写入任何客户记录', 'warn')],
          }
        }
        cloudCursor = snap?.cursor ?? cloudCursor
        // v0.6.0：排队任务订阅 SSE 时不能把「排队中」硬写成「执行中」
        status = snap?.status ?? 'running'
        queuePosition = Number(snap?.queuePosition ?? 0)
        maxConcurrent = snap?.maxConcurrent ?? maxConcurrent
        if (status === 'queued') {
          progress = { ...progress, log: [...progress.log, logLine(`并发槽位已满，任务位于队列第 ${queuePosition} 位；槽位释放后自动启动`, 'warn')] }
        }
        break
      }
      case 'stage':
        progress = { ...progress, stage: String(evt.stage ?? progress.stage), stageIndex: Number(evt.stageIndex ?? progress.stageIndex) }
        break
      case 'progress': {
        const incoming = evt.progress as TaskProgress | undefined
        if (incoming) progress = { ...progress, ...incoming }
        cloudCursor = evt.cursor ?? cloudCursor
        break
      }
      case 'source_warning': {
        const src = evt.source as { name?: string; reason?: string } | undefined
        progress = {
          ...progress,
          sources: progress.sources.map((x) => x.name === src?.name
            ? { ...x, status: 'warn' as const, failures: 1, reason: src.reason }
            : x),
          log: [...progress.log, logLine(`单源降级：${src?.name ?? '未知源'} · 完整性约 ${Math.round(Number(evt.completeness ?? 0) * 100)}%`, 'warn')],
        }
        break
      }
      case 'queued':
        status = 'queued'
        queuePosition = Number(evt.position ?? 1)
        maxConcurrent = Number(evt.maxConcurrent ?? maxConcurrent)
        progress = { ...progress, log: [...progress.log, logLine(`任务排队中：第 ${queuePosition} 位 / 并发上限 ${maxConcurrent ?? '—'}；槽位释放后自动启动，无需重复点击继续`, 'warn')] }
        break
      case 'started':
        status = 'running'
        queuePosition = 0
        maxConcurrent = Number(evt.maxConcurrent ?? maxConcurrent)
        progress = evt.dequeued
          ? { ...progress, log: [...progress.log, logLine('已从并发队列出队并按 FIFO 自动启动；排队时长不计入硬超时，点数不重复预扣')] }
          : progress
        break
      case 'paused':
        status = 'paused'
        queuePosition = 0
        cloudCursor = evt.cursor ?? cloudCursor
        progress = { ...progress, log: [...progress.log, logLine('云端任务已暂停，游标已持久化；释放的并发槽位由队首任务接替', 'warn')] }
        break
      case 'resumed':
        status = 'running'
        queuePosition = 0
        progress = { ...progress, log: [...progress.log, logLine('云端任务从持久化游标继续，额度不重复扣减')] }
        break
      case 'done':
        status = 'done'
        queuePosition = 0
        progress = { ...progress, stage: '完成', etaRange: [0, 0], log: [...progress.log, logLine('云端编排完成（演示编排，不产生真实客户记录）')] }
        break
      case 'aborted':
        status = 'aborted'
        queuePosition = 0
        progress = { ...progress, etaRange: [0, 0], log: [...progress.log, logLine('云端任务已中止；已采集结果全部保留，游标可断点续跑', 'warn')] }
        break
      case 'error':
        progress = { ...progress, log: [...progress.log, logLine(`SSE 中断：${String(evt.reason ?? '连接异常')}`, 'error')] }
        break
      default: break
    }

    progress = { ...progress, log: progress.log.slice(-80) }
    const terminal = ['done', 'aborted', 'failed'].includes(status)
    return {
      tasks: s.tasks.map((t) => t.id === taskId ? { ...t, status, progress, queuePosition, maxConcurrent } : t),
      activeTaskId: terminal && s.activeTaskId === taskId ? null : s.activeTaskId,
    }
  })
}

export const useAppStore = create<AppState>((set, get) => ({
  companies: initialCompanies,
  tasks: persisted?.tasks?.length ? persisted.tasks : [demoTask(initialCompanies)],
  outreach: persisted?.outreach ?? [],
  settings: persisted?.settings ?? DEFAULT_SETTINGS,
  activeView: 'developer',
  drawerCompanyId: null,
  composerCompanyId: null,
  activeTaskId: null,
  runnerMode: 'local',
  filters: { quick: 'all', search: '', sort: 'default', minScore: 0, hideCompetitors: true, grade: 'ALL' },
  selectedIds: [],
  toast: null,
  gateway: null,
  probing: false,
  judgingCompanyId: null,
  lastGatewayResult: null,
  undoStack: [],

  setActiveView: (activeView) => set({ activeView, selectedIds: [] }),
  openCompany: (drawerCompanyId) => set({ drawerCompanyId }),
  openComposer: (composerCompanyId) => set({ composerCompanyId }),
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  toggleSelect: (id, shift) => set((s) => {
    if (shift && s.selectedIds.length) return { selectedIds: Array.from(new Set([...s.selectedIds, id])) }
    return { selectedIds: s.selectedIds.includes(id) ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id] }
  }),
  selectAll: (ids) => set({ selectedIds: ids }),
  clearSelection: () => set({ selectedIds: [] }),
  showToast: (message, tone = 'info') => {
    const id = Date.now()
    set({ toast: { id, message, tone } })
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      if (get().toast?.id === id) set({ toast: null })
    }, 4200)
  },
  clearToast: () => set({ toast: null }),

  startTask: (config) => {
    const state = get()
    const cost = config.targetCount * DEPTH_CONFIG[config.depth].pointsPerCompany
    if (cost > state.settings.pointsBalance) {
      return { ok: false, message: `E4001 点数不足：本次预计消耗 ${cost} 点，剩余 ${state.settings.pointsBalance} 点。请降配或充值。` }
    }
    if (state.tasks.some((t) => t.status === 'running')) {
      return { ok: false, message: '当前已有运行中的任务，单机最多同时运行 3 个任务（演示限制为 1 个）' }
    }
    if (config.keywords.length === 0 || config.markets.length === 0) {
      return { ok: false, message: '关键词与目标市场为必填项（PRD F1-2：默认不选任何市场，强制用户表达明确意图）' }
    }

    runner?.dispose()
    cloudClose?.()
    cloudClose = null
    cloudTaskId = null
    cloudCursor = null
    const id = `task_${Date.now()}`
    const mode = state.runnerMode
    const task: DevTask = {
      id, mode,
      name: config.name || `${config.keywords[0]} · ${config.markets.join('+')} · ${DEPTH_CONFIG[config.depth].label}`,
      status: 'running', config,
      pointsEstimated: cost, pointsUsed: 0,
      createdAt: new Date().toISOString(),
      progress: {
        stage: '检索候选', stageIndex: 0, candidates: 0, stored: 0, qualified: 0, etaRange: [4, 8],
        sources: ([
          { name: '搜索引擎（SerpAPI 兼容）', hits: 0, failures: 0, status: 'ok' },
          { name: '公开企业注册库', hits: 0, failures: 0, status: 'ok' },
          { name: '官网抓取器', hits: 0, failures: 0, status: 'ok' },
          { name: '邮箱发现', hits: 0, failures: 0, status: 'ok' },
          { name: '海关数据（授权）', hits: 0, failures: 0, status: 'ok' },
        ] as TaskProgress['sources']).slice(0, DEPTH_CONFIG[config.depth].sources),
        log: [],
      },
      companyIds: [],
    }
    const existingDomains = new Set(state.companies.map((c) => c.domain))
    const pool = buildDemoCompanies(120).filter((c) => !existingDomains.has(c.domain))

    set((s) => ({
      tasks: [task, ...s.tasks],
      activeTaskId: id,
      settings: { ...s.settings, pointsBalance: s.settings.pointsBalance - cost },
      filters: { ...s.filters, quick: 'all', search: '' },
    }))

    if (mode === 'cloud') {
      void startCloudTask(config, (evt) => applyCloudEvent(id, evt)).then((res) => {
        if (!res.ok || !res.taskId) {
          // 不静默失败：任务标 failed、退还预扣点数、日志留痕
          useAppStore.setState((s) => ({
            tasks: s.tasks.map((t) => t.id === id ? {
              ...t, status: 'failed', finishedAt: new Date().toISOString(),
              progress: { ...t.progress, log: [...t.progress.log, logLine(`云端任务创建失败：${res.reason ?? '服务不可达'} · 已退还预扣 ${cost} 点`, 'error')] },
            } : t),
            activeTaskId: null,
            settings: { ...s.settings, pointsBalance: s.settings.pointsBalance + cost },
          }))
          useAppStore.getState().showToast(`云端编排器不可用：${res.reason ?? '服务未启动'}，已退还点数`, 'error')
          return
        }
        cloudTaskId = res.taskId
        cloudClose = res.close
      })
      return { ok: true, message: '云端编排任务已提交 · SSE 流式推送中（数据源未接入，不产生客户记录）' }
    }

    runner = createTaskRunner(
      { ...task },
      pool,
      {
        onProgress(progress: TaskProgress, batch: Company[]) {
          set((s) => {
            const newOnes = batch.map((c) => ({ ...c, sourceTaskId: id }))
            return {
              companies: newOnes.length ? [...newOnes, ...s.companies] : s.companies,
              tasks: s.tasks.map((t) => t.id === id ? {
                ...t,
                progress,
                companyIds: newOnes.length ? [...t.companyIds, ...newOnes.map((c) => c.id)] : t.companyIds,
              } : t),
            }
          })
        },
        onDone() {
          set((s) => ({
            tasks: s.tasks.map((t) => t.id === id ? {
              ...t, status: 'done' as const, finishedAt: new Date().toISOString(), pointsUsed: t.pointsEstimated,
            } : t),
            activeTaskId: null,
          }))
          get().showToast('演示任务完成：结果为本地预置数据，未发起真实采集', 'ok')
        },
      },
    )
    return { ok: true, message: `任务已启动 · 预扣 ${cost} 点` }
  },
  setRunnerMode: (runnerMode) => set({ runnerMode }),
  pauseTask: () => {
    if (get().runnerMode === 'cloud') {
      if (!cloudTaskId) return
      void controlCloudTask(cloudTaskId, 'pause').then((r) => {
        if (!r.ok) { get().showToast('云端暂停失败：任务状态不允许该操作', 'warn'); return }
        const status: TaskStatus = r.task?.status ?? 'paused'
        set((s) => ({ tasks: s.tasks.map((t) => t.status === 'running'
          ? { ...t, status, queuePosition: r.task?.queuePosition ?? 0 } : t) }))
      })
      return
    }
    runner?.pause()
    set((s) => ({ tasks: s.tasks.map((t) => t.status === 'running' ? { ...t, status: 'paused' } : t) }))
  },
  resumeTask: () => {
    if (get().runnerMode === 'cloud') {
      if (!cloudTaskId) return
      void controlCloudTask(cloudTaskId, 'resume', cloudCursor).then((r) => {
        if (!r.ok) { get().showToast('云端续跑失败：任务已完成或不存在', 'warn'); return }
        // 服务端权威状态：并发已满时任务仍是 queued，绝不乐观标成 running
        const status: TaskStatus = r.task?.status ?? 'running'
        set((s) => ({ tasks: s.tasks.map((t) => t.status === 'paused' || t.status === 'queued'
          ? { ...t, status, queuePosition: r.task?.queuePosition ?? 0, maxConcurrent: r.task?.maxConcurrent ?? t.maxConcurrent }
          : t) }))
        if (status === 'queued') get().showToast('并发槽位已满，任务仍在队列中；槽位释放后会自动启动', 'warn')
      })
      return
    }
    runner?.resume()
    set((s) => ({ tasks: s.tasks.map((t) => t.status === 'paused' ? { ...t, status: 'running' } : t) }))
  },
  abortTask: () => {
    if (get().runnerMode === 'cloud' && cloudTaskId) {
      void controlCloudTask(cloudTaskId, 'abort').then((r) => {
        if (!r.ok) return
        const status: TaskStatus = r.task?.status ?? 'aborted'
        set((s) => ({ tasks: s.tasks.map((t) => t.mode === 'cloud' && !['done', 'aborted', 'failed'].includes(t.status)
          ? { ...t, status, queuePosition: 0 } : t) }))
      })
    }
    cloudClose?.()
    cloudClose = null
    cloudTaskId = null
    runner?.abort()
    runner = null
    set((s) => ({
      tasks: s.tasks.map((t) => t.status === 'running' || t.status === 'paused' ? {
        ...t, status: 'aborted', finishedAt: new Date().toISOString(),
        progress: { ...t.progress, log: [...t.progress.log, { at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level: 'warn', text: '用户中止：已采集结果全部保留' }] },
      } : t),
      activeTaskId: null,
    }))
  },

  updateCompany: (id, patch) => set((s) => ({
    companies: s.companies.map((c) => c.id === id ? { ...c, ...patch } : c),
  })),

  setCompanyStatus: (id, to, opts) => {
    const company = get().companies.find((c) => c.id === id)
    if (!company) return { ok: false, message: '客户不存在' }
    const check = canTransition({ from: company.status, to, automated: false, batch: opts?.batch, confirmed: opts?.confirmed })
    if (!check.allowed) return { ok: false, message: check.message }
    if (check.needsConfirm) return { ok: false, needsConfirm: true, message: check.message }
    const updated = applyTransition(company, to, { operator: '本地用户', note: opts?.note })
    set((s) => ({
      companies: s.companies.map((c) => c.id === id ? updated : c),
      // PRD 8.4：状态变更支持 Ctrl+Z，保留 5 步
      undoStack: [...s.undoStack.slice(-4), {
        companyId: id, prevStatus: company.status, prevStatusLog: company.statusLog,
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

  addOutreach: (o) => {
    const company = get().companies.find((c) => c.id === o.companyId)
    if (!company) return { ok: false, message: '客户不存在，草稿未创建' }
    // P0-3：建草稿是自动流转，必须过状态机。此前直接 applyTransition 会绕开
    // canTransition 的 E3001，把已退订/无效的不可逆终态客户强行改回 drafted。
    const check = canTransition({ from: company.status, to: 'drafted', automated: true })
    if (!check.allowed) return { ok: false, message: check.message ?? '当前状态不允许创建草稿' }
    set((s) => ({
      outreach: [o, ...s.outreach],
      companies: s.companies.map((c) => c.id === o.companyId
        ? applyTransition(c, 'drafted', { operator: '系统', automated: true, note: '本地草稿队列已创建（演示）' })
        : c),
    }))
    return { ok: true }
  },
  updateOutreach: (id, patch) => set((s) => ({ outreach: s.outreach.map((o) => o.id === id ? { ...o, ...patch } : o) })),
  updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  addBlacklist: (value) => set((s) => ({ settings: { ...s.settings, blacklist: Array.from(new Set([...s.settings.blacklist, value])) } })),

  probeGateway: async () => {
    if (get().probing) return
    set({ probing: true })
    const health = await probeGateway()
    set({ gateway: health, probing: false })
  },

  /** 用云端网关重新判断一家客户：结果无论成功或降级都要显式落到评分卡上 */
  judgeWithGateway: async (companyId) => {
    const company = get().companies.find((c) => c.id === companyId)
    if (!company) return
    set({ judgingCompanyId: companyId })
    const f = company.features
    // 与服务端 11.4 数据最小化一致：只传判断所需的事实，绝不传邮箱/电话/联系人
    const facts = {
      keywordHits: f.keywordHits,
      categoryDistance: f.categoryDistance,
      semanticSimilarity: f.semanticSimilarity,
      importBatches24m: f.importBatches24m,
      customsRecords: f.customsRecords,
      customsDataAvailable: f.customsDataAvailable,
      distributedBrands: f.distributedBrands,
      tradeTermHits: f.tradeTermHits,
      employeeCount: f.employeeCount,
      marketMatch: f.marketMatch,
      importWording: f.importWording,
    }
    const result = await judgeCompany({
      companyId, domain: company.domain, country: company.country,
      sourceTexts: f.sourceTexts, facts,
      depth: 2,
      regionPolicy: get().settings.llm.regionPolicy,
    })
    const at = new Date().toISOString()

    if (result.ok && result.clientJudgement) {
      // 客户端不信任服务端结论，再跑一次 schema + 证据校验
      const accepted = acceptModelJudgement(result.clientJudgement, f.sourceTexts)
      const card = buildScoreCard(f, accepted.judgement, { modelAvailable: Boolean(accepted.judgement) })
      set((s) => ({
        companies: s.companies.map((c) => c.id === companyId ? { ...c, scoreCard: card } : c),
        judgingCompanyId: null,
        lastGatewayResult: {
          companyId, at, provider: result.audit?.providerKey, model: result.audit?.model,
          cached: Boolean(result.cached), provenance: result.provenanceRate ?? 0,
          points: result.audit?.points, degraded: !accepted.judgement,
          reason: accepted.errorCodes.length ? accepted.reason : undefined,
        },
      }))
      get().showToast(
        accepted.judgement
          ? `云端判断完成：${result.audit?.model ?? '网关'} · 可溯源率 ${((result.provenanceRate ?? 0) * 100).toFixed(0)}%${result.cached ? ' · 命中 30 天缓存' : ` · 消耗 ${result.audit?.points ?? 0} 点`}`
          : '云端返回未通过客户端二次校验，已回退规则估算并降低置信度',
        accepted.judgement ? 'ok' : 'warn',
      )
    } else {
      // E6005：不静默回退，分数变区间、置信度标低、界面标注未经模型校验
      const card = buildScoreCard(f, null, { modelAvailable: false })
      set((s) => ({
        companies: s.companies.map((c) => c.id === companyId ? { ...c, scoreCard: card } : c),
        judgingCompanyId: null,
        lastGatewayResult: {
          companyId, at, cached: false, provenance: 0, degraded: true,
          reason: result.reason ?? '网关不可用',
        },
      }))
      get().showToast(`${result.reason ?? '网关不可用'} · 该客户分数已改为区间显示`, 'warn')
    }
  },

  undo: () => {
    const stack = get().undoStack
    const last = stack[stack.length - 1]
    if (!last) { get().showToast('没有可撤销的状态变更', 'info'); return }
    set((s) => ({
      companies: s.companies.map((c) => c.id === last.companyId
        ? { ...c, status: last.prevStatus, statusLog: last.prevStatusLog } : c),
      undoStack: s.undoStack.slice(0, -1),
    }))
    get().showToast('已撤销上一次状态变更', 'ok')
  },

  resetDemo: () => {
    runner?.dispose()
    runner = null
    cloudClose?.()
    cloudClose = null
    cloudTaskId = null
    cloudCursor = null
    localRepository.clear()
    const companies = buildDemoCompanies(48)
    set({
      companies, tasks: [demoTask(companies)], outreach: [], settings: DEFAULT_SETTINGS,
      activeTaskId: null, drawerCompanyId: null, composerCompanyId: null, selectedIds: [],
      filters: { quick: 'all', search: '', sort: 'default', minScore: 0, hideCompetitors: true, grade: 'ALL' },
    })
    get().showToast('演示数据已重置', 'ok')
  },
}))

// 采集运行期每 ~420ms 就有一次状态变更，节流持久化避免阻塞 UI
let saveTimer: ReturnType<typeof setTimeout> | null = null
useAppStore.subscribe((state) => {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    localRepository.save({
      version: 1,
      companies: state.companies,
      tasks: state.tasks,
      outreach: state.outreach,
      settings: state.settings,
    })
  }, 400)
})
