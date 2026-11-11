/**
 * F2 采集执行与进度 · 演示运行器
 *
 * 明确标注：本运行器使用本地预置数据模拟「流式返回 / 分阶段进度 / 部分失败」，
 * 不发起任何真实网络请求。真实实现需替换为云端 SSE 任务编排器（PRD 9.1）。
 */
import type { Company, DevTask, TaskConfig, TaskProgress } from '@/types'
import { DEPTH_CONFIG, TASK_STAGES } from '@/domain/constants'

export interface RunnerCallbacks {
  onProgress(progress: TaskProgress, batch: Company[]): void
  onDone(): void
}

export interface TaskRunner {
  pause(): void
  resume(): void
  abort(): void
  dispose(): void
}

const emptyProgress = (depth: TaskConfig['depth']): TaskProgress => ({
  stage: TASK_STAGES[0] ?? '', stageIndex: 0, candidates: 0, stored: 0, qualified: 0,
  etaRange: [4, 8],
  sources: ([
    { name: '搜索引擎（SerpAPI 兼容）', hits: 0, failures: 0, status: 'ok' },
    { name: '公开企业注册库', hits: 0, failures: 0, status: 'ok' },
    { name: '官网抓取器', hits: 0, failures: 0, status: 'ok' },
    { name: '邮箱发现', hits: 0, failures: 0, status: 'ok' },
    { name: '海关数据（授权）', hits: 0, failures: 0, status: 'ok' },
    { name: 'LLM 网关 T0/T1', hits: 0, failures: 0, status: 'ok' },
  ] as TaskProgress['sources']).slice(0, DEPTH_CONFIG[depth].sources),
  log: [
    { at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level: 'warn', text: '演示模式：本任务使用本地预置数据，未发起任何真实采集或模型调用' },
    { at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level: 'info', text: `任务启动 · ${DEPTH_CONFIG[depth].label} · 目标 ${0} 家` },
  ],
})

export function createTaskRunner(
  task: DevTask,
  pool: Company[],
  callbacks: RunnerCallbacks,
): TaskRunner {
  let progress = emptyProgress(task.config.depth)
  const startLine = progress.log[1]
  if (startLine) startLine.text = `任务启动 · ${DEPTH_CONFIG[task.config.depth].label} · 目标 ${task.config.targetCount} 家`
  let emitted = 0
  let paused = false
  let aborted = false
  let tick = 0

  const timer = setInterval(() => {
    if (paused || aborted) return
    tick += 1
    const target = Math.min(task.config.targetCount, pool.length)
    const stageIndex = Math.min(TASK_STAGES.length - 1, Math.floor(tick / 3))
    const batchSize = Math.min(4, Math.max(1, Math.ceil(target / 12)))
    const batch = pool.slice(emitted, emitted + batchSize)
    emitted += batch.length

    const candidates = Math.min(target * 1.8, progress.candidates + 37 + batch.length)
    const stored = Math.min(target, progress.stored + batch.length + 2)
    const qualified = Math.min(target, progress.qualified + batch.length)
    const remainingTicks = Math.max(1, Math.ceil((target - qualified) / Math.max(1, batchSize)))
    const etaRange: [number, number] = [Math.max(1, remainingTicks), Math.max(2, remainingTicks + 2)]

    const sources = progress.sources.map((s, i) => {
      if (i === 4 && tick === 4) {
        return { ...s, status: 'warn' as const, failures: 1, reason: '配额用尽 · 本次结果基于其余数据源，完整性约 78%' }
      }
      return { ...s, hits: s.hits + (i === 4 && tick >= 4 ? 0 : batch.length * (i + 1)) }
    })

    const log = [...progress.log]
    if (tick === 4) log.push({ at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level: 'warn', text: '海关数据源不可用：配额用尽。本次结果基于其余数据源，完整性约 78%（不允许静默降级）' })
    if (stageIndex !== progress.stageIndex) log.push({ at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level: 'info', text: `进入阶段：${TASK_STAGES[stageIndex] ?? ''}` })
    log.push({ at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level: 'info', text: `新增 ${batch.length} 家达标客户 · 已入库 ${stored}` })

    progress = {
      stage: TASK_STAGES[stageIndex] ?? '', stageIndex, candidates: Math.round(candidates),
      stored, qualified, etaRange, sources, log: log.slice(-80),
    }

    callbacks.onProgress(progress, batch)

    if (qualified >= target || tick >= 36) {
      const finalLog = [...progress.log, { at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level: 'info' as const, text: `任务完成 · 目标 ${target} / 达成 ${qualified}${qualified < target ? '（结果不足，可放宽条件续采）' : ''}` }]
      callbacks.onProgress({ ...progress, stage: '完成', log: finalLog }, [])
      callbacks.onDone()
      clearInterval(timer)
    }
  }, 420)

  return {
    pause() { paused = true },
    resume() { paused = false },
    abort() {
      aborted = true
      clearInterval(timer)
    },
    dispose() { clearInterval(timer) },
  }
}
