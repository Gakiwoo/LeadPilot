/**
 * PRD 9.1 / F2 · 云端任务编排器（编排与 SSE 为真实实现，采集数据源未接入）
 *
 * 真实部分：任务状态机、6 阶段推进、SSE 单向推送、断点续跑游标、
 *          硬超时、并发上限 3、单源失败显式降级、暂停/继续/中止。
 * 未接部分：6 类 DataSourceAdapter 与 Playwright 集群。所有事件带 demo:true，
 *          不生成任何「看起来像真公司」的数据，由客户端用本地演示池渲染。
 *
 * v0.4.0：源清单改由 server/data-sources.mjs 的注册表提供（可插拔 + 显式健康状态），
 *         编排器不再硬编码源名；注册表如实报告 0/6 已接入，绝不制造「已接入」假象。
 */
import { createDataSourceRegistry } from './data-sources.mjs'
import { protocol } from './protocol.mjs'

export const STAGES = ['检索候选', '规范化', '去重', '抓取详情', '验证邮箱', '模型判断与评分']
const HARD_TIMEOUT_MIN = { 1: 10, 2: 25, 3: 50, 4: 90 }
const SOURCES_BY_DEPTH = { 1: 3, 2: 5, 3: 6, 4: 6 }
const MAX_CONCURRENT = 3

