/**
 * F11 第二步 · 多步序列（域层，纯函数）
 *
 * 先说不做什么，这比做什么重要：
 *  - **不自动发送**。产品本身不具备发送能力（导出 mbox 由用户自己点发送），
 *    所以「自动节奏」在本产品里没有落点。
 *  - **不自动建草稿**。到期只给提示，建草稿仍然走 `addOutreach`（含 G2 硬拦与状态机白名单）。
 *  - **不自动改客户状态**。状态只由真实动作触发（建草稿 / 发送 / 退信 / 回复）。
 *  - **没有任何定时器**。本文件是纯函数，`now` 由调用方传入，测试可完全确定。
 *
 * 序列只回答三个问题：第几步、最早什么时候、用哪封模板。执行权永远在人手上。
 *
 * 这一条写进 ADR-038：把序列做成「自动排期 + 自动发送」会同时绕过
 * F7-2 发送闸门与 F8 状态机的「不可逆终态」保护，是最容易做歪的方向。
 */
import type { CompanyStatus } from '@/types'

/** PRD F11 的口径：最多 3 步（首发 + 两次跟进） */
export const MAX_SEQUENCE_STEPS = 3
/** 单步最小间隔：同日跟进同一客户没有意义，且容易撞上 G3 节流 */
export const MIN_STEP_GAP_DAYS = 1
/** 单步最大间隔：超过两个月的跟进已经不是同一轮对话 */
export const MAX_STEP_GAP_DAYS = 60
/**
 * 整条序列的总跨度上限（天）。
 * 必须**严格小于**「步数 × 单步上限」= 180，否则这条校验永远触发不了（就是一段死代码）。
 * 90 天的口径：超过三个月的三步跟进已经跨了两个采购周期，不该算同一轮对话。
 */
export const MAX_SEQUENCE_SPAN_DAYS = 90

export interface SequenceStep {
  /** 引用模板库里的模板 id；模板被删掉时该步骤不可用（不静默换模板） */
  templateId: string
  /** 距**上一步**的最小间隔天数；第 1 步必须为 0 */
  gapDays: number
  /** 给用户看的一句话说明，例如「换个角度，不催」 */
  note?: string
}

export interface FollowUpSequence {
  id: string
  name: string
  steps: SequenceStep[]
  /** 内置序列：可套用、可复制，但不可删除、不可覆盖（与模板库同一条纪律） */
  builtin?: boolean
  demo?: boolean
}

export interface SequenceDraft {
  id?: string
  name: string
  steps: SequenceStep[]
}

export interface SequenceValidation {
  ok: boolean
  issues: string[]
}

const isWholeNumber = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n)

/**
 * 序列校验。issues 会直接展示给用户，所以每条都要说清「哪里错、为什么」。
 *
 * `templateIds` 由调用方传入当前模板库的真实 id，避免域层反向依赖 store。
 */
