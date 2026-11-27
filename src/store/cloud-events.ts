/**
 * P3-6 · 云端 SSE 事件 → 本地任务进度的映射
 *
 * 纪律（原样保留）：编排器数据源未接入 → 绝不往客户库写入任何「看起来像真公司」的记录，
 * 事件里的候选域名是占位标识，只在日志里说明。
 *
 * 从 useAppStore.ts 搬出时只改了一处：原来是直接 `useAppStore.setState / getState`，
 * 现在改成由入口注入的 `set / get`，避免 slice 反向 import store 造成循环依赖。
 */
import type { TaskProgress, TaskStatus } from '@/types'
import { runtime } from './runtime'
import type { CloudEvent, StoreGet, StoreSet, TaskLogLine } from './types'

export function logLine(text: string, level: 'info' | 'warn' | 'error' = 'info'): TaskLogLine {
  return { at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level, text }
}

const TERMINAL_STATUSES = ['done', 'aborted', 'failed']

export function createCloudEventHandler(set: StoreSet, get: StoreGet) {
  return function applyCloudEvent(taskId: string, evt: CloudEvent): void {
    set((s) => {
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
          runtime.cloudCursor = snap?.cursor ?? runtime.cloudCursor
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
          runtime.cloudCursor = evt.cursor ?? runtime.cloudCursor
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
          runtime.cloudCursor = evt.cursor ?? runtime.cloudCursor
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
      const terminal = TERMINAL_STATUSES.includes(status)
      return {
        tasks: s.tasks.map((t) => t.id === taskId ? { ...t, status, progress, queuePosition, maxConcurrent } : t),
        activeTaskId: terminal && s.activeTaskId === taskId ? null : s.activeTaskId,
      }
    })
    // 终态后与服务端账本对齐，避免本地镜像余额长期偏离真实扣点
    const current = get().tasks.find((t) => t.id === taskId)
    if (current && TERMINAL_STATUSES.includes(current.status)) {
      void get().syncPoints()
    }
  }
}
