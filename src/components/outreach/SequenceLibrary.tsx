/**
 * F11 · 多步序列面板（模板库弹窗的第二个页签）
 *
 * 界面上要传达的第一件事不是「怎么配」，而是「它不会替你做什么」：
 * 页脚与预览区都明确写「只给时间提示，不自动发送、不自动建草稿」。
 *
 * 三个交互决定：
 *  1. **内置序列只读**：要改先「复制为我的序列」，与模板库同一条纪律。
 *  2. **边改边校验**：用 `validateSequence` 实时算 issues，但真正的闸门在 store 里。
 *  3. **预览只做一次静态推算**：用「今天开始」推各步到期日，不做任何持久化或调度。
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, ArrowRight, CheckCircle2, Copy, Plus, Save, Trash2 } from 'lucide-react'
import {
  MAX_SEQUENCE_STEPS, MIN_STEP_GAP_DAYS, MAX_STEP_GAP_DAYS,
  planFollowUp, sequenceSpanDays, validateSequence,
  type FollowUpSequence, type SequenceDraft,
} from '@/domain/follow-up'
import { useAppStore } from '@/store/useAppStore'
import { Badge, Button, EmptyState, Field } from '@/components/ui'

const EMPTY_DRAFT: SequenceDraft = {
  name: '',
  steps: [{ templateId: '', gapDays: 0, note: '' }],
}

function toDraft(s: FollowUpSequence): SequenceDraft {
  return {
    id: s.id,
    name: s.name,
    steps: s.steps.map((x) => ({ templateId: x.templateId, gapDays: x.gapDays, note: x.note ?? '' })),
  }
}

const fmtDate = (iso: string) => iso.slice(0, 10)

export default function SequenceLibrary() {
  const sequences = useAppStore((s) => s.sequences)
  const templates = useAppStore((s) => s.templates)
  const saveSequence = useAppStore((s) => s.saveSequence)
  const deleteSequence = useAppStore((s) => s.deleteSequence)
  const duplicateSequence = useAppStore((s) => s.duplicateSequence)
  const showToast = useAppStore((s) => s.showToast)

  const [draft, setDraft] = useState<SequenceDraft>(EMPTY_DRAFT)

  const selected = draft.id ? sequences.find((s) => s.id === draft.id) ?? null : null
  const readOnly = Boolean(selected?.builtin)
  const templateIds = useMemo(() => templates.map((t) => t.id), [templates])
  const check = useMemo(() => validateSequence(draft, { templateIds }), [draft, templateIds])

  const builtins = sequences.filter((s) => s.builtin)
  const customs = sequences.filter((s) => !s.builtin)

  // 预览：假设今天做第 1 步，各步最早什么时候到期。只算不存。
  const preview = useMemo(() => planFollowUp({
    sequence: { steps: draft.steps.map((s) => ({ templateId: s.templateId, gapDays: Number(s.gapDays) || 0 })) },
    startedAt: new Date().toISOString(),
    completedSteps: 0,
    status: 'new',
  }), [draft.steps])

  const patch = (p: Partial<SequenceDraft>) => setDraft((d) => ({ ...d, ...p }))
  const patchStep = (i: number, p: Partial<SequenceDraft['steps'][number]>) => setDraft((d) => ({
    ...d,
    steps: d.steps.map((s, idx) => (idx === i ? { ...s, ...p } : s)),
  }))

  const addStep = () => {
    if (readOnly || draft.steps.length >= MAX_SEQUENCE_STEPS) return
    const last = draft.steps[draft.steps.length - 1]
    patch({ steps: [...draft.steps, { templateId: '', gapDays: Math.max(MIN_STEP_GAP_DAYS, (Number(last?.gapDays) || 0) + 3), note: '' }] })
  }

  const removeStep = (i: number) => {
    if (readOnly || draft.steps.length <= 1) return
    patch({ steps: draft.steps.filter((_, idx) => idx !== i) })
  }

  const handleSave = () => {
    if (readOnly) return
    const res = saveSequence(draft)
    if (!res.ok) { showToast(res.message ?? '保存失败', 'error'); return }
    setDraft((d) => ({ ...d, id: res.id }))
    showToast('序列已保存（仅本地，未上传）', 'ok')
  }

  const handleDuplicate = () => {
    if (!draft.id) return
    const res = duplicateSequence(draft.id)
    if (!res.ok || !res.id) { showToast(res.message ?? '复制失败', 'error'); return }
    const copy = useAppStore.getState().sequences.find((s) => s.id === res.id)
    if (copy) setDraft(toDraft(copy))
    showToast('已复制为我的序列，可以放心修改', 'ok')
  }

  const handleDelete = () => {
    if (!draft.id) return
    const res = deleteSequence(draft.id)
    if (!res.ok) { showToast(res.message ?? '删除失败', 'error'); return }
    setDraft(EMPTY_DRAFT)
    showToast('序列已删除', 'ok')
  }

  const renderRow = (s: FollowUpSequence) => {
    const active = draft.id === s.id
    return (
      <button
        key={s.id}
        onClick={() => setDraft(toDraft(s))}
        className={`w-full rounded-lg border px-3 py-2 text-left transition ${active ? 'border-brand-200 bg-brand-50' : 'border-transparent hover:bg-canvas'}`}
      >
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-medium text-ink">{s.name}</span>
          {s.builtin && <Badge tone="slate">内置</Badge>}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted">
          {s.steps.length} 步 · 跨度 {sequenceSpanDays(s)} 天
        </p>
      </button>
    )
  }

  return (
    <div className="grid grid-cols-[240px_1fr] gap-4">
      {/* 左：序列列表 */}
      <div className="min-h-0 space-y-3">
        <Button variant="secondary" size="sm" className="w-full" onClick={() => setDraft(EMPTY_DRAFT)}>
          <Plus size={13} /> 新建序列
        </Button>

        <div>
          <p className="mb-1 px-1 text-[11px] font-medium text-muted">内置序列（{builtins.length}）</p>
          <div className="space-y-0.5">{builtins.map(renderRow)}</div>
        </div>

        <div>
          <p className="mb-1 px-1 text-[11px] font-medium text-muted">我的序列（{customs.length}）</p>
          {customs.length
            ? <div className="space-y-0.5">{customs.map(renderRow)}</div>
            : <p className="px-1 text-[11px] leading-4 text-muted">还没有自建序列。选中内置序列点「复制为我的序列」就能改间隔与模板。</p>}
        </div>
      </div>

      {/* 右：编辑区 */}
      <div className="space-y-3">
        {!draft.id && !draft.name && draft.steps.every((s) => !s.templateId) ? (
          <EmptyState
            title="左侧选一个序列，或新建"
            desc="序列只安排「什么时候用哪封模板」：不自动发送、不自动建草稿、不自动改客户状态。到点后仍需你手动确认。"
          />
        ) : (
          <>
            {readOnly && (
              <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                <AlertTriangle size={13} className="shrink-0" />
                内置序列为只读基线：要改请点「复制为我的序列」，否则出厂节奏就回不去了。
              </div>
            )}

            <Field label="序列名称" required>
              <input value={draft.name} disabled={readOnly} maxLength={40}
                onChange={(e) => patch({ name: e.target.value })} className="lp-input" placeholder="例如：展会后跟进 · 3 步" />
            </Field>

            <div className="space-y-2">
              {draft.steps.map((step, i) => (
                <div key={i} className="rounded-lg border border-line p-2.5">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-50 text-[11px] font-medium text-brand-700">{i + 1}</span>
                    <span className="text-[11px] font-medium text-slate-600">
                      {i === 0 ? '首发' : `第 ${i + 1} 步跟进`}
                    </span>
                    {i > 0 && (
                      <span className="text-[11px] text-muted">
                        距上一步至少
                        <input type="number" min={MIN_STEP_GAP_DAYS} max={MAX_STEP_GAP_DAYS}
                          value={step.gapDays} disabled={readOnly}
                          onChange={(e) => patchStep(i, { gapDays: Number(e.target.value) })}
                          className="mx-1 w-12 rounded border border-line px-1 py-0.5 text-center text-[11px] outline-none disabled:bg-canvas" />
                        天
                      </span>
                    )}
                    {draft.steps.length > 1 && !readOnly && (
                      <button onClick={() => removeStep(i)} className="ml-auto text-muted hover:text-rose-600" title="删除该步">
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-[1fr_1fr] gap-2">
                    <select value={step.templateId} disabled={readOnly}
                      onChange={(e) => patchStep(i, { templateId: e.target.value })} className="lp-input">
                      <option value="">选择模板…</option>
                      {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                    <input value={step.note ?? ''} disabled={readOnly} maxLength={60}
                      onChange={(e) => patchStep(i, { note: e.target.value })}
                      className="lp-input" placeholder="这一步的用意（可选）" />
                  </div>
                </div>
              ))}

              {draft.steps.length < MAX_SEQUENCE_STEPS && !readOnly && (
                <Button size="sm" variant="ghost" onClick={addStep}>
                  <Plus size={13} /> 增加一步（最多 {MAX_SEQUENCE_STEPS} 步）
                </Button>
              )}
            </div>

            <div className="rounded-lg border border-line bg-canvas px-3 py-2">
              <p className="text-[11px] font-medium text-slate-600">排期预览（假设今天完成第 1 步）</p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                {preview.steps.map((p, i) => (
                  <span key={i} className="flex items-center gap-1">
                    {i > 0 && <ArrowRight size={11} className="text-slate-300" />}
                    <span className="rounded bg-white px-1.5 py-0.5 ring-1 ring-line">
                      {p.dueAt ? fmtDate(p.dueAt) : `第 ${p.index} 步`}
                    </span>
                  </span>
                ))}
                <span className="ml-1">· 跨度 {sequenceSpanDays(draft)} 天</span>
              </div>
              <p className="mt-1.5 text-[11px] leading-4 text-muted">
                仅预览：不写库、不排程。到期后在建草稿时会先过 G2 闸门与状态机白名单，退订 / 已回复的客户直接拒绝。
              </p>
            </div>

            <div className={`rounded-lg border px-3 py-2 text-[11px] leading-4 ${check.ok ? 'border-emerald-200 bg-emerald-50/50 text-emerald-800' : 'border-rose-200 bg-rose-50/50 text-rose-800'}`}>
              <p className="flex items-center gap-1 font-medium">
                {check.ok ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
                {check.ok ? '可以保存：步数、间隔与模板引用全部有效' : `还有 ${check.issues.length} 项需要处理`}
              </p>
              {!check.ok && <ul className="mt-1 list-disc space-y-0.5 pl-4">{check.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
            </div>

            <div className="flex items-center gap-2">
              <Button variant="primary" size="sm" disabled={readOnly || !check.ok} onClick={handleSave}>
                <Save size={13} /> {draft.id ? '保存修改' : '保存为新序列'}
              </Button>
              {draft.id && <Button size="sm" onClick={handleDuplicate}><Copy size={13} /> 复制为我的序列</Button>}
              {draft.id && !readOnly && <Button size="sm" onClick={handleDelete}><Trash2 size={13} /> 删除</Button>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