export function validateSequence(
  input: Pick<FollowUpSequence, 'name' | 'steps'>,
  opts: { templateIds: readonly string[] },
): SequenceValidation {
  const issues: string[] = []
  const name = String(input?.name ?? '').trim()
  const steps = Array.isArray(input?.steps) ? input.steps : []
  const knownTemplates = new Set(opts?.templateIds ?? [])

  if (!name) issues.push('序列名称不能为空')
  if (name.length > 40) issues.push('序列名称不超过 40 个字符')

  if (steps.length === 0) issues.push('序列至少要有 1 步')
  if (steps.length > MAX_SEQUENCE_STEPS) {
    issues.push(`序列最多 ${MAX_SEQUENCE_STEPS} 步（当前 ${steps.length} 步）：再多就不是同一轮跟进，而是一轮骚扰`)
  }

  steps.forEach((step, i) => {
    const label = `第 ${i + 1} 步`
    if (!step || typeof step !== 'object') { issues.push(`${label}格式不合法`); return }

    if (!knownTemplates.has(String(step.templateId ?? ''))) {
      issues.push(`${label}引用的模板不存在（可能已被删除）：请重新选择模板，不会自动换成别的模板`)
    }
    if (!isWholeNumber(step.gapDays)) {
      issues.push(`${label}的间隔天数必须是整数`)
    } else if (i === 0 && step.gapDays !== 0) {
      issues.push('第 1 步的间隔天数必须是 0（首发没有「上一步」）')
    } else if (i > 0 && step.gapDays < MIN_STEP_GAP_DAYS) {
      issues.push(`${label}的间隔至少 ${MIN_STEP_GAP_DAYS} 天：同日跟进同一客户会撞上 G3 节流`)
    } else if (step.gapDays > MAX_STEP_GAP_DAYS) {
      issues.push(`${label}的间隔不超过 ${MAX_STEP_GAP_DAYS} 天：超过两个月的跟进已经不属于同一轮对话`)
    }
  })

  // 间隔必须严格递增：否则第 3 步会排在第 2 步之前，排期出现负值
  for (let i = 1; i < steps.length; i += 1) {
    const prev = steps[i - 1]?.gapDays
    const cur = steps[i]?.gapDays
    if (isWholeNumber(prev) && isWholeNumber(cur) && cur <= 0) {
      issues.push(`第 ${i + 1} 步的间隔必须大于 0`)
    }
  }

  const span = steps.reduce((sum, s) => sum + (isWholeNumber(s?.gapDays) ? s.gapDays : 0), 0)
  if (span > MAX_SEQUENCE_SPAN_DAYS) {
    issues.push(`整条序列跨度 ${span} 天，超过上限 ${MAX_SEQUENCE_SPAN_DAYS} 天`)
  }

  return { ok: issues.length === 0, issues }
}

/** 从第 1 步到末尾的累计天数（第 1 步 gapDays=0，所以直接求和） */
export function sequenceSpanDays(sequence: Pick<FollowUpSequence, 'steps'>): number {
  const steps = Array.isArray(sequence?.steps) ? sequence.steps : []
  return steps.reduce((sum, s) => sum + (isWholeNumber(s?.gapDays) ? s.gapDays : 0), 0)
}

export type PlannedStepState = 'waiting' | 'due' | 'overdue' | 'done' | 'blocked'

export interface PlannedStep {
  /** 1-based，与 UI 展示一致 */
  index: number
  templateId: string
  gapDays: number
  /** 未开始（startedAt 为空）或整条序列被阻断时为 null */
  dueAt: string | null
  state: PlannedStepState
  /** 正数 = 还有几天；0 = 今天到期；负数 = 已逾期几天；null = 无法计算 */
  daysUntilDue: number | null
  note?: string
}

export interface FollowUpPlan {
  steps: PlannedStep[]
  /** 现在该做哪一步（1-based）；null 表示「还没到点」或「整条序列被阻断」 */
  nextIndex: number | null
  blocked: boolean
  /** blocked 的原因，直接展示给用户 */
  reason?: string
}

/**
 * 这些状态下不再推进序列：
 *  - 退订 / 无意向 / 硬退信：属于不可逆终态，再发就是骚扰或撞黑名单；
 *  - 已回复 / 有意向 / 已报价 / 已成单：已经进入人工沟通，模板跟进会让对话变机械。
 *
 * 这里**不猜**「多久没回就该催」，只按状态判定；时间判定全部交给 gapDays。
 */
export const SEQUENCE_BLOCKED_STATUSES: readonly CompanyStatus[] = [
  'unsubscribed', 'not_interested', 'bounced', 'replied', 'interested', 'quoted', 'won',
]

const DAY_MS = 86400000

function toIso(date: Date): string {
  return date.toISOString()
}

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * 计算排期。**只算不执行**：返回的每一步都是「如果按这条序列走，第 N 步最早哪天」。
 *
 * @param startedAt 第 1 步的基准时间（通常是首封信的发送时间）；为空表示还没开始
 * @param completedSteps 已经完成的步数（由调用方从草稿/发送记录推出，域层不猜）
 * @param status 客户当前状态；命中 `SEQUENCE_BLOCKED_STATUSES` 时整条序列标 blocked
 */
