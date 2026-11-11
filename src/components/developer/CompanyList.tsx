import { useMemo, useState } from 'react'
import { ArrowDownUp, Ban, ChevronDown, Download, FileText, Mail, ShieldAlert, SlidersHorizontal } from 'lucide-react'
import type { Company, CompanyStatus } from '@/types'
import { CUSTOMER_TYPES, STATUS_DEFS } from '@/domain/constants'
import { QUICK_FILTERS, filterAndSort } from '@/domain/filters'
import { toCsv, downloadCsv } from '@/domain/compliance'
import { generateEmails } from '@/services/adapters'
import { useAppStore } from '@/store/useAppStore'
import { Badge, Button, Card, EmptyState, GradeBadge, ScoreBar, SectionTitle } from '@/components/ui'

export default function CompanyList() {
  const companies = useAppStore((s) => s.companies)
  const filters = useAppStore((s) => s.filters)
  const setFilters = useAppStore((s) => s.setFilters)
  const openCompany = useAppStore((s) => s.openCompany)
  const openComposer = useAppStore((s) => s.openComposer)
  const selectedIds = useAppStore((s) => s.selectedIds)
  const toggleSelect = useAppStore((s) => s.toggleSelect)
  const selectAll = useAppStore((s) => s.selectAll)
  const clearSelection = useAppStore((s) => s.clearSelection)
  const setCompanyStatus = useAppStore((s) => s.setCompanyStatus)
  const batchSetStatus = useAppStore((s) => s.batchSetStatus)
  const addOutreach = useAppStore((s) => s.addOutreach)
  const settings = useAppStore((s) => s.settings)
  const showToast = useAppStore((s) => s.showToast)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const rows = useMemo(() => filterAndSort(companies, filters), [companies, filters])
  const visibleIds = rows.map((c) => c.id)
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id))
  const selectedCompanies = companies.filter((c) => selectedIds.includes(c.id))

  const exportSelected = () => {
    const headers = ['公司名', '域名', '国家', '综合分', '匹配度', '采购概率', '规模', '进口可能性', '联系方式', '客户类型', '状态', '备注']
    const csv = toCsv(headers, selectedCompanies.map((c) => [
      c.name, c.domain, c.country, c.scoreCard.totalDisplay,
      c.scoreCard.dimensions.match.score, c.scoreCard.dimensions.propensity.score,
      c.sizeTier, c.scoreCard.dimensions.import.score, c.contacts[0]?.grade ?? '',
      c.customerTypes.map((t) => CUSTOMER_TYPES.find((x) => x.key === t)?.zh).join('/'),
      STATUS_DEFS.find((s) => s.key === c.status)?.zh ?? c.status, c.note,
    ]))
    downloadCsv(`LeadPilot-选中客户-${new Date().toISOString().slice(0, 10)}.csv`, csv)
    showToast(`已导出 ${selectedCompanies.length} 家（UTF-8 BOM，Excel 中文不乱码）`, 'ok')
  }

  const batchDraft = () => {
    const targets = selectedCompanies.filter((c) => ['A', 'B'].includes(c.contacts[0]?.grade ?? '')).slice(0, 50)
    if (!targets.length) { showToast('选中客户中没有 A/B 级可发信邮箱，未创建草稿', 'warn'); return }
    let created = 0
    let blocked = 0
    for (const c of targets) {
      const mail = generateEmails(c, settings.profile, { purpose: 'intro', tone: 'concise', length: 'short' })[0]
      const r = addOutreach({
        id: `out_${Date.now()}_${c.id}`, companyId: c.id, contactId: c.contacts[0]?.id ?? '',
        subject: mail.subject, bodyText: mail.body, bodyHtml: `<pre>${mail.body}</pre>`,
        language: 'en', purpose: 'intro', status: 'draft',
        personalizationTags: mail.tags, validation: mail.validation,
        createdAt: new Date().toISOString(), demo: true,
      })
      if (r.ok) created += 1
      else blocked += 1
    }
    showToast(blocked
      ? `已为 ${created} 家创建本地草稿，${blocked} 家因状态不可流转被拒（退订/无效为不可逆终态）`
      : `已为 ${created} 家创建本地草稿（演示：未调用 Gmail API）；批量直接发送不提供`, blocked ? 'warn' : 'ok')
    if (created) clearSelection()
  }

  return (
    <div className="space-y-3">
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {QUICK_FILTERS.map((q) => (
            <button key={q.key} onClick={() => setFilters({ quick: q.key })} className={`rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition ${filters.quick === q.key ? 'bg-brand-500 text-white' : 'bg-canvas text-slate-600 hover:bg-slate-100'}`}>{q.label}</button>
          ))}
          <div className="ml-auto flex items-center gap-1.5">
            <button onClick={() => setShowAdvanced(!showAdvanced)} className={`lp-chip ${showAdvanced ? 'border-brand-500 text-brand-700' : ''}`}><SlidersHorizontal size={11} /> 高级筛选</button>
            <select value={filters.sort} onChange={(e) => setFilters({ sort: e.target.value as typeof filters.sort })} className="lp-input h-7 w-36 py-0 text-[11px]">
              <option value="default">可发信优先 · 综合分</option>
              <option value="total">纯综合分</option>
              <option value="propensity">采购概率</option>
              <option value="import">进口可能性</option>
              <option value="name">公司名 A–Z</option>
              <option value="discovered">发现时间</option>
            </select>
          </div>
        </div>
        {showAdvanced && (
          <div className="lp-fade mt-3 flex flex-wrap items-center gap-4 border-t border-line pt-3 text-[11px]">
            <label className="flex items-center gap-2">最低综合分 <input type="number" min={0} max={100} value={filters.minScore} onChange={(e) => setFilters({ minScore: Number(e.target.value) })} className="lp-input h-7 w-20 py-0" /></label>
            <label className="flex items-center gap-2">邮箱等级
              <select value={filters.grade} onChange={(e) => setFilters({ grade: e.target.value as typeof filters.grade })} className="lp-input h-7 w-20 py-0">
                <option value="ALL">全部</option>{['A', 'B', 'C', 'D'].map((g) => <option key={g} value={g}>{g} 级</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={filters.hideCompetitors} onChange={(e) => setFilters({ hideCompetitors: e.target.checked })} className="accent-brand-500" /> 折叠疑似同行（默认开启）</label>
            <span className="ml-auto flex items-center gap-1 text-muted"><ArrowDownUp size={12} /> 命中 {rows.length} 家 · 共 {companies.length} 家</span>
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <SectionTitle title="客户名单" desc="默认按「可发信性优先，再按综合分降序」· 点击行查看五维证据链" />
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <Badge tone="amber"><ShieldAlert size={11} /> 演示数据</Badge>
            <span>共 {rows.length} 条</span>
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="p-6"><EmptyState title="没有符合条件的客户" desc="放宽快捷筛选或最低分后再试；结果不足时应提供「放宽条件续采」而不是空列表。" /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] border-collapse text-[12px]">
              <thead className="bg-canvas text-[10px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="w-10 px-3 py-2"><input type="checkbox" checked={allSelected} onChange={() => allSelected ? clearSelection() : selectAll(visibleIds)} className="accent-brand-500" /></th>
                  <th className="px-2 py-2 text-left font-medium">公司名</th>
                  <th className="w-[92px] px-2 py-2 text-left font-medium">综合分</th>
                  <th className="w-16 px-2 py-2 text-left font-medium">匹配度</th>
                  <th className="w-16 px-2 py-2 text-left font-medium">采购概率</th>
                  <th className="w-14 px-2 py-2 text-left font-medium">规模</th>
                  <th className="w-[88px] px-2 py-2 text-left font-medium">进口可能</th>
                  <th className="w-[112px] px-2 py-2 text-left font-medium">联系方式</th>
                  <th className="w-[124px] px-2 py-2 text-left font-medium">客户类型</th>
                  <th className="w-[124px] px-2 py-2 text-left font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c: Company) => (
                  <tr
                    key={c.id}
                    className="group cursor-pointer border-t border-line hover:bg-brand-50/40"
                    style={{ contentVisibility: 'auto', containIntrinsicSize: '48px' }}
                    onClick={(e) => { toggleSelect(c.id, e.shiftKey) }}
                    onDoubleClick={() => openCompany(c.id)}
                  >
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selectedIds.includes(c.id)} onChange={() => toggleSelect(c.id)} className="accent-brand-500" />
                    </td>
                    <td className="px-2 py-2">
                      <button onClick={(e) => { e.stopPropagation(); openCompany(c.id) }} className="block max-w-[250px] truncate text-left font-medium text-ink hover:text-brand-600">{c.name}</button>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted"><span>{c.flag} {c.country}</span><span className="text-slate-300">·</span><span className="truncate">{c.domain}</span></div>
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[15px] font-semibold tabular-nums ${c.scoreCard.confidence === 'low' ? 'text-amber-600' : 'text-ink'}`}>{c.scoreCard.totalDisplay}</span>
                        {c.scoreCard.confidence === 'low' && <Badge tone="amber">低置信</Badge>}
                      </div>
                      <div className="mt-1"><ScoreBar value={c.scoreCard.totalScore} compact /></div>
                    </td>
                    <td className="px-2 py-2 tabular-nums">{c.scoreCard.dimensions.match.displayValue}</td>
                    <td className="px-2 py-2 tabular-nums">{c.scoreCard.dimensions.propensity.displayValue}</td>
                    <td className="px-2 py-2"><Badge tone="slate">{c.scoreCard.dimensions.size.displayValue}</Badge></td>
                    <td className="px-2 py-2">
                      <span className="tabular-nums">{c.scoreCard.dimensions.import.displayValue}</span>
                      <span className="ml-1 text-[10px] text-muted">{c.features.customsRecords !== null ? '已证实' : '推断'}</span>
                    </td>
                    <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}><GradeBadge grade={c.contacts[0]?.grade ?? 'D'} /></td>
                    <td className="px-2 py-2">
                      <div className="flex flex-wrap gap-1">
                        {c.customerTypes.slice(0, 2).map((t) => <Badge key={t} tone="brand">{CUSTOMER_TYPES.find((x) => x.key === t)?.zh}</Badge>)}
                        {c.customerTypes.length > 2 && <span className="text-[10px] text-muted">+{c.customerTypes.length - 2}</span>}
                      </div>
                    </td>
                    <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                      <select
                        value={c.status}
                        onChange={(e) => {
                          const r = setCompanyStatus(c.id, e.target.value as CompanyStatus)
                          if (r.needsConfirm) {
                            if (window.confirm(`${r.message}\n\n确认继续？`)) setCompanyStatus(c.id, e.target.value as CompanyStatus, { confirmed: true })
                          } else if (!r.ok) showToast(r.message ?? '状态不可流转', 'error')
                        }}
                        className="h-7 w-[112px] rounded-md border border-line bg-white px-1.5 text-[11px] text-slate-700 outline-none focus:border-brand-500"
                      >
                        {STATUS_DEFS.map((s) => <option key={s.key} value={s.key}>{s.zh}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selectedIds.length > 0 && (
        <div className="lp-fade sticky bottom-4 z-20 flex items-center gap-2 rounded-xl border border-brand-100 bg-white px-4 py-2.5 shadow-lg">
          <span className="text-[12px] font-medium text-ink">已选 {selectedIds.length} 家</span>
          <span className="text-[11px] text-muted">· 批量与真发之间必须保留人的一次确认</span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Button size="sm" onClick={() => { openComposer(selectedCompanies[0]?.id ?? null); showToast('批量生成开发信：演示模式先打开单封编辑器（一次生成 2 版）') }}><FileText size={12} /> 批量生成开发信</Button>
            <Button size="sm" onClick={batchDraft}><Mail size={12} /> 批量建草稿（≤50）</Button>
            <select
              defaultValue=""
              onChange={(e) => { if (!e.target.value) return; const r = batchSetStatus(selectedIds, e.target.value as CompanyStatus); if (r.needsConfirm && window.confirm(`${r.message}\n\n确认继续？`)) batchSetStatus(selectedIds, e.target.value as CompanyStatus, true); e.target.value = '' }}
              className="lp-input h-7 w-28 py-0 text-[11px]"
            >
              <option value="">批量改状态</option>
              {STATUS_DEFS.filter((s) => !s.terminal).map((s) => <option key={s.key} value={s.key}>→ {s.zh}</option>)}
            </select>
            <Button size="sm" onClick={exportSelected}><Download size={12} /> 导出选中</Button>
            <Button size="sm" variant="danger" onClick={() => {
              if (!window.confirm('标记为「退订/无效」会写入全局黑名单且不可逆，确认？')) return
              batchSetStatus(selectedIds, 'unsubscribed', true)
              showToast('已加入全局黑名单：所有账号、任务、模板一律不可再发', 'warn')
            }}><Ban size={12} /> 加入黑名单</Button>
            <Button size="sm" variant="ghost" onClick={clearSelection}>取消</Button>
          </div>
        </div>
      )}

      <p className="flex items-center gap-1.5 px-1 text-[10px] text-muted">
        <ShieldAlert size={12} className="text-rose-500" />
        产品不提供「批量直接发送」（PRD F3-3 唯一被禁止的批量操作）；可按 <ChevronDown size={10} /> 展开筛选、拖拽列、行内改状态，列配置在桌面版持久化。
      </p>
    </div>
  )
}
