/**
 * 客户详情里的「跟进序列进度」。
 *
 * 只读展示：显示当前客户按默认序列走到第几步、下一步最早哪天、
 * 以及该用哪封模板。**没有任何按钮会直接执行**——建草稿仍走写信按钮，
 * 由 `addOutreach` 再过一遍 G2 闸门与状态机白名单。
 *
 * 之所以放在详情页：序列如果只存在于设置面板里，就是「配了但没用」。
 */
import { Ban, Clock, Sparkles } from 'lucide-react'
import type { Company } from '@/types'
import { planFollowUp } from '@/domain/follow-up'
import { useAppStore } from '@/store/useAppStore'

export default function SequenceProgress({ company }: { company: Company }) {
  const sequences = useAppStore((s) => s.sequences)
  const templates = useAppStore((s) => s.templates)
  const outreach = useAppStore((s) => s.outreach)

  // 目前只有一个「默认序列」的概念：取列表第一条（内置序列排在最前）。
  // 不做「每个客户单独选序列」——那需要在客户表里再加一个字段与一套选择 UI，
  // 而当前并没有真实数据能说明用户需要多序列并存。
  const sequence = sequences[0]
  if (!sequence) return null

  // 已完成步数 = 该客户已有的草稿条数。不猜、不按天数推算。
  const completedSteps = outreach.filter((o) => o.companyId === company.id).length
  const plan = planFollowUp({
    sequence,
    startedAt: company.lastContactAt ?? null,
    completedSteps,
    status: company.status,
  })

  const templateName = (id: string) => templates.find((t) => t.id === id)?.name ?? '模板已删除'
  const next = plan.nextIndex ? plan.steps[plan.nextIndex - 1] : null

  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Sparkles size={11} className="text-brand-600" />
        <span className="text-[11px] font-medium text-slate-600">跟进序列 · {sequence.name}</span>
        <span className="text-[11px] text-muted">{sequence.steps.length} 步 · 只做提示，不自动发送</span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {plan.steps.map((step) => {
          const tone = step.state === 'done'
            ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
            : step.state === 'overdue'
              ? 'bg-rose-50 text-rose-700 ring-rose-200'
              : step.state === 'due'
                ? 'bg-amber-50 text-amber-700 ring-amber-200'
                : step.state === 'blocked'
                  ? 'bg-slate-100 text-slate-500 ring-slate-200'
                  : 'bg-white text-slate-500 ring-line'
          return (
            <span key={step.index} className={`rounded-md px-1.5 py-0.5 text-[11px] ring-1 ${tone}`}>
              {step.index}. {templateName(step.templateId)}
              {step.state === 'done' && ' · 已完成'}
              {step.state === 'overdue' && ` · 逾期 ${Math.abs(step.daysUntilDue ?? 0)} 天`}
              {step.state === 'due' && ' · 今天到期'}
              {step.state === 'waiting' && step.dueAt && ` · ${step.dueAt.slice(0, 10)}`}
            </span>
          )
        })}
      </div>

      {plan.blocked ? (
        <p className="mt-1.5 flex items-center gap-1 text-[11px] text-slate-500">
          <Ban size={11} /> {plan.reason}
        </p>
      ) : next ? (
        <p className="mt-1.5 flex items-center gap-1 text-[11px] text-brand-700">
          <Clock size={11} />
          现在可做第 {next.index} 步：建议用「{templateName(next.templateId)}」起草，是否执行由你决定
        </p>
      ) : (
        <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted">
          <Clock size={11} /> 还没到下一步时间{plan.steps[0]?.dueAt ? `，第一步最早 ${plan.steps[0].dueAt.slice(0, 10)}` : ''}
        </p>
      )}
    </div>
  )
}
