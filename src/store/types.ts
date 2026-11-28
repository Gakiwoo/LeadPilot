/**
 * P3-6 · store 的类型与公开契约（唯一出口）
 *
 * 拆分原则：**对外形状一个字都不改**。
 * `AppState` 仍是原来那个「数据字段 + 动作」的扁平对象，拆的只是实现文件。
 * 每个 slice 用 `Pick<AppState, ...>` 声明自己负责的那几项，编译器会兜住
 * 「某个动作在切片里忘了实现 / 实现了但没并回 AppState」这两类漏项。
 *
 * 为什么类型单独一个文件：slice 之间要互相调用（例如 `batchSetStatus` 调 `setCompanyStatus`），
 * 如果类型定义在 useAppStore.ts，slice 就要反向 import 入口，形成循环依赖。
 */
import type { StoreApi } from 'zustand'
import type {
  Company, CompanyStatus, DevTask, Outreach, Settings, StatusLogEntry, TaskConfig, TaskProgress,
} from '@/types'
import type { GatewayHealth } from '@/services/adapters'
import type { EmailTemplate, TemplateDraft } from '@/domain/email-template'

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

export type ToastTone = 'info' | 'warn' | 'error' | 'ok'

export interface Toast {
  id: number
  message: string
  tone: ToastTone
}

/** PRD 8.4：状态变更支持撤销，副作用一并快照（P1-12） */
export interface UndoEntry {
  companyId: string
  prevStatus: CompanyStatus
  prevStatusLog: StatusLogEntry[]
  prevBlacklist: string[]
  prevLastContactAt: string | null
}

export interface LastGatewayResult {
  companyId: string
  at: string
  provider?: string
  model?: string
  cached: boolean
  provenance: number
  points?: number
  degraded: boolean
  reason?: string
}

export interface AppState {
  companies: Company[]
  tasks: DevTask[]
  outreach: Outreach[]
  settings: Settings
  /** F11 模板库。内置模板常驻（不可删、不可覆盖），自建模板由用户维护 */
  templates: EmailTemplate[]
  activeView: ViewKey
  drawerCompanyId: string | null
  composerCompanyId: string | null
  activeTaskId: string | null
  runnerMode: 'local' | 'cloud'
  filters: Filters
  selectedIds: string[]
  toast: Toast | null
  gateway: GatewayHealth | null
  probing: boolean
  /** local-demo = 本地演示余额；server = 已与服务端账本对齐 */
  pointsSource: 'local-demo' | 'server'
  judgingCompanyId: string | null
  lastGatewayResult: LastGatewayResult | null
  undoStack: UndoEntry[]

  setActiveView(v: ViewKey): void
  openCompany(id: string | null): void
  openComposer(id: string | null): void
  setFilters(patch: Partial<Filters>): void
  toggleSelect(id: string, shift?: boolean): void
  selectAll(ids: string[]): void
  clearSelection(): void
  showToast(message: string, tone?: ToastTone): void
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
  /** F11：保存模板（无 id 新建 / 有 id 更新）。保存前必过 validateTemplate */
  saveTemplate(draft: TemplateDraft): { ok: boolean; message?: string; id?: string }
  deleteTemplate(id: string): { ok: boolean; message?: string }
  duplicateTemplate(id: string): { ok: boolean; message?: string; id?: string }
  updateSettings(patch: Partial<Settings>): void
  addBlacklist(value: string): void
  probeGateway(): Promise<void>
  /** 以服务端账本覆盖本地余额镜像（唯一权威） */
  syncPoints(): Promise<void>
  judgeWithGateway(companyId: string): Promise<void>
  undo(): void
  resetDemo(): void
}

/** slice 内部互相调用时用的 set / get，与 zustand 的 StoreApi 完全一致 */
export type StoreSet = StoreApi<AppState>['setState']
export type StoreGet = StoreApi<AppState>['getState']

/** 云端 SSE 事件的最小形状：type 用于分派，其余字段按事件类型取用 */
export interface CloudEvent {
  type: string
  [k: string]: unknown
}

export type TaskLogLine = TaskProgress['log'][number]