export function planFollowUp(input: {
  sequence: Pick<FollowUpSequence, 'steps'>
  startedAt: string | null
  completedSteps: number
  status: CompanyStatus
  now?: Date
}): FollowUpPlan {
  const steps = Array.isArray(input?.sequence?.steps) ? input.sequence.steps : []
  const now = input?.now ?? new Date()
  const nowMs = now.getTime()
  const startMs = parseTime(input?.startedAt)
  const completed = Math.max(0, Math.floor(Number(input?.completedSteps) || 0))

  if (SEQUENCE_BLOCKED_STATUSES.includes(input.status)) {
    return {
      steps: steps.map((s, i): PlannedStep => ({
        index: i + 1, templateId: s.templateId, gapDays: s.gapDays,
        dueAt: null, state: 'blocked', daysUntilDue: null, note: s.note,
      })),
      nextIndex: null,
      blocked: true,
      reason: blockReason(input.status),
    }
  }

  let cumulative = 0
  const planned: PlannedStep[] = steps.map((s, i) => {
    cumulative += isWholeNumber(s.gapDays) ? s.gapDays : 0
    const index = i + 1

    // 未开始：第 1 步随时可以做，后续步骤没有基准时间，如实给 null 而不是编一个日期
    if (startMs === null) {
      return {
        index, templateId: s.templateId, gapDays: s.gapDays, note: s.note,
        dueAt: null,
        state: index === 1 ? 'due' : 'waiting',
        daysUntilDue: null,
      }
    }

    const dueMs = startMs + cumulative * DAY_MS
    const dueAt = toIso(new Date(dueMs))
    if (index <= completed) {
      return { index, templateId: s.templateId, gapDays: s.gapDays, note: s.note, dueAt, state: 'done' as const, daysUntilDue: null }
    }
    const daysUntilDue = Math.floor((dueMs - nowMs) / DAY_MS)
    const state: PlannedStepState = daysUntilDue > 0 ? 'waiting' : daysUntilDue === 0 ? 'due' : 'overdue'
    return { index, templateId: s.templateId, gapDays: s.gapDays, note: s.note, dueAt, state, daysUntilDue }
  })

  // 只把「已到期或已逾期」的第一步当作可执行项，避免一次列出三步催用户
  const next = planned.find((p) => p.state === 'due' || p.state === 'overdue')
  return { steps: planned, nextIndex: next ? next.index : null, blocked: false }
}

function blockReason(status: CompanyStatus): string {
  switch (status) {
    case 'unsubscribed': return '客户已退订：终止一切跟进，已进入 G2 抑制名单'
    case 'not_interested': return '客户已明确无意向：不再自动提醒跟进'
    case 'bounced': return '上次邮件硬退信：继续发送只会损伤发件域信誉，先处理邮箱有效性'
    case 'won': return '已成单：转入交付与复购节奏，不再套用开发信序列'
    default: return '客户已回复或进入人工沟通：模板跟进会让对话变机械，请直接人工回复'
  }
}

/**
 * 内置序列：与内置模板一样是只读基线，可复制不可改。
 * 3 步覆盖 PRD F8-3 的「首发 → 3 天后二次触达 → 再 10 天收尾」。
 */
export const DEFAULT_SEQUENCES: FollowUpSequence[] = [
  {
    id: 'seq_builtin_standard',
    name: '标准跟进 · 3 步',
    steps: [
      { templateId: 'tpl_builtin_intro', gapDays: 0, note: '首次触达，只讲一个具体价值点' },
      { templateId: 'tpl_builtin_followup', gapDays: 3, note: '换个角度补信息，不重复催问' },
      { templateId: 'tpl_builtin_breakup', gapDays: 10, note: '收尾关闭话题，留一条下次联系的路' },
    ],
    builtin: true,
    demo: true,
  },
  {
    id: 'seq_builtin_short',
    name: '轻触达 · 2 步',
    steps: [
      { templateId: 'tpl_builtin_intro', gapDays: 0, note: '首次触达' },
      { templateId: 'tpl_builtin_breakup', gapDays: 7, note: '一周无回应就收尾，不纠缠' },
    ],
    builtin: true,
    demo: true,
  },
]
