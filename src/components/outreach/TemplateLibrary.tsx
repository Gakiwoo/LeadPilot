/**
 * F11 · 模板库面板
 *
 * 交互上的三个决定：
 *  1. **内置模板只读**：点开只能「复制为我的模板」，编辑区对内置项直接锁字段。
 *     如果允许就地改，用户改坏一次就再也拿不回出厂措辞了。
 *  2. **边写边校验**：用 `validateTemplate` 实时算 issues，不是等点保存才报错。
 *     但真正的闸门在 store 的 `saveTemplate` 里——这里只是提前告知。
 *  3. **变量用插入而不是让用户手打**：白名单外的变量会被判非法，手打 {{company_name}}
 *     这种近似写法必然踩坑，给按钮最省事。
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Copy, Plus, Save, Trash2 } from 'lucide-react'
import {
  TEMPLATE_VARIABLES, validateTemplate,
  type EmailTemplate, type TemplateDraft, type TemplateStage,
} from '@/domain/email-template'
import { EMAIL_PURPOSES } from '@/domain/constants'
import { useAppStore } from '@/store/useAppStore'
import { Badge, Button, EmptyState, Field, Modal } from '@/components/ui'
import SequenceLibrary from './SequenceLibrary'

const STAGE_LABEL: Record<TemplateStage, string> = {
  intro: '首次触达',
  followup: '二次跟进',
  breakup: '收尾关闭',
}

const EMPTY_DRAFT: TemplateDraft = {
  name: '',
  stage: 'intro',
  purpose: 'intro',
  subject: '',
  body: '',
}

/** 已存模板 → 可编辑草稿 */
function toDraft(t: EmailTemplate): TemplateDraft {
  return { id: t.id, name: t.name, stage: t.stage, purpose: t.purpose, subject: t.subject, body: t.body }
}

