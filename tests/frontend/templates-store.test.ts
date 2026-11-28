/**
 * F11 · 模板库的 store 行为测试
 *
 * 域层测试（email-template.test.ts）证明「校验规则本身对不对」，
 * 这里证明「校验真的接在写入口上」——再好的校验函数，只要保存动作绕开它就是装饰。
 *
 * 三条主断言：
 *  1. 非法模板进不了 state（不是「存进去了再标红」）；
 *  2. 内置模板不可覆盖、不可删除，只能复制；
 *  3. 持久化与重置把模板库一起带上，刷新/重置后不留幽灵。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/useAppStore'
import { DEFAULT_TEMPLATES, type TemplateDraft } from '@/domain/email-template'

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

const BASE = DEFAULT_TEMPLATES.map((t) => ({ ...t }))

beforeEach(() => {
  useAppStore.setState({ templates: BASE.map((t) => ({ ...t })), toast: null })
})

const templates = () => useAppStore.getState().templates
const builtinCount = () => templates().filter((t) => t.builtin).length

/** 数组下标在 noUncheckedIndexedAccess 下是 undefined，用断言函数而不是 `!` */
function builtin(index = 0): (typeof DEFAULT_TEMPLATES)[number] {
  const t = DEFAULT_TEMPLATES[index]
  if (!t) throw new Error(`内置模板缺失：index ${index}`)
  return t
}

const draft = (over: Partial<TemplateDraft> = {}): TemplateDraft => ({
  name: '我的报价模板',
  stage: 'intro',
  purpose: 'quote',
  subject: '{{product}} quote for {{company}}',
  body: 'We noticed {{anchor}}. Attached is our current price list for {{product}}, with {{advantage}}. Tell me which sizes matter most and I will quote those first.',
  ...over,
})

describe('F11 store · 保存入口必过校验', () => {
  it('合法模板能存进去，落成非内置模板', () => {
    const res = useAppStore.getState().saveTemplate(draft())
    expect(res.ok).toBe(true)
    expect(res.id).toBeTruthy()
    const saved = templates().find((t) => t.id === res.id)
    expect(saved?.name).toBe('我的报价模板')
    expect(saved?.builtin).toBe(false)
    expect(saved?.demo).toBe(false)
  })

  it('非法模板进不了 state（校验在写入口，不是存完再标红）', () => {
    const before = templates().length
    const res = useAppStore.getState().saveTemplate(draft({ body: 'too short' }))
    expect(res.ok).toBe(false)
    expect(res.message).toContain('正文至少 40 个字符')
    expect(templates()).toHaveLength(before)
  })

  it('校验失败时回全部 issue，而不是只回第一条', () => {
    const res = useAppStore.getState().saveTemplate({ name: '', stage: 'intro', purpose: 'nope', subject: 'x', body: 'y' })
    expect(res.ok).toBe(false)
    expect(res.message?.split('；').length).toBeGreaterThanOrEqual(3)
  })

  it('自带退订尾巴的模板存不进去', () => {
    const res = useAppStore.getState().saveTemplate(draft({ body: `${draft().body} Reply STOP to unsubscribe.` }))
    expect(res.ok).toBe(false)
    expect(res.message).toContain('不得自带退订语句')
  })

  it('自建模板可改，改完 id 不变、顺序不变', () => {
    const created = useAppStore.getState().saveTemplate(draft())
    const orderBefore = templates().map((t) => t.id)
    const updated = useAppStore.getState().saveTemplate({ ...draft({ name: '改过的名字' }), id: created.id })
    expect(updated.ok).toBe(true)
    expect(updated.id).toBe(created.id)
    expect(templates()).toHaveLength(orderBefore.length)
    expect(templates().map((t) => t.id)).toEqual(orderBefore)
    expect(templates().find((t) => t.id === created.id)?.name).toBe('改过的名字')
  })

  it('新建模板排在内置之后、其他自建之前（改完马上能看到）', () => {
    useAppStore.getState().saveTemplate(draft({ name: '第一版' }))
    const second = useAppStore.getState().saveTemplate(draft({ name: '第二版' }))
    const list = templates()
    expect(list.filter((t) => t.builtin)).toHaveLength(builtinCount())
    expect(list.findIndex((t) => t.id === second.id)).toBe(builtinCount())
  })

  it('id 唯一：连续新建不会撞号', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 8; i += 1) {
      const res = useAppStore.getState().saveTemplate(draft({ name: `模板 ${i}` }))
      expect(res.ok).toBe(true)
      ids.add(String(res.id))
    }
    expect(ids.size).toBe(8)
  })

  it('更新不存在的模板被拒（不静默新增）', () => {
    const res = useAppStore.getState().saveTemplate({ ...draft(), id: 'tpl_ghost' })
    expect(res.ok).toBe(false)
    expect(res.message).toContain('模板不存在')
    expect(templates()).toHaveLength(BASE.length)
  })
})

