/**
 * slice · 采集任务的启动 / 暂停 / 继续 / 中止
 *
 * 这里是全 store 唯一会「花钱」的地方，所以两条纪律单独强调：
 *  1. 预扣 = 目标数 × 深度单价，前置校验不过就**不建任务也不扣点**；
 *  2. 只有「服务端根本没产生任务」才退还本地镜像余额。任务已创建、只是 SSE 没连上时，
 *     绝不回退点数 —— 钱的事以服务端账本为准，前端不做二次裁决。
 */
import type { StateCreator } from 'zustand'
import type { Company, DevTask, TaskConfig, TaskProgress, TaskStatus } from '@/types'
import { DEPTH_CONFIG } from '@/domain/constants'
import { dedupeByFingerprint, fingerprintKeys } from '@/domain/dedupe'
import { buildDemoCompanies } from '@/data/demo-data'
import {
  controlCloudTask, createTaskRunner, startCloudTask,
} from '@/services/adapters'
import { createCloudEventHandler, logLine } from '../cloud-events'
import { DEMO_ENABLED } from '../demo-bootstrap'
import { runtime } from '../runtime'
import type { AppState } from '../types'

export type TaskSlice = Pick<AppState,
  | 'activeTaskId' | 'runnerMode'
  | 'startTask' | 'setRunnerMode' | 'pauseTask' | 'resumeTask' | 'abortTask'>

const EMPTY_SOURCES: TaskProgress['sources'] = [
  { name: '搜索引擎（SerpAPI 兼容）', hits: 0, failures: 0, status: 'ok' },
  { name: '公开企业注册库', hits: 0, failures: 0, status: 'ok' },
  { name: '官网抓取器', hits: 0, failures: 0, status: 'ok' },
  { name: '邮箱发现', hits: 0, failures: 0, status: 'ok' },
  { name: '海关数据（授权）', hits: 0, failures: 0, status: 'ok' },
]

