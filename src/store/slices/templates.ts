/**
 * slice · 模板库（F11 第一步）
 *
 * 三条硬边界：
 *  1. **保存前必过 `validateTemplate`** —— 不合法的模板不进 state。UI 层的实时提示是
 *     体验，这道校验才是闸门；两者不能只留一个。
 *  2. **内置模板不可覆盖、不可删除** —— 覆盖了就没有基线可回退，用户「改坏一个内置模板」
 *     后就再也拿不回出厂措辞。想改就复制一份再改。
 *  3. 合规尾巴与发件人身份永远由代码注入（PRD F6-5），所以模板本身不存这两样东西，
 *     校验层也会拦下自带尾巴的正文。
 *
 * 本片不涉及多步序列（follow-up 排期），那是 F11 的第二步。
 */
import type { StateCreator } from 'zustand'
import {
  DEFAULT_TEMPLATES, validateTemplate,
  type EmailTemplate, type TemplateDraft,
} from '@/domain/email-template'
import type { AppState } from '../types'

export type TemplatesSlice = Pick<AppState,
  | 'saveTemplate' | 'deleteTemplate' | 'duplicateTemplate'>

/** 内置模板的 id 前缀是契约的一部分：UI 靠它区分「可编辑」与「只读」 */
const BUILTIN_PREFIX = 'tpl_builtin_'

const isBuiltin = (id: string) => id.startsWith(BUILTIN_PREFIX)

/** 不用 crypto.randomUUID：老 WebView 与测试环境不一定有，且 id 只需要局部唯一 */
function newTemplateId(existing: EmailTemplate[]): string {
  const base = `tpl_${Date.now().toString(36)}`
  let id = base
  let n = 1
  while (existing.some((t) => t.id === id)) { n += 1; id = `${base}_${n}` }
  return id
}

export const createTemplatesSlice: StateCreator<AppState, [], [], TemplatesSlice> = (set, get) => ({
  // 初始值由 demo-bootstrap 统一提供，slice 不造数据
  saveTemplate: (draft: TemplateDraft) => {
    const name = String(draft?.name ?? '').trim()
    const subject = String(draft?.subject ?? '').trim()
    const body = String(draft?.body ?? '').trim()
    const purpose = String(draft?.purpose ?? '')

    const checked = validateTemplate({ name, subject, body, purpose })
    if (!checked.ok) {
      // 全部 issue 都带回去：只回第一条会让用户改一处、再报下一处，来回拉扯
      return { ok: false, message: checked.issues.join('；') }
    }

    const list = get().templates
    const targetId = String(draft?.id ?? '').trim()

    if (targetId) {
      if (isBuiltin(targetId)) {
        return { ok: false, message: '内置模板不可修改：请先「复制为我的模板」再改，否则出厂措辞就回不去了' }
      }
      if (!list.some((t) => t.id === targetId)) {
        return { ok: false, message: '模板不存在，可能已被删除' }
      }
      set((s) => ({
        templates: s.templates.map((t) => t.id === targetId
          ? { ...t, name, subject, body, purpose, stage: draft.stage, demo: false }
          : t),
      }))
      return { ok: true, id: targetId }
    }

    const id = newTemplateId(list)
    const created: EmailTemplate = {
      id, name, subject, body, purpose, stage: draft.stage, builtin: false, demo: false,
    }
    // 新模板排在内置模板之后、同类自建模板之前 —— 用户改完就想马上看到，放最上面更顺手
    set((s) => {
      const builtins = s.templates.filter((t) => t.builtin)
      const customs = s.templates.filter((t) => !t.builtin)
      return { templates: [...builtins, created, ...customs] }
    })
    return { ok: true, id }
  },

  deleteTemplate: (id: string) => {
    if (isBuiltin(id)) {
      return { ok: false, message: '内置模板不可删除：它是模板库的基线，删掉就找不回出厂措辞了' }
    }
    if (!get().templates.some((t) => t.id === id)) {
      return { ok: false, message: '模板不存在或已删除' }
    }
    set((s) => ({ templates: s.templates.filter((t) => t.id !== id) }))
    return { ok: true }
  },

  duplicateTemplate: (id: string) => {
    const source = get().templates.find((t) => t.id === id)
    if (!source) return { ok: false, message: '模板不存在或已删除' }
    const copy: EmailTemplate = {
      ...source,
      id: newTemplateId(get().templates),
      // 名称加后缀可能超 40 字上限，超了就截断再拼，别让「复制」产出一个存不回去的模板
      name: `${source.name.slice(0, 32)} · 副本`,
      builtin: false,
      demo: false,
    }
    set((s) => {
      const builtins = s.templates.filter((t) => t.builtin)
      const customs = s.templates.filter((t) => !t.builtin)
      return { templates: [...builtins, copy, ...customs] }
    })
    return { ok: true, id: copy.id }
  },
})

/** resetDemo 复用：回到出厂模板集 */
export function builtinTemplates(): EmailTemplate[] {
  return DEFAULT_TEMPLATES.map((t) => ({ ...t }))
}