describe('F11 store · 内置模板不可篡改', () => {
  it('内置模板不可覆盖改内容', () => {
    const target = builtin()
    const res = useAppStore.getState().saveTemplate({ ...draft(), id: target.id })
    expect(res.ok).toBe(false)
    expect(res.message).toContain('内置模板不可修改')
    expect(templates().find((t) => t.id === target.id)?.body).toBe(target.body)
  })

  it('内置模板不可删除', () => {
    const res = useAppStore.getState().deleteTemplate(builtin().id)
    expect(res.ok).toBe(false)
    expect(res.message).toContain('内置模板不可删除')
    expect(builtinCount()).toBe(DEFAULT_TEMPLATES.length)
  })

  it('自建模板可删除', () => {
    const created = useAppStore.getState().saveTemplate(draft())
    expect(useAppStore.getState().deleteTemplate(String(created.id)).ok).toBe(true)
    expect(templates().some((t) => t.id === created.id)).toBe(false)
  })

  it('删除不存在的模板被拒', () => {
    expect(useAppStore.getState().deleteTemplate('tpl_ghost').ok).toBe(false)
  })

  it('删除只删中的那一条，其余原样', () => {
    const a = useAppStore.getState().saveTemplate(draft({ name: 'A 版' }))
    const b = useAppStore.getState().saveTemplate(draft({ name: 'B 版' }))
    useAppStore.getState().deleteTemplate(String(a.id))
    const list = templates()
    expect(list.some((t) => t.id === a.id)).toBe(false)
    expect(list.some((t) => t.id === b.id)).toBe(true)
    expect(list).toHaveLength(BASE.length + 1)
  })
})

describe('F11 store · 复制', () => {
  it('内置模板复制成自建模板，内容一致但 id / builtin / 名称不同', () => {
    const src = builtin()
    const res = useAppStore.getState().duplicateTemplate(src.id)
    expect(res.ok).toBe(true)
    const copy = templates().find((t) => t.id === res.id)
    expect(copy?.builtin).toBe(false)
    expect(copy?.body).toBe(src.body)
    expect(copy?.subject).toBe(src.subject)
    expect(copy?.name).toBe(`${src.name} · 副本`)
    expect(copy?.id).not.toBe(src.id)
    // 原件不动
    expect(templates().find((t) => t.id === src.id)?.name).toBe(src.name)
  })

  it('复制出来的模板可以改（这是「想改内置模板」的正确路径）', () => {
    const res = useAppStore.getState().duplicateTemplate(builtin().id)
    const edited = useAppStore.getState().saveTemplate({ ...draft({ name: '我的引言式' }), id: res.id })
    expect(edited.ok).toBe(true)
  })

  it('超长名称复制后仍在上限内，不会产出一个存不回去的模板', () => {
    const created = useAppStore.getState().saveTemplate(draft({ name: '名'.repeat(40) }))
    const res = useAppStore.getState().duplicateTemplate(String(created.id))
    expect(res.ok).toBe(true)
    const copy = templates().find((t) => t.id === res.id)
    expect((copy?.name ?? '').length).toBeLessThanOrEqual(40)
    // 复制品本身必须是可保存状态
    expect(useAppStore.getState().saveTemplate({ ...draft(), id: String(res.id) }).ok).toBe(true)
  })

  it('复制不存在的模板被拒', () => {
    expect(useAppStore.getState().duplicateTemplate('tpl_ghost').ok).toBe(false)
  })
})

describe('F11 store · 重置与持久化', () => {
  it('resetDemo 把模板库回到出厂集，自建模板一并清空', () => {
    useAppStore.getState().saveTemplate(draft())
    expect(templates().length).toBeGreaterThan(DEFAULT_TEMPLATES.length)
    useAppStore.getState().resetDemo()
    expect(templates()).toHaveLength(DEFAULT_TEMPLATES.length)
    expect(templates().every((t) => t.builtin)).toBe(true)
  })

  it('resetDemo 后的内置模板内容与出厂一致（没有被前面的用例污染）', () => {
    useAppStore.getState().resetDemo()
    expect(templates().map((t) => t.body)).toEqual(DEFAULT_TEMPLATES.map((t) => t.body))
  })

  it('持久化写入包含 templates 字段', async () => {
    useAppStore.getState().saveTemplate(draft({ name: '待落盘' }))
    const { flushSave } = await import('@/store/persistence')
    flushSave()
    const raw = memory.get('leadpilot.state.v1')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(String(raw))
    expect(Array.isArray(parsed.templates)).toBe(true)
    expect(parsed.templates.some((t: { name: string }) => t.name === '待落盘')).toBe(true)
  })
})