export default function TemplateLibrary({ open, onClose, onPick }: {
  open: boolean
  onClose(): void
  /** 从写信页打开时传入：选中模板即套用并关闭 */
  onPick?(tpl: EmailTemplate): void
}) {
  const templates = useAppStore((s) => s.templates)
  const saveTemplate = useAppStore((s) => s.saveTemplate)
  const deleteTemplate = useAppStore((s) => s.deleteTemplate)
  const duplicateTemplate = useAppStore((s) => s.duplicateTemplate)
  const showToast = useAppStore((s) => s.showToast)

  const [draft, setDraft] = useState<TemplateDraft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<'templates' | 'sequences'>('templates')

  const selected = draft.id ? templates.find((t) => t.id === draft.id) ?? null : null
  const readOnly = Boolean(selected?.builtin)
  const check = useMemo(() => validateTemplate(draft), [draft])
  const builtins = templates.filter((t) => t.builtin)
  const customs = templates.filter((t) => !t.builtin)

  const patch = (p: Partial<TemplateDraft>) => setDraft((d) => ({ ...d, ...p }))

  const insertVar = (v: string) => {
    if (readOnly) return
    patch({ body: `${draft.body}${draft.body && !draft.body.endsWith(' ') ? ' ' : ''}{{${v}}}` })
  }

  const handleSave = () => {
    if (saving || readOnly) return
    setSaving(true)
    const res = saveTemplate(draft)
    setSaving(false)
    if (!res.ok) { showToast(res.message ?? '保存失败', 'error'); return }
    setDraft((d) => ({ ...d, id: res.id }))
    showToast('模板已保存（仅本地，未上传）', 'ok')
  }

  const handleDuplicate = () => {
    if (!draft.id) return
    const res = duplicateTemplate(draft.id)
    if (!res.ok || !res.id) { showToast(res.message ?? '复制失败', 'error'); return }
    const copy = useAppStore.getState().templates.find((t) => t.id === res.id)
    if (copy) setDraft(toDraft(copy))
    showToast('已复制为我的模板，可以放心修改', 'ok')
  }

  const handleDelete = () => {
    if (!draft.id) return
    const res = deleteTemplate(draft.id)
    if (!res.ok) { showToast(res.message ?? '删除失败', 'error'); return }
    setDraft(EMPTY_DRAFT)
    showToast('模板已删除', 'ok')
  }

  const renderRow = (t: EmailTemplate) => {
    const active = draft.id === t.id
    return (
      <button
        key={t.id}
        onClick={() => setDraft(toDraft(t))}
        className={`w-full rounded-lg border px-3 py-2 text-left transition ${active ? 'border-brand-200 bg-brand-50' : 'border-transparent hover:bg-canvas'}`}
      >
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-medium text-ink">{t.name}</span>
          {t.builtin && <Badge tone="slate">内置</Badge>}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted">{STAGE_LABEL[t.stage]} · {t.subject}</p>
      </button>
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="模板与跟进序列"
      width="960px"
      footer={
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted">
            {tab === 'templates'
              ? '合规尾巴与发件人身份由代码注入 · 模板不保存这两样'
              : '序列只给时间提示：不自动发送、不自动建草稿、不自动改客户状态'}
          </span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onClose}>关闭</Button>
          {tab === 'templates' && onPick && selected && (
            <Button variant="primary" size="sm" onClick={() => { onPick(selected); onClose() }}>套用这封模板</Button>
          )}
        </div>
      }
    >
      <div className="mb-3 flex items-center gap-1 border-b border-line">
        {([
          ['templates', '模板库'],
          ['sequences', '跟进序列'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-[12px] transition ${tab === key ? 'border-brand-500 font-medium text-brand-700' : 'border-transparent text-muted hover:text-slate-700'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'templates' ? (
      <div className="grid grid-cols-[240px_1fr] gap-4">
        {/* 左：模板列表 */}
        <div className="min-h-0 space-y-3">
          <Button variant="secondary" size="sm" className="w-full" onClick={() => setDraft(EMPTY_DRAFT)}>
            <Plus size={13} /> 新建模板
          </Button>

          <div>
            <p className="mb-1 px-1 text-[11px] font-medium text-muted">内置模板（{builtins.length}）</p>
            <div className="space-y-0.5">{builtins.map(renderRow)}</div>
          </div>

          <div>
            <p className="mb-1 px-1 text-[11px] font-medium text-muted">我的模板（{customs.length}）</p>
            {customs.length
              ? <div className="space-y-0.5">{customs.map(renderRow)}</div>
              : <p className="px-1 text-[11px] leading-4 text-muted">还没有自建模板。选中一个内置模板点「复制为我的模板」就能改。</p>}
          </div>
        </div>

        {/* 右：编辑区 */}
        <div className="space-y-3">
          {!draft.id && !draft.name && !draft.subject && !draft.body ? (
            <EmptyState
              title="左侧选一个模板，或新建"
              desc="模板只负责结构与措辞。退订语句与发件人身份由代码统一注入，所以不要在正文里自己写。"
            />
          ) : (
            <>
              {readOnly && (
                <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                  <AlertTriangle size={13} className="shrink-0" />
                  内置模板为只读基线：要改请点「复制为我的模板」，否则出厂措辞就回不去了。
                </div>
              )}

              <div className="grid grid-cols-3 gap-3">
                <Field label="模板名称" required>
                  <input value={draft.name} disabled={readOnly} maxLength={40}
                    onChange={(e) => patch({ name: e.target.value })} className="lp-input" placeholder="例如：报价 · 简短版" />
                </Field>
                <Field label="阶段">
                  <select value={draft.stage} disabled={readOnly}
                    onChange={(e) => patch({ stage: e.target.value as TemplateStage })} className="lp-input">
                    {(Object.keys(STAGE_LABEL) as TemplateStage[]).map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
                  </select>
                </Field>
                <Field label="本次目的">
                  <select value={draft.purpose} disabled={readOnly}
                    onChange={(e) => patch({ purpose: e.target.value })} className="lp-input">
                    {EMAIL_PURPOSES.map((p) => <option key={p.key} value={p.key}>{p.zh}</option>)}
                  </select>
                </Field>
              </div>

              <Field label="主题" required>
                <input value={draft.subject} disabled={readOnly} maxLength={120}
                  onChange={(e) => patch({ subject: e.target.value })} className="lp-input" placeholder="{{product}} for {{company}}" />
              </Field>

              <Field label="正文" hint="不要写退订语句与公司签名，代码会注入">
                <textarea value={draft.body} disabled={readOnly} readOnly={readOnly}
                  onChange={(e) => patch({ body: e.target.value })}
                  className="h-[180px] w-full resize-none rounded-lg border border-line px-3 py-2 text-[12px] leading-5 text-ink outline-none disabled:bg-canvas" />
              </Field>

              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-muted">插入变量：</span>
                {TEMPLATE_VARIABLES.map((v) => (
                  <button key={v} onClick={() => insertVar(v)} disabled={readOnly}
                    className="rounded-md bg-canvas px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-brand-50 hover:text-brand-700 disabled:opacity-50">
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>

              <div className={`rounded-lg border px-3 py-2 text-[11px] leading-4 ${check.ok ? 'border-emerald-200 bg-emerald-50/50 text-emerald-800' : 'border-rose-200 bg-rose-50/50 text-rose-800'}`}>
                <p className="flex items-center gap-1 font-medium">
                  {check.ok ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
                  {check.ok ? '可以保存：结构、变量与合规检查全部通过' : `还有 ${check.issues.length} 项需要处理`}
                </p>
                {!check.ok && <ul className="mt-1 list-disc space-y-0.5 pl-4">{check.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
              </div>

              <div className="flex items-center gap-2">
                <Button variant="primary" size="sm" disabled={readOnly || saving || !check.ok} onClick={handleSave}>
                  <Save size={13} /> {draft.id ? '保存修改' : '保存为新模板'}
                </Button>
                {draft.id && <Button size="sm" onClick={handleDuplicate}><Copy size={13} /> 复制为我的模板</Button>}
                {draft.id && !readOnly && <Button size="sm" onClick={handleDelete}><Trash2 size={13} /> 删除</Button>}
                <span className="ml-auto text-[11px] text-muted">
                  {draft.body.trim().length}/1200 字符 · 变量校验与 F6-2 禁词同一份词表
                </span>
              </div>
            </>
          )}
        </div>
      </div>
      ) : (
        <SequenceLibrary />
      )}
    </Modal>
  )
}