export function createOrchestrator(opts = {}) {
  const now = opts.now ?? (() => Date.now())
  const tickMs = opts.tickMs ?? 400
  const store = opts.store ?? null // 传入持久化存储后，任务游标跨进程可恢复（AC-03）
  const ledger = opts.ledger ?? null // 点数账本：预扣/结算/释放全部幂等，跨进程不重复扣
  const dataSources = opts.dataSources ?? createDataSourceRegistry()
  const tasks = new Map()
  const subscribers = new Map()
  const timers = new Map()

  /** 内部全量状态（含游标 / tick / 日志），用于持久化；与对外的 snapshot 刻意区分 */
  function serialize(task) {
    return {
      id: task.id, config: task.config, status: task.status,
      pointsEstimated: task.pointsEstimated, pointsUsed: task.pointsUsed,
      createdAt: task.createdAt, finishedAt: task.finishedAt ?? null,
      startedMs: task.startedMs ?? null, tick: task.tick ?? 0,
      cursor: task.cursor, progress: task.progress,
      ledger: task.ledger ?? null, ledgerSettled: Boolean(task.ledgerSettled),
      sourceMode: task.sourceMode ?? 'demo', demo: true,
    }
  }

  function persist(task) {
    if (!store) return
    try { store.taskUpsert(task.id, serialize(task)) } catch (err) {
      // 持久化失败必须可见，绝不静默假装已落盘
      // eslint-disable-next-line no-console
      console.warn(`[LeadPilot] 任务 ${task.id} 持久化失败：${String(err?.message ?? err)}`)
    }
  }

  /** 进程重启后：活跃任务一律降为 paused 并保留游标，由用户显式点击「继续」恢复 */
  function hydrate() {
    if (!store) return []
    const ids = []
    for (const raw of store.taskList()) {
      if (!raw?.id || !raw.progress || !raw.cursor) continue
      const wasActive = raw.status === 'running' || raw.status === 'queued'
      const task = {
        ...raw,
        status: wasActive ? 'paused' : raw.status,
        tick: raw.tick ?? 0,
        startedMs: now(),
        recovered: true,
        // 旧版本任务没有账本预扣记录：绝不补扣，按只读方式记录历史消耗
        ledger: raw.ledger ?? null,
        ledgerSettled: Boolean(raw.ledgerSettled),
        progress: {
          ...raw.progress,
          log: [...(raw.progress.log ?? []), {
            at: new Date(now()).toLocaleTimeString('zh-CN', { hour12: false }),
            level: 'warn',
            text: wasActive
              ? '进程重启：已从持久化游标恢复为「已暂停」，点击继续即断点续跑，额度不重复扣减（AC-03）'
              : '任务状态已从持久化存储恢复',
          }].slice(-80),
        },
      }
      tasks.set(task.id, task)
      ids.push(task.id)
      persist(task)
    }
    return ids
  }
  const recoveredIds = hydrate()

  function emit(taskId, type, data) {
    const payload = { type, taskId, at: new Date(now()).toISOString(), demo: true, ...data }
    for (const cb of subscribers.get(taskId) ?? []) {
      try { cb(payload) } catch { /* 单个订阅者异常不影响任务 */ }
    }
    return payload
  }

  function subscribe(taskId, cb) {
    if (!subscribers.has(taskId)) subscribers.set(taskId, new Set())
    subscribers.get(taskId).add(cb)
    return () => subscribers.get(taskId)?.delete(cb)
  }

  function snapshot(task) {
    const ds = dataSources.health()
    return {
      id: task.id, status: task.status, config: task.config,
      progress: task.progress, cursor: task.cursor,
      pointsEstimated: task.pointsEstimated, pointsUsed: task.pointsUsed,
      createdAt: task.createdAt, finishedAt: task.finishedAt,
      recovered: Boolean(task.recovered),
      persistence: store?.mode ?? 'memory',
      ledger: task.ledger ?? null,
      sourceMode: task.sourceMode ?? 'demo',
      dataSources: { ready: ds.readyCount, total: ds.total },
      demo: true,
    }
  }

  /**
   * 收尾。点数账本在这里结算/释放，且只做一次：
   *  - 正常完成：按全额结算
   *  - 硬超时 / 中止：按已达成比例结算，差额退还
   *  - 创建后未启动即废弃：release 全额退还，不产生任何消耗
   * 幂等由 ledger 的 idem_key 保证；进程重启后再次收尾也不会重复扣点。
   */
  function finish(task, status, reason, opts = {}) {
    clearInterval(timers.get(task.id))
    timers.delete(task.id)
    task.status = status
    task.finishedAt = new Date(now()).toISOString()
    const prorated = Math.round(task.pointsEstimated * task.progress.qualified / Math.max(1, task.config.targetCount))
    const requested = Math.max(0, Math.min(task.pointsEstimated, Math.round(opts.actualPoints ?? task.pointsEstimated)))
    task.pointsUsed = requested
    const neverStarted = task.tick === 0 && task.progress.qualified === 0
    let pointsRefunded = 0

    if (ledger && task.ledger?.refId && !task.ledgerSettled) {
      const refId = task.ledger.refId
      const shouldRelease = status !== 'done' && neverStarted && requested === 0
      const r = shouldRelease
        ? ledger.release({ refId, reason: '任务未启动即废弃：全额退还预扣点数' })
        : ledger.settle({ refId, amount: requested, reason: `任务${status === 'done' ? '完成' : '中止'}结算` })
      if (r.ok) {
        task.pointsUsed = r.charged ?? 0
        pointsRefunded = r.refunded ?? 0
        task.ledger = {
          ...task.ledger, settled: shouldRelease ? 'released' : 'settled',
          charged: task.pointsUsed, refunded: pointsRefunded, idempotent: Boolean(r.idempotent),
        }
        task.progress.log.push({
          at: new Date(now()).toLocaleTimeString('zh-CN', { hour12: false }), level: 'info',
          text: shouldRelease
            ? `点数账本：已全额释放 ${pointsRefunded} 点预扣，本次消耗 0 点`
            : `点数账本：预扣 ${task.ledger.reserved} 点 → 实扣 ${task.pointsUsed} 点 / 退还 ${pointsRefunded} 点${r.idempotent ? '（幂等命中，不重复扣）' : ''}`,
        })
      } else {
        // E4003（历史任务无预扣）不补扣、不假装成功；其余错误必须可见
        task.ledger = { ...task.ledger, settled: 'failed', code: r.code, error: r.reason }
        task.progress.log.push({
          at: new Date(now()).toLocaleTimeString('zh-CN', { hour12: false }), level: 'error',
          text: `点数账本结算失败（${r.code}）：${r.reason} · 本次未扣点`,
        })
      }
      task.ledgerSettled = true
    }

    task.progress.log.push({ at: new Date(now()).toLocaleTimeString('zh-CN', { hour12: false }), level: status === 'done' ? 'info' : 'warn', text: reason })
    task.progress.stage = status === 'done' ? '完成' : task.progress.stage
    task.progress.etaRange = [0, 0]
    task.progress.log = task.progress.log.slice(-80)
    persist(task)
    emit(task.id, status === 'done' ? 'done' : 'aborted', {
      progress: task.progress, cursor: task.cursor,
      pointsUsed: task.pointsUsed, pointsRefunded, ledger: task.ledger, reason,
    })
  }

  function tick(task) {
    if (task.status !== 'running') return
    const ds = dataSources.health()
    const p = task.progress
    const target = Math.max(10, Math.min(1000, Number(task.config.targetCount) || 100))
    const depth = [1, 2, 3, 4].includes(Number(task.config.depth)) ? Number(task.config.depth) : 2
    task.tick += 1

    const stageIndex = Math.min(STAGES.length - 1, Math.floor(task.tick / 3))
    if (stageIndex !== p.stageIndex) {
      p.stageIndex = stageIndex
      p.stage = STAGES[stageIndex]
      emit(task.id, 'stage', { stage: p.stage, stageIndex })
    }

    const batch = Math.min(4, Math.max(1, Math.ceil(target / 12)))
    const plan = dataSources.planBatch({ count: batch, cursorOffset: task.cursor.offset })
    // 已注册实现但真实采集链路尚未接入：显式阻塞并暂停，不推进游标、不假装进度
    if (plan.sourceMode === 'blocked') {
      p.log.push({ at: new Date(now()).toLocaleTimeString('zh-CN', { hour12: false }), level: 'warn', text: plan.note })
      p.log = p.log.slice(-80)
      emit(task.id, 'source_warning', { sourceMode: 'blocked', note: plan.note, completeness: 0 })
      pause(task.id)
      return
    }
    task.sourceMode = plan.sourceMode
    const demoDomains = plan.domains
    task.cursor.offset += batch
    task.cursor.processedDomains = [...task.cursor.processedDomains.slice(-200), ...demoDomains]

    p.candidates = Math.min(Math.round(target * 1.8), p.candidates + 37 + batch)
    p.stored = Math.min(target, p.stored + batch + 2)
    p.qualified = Math.min(target, p.qualified + batch)
    const remaining = Math.max(1, Math.ceil((target - p.qualified) / Math.max(1, batch)))
    p.etaRange = [Math.max(1, Math.round(remaining * tickMs / 60000)), Math.max(2, Math.round(remaining * tickMs / 60000) + 2)]

    // PRD 5.3：单源失败必须显式告知，不允许静默降级
    if (task.tick === 4 && p.sources.length >= 3) {
      const s = p.sources[2]
      s.status = 'warn'
      s.failures = 1
      s.reason = s.mode === 'unconfigured'
        ? `数据源「${s.name}」未接入（unconfigured）· 演示编排完整性 0%，不代表真实采集`
        : `数据源「${s.name}」${s.reason ?? '不可用'} · 本次结果基于其余源`
      p.log.push({ at: new Date(now()).toLocaleTimeString('zh-CN', { hour12: false }), level: 'warn', text: s.reason })
      emit(task.id, 'source_warning', { source: s, completeness: 0, sourceMode: plan.sourceMode })
    }
    for (let i = 0; i < p.sources.length; i++) {
      const s = p.sources[i]
      if (s.status === 'ok') s.hits += batch * (i + 1)
    }
    p.log.push({ at: new Date(now()).toLocaleTimeString('zh-CN', { hour12: false }), level: 'info', text: `${p.stage} · 新增 ${batch} 条候选 · 已入库 ${p.stored}` })
    p.log = p.log.slice(-80)

    persist(task)
    emit(task.id, 'progress', {
      progress: p, cursor: task.cursor, demoDomains,
      sourceMode: plan.sourceMode,
      dataSources: { ready: ds.readyCount, total: ds.total },
      note: plan.note,
    })

    const elapsedMin = (now() - task.startedMs) / 60000
    const prorated = Math.round(task.pointsEstimated * p.qualified / Math.max(1, target))
    if (p.qualified >= target) finish(task, 'done', `任务完成 · 目标 ${target} / 达成 ${p.qualified}（演示编排）`, { actualPoints: task.pointsEstimated })
    else if (elapsedMin >= (HARD_TIMEOUT_MIN[depth] ?? 25)) finish(task, 'done', `硬超时 ${HARD_TIMEOUT_MIN[depth]} 分钟自动收尾，返回已有结果并标注未完成全量采集`, { actualPoints: prorated })
  }

  function start(task) {
    if (timers.has(task.id)) return
    task.status = 'running'
    task.startedMs = now()
    persist(task)
    timers.set(task.id, setInterval(() => tick(task), tickMs))
    emit(task.id, 'started', { config: task.config, hardTimeoutMin: HARD_TIMEOUT_MIN[task.config.depth] ?? 25 })
  }

  function createTask(config = {}) {
    const running = [...tasks.values()].filter((t) => t.status === 'running').length
    const depth = [1, 2, 3, 4].includes(Number(config.depth)) ? Number(config.depth) : 2
    const target = Math.max(10, Math.min(1000, Number(config.targetCount) || 100))
    const id = `task_${now()}_${Math.random().toString(36).slice(2, 8)}`
    const pointsEstimated = target * (protocol.billing.depthPointsPerCompany[depth] ?? 2)
    // 先预扣再建任务：余额不足直接拒绝，绝不「先跑起来再补扣」
    let hold = null
    if (ledger) {
      hold = ledger.reserve({ refId: id, amount: pointsEstimated, reason: '云端采集任务预扣' })
      if (!hold.ok) {
        return {
          ok: false, code: hold.code, reason: hold.reason,
          pointsEstimated, available: hold.available ?? null,
          action: hold.code === 'E4001' ? '降低目标数量 / 采集深度，或充值后重试' : '检查任务 ID 是否重复',
        }
      }
    }
    const ds = dataSources.health()
    const shownSources = ds.sources.slice(0, SOURCES_BY_DEPTH[depth] ?? 5)
    const task = {
      id, config: { ...config, depth, targetCount: target },
      status: running >= MAX_CONCURRENT ? 'queued' : 'running',
      pointsEstimated,
      pointsUsed: 0,
      ledger: hold ? { refId: id, reserved: hold.held, settled: null } : null,
      ledgerSettled: false,
      createdAt: new Date(now()).toISOString(),
      finishedAt: undefined,
      startedMs: now(),
      tick: 0,
      sourceMode: ds.mode === 'demo' ? 'demo' : 'blocked',
      cursor: { stageIndex: 0, offset: 0, processedDomains: [] },
      progress: {
        stage: STAGES[0], stageIndex: 0, candidates: 0, stored: 0, qualified: 0, etaRange: [4, 8],
        sources: shownSources.map((s) => ({
          key: s.key, name: s.name, mode: s.mode, reason: s.reason,
          hits: 0, failures: 0, status: 'ok',
        })),
        log: [{
          at: new Date(now()).toLocaleTimeString('zh-CN', { hour12: false }),
          level: 'warn',
          text: `数据源 ${ds.readyCount}/${ds.total} 已接入：${ds.note}；本任务不产生真实采集结果、不写入客户记录`,
        }, {
          at: new Date(now()).toLocaleTimeString('zh-CN', { hour12: false }),
          level: 'info',
          text: hold
            ? `点数账本：已幂等预扣 ${hold.held} 点（refId=${id}），任务收尾时按实际达成结算并退还差额`
            : '未注入点数账本：本任务点数仅为估算值，不产生真实扣费',
        }],
      },
    }
    tasks.set(id, task)
    persist(task)
    if (task.status === 'running') start(task)
    else emit(id, 'queued', { position: running - MAX_CONCURRENT + 1 })
    return snapshot(task)
  }

  function getTask(id) { const t = tasks.get(id); return t ? snapshot(t) : null }
  function listTasks() { return [...tasks.values()].map(snapshot) }

  function pause(id) {
    const t = tasks.get(id); if (!t || t.status !== 'running') return null
    t.status = 'paused'
    clearInterval(timers.get(id)); timers.delete(id)
    persist(t)
    emit(id, 'paused', { cursor: t.cursor })
    return snapshot(t)
  }

  function resume(id, cursor) {
    const t = tasks.get(id); if (!t || !['paused', 'queued'].includes(t.status)) return null
    if (cursor) t.cursor = { ...t.cursor, ...cursor }
    persist(t)
    start(t)
    emit(id, 'resumed', { cursor: t.cursor, note: '从持久化游标继续，额度不重复扣减（PRD F2-2）' })
    return snapshot(t)
  }

  function abort(id) {
    const t = tasks.get(id); if (!t || ['done', 'aborted', 'failed'].includes(t.status)) return null
    const prorated = Math.round(t.pointsEstimated * t.progress.qualified / Math.max(1, t.config.targetCount))
    finish(t, 'aborted', '用户中止：已采集结果全部保留，游标已持久化，可断点续跑', { actualPoints: prorated })
    return snapshot(t)
  }

  function dispose() { for (const timer of timers.values()) clearInterval(timer); timers.clear(); tasks.clear(); subscribers.clear() }

  return {
    createTask, getTask, listTasks, pause, resume, abort, subscribe, emit, dispose, snapshot,
    persistence: store?.mode ?? 'memory',
    dataSources,
    recoveredIds,
  }
}
