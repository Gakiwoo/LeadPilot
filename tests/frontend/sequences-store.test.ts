/**
 * F11 第二步 · 序列 store 行为级反例
 *
 * 与 `templates.ts` 同一条纪律，这里逐条钉死：
 *  1. 写入口自己校验（不靠 UI 自觉）；
 *  2. 内置序列可复制、不可改、不可删；
 *  3. 引用已删除的模板时保存失败，而不是静默换成第一封模板。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/useAppStore'
import { DEFAULT_SEQUENCES, MAX_SEQUENCE_STEPS } from '@/domain/follow-up'
import type { SequenceDraft } from '@/domain/follow-up'

const memory = new Map<string, string>()

beforeAll(() => {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => { memory.set(k, v) },
    removeItem: (k: string) => { memory.delete(k) },
    clear: () => { memory.clear() },
    key: (i: number) => Array.from(memory.keys())[i] ?? null,
    get length() { return memory.size },
  })
})

const builtinTemplates = useAppStore.getState().templates
const T1 = builtinTemplates[0]!.id
const T2 = builtinTemplates[1]!.id

const draft = (over: Partial<SequenceDraft> = {}): SequenceDraft => ({
  name: '我的跟进',
  steps: [{ templateId: T1, gapDays: 0 }, { templateId: T2, gapDays: 3 }],
  ...over,
})

beforeEach(() => {
  // 每个用例自己铺前置：模板保留、序列回到出厂
  useAppStore.setState({
    templates: builtinTemplates,
    sequences: DEFAULT_SEQUENCES.map((s) => ({ ...s, steps: s.steps.map((x) => ({ ...x })) })),
  })
})

const seqs = () => useAppStore.getState().sequences
const custom = () => seqs().filter((s) => !s.builtin)

describe('初始状态', () => {
  it('内置序列默认存在且排在最前', () => {
    expect(seqs().length).toBe(DEFAULT_SEQUENCES.length)
    expect(seqs().every((s) => s.builtin)).toBe(true)
    expect(seqs()[0]?.id).toBe(DEFAULT_SEQUENCES[0]!.id)
  })
})

describe('saveSequence · 新建', () => {
  it('合法序列落库到「我的序列」，且不是内置', () => {
    const res = useAppStore.getState().saveSequence(draft({ name: '展会后 3 步' }))
    expect(res.ok).toBe(true)
    const created = seqs().find((s) => s.id === res.id)
    expect(created?.name).toBe('展会后 3 步')
    expect(created?.builtin).toBe(false)
    expect(created?.demo).toBe(false)
    expect(custom()).toHaveLength(1)
  })

  it('校验失败时不入任何库，并把全部原因一起返回', () => {
    const res = useAppStore.getState().saveSequence(draft({ name: '' }))
    expect(res.ok).toBe(false)
    expect(res.message).toContain('名称不能为空')
    expect(custom()).toHaveLength(0)
  })

  it('超过 3 步被拒，且库里没有被写入半成品', () => {
    const steps = Array.from({ length: MAX_SEQUENCE_STEPS + 1 }, (_, i) => ({ templateId: T1, gapDays: i === 0 ? 0 : i }))
    const res = useAppStore.getState().saveSequence(draft({ steps }))
    expect(res.ok).toBe(false)
    expect(res.message).toContain(`最多 ${MAX_SEQUENCE_STEPS} 步`)
    expect(custom()).toHaveLength(0)
  })

  it('引用不存在的模板时失败，不会静默替换', () => {
    const res = useAppStore.getState().saveSequence(draft({
      steps: [{ templateId: 'tpl_deleted', gapDays: 0 }],
    }))
    expect(res.ok).toBe(false)
    expect(res.message).toContain('模板不存在')
    expect(custom()).toHaveLength(0)
  })
})

describe('saveSequence · 更新', () => {
  it('可以修改自建序列', () => {
    const created = useAppStore.getState().saveSequence(draft())
    const res = useAppStore.getState().saveSequence(draft({ id: created.id, name: '改名后' }))
    expect(res.ok).toBe(true)
    expect(seqs().find((s) => s.id === created.id)?.name).toBe('改名后')
    expect(custom()).toHaveLength(1)
  })

  it('内置序列不可修改，并给出可执行的下一步', () => {
    const builtin = seqs().find((s) => s.builtin)!
    const res = useAppStore.getState().saveSequence(draft({ id: builtin.id, name: '偷偷改内置' }))
    expect(res.ok).toBe(false)
    expect(res.message).toContain('内置序列不可修改')
    expect(seqs().find((s) => s.id === builtin.id)?.name).toBe(builtin.name)
  })

  it('更新不存在的 id 时失败', () => {
    const res = useAppStore.getState().saveSequence(draft({ id: 'seq_nope' }))
    expect(res.ok).toBe(false)
    expect(res.message).toContain('不存在')
  })
})

describe('deleteSequence', () => {
  it('自建可删', () => {
    const created = useAppStore.getState().saveSequence(draft())
    expect(useAppStore.getState().deleteSequence(created.id!).ok).toBe(true)
    expect(custom()).toHaveLength(0)
  })

  it('内置不可删：出厂节奏必须有回退点', () => {
    const builtin = seqs().find((s) => s.builtin)!
    const res = useAppStore.getState().deleteSequence(builtin.id)
    expect(res.ok).toBe(false)
    expect(res.message).toContain('内置序列不可删除')
    expect(seqs().some((s) => s.id === builtin.id)).toBe(true)
  })

  it('删不存在的 id 返回失败而不是静默成功', () => {
    const res = useAppStore.getState().deleteSequence('seq_nope')
    expect(res.ok).toBe(false)
  })
})

describe('duplicateSequence', () => {
  it('复制内置得到可编辑副本，原内置保持不变', () => {
    const builtin = seqs().find((s) => s.builtin)!
    const before = seqs().length
    const res = useAppStore.getState().duplicateSequence(builtin.id)
    expect(res.ok).toBe(true)
    const copy = seqs().find((s) => s.id === res.id)
    expect(copy?.builtin).toBe(false)
    expect(copy?.name).toContain('副本')
    expect(copy?.id).not.toBe(builtin.id)
    expect(seqs()).toHaveLength(before + 1)
    expect(seqs().find((s) => s.id === builtin.id)?.name).toBe(builtin.name)
  })

  it('副本名称不会超过 40 字上限（否则复制出来的东西存不回去）', () => {
    const long = useAppStore.getState().saveSequence(draft({ name: 'x'.repeat(40) }))
    const res = useAppStore.getState().duplicateSequence(long.id!)
    const copy = seqs().find((s) => s.id === res.id)!
    expect(copy.name.length).toBeLessThanOrEqual(40)
    // 复制出来的副本必须能直接保存
    expect(useAppStore.getState().saveSequence({ ...copy, id: copy.id, name: copy.name, steps: copy.steps }).ok).toBe(true)
  })

  it('复制不存在 id 时失败', () => {
    expect(useAppStore.getState().duplicateSequence('seq_nope').ok).toBe(false)
  })
})

describe('resetDemo · 序列回到出厂', () => {
  it('自建序列被清掉，内置序列恢复', () => {
    useAppStore.getState().saveSequence(draft({ name: '临时序列' }))
    expect(custom()).toHaveLength(1)
    useAppStore.getState().resetDemo()
    expect(custom()).toHaveLength(0)
    expect(seqs().filter((s) => s.builtin)).toHaveLength(DEFAULT_SEQUENCES.length)
  })
})
