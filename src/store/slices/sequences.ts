/**
 * slice · 多步序列（F11 第二步）
 *
 * 与 `slices/templates.ts` 同一条纪律，三条边界一模一样：
 *  1. **写入口校验**：`saveSequence` 自己调 `validateSequence`，不靠 UI 自觉。
 *  2. **内置不可覆盖、不可删除**：内置序列是基线，改了就没有回退点。
 *  3. **模板必须真实存在**：校验时传当前模板库的 id 集合，删掉模板后序列不会静默换一封。
 *
 * 本片**不执行任何动作**：没有定时器、没有自动建草稿、没有自动改状态。
 * 序列只是「给人看的排期」，落点仍在 `addOutreach`（含 G2 硬拦与状态机白名单）。
 */
import type { StateCreator } from 'zustand'
import {
  DEFAULT_SEQUENCES, validateSequence,
  type FollowUpSequence, type SequenceDraft,
} from '@/domain/follow-up'
import type { AppState } from '../types'

export type SequencesSlice = Pick<AppState,
  | 'saveSequence' | 'deleteSequence' | 'duplicateSequence'>

/** 内置序列的 id 前缀是契约的一部分：UI 靠它区分「可编辑」与「只读」 */
const BUILTIN_PREFIX = 'seq_builtin_'

const isBuiltin = (id: string) => id.startsWith(BUILTIN_PREFIX)

/** 不用 crypto.randomUUID：老 WebView 与测试环境不一定有，且 id 只需局部唯一 */
function newSequenceId(existing: FollowUpSequence[]): string {
  const base = `seq_${Date.now().toString(36)}`
  let id = base
  let n = 1
  while (existing.some((s) => s.id === id)) { n += 1; id = `${base}_${n}` }
  return id
}

/** 归一化步骤：只保留域层认识的字段，避免把 UI 的临时字段（如 key）带进持久化 */
function normalizeSteps(steps: SequenceDraft['steps']): SequenceDraft['steps'] {
  return (Array.isArray(steps) ? steps : []).map((s) => ({
    templateId: String(s?.templateId ?? ''),
    gapDays: Number(s?.gapDays ?? 0),
    ...(s?.note ? { note: String(s.note).slice(0, 60) } : {}),
  }))
}

export const createSequencesSlice: StateCreator<AppState, [], [], SequencesSlice> = (set, get) => ({
  // 初始值由 demo-bootstrap 统一提供，slice 不造数据
  saveSequence: (draft: SequenceDraft) => {
    const name = String(draft?.name ?? '').trim()
    const steps = normalizeSteps(draft?.steps)
    const templateIds = get().templates.map((t) => t.id)

    const checked = validateSequence({ name, steps }, { templateIds })
    if (!checked.ok) {
      // 全部 issue 一起返回：只回第一条会让用户改一处、再报下一处
      return { ok: false, message: checked.issues.join('；') }
    }

    const list = get().sequences
    const targetId = String(draft?.id ?? '').trim()

    if (targetId) {
      if (isBuiltin(targetId)) {
        return { ok: false, message: '内置序列不可修改：请先「复制为我的序列」再改，否则出厂节奏就回不去了' }
      }
      if (!list.some((s) => s.id === targetId)) {
        return { ok: false, message: '序列不存在，可能已被删除' }
      }
      set((s) => ({
        sequences: s.sequences.map((x) => x.id === targetId
          ? { ...x, name, steps, demo: false }
          : x),
      }))
      return { ok: true, id: targetId }
    }

    const id = newSequenceId(list)
    const created: FollowUpSequence = { id, name, steps, builtin: false, demo: false }
    set((s) => {
      const builtins = s.sequences.filter((x) => x.builtin)
      const customs = s.sequences.filter((x) => !x.builtin)
      return { sequences: [...builtins, created, ...customs] }
    })
    return { ok: true, id }
  },

  deleteSequence: (id: string) => {
    if (isBuiltin(id)) {
      return { ok: false, message: '内置序列不可删除：它是跟进节奏的基线，删掉就找不回出厂配置了' }
    }
    if (!get().sequences.some((s) => s.id === id)) {
      return { ok: false, message: '序列不存在或已删除' }
    }
    set((s) => ({ sequences: s.sequences.filter((x) => x.id !== id) }))
    return { ok: true }
  },

  duplicateSequence: (id: string) => {
    const source = get().sequences.find((s) => s.id === id)
    if (!source) return { ok: false, message: '序列不存在或已删除' }
    const copy: FollowUpSequence = {
      ...source,
      id: newSequenceId(get().sequences),
      // 名称加后缀可能超 40 字上限，超了先截断再拼，别让「复制」产出一个存不回去的序列
      name: `${source.name.slice(0, 32)} · 副本`,
      steps: source.steps.map((s) => ({ ...s })),
      builtin: false,
      demo: false,
    }
    set((s) => {
      const builtins = s.sequences.filter((x) => x.builtin)
      const customs = s.sequences.filter((x) => !x.builtin)
      return { sequences: [...builtins, copy, ...customs] }
    })
    return { ok: true, id: copy.id }
  },
})

/** resetDemo 复用：回到出厂序列集 */
export function builtinSequences(): FollowUpSequence[] {
  return DEFAULT_SEQUENCES.map((s) => ({ ...s, steps: s.steps.map((x) => ({ ...x })) }))
}
