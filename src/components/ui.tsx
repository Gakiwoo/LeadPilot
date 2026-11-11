import {
  cloneElement, isValidElement, useEffect, useId, useRef,
  type ButtonHTMLAttributes, type ReactElement, type ReactNode,
} from 'react'
import { AlertTriangle, Info, X } from 'lucide-react'
import { GRADE_LABELS, STATUS_DEFS } from '@/domain/constants'
import type { CompanyStatus, ContactGrade } from '@/types'

type Tone = 'slate' | 'blue' | 'emerald' | 'amber' | 'rose' | 'indigo' | 'violet' | 'cyan' | 'brand'

const TONE: Record<Tone, string> = {
  slate: 'bg-slate-50 text-slate-700 border-slate-200',
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
  rose: 'bg-rose-50 text-rose-700 border-rose-200',
  indigo: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  violet: 'bg-violet-50 text-violet-700 border-violet-200',
  cyan: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  brand: 'bg-brand-50 text-brand-700 border-brand-100',
}

export function Badge({ children, tone = 'slate', className = '' }: { children: ReactNode; tone?: Tone; className?: string }) {
  return <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4 ${TONE[tone]} ${className}`}>{children}</span>
}

export function StatusBadge({ status }: { status: CompanyStatus }) {
  // STATUS_DEFS 非空是常量事实，但 `find(...)[0]` 在开启 noUncheckedIndexedAccess 后是
  // `CompanyStatusDef | undefined`：这里显式兜底，避免「状态值不在表里」时整页崩白。
  const d = STATUS_DEFS.find((x) => x.key === status) ?? STATUS_DEFS[0] ?? { key: status, zh: String(status), en: String(status), tone: 'slate', terminal: false }
  return <Badge tone={d.tone as Tone}>{d.zh}</Badge>
}

export function GradeBadge({ grade }: { grade: ContactGrade }) {
  const g = GRADE_LABELS[grade]
  return <Badge tone={g.tone as Tone} className="font-semibold">{grade} · {g.name}</Badge>
}

export function scoreTone(v: number): Tone {
  if (v >= 80) return 'emerald'
  if (v >= 60) return 'blue'
  if (v >= 40) return 'slate'
  return 'rose'
}

export function ScoreBar({ value, label, compact = false }: { value: number; label?: string; compact?: boolean }) {
  const tone = scoreTone(value)
  const bar: Record<Tone, string> = {
    emerald: 'bg-emerald-500', blue: 'bg-blue-500', slate: 'bg-slate-400', rose: 'bg-rose-500',
    amber: 'bg-amber-500', indigo: 'bg-indigo-500', violet: 'bg-violet-500', cyan: 'bg-cyan-500', brand: 'bg-brand-500',
  }
  return (
    <div className={compact ? 'flex items-center gap-2' : 'space-y-1'}>
      {label && <span className="text-[11px] text-muted">{label}</span>}
      <div className={`flex items-center gap-2 ${compact ? '' : 'w-full'}`}>
        <span className={`tabular-nums font-semibold text-ink ${compact ? 'text-[12px] w-7 text-right' : 'text-sm'}`}>{value}</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
          <div className={`h-full rounded-full ${bar[tone]}`} style={{ width: `${Math.max(2, value)}%` }} />
        </div>
      </div>
    </div>
  )
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft'
  size?: 'sm' | 'md'
}

export function Button({ variant = 'secondary', size = 'md', className = '', children, ...rest }: BtnProps) {
  const base = 'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-45'
  const sizes = { sm: 'h-7 px-2.5 text-[12px]', md: 'h-9 px-3.5 text-[13px]' }
  const variants = {
    primary: 'bg-brand-500 text-white hover:bg-brand-600 shadow-sm',
    secondary: 'border border-line bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50',
    ghost: 'text-slate-600 hover:bg-slate-100',
    danger: 'border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100',
    soft: 'bg-brand-50 text-brand-700 hover:bg-brand-100',
  }
  return <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...rest}>{children}</button>
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`lp-card ${className}`}>{children}</div>
}

export function Field({ label, hint, children, required }: { label: string; hint?: string; children: ReactNode; required?: boolean }) {
  const id = useId()
  const labelId = `${id}-label`
  const hintId = hint ? `${id}-hint` : undefined
  // B3-5 · 单一控件（input/select/textarea）用 htmlFor 显式关联；
  // 复合控件组（关键词 chips、多选按钮组等）改用 role=group + aria-labelledby，
  // 避免把 label 指向一个 div 造成「有 label 但没有可访问名称」的假无障碍。
  const singleControl = isValidElement(children) && typeof children.type === 'string'
    && ['input', 'select', 'textarea'].includes(children.type)
  const control = singleControl
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id, 'aria-labelledby': labelId, 'aria-describedby': hintId,
      })
    : children
  return (
    <div role={singleControl ? undefined : 'group'} aria-labelledby={singleControl ? undefined : labelId}>
      {singleControl
        ? <label htmlFor={id} id={labelId} className="lp-label">{label}{required && <span className="ml-0.5 text-rose-500">*</span>}</label>
        : <span id={labelId} className="lp-label">{label}{required && <span className="ml-0.5 text-rose-500">*</span>}</span>}
      {control}
      {hint && <p id={hintId} className="mt-1 text-[11px] leading-4 text-muted">{hint}</p>}
    </div>
  )
}

export function SectionTitle({ title, desc, extra }: { title: string; desc?: string; extra?: ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-4">
      <div>
        <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
        {desc && <p className="mt-0.5 text-[12px] text-muted">{desc}</p>}
      </div>
      {extra}
    </div>
  )
}

export function StatTile({ label, value, sub, tone = 'slate' }: { label: string; value: string | number; sub?: string; tone?: Tone }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-[11px] text-muted">{label}</p>
      <p className="mt-1 text-[22px] font-semibold tabular-nums leading-7 text-ink">{value}</p>
      {sub && <p className={`mt-0.5 text-[11px] ${tone === 'rose' ? 'text-rose-600' : tone === 'emerald' ? 'text-emerald-600' : 'text-muted'}`}>{sub}</p>}
    </Card>
  )
}

export function Toggle({ checked, onChange, label, desc }: { checked: boolean; onChange: (v: boolean) => void; label: string; desc?: string }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-1.5">
      <span>
        <span className="block text-[13px] font-medium text-ink">{label}</span>
        {desc && <span className="mt-0.5 block text-[11px] leading-4 text-muted">{desc}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 h-5 w-9 shrink-0 rounded-full transition ${checked ? 'bg-brand-500' : 'bg-slate-300'}`}
      >
        <span className={`block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition ${checked ? 'translate-x-[18px]' : ''}`} />
      </button>
    </label>
  )
}