export const createTaskSlice: StateCreator<AppState, [], [], TaskSlice> = (set, get) => {
  const applyCloudEvent = createCloudEventHandler(set, get)

  return {
    // 任务列表的初始值由 demo-bootstrap 统一提供（演示任务或持久化恢复），slice 不造数据
    activeTaskId: null,
    runnerMode: 'local',

    startTask: (config: TaskConfig) => {
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

      runtime.runner?.dispose()
      runtime.cloudClose?.()
      runtime.cloudClose = null
      runtime.cloudTaskId = null
      runtime.cloudCursor = null
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
          sources: EMPTY_SOURCES.slice(0, DEPTH_CONFIG[config.depth].sources),
          log: [],
        },
        companyIds: [],
      }

      // AC-05：任务出库同样按三重指纹走 —— 先算库内已有指纹，再对本批候选做同期去重。
      // 只按域名过滤会漏掉「同一家公司换了国别后缀 / 经销域名又出现」的重复线索。
      const knownKeys = new Set(state.companies.flatMap((c) => fingerprintKeys(c)))
      const candidates = DEMO_ENABLED ? buildDemoCompanies(120) : []
      const { unique, duplicates } = dedupeByFingerprint(candidates, (c) => c)
      const pool = unique.filter((c) => !fingerprintKeys(c).some((k) => knownKeys.has(k)))
      const existingSkipped = unique.length - pool.length
      const skipped = candidates.length - pool.length
      if (skipped > 0) {
        task.progress.log.push(logLine(
          `三重指纹去重：候选 ${candidates.length} 家 → 跳过 ${skipped} 家（库内已存在 ${existingSkipped} 家 / 本批内重复 ${duplicates.length} 家），实际可入库候选 ${pool.length} 家`,
        ))
      }

      set((s) => ({
        tasks: [task, ...s.tasks],
        activeTaskId: id,
        settings: { ...s.settings, pointsBalance: s.settings.pointsBalance - cost },
        filters: { ...s.filters, quick: 'all', search: '' },
      }))

      if (mode === 'cloud') {
        void startCloudTask(config, (evt) => applyCloudEvent(id, evt)).then((res) => {
          if (res.taskId) {
            // 任务已在服务端创建（账本已预扣），后续一切以服务端状态为准
            runtime.cloudTaskId = res.taskId
            runtime.cloudClose = res.close
          }
          if (!res.taskId) {
            // 仅「服务端没有产生任务」时才退还本地镜像余额
            set((s) => ({
              tasks: s.tasks.map((t) => t.id === id ? {
                ...t, status: 'failed', finishedAt: new Date().toISOString(),
                progress: { ...t.progress, log: [...t.progress.log, logLine(`云端任务创建失败：${res.reason ?? '服务不可达'} · 已退还预扣 ${cost} 点`, 'error')] },
              } : t),
              activeTaskId: null,
              settings: { ...s.settings, pointsBalance: s.settings.pointsBalance + cost },
            }))
            get().showToast(`云端编排器不可用：${res.reason ?? '服务未启动'}，已退还点数`, 'error')
            return
          }
          if (!res.ok) {
            // 任务已创建、点数已预扣，只是实时推送没连上：绝不回退点数，也不把任务标成失败
            set((s) => ({
              tasks: s.tasks.map((t) => t.id === id ? {
                ...t,
                progress: { ...t.progress, log: [...t.progress.log, logLine(`任务已在云端创建，但 SSE 订阅失败：${res.reason ?? '连接异常'}；服务端仍在执行，可稍后刷新任务状态`, 'warn')] },
              } : t),
            }))
            get().showToast('任务已在云端创建，但实时推送未连上；点数以服务端账本为准', 'warn')
          }
          void get().syncPoints()
        })
        return { ok: true, message: '云端编排任务已提交 · SSE 流式推送中（数据源未接入，不产生客户记录）' }
      }

      runtime.runner = createTaskRunner(
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
        if (!runtime.cloudTaskId) return
        void controlCloudTask(runtime.cloudTaskId, 'pause').then((r) => {
          if (!r.ok) { get().showToast('云端暂停失败：任务状态不允许该操作', 'warn'); return }
          const status: TaskStatus = r.task?.status ?? 'paused'
          set((s) => ({ tasks: s.tasks.map((t) => t.status === 'running'
            ? { ...t, status, queuePosition: r.task?.queuePosition ?? 0 } : t) }))
        })
        return
      }
      runtime.runner?.pause()
      set((s) => ({ tasks: s.tasks.map((t) => t.status === 'running' ? { ...t, status: 'paused' } : t) }))
    },

    resumeTask: () => {
      if (get().runnerMode === 'cloud') {
        if (!runtime.cloudTaskId) return
        void controlCloudTask(runtime.cloudTaskId, 'resume', runtime.cloudCursor).then((r) => {
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
      runtime.runner?.resume()
      set((s) => ({ tasks: s.tasks.map((t) => t.status === 'paused' ? { ...t, status: 'running' } : t) }))
    },

    abortTask: () => {
      if (get().runnerMode === 'cloud' && runtime.cloudTaskId) {
        void controlCloudTask(runtime.cloudTaskId, 'abort').then((r) => {
          if (!r.ok) return
          const status: TaskStatus = r.task?.status ?? 'aborted'
          set((s) => ({ tasks: s.tasks.map((t) => t.mode === 'cloud' && !['done', 'aborted', 'failed'].includes(t.status)
            ? { ...t, status, queuePosition: 0 } : t) }))
        })
      }
      runtime.cloudClose?.()
      runtime.cloudClose = null
      runtime.cloudTaskId = null
      runtime.runner?.abort()
      runtime.runner = null
      set((s) => ({
        tasks: s.tasks.map((t) => t.status === 'running' || t.status === 'paused' ? {
          ...t, status: 'aborted', finishedAt: new Date().toISOString(),
          progress: { ...t.progress, log: [...t.progress.log, logLine('用户中止：已采集结果全部保留', 'warn')] },
        } : t),
        activeTaskId: null,
      }))
    },
  }
}
