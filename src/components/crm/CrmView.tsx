import { useMemo, useState } from 'react'
import { Download, KanbanSquare, LayoutList, Save, TrendingUp } from 'lucide-react'
import type { Company, CompanyStatus } from '@/types'
import { STATUS_DEFS } from '@/domain/constants'
import { toCsv, downloadCsv } from '@/domain/compliance'
import { useAppStore } from '@/store/useAppStore'
import { Badge, Button, Card, EmptyState, GradeBadge, SectionTitle, StatTile, StatusBadge } from '@/components/ui'

const BOARD_COLUMNS: CompanyStatus[] = ['new', 'drafted', 'sent', 'replied', 'interested', 'won']

export default function CrmView() {
  const [view, setView] = useState<'table' | 'board'>('table')
  const companies = useAppStore((s) => s.companies)
  const outreach = useAppStore((s) => s.outreach)
  const updateCompany = useAppStore((s) => s.updateCompany)
  const setCompanyStatus = useAppStore((s) => s.setCompanyStatus)
  const showToast = useAppStore((s) => s.showToast)
  const [dragOver, setDragOver] = useState<CompanyStatus | null>(null)

  // F9-1 自动归集：产生过建草稿 / 发送 / 手动标记状态 / 加备注行为即进入 CRM 主表
  const crmCompanies = useMemo(() => companies.filter((c) =>
    c.status !== 'new' || !!c.note || outreach.some((o) => o.companyId === c.id),
  ), [companies, outreach])

  const stats = useMemo(() => {
    const sent = crmCompanies.filter((c) => ['sent', 'delivered', 'opened', 'replied', 'interested', 'quoted', 'won'].includes(c.status)).length
    const replied = crmCompanies.filter((c) => ['replied', 'interested', 'quoted', 'won'].includes(c.status)).length
    const interested = crmCompanies.filter((c) => c.status === 'interested' || c.status === 'won').length
    return {
      total: crmCompanies.length, sent, replied, interested,
      replyRate: sent ? ((replied / sent) * 100).toFixed(1) : '0.0',
      bounced: crmCompanies.filter((c) => c.status === 'bounced').length,
    }
  }, [crmCompanies])

  const exportAll = () => {
    const headers = ['公司名', '国家', '综合分', '匹配度', '采购概率', '规模', '进口可能性', '联系方式', '客户类型', '状态', '最后联系', '下次跟进', '归属任务', '备注']
    const csv = toCsv(headers, crmCompanies.map((c) => [
      c.name, c.country, c.scoreCard.totalDisplay, c.scoreCard.dimensions.match.score,
      c.scoreCard.dimensions.propensity.score, c.sizeTier, c.scoreCard.dimensions.import.score,
      c.contacts[0]?.grade ?? '', c.customerTypes.join('/'),
      STATUS_DEFS.find((s) => s.key === c.status)?.zh ?? c.status,
      c.lastContactAt ? c.lastContactAt.slice(0, 10) : '', c.nextFollowAt ?? '', c.sourceTaskId, c.note,
    ]))
    downloadCsv(`LeadPilot-CRM-${new Date().toISOString().slice(0, 10)}.csv`, csv)
    showToast(`已导出 CRM 主表 ${crmCompanies.length} 行（UTF-8 BOM）`, 'ok')
  }

  const onDrop = (status: CompanyStatus, e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(null)
    const id = e.dataTransfer.getData('text/plain')
    if (!id) return
    const r = setCompanyStatus(id, status)
    if (r.needsConfirm) { if (window.confirm(`${r.message}\n\n确认继续？`)) setCompanyStatus(id, status, { confirmed: true }) }
    else if (!r.ok) showToast(r.message ?? '状态不可流转', 'error')
    else showToast(`已拖拽更新为「${STATUS_DEFS.find((s) => s.key === status)?.zh}」`, 'ok')
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-5 gap-3">
        <StatTile label="客户总数" value={stats.total} sub="自动归集：产生过行为即入主表" />
        <StatTile label="已发送" value={stats.sent} sub="发送不额外计费" />
        <StatTile label="已回复" value={stats.replied} sub={`回复率 ${stats.replyRate}%`} tone="emerald" />
        <StatTile label="有意向" value={stats.interested} sub="北极星指标 PRW 计数态" tone="emerald" />
        <StatTile label="退信" value={stats.bounced} sub={stats.bounced ? '需治理：硬退信率 > 3% 触发熔断' : '硬退信率 0.0%'} tone="rose" />
      </div>

      <Card className="p-3">
        <div className="flex items-center gap-1.5">
          <button onClick={() => setView('table')} className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium ${view === 'table' ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}><LayoutList size={13} /> 表格视图</button>
          <button onClick={() => setView('board')} className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium ${view === 'board' ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}><KanbanSquare size={13} /> 看板视图</button>
          <span className="ml-auto flex items-center gap-1.5">
            <Button size="sm" onClick={() => showToast('已保存为「我的视图」（演示：视图配置持久化在桌面版）')}><Save size={12} /> 保存视图</Button>
            <Button size="sm" onClick={exportAll}><Download size={12} /> 导出 CSV</Button>
          </span>
        </div>
      </Card>

      {view === 'table' ? (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <SectionTitle title="CRM 主表" desc="状态、备注、自定义字段支持行内编辑，不弹窗" />
            <Badge tone="brand">{crmCompanies.length} 行</Badge>
          </div>
          {crmCompanies.length === 0 ? (
            <div className="p-6"><EmptyState title="还没有客户进入 CRM" desc="任一客户产生建草稿、发送、手动标记状态或加备注行为后，会自动归集到主表。" /></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1000px] text-[12px]">
                <thead className="bg-canvas text-[10px] uppercase tracking-wide text-muted">
                  <tr>{['公司名', '国家', '综合分', '联系方式', '状态', '最后联系', '下次跟进', '归属任务', '备注（行内可编辑）'].map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {crmCompanies.map((c: Company) => (
                    <tr key={c.id} className="border-t border-line hover:bg-slate-50/60">
                      <td className="px-3 py-2 font-medium text-ink">{c.name}<div className="text-[10px] font-normal text-muted">{c.domain}</div></td>
                      <td className="px-3 py-2">{c.flag} {c.country}</td>
                      <td className="px-3 py-2 font-semibold tabular-nums">{c.scoreCard.totalDisplay}</td>
                      <td className="px-3 py-2"><GradeBadge grade={c.contacts[0]?.grade ?? 'D'} /></td>
                      <td className="px-3 py-2"><StatusBadge status={c.status} /></td>
                      <td className="px-3 py-2 text-[11px] text-muted">{c.lastContactAt ? c.lastContactAt.slice(0, 10) : '—'}</td>
                      <td className="px-3 py-2 text-[11px] text-amber-700">{c.nextFollowAt ?? '—'}</td>
                      <td className="px-3 py-2 font-mono text-[10px] text-muted">{c.sourceTaskId}</td>
                      <td className="px-3 py-2"><input value={c.note} onChange={(e) => updateCompany(c.id, { note: e.target.value })} placeholder="点击输入备注" className="w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-[11px] outline-none hover:border-line focus:border-brand-500 focus:bg-white" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : (
        <div className="grid grid-cols-6 gap-2.5">
          {BOARD_COLUMNS.map((status) => {
            const def = STATUS_DEFS.find((s) => s.key === status)!
            const items = crmCompanies.filter((c) => c.status === status)
            return (
              <div key={status}
                onDragOver={(e) => { e.preventDefault(); setDragOver(status) }}
                onDragLeave={() => setDragOver(null)}
                onDrop={(e) => onDrop(status, e)}
                className={`min-h-[320px] rounded-xl border p-2.5 transition ${dragOver === status ? 'border-brand-500 bg-brand-50' : 'border-line bg-canvas'}`}
              >
                <div className="mb-2 flex items-center gap-1.5"><StatusBadge status={status} /><span className="ml-auto text-[11px] tabular-nums text-muted">{items.length}</span></div>
                <div className="space-y-1.5">
                  {items.slice(0, 12).map((c) => (
                    <div key={c.id} draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', c.id)}
                      className="cursor-grab rounded-lg border border-line bg-white px-2.5 py-2 shadow-sm active:cursor-grabbing">
                      <p className="truncate text-[11px] font-medium text-ink">{c.name}</p>
                      <p className="mt-0.5 text-[10px] text-muted">{c.flag} {c.country} · {c.contacts[0]?.grade} 级</p>
                      <div className="mt-1.5 flex items-center justify-between"><span className="text-[12px] font-semibold tabular-nums text-brand-600">{c.scoreCard.totalDisplay}</span><span className="text-[10px] text-muted">{def.zh}</span></div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Card className="p-4">
          <SectionTitle title="状态漏斗" desc="各状态数量与转化率（演示数据）" />
          <div className="space-y-1.5">
            {STATUS_DEFS.filter((s) => crmCompanies.some((c) => c.status === s.key)).map((s) => {
              const n = crmCompanies.filter((c) => c.status === s.key).length
              return (
                <div key={s.key} className="flex items-center gap-2 text-[11px]">
                  <span className="w-20 shrink-0 text-muted">{s.zh}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.max(3, (n / Math.max(1, crmCompanies.length)) * 100 * 2.5)}%` }} /></div>
                  <span className="w-6 text-right tabular-nums text-ink">{n}</span>
                </div>
              )
            })}
          </div>
        </Card>
        <Card className="p-4">
          <SectionTitle title="效果对比与跟进" desc="哪类客户回复率高 → 反过来指导任务筛选条件（产品内闭环）" />
          <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-[11px] text-emerald-800">
            <TrendingUp size={14} /> 演示洞察：有海关进口记录的客户回复率约为无记录客户的 2.1 倍
          </div>
          <div className="mt-3 space-y-1.5">
            {companies.filter((c) => c.followups.length).slice(0, 5).map((c) => (
              <div key={c.id} className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-[11px]">
                <span className="font-medium text-ink">{c.name}</span>
                <span className="ml-auto text-amber-700">{c.followups[0].dueDate} · {c.followups[0].content}</span>
              </div>
            ))}
            {companies.filter((c) => c.followups.length).length === 0 && <p className="text-[11px] text-muted">暂无跟进任务</p>}
          </div>
        </Card>
      </div>
    </div>
  )
}