/**
 * B3-5 · 抽屉 / 弹窗的 dialog 语义与焦点陷阱。
 * Esc 关闭由 App 的全局 keydown 统一处理，这里只负责：打开时移入焦点、
 * Tab / Shift+Tab 在对话框内循环、关闭后把焦点还给触发元素。
 */
function useDialogA11y(open: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const focusable = () => Array.from(ref.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? [])
    focusable()[0]?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const items = focusable()
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && first && document.activeElement === first) { e.preventDefault(); last?.focus() }
      else if (!e.shiftKey && last && document.activeElement === last) { e.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [open])
  return { ref, titleId }
}

export function Drawer({ open, onClose, title, subtitle, children, footer, width = '60%' }: {
  open: boolean; onClose(): void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; width?: string
}) {
  const dialog = useDialogA11y(open)
  if (!open) return null
  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="flex-1 bg-ink/20 backdrop-blur-[1px]" onClick={onClose} />
      <div ref={dialog.ref} role="dialog" aria-modal="true" aria-labelledby={dialog.titleId}
        className="lp-slide flex h-full flex-col bg-white shadow-drawer" style={{ width }}>
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
          <div className="min-w-0">
            <div id={dialog.titleId} className="truncate text-[16px] font-semibold text-ink">{title}</div>
            {subtitle && <div className="mt-1 text-[12px] text-muted">{subtitle}</div>}
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted hover:bg-slate-100 hover:text-ink" aria-label="关闭"><X size={17} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="border-t border-line bg-slate-50/70 px-6 py-3">{footer}</div>}
      </div>
    </div>
  )
}

export function Modal({ open, onClose, title, children, footer, width = '640px' }: {
  open: boolean; onClose(): void; title: string; children: ReactNode; footer?: ReactNode; width?: string
}) {
  const dialog = useDialogA11y(open)
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/25 p-6" onClick={onClose}>
      <div ref={dialog.ref} role="dialog" aria-modal="true" aria-labelledby={dialog.titleId}
        className="lp-fade flex max-h-[88vh] w-full flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        style={{ maxWidth: width }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h3 id={dialog.titleId} className="text-[15px] font-semibold text-ink">{title}</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted hover:bg-slate-100" aria-label="关闭"><X size={17} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="border-t border-line bg-slate-50/70 px-5 py-3">{footer}</div>}
      </div>
    </div>
  )
}

export function EmptyState({ title, desc, action }: { title: string; desc?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line bg-white/60 px-6 py-14 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><Info size={19} /></div>
      <p className="text-[14px] font-medium text-ink">{title}</p>
      {desc && <p className="mt-1 max-w-md text-[12px] leading-5 text-muted">{desc}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

/** 演示模式提示：PRD 反复强调「不能假知道」，这根黄条常驻，不提供关闭 */
export function DemoBanner({ text }: { text?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
      <AlertTriangle size={14} className="shrink-0" />
      <span><strong>演示模式</strong> · {text ?? '采集、模型判断与 Gmail 均未真实接入，全部结果为本地预置数据。界面与评分逻辑为真实实现。'}</span>
    </div>
  )
}

export function ProgressLine({ value, tone = 'brand' }: { value: number; tone?: 'brand' | 'amber' | 'emerald' }) {
  const c = { brand: 'bg-brand-500', amber: 'bg-amber-500', emerald: 'bg-emerald-500' }[tone]
  return <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full transition-all duration-500 ${c}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>
}
