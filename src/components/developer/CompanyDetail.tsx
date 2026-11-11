import { useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, CloudCog, ExternalLink, FileSearch, Mail, RotateCcw, ShieldCheck, Sparkles } from 'lucide-react'
import type { Company, CompanyStatus, DimensionKey } from '@/types'
import { CUSTOMER_TYPES, DIMENSION_LABELS, GRADE_LABELS, SIZE_LABELS, STATUS_DEFS } from '@/domain/constants'
import { minimizeForModel } from '@/domain/compliance'
import { useAppStore } from '@/store/useAppStore'
import { Badge, Button, Card, Drawer, GradeBadge, ScoreBar, SectionTitle, StatusBadge } from '@/components/ui'

const DIMS: DimensionKey[] = ['match', 'propensity', 'size', 'import', 'contact']

export default function CompanyDetail({ company, onClose }: { company: Company | null; onClose(): void }) {
  const [expanded, setExpanded] = useState<DimensionKey | null>(null)
  const openComposer = useAppStore((s) => s.openComposer)
  const setCompanyStatus = useAppStore((s) => s.setCompanyStatus)
  const showToast = useAppStore((s) => s.showToast)
  const settings = useAppStore((s) => s.settings)
  const gateway = useAppStore((s) => s.gateway)
  const judgeWithGateway = useAppStore((s) => s.judgeWithGateway)
  const judgingCompanyId = useAppStore((s) => s.judgingCompanyId)
  const lastGatewayResult = useAppStore((s) => s.lastGatewayResult)
  const undo = useAppStore((s) => s.undo)
  if (!company) return null
  const c = company
  const sc = c.scoreCard
  const minimized = minimizeForModel(c.features, settings.profile)
  const judging = judgingCompanyId === c.id
  const gatewayResult = lastGatewayResult?.companyId === c.id ? lastGatewayResult : null

  return (
    <Drawer
      open={!!company}
      onClose={onClose}
      width="62%"
      title={<span>{c.name} <span className="ml-2 align-middle"><StatusBadge status={c.status} /></span></span>}
      subtitle={<span className="flex flex-wrap items-center gap-1.5">{c.flag} {c.country} · {c.city} · <a href={c.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-brand-600 hover:underline">{c.domain} <ExternalLink size={10} /></a> · {c.customerTypes.map((t) => CUSTOMER_TYPES.find((x) => x.key === t)?.zh).join(' / ')}</span>}
      footer={
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted">状态</span>
          <select value={c.status} onChange={(e) => {
            const r = setCompanyStatus(c.id, e.target.value as CompanyStatus)
            if (r.needsConfirm) { if (window.confirm(`${r.message}\n\n确认继续？`)) setCompanyStatus(c.id, e.target.value as CompanyStatus, { confirmed: true }) }
            else if (!r.ok) showToast(r.message ?? '状态不可流转', 'error')
          }} className="lp-input h-8 w-32 py-0 text-[12px]">
            {STATUS_DEFS.map((s) => <option key={s.key} value={s.key}>{s.zh}</option>)}
          </select>
          <button onClick={undo} title="撤销上一次状态变更（Ctrl+Z，保留 5 步）" className="rounded-lg border border-line px-2 py-1.5 text-[11px] text-slate-500 hover:bg-slate-50"><RotateCcw size={12} /></button>
          <span className="ml-1 text-[11px] text-muted">演示数据 · 评分由本地引擎计算</span>
          <Button
            size="sm"
            className="ml-auto"
            disabled={judging}
            title={gateway?.online
              ? gateway.mode === 'configured'
                ? '向云端网关发起真实 T1 判断；客户端会再做一次 schema + 证据校验'
                : '网关在线但未配置 API Key：本次将明确返回 E6005 降级，并把分数改为区间显示'
              : '云端网关离线，点击会明确显示不可达降级，不会伪造判断'}
            onClick={() => void judgeWithGateway(c.id)}
          >
            <CloudCog size={13} className={judging ? 'animate-spin' : ''} /> {judging ? '判断中…' : '云端判断'}
          </Button>
          <Button variant="primary" size="sm" onClick={() => { onClose(); openComposer(c.id) }}><Sparkles size={13} /> 生成开发信</Button>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="flex items-center gap-3 rounded-xl border border-line bg-canvas px-4 py-3">
          <div>
            <p className="text-[11px] text-muted">综合分 · 置信度 {sc.confidence === 'high' ? '高' : sc.confidence === 'mid' ? '中' : '低'}（{sc.coveredDimensions}/5 维）</p>
            <p className="text-[28px] font-semibold leading-8 tabular-nums text-ink">{sc.totalDisplay}</p>
          </div>
          <div className="flex-1"><ScoreBar value={sc.totalScore} /></div>
          <div className="text-right">
            <p className="text-[11px] text-muted">可发信性</p>
            <p className={`text-[13px] font-semibold ${sc.canSend ? 'text-emerald-600' : 'text-rose-600'}`}>{sc.canSend ? '可进入发送队列' : '禁止发送（D 级）'}</p>
          </div>
        </div>

        {gatewayResult && (
          <div className={`rounded-xl border px-3.5 py-3 ${gatewayResult.degraded ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50/60'}`}>
            <div className="flex items-center gap-1.5 text-[12px] font-medium">
              <CloudCog size={13} />
              <span className={gatewayResult.degraded ? 'text-amber-800' : 'text-emerald-800'}>
                {gatewayResult.degraded ? '云端判断已降级 · 当前分数未经模型校验（E6005）' : '云端判断已完成 · 客户端二次校验通过'}
              </span>
              <span className="ml-auto text-[11px] font-normal text-slate-500">{new Date(gatewayResult.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5 pl-5 text-[11px] text-slate-600">
              {gatewayResult.provider && <span className="lp-chip">provider {gatewayResult.provider}</span>}
              {gatewayResult.model && <span className="lp-chip">model {gatewayResult.model}</span>}
              <span className="lp-chip">可溯源率 {Math.round(gatewayResult.provenance * 100)}%</span>
              {gatewayResult.cached && <span className="lp-chip">命中 30 天缓存 · 0 点</span>}
              {gatewayResult.points !== undefined && !gatewayResult.cached && <span className="lp-chip">消耗 {gatewayResult.points} 点</span>}
            </div>
            {gatewayResult.reason && <p className="mt-1.5 pl-5 text-[11px] leading-4 text-amber-800">{gatewayResult.reason}</p>}
            <p className="mt-1.5 pl-5 text-[11px] leading-4 text-slate-500">
              {gatewayResult.degraded
                ? '按 PRD F0-4：不静默回退、不编造模型结论，分数改区间显示并下调置信度。配置 API Key 后重新点击即可走真实链路。'
                : '模型只输出离散枚举与证据，分数仍由本地代码按固定公式合成；证据引用须能在官网原文中命中。'}
            </p>
          </div>
        )}

        {sc.warnings.length > 0 && (
          <div className="space-y-1.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-amber-800"><AlertTriangle size={13} /> 可信度提示（不静默降级）</div>
            {sc.warnings.map((w, i) => <p key={i} className="pl-5 text-[11px] leading-4 text-amber-800">{w}</p>)}
          </div>
        )}

        <section>
          <SectionTitle title="五维评分卡" desc="模型只判断、不打分；分数由代码按固定公式合成，每一分都能点开看证据" extra={<Badge tone="brand">6.7 三层结构</Badge>} />
          <div className="grid grid-cols-5 gap-2">
            {DIMS.map((k) => {
              const d = sc.dimensions[k]
              const open = expanded === k
              return (
                <button key={k} onClick={() => setExpanded(open ? null : k)} className={`rounded-lg border p-2.5 text-left transition ${open ? 'border-brand-500 bg-brand-50/50' : 'border-line bg-white hover:border-slate-300'} ${!d.hasData ? 'opacity-60' : ''}`}>
                  <div className="truncate text-[11px] text-muted">{DIMENSION_LABELS[k].zh}</div>
                  <div className="mt-1 flex items-baseline gap-1">
                    <span className="text-[20px] font-semibold tabular-nums text-ink">{d.displayValue}</span>
                    {d.hasData && !['size', 'contact'].includes(k) && <span className="text-[11px] text-muted">/100</span>}
                  </div>
                  <div className="mt-1.5"><ScoreBar value={d.score} compact /></div>
                  <div className="mt-1.5 flex items-center justify-between text-[9px] text-muted">
                    <span>α {d.alpha.toFixed(2)}</span>
                    {d.conflict ? <span className="text-rose-600">待复议</span> : d.confidence === 'low' ? <span className="text-amber-600">低置信</span> : <span>展开证据</span>}
                  </div>
                </button>
              )
            })}
          </div>
          {expanded && (() => {
            const d = sc.dimensions[expanded]
            return (
              <Card className="lp-fade mt-2 p-3.5">
                <div className="flex items-center gap-2">
                  <FileSearch size={14} className="text-brand-600" />
                  <h4 className="text-[13px] font-semibold text-ink">{DIMENSION_LABELS[expanded].zh} {DIMENSION_LABELS[expanded].en} · {d.displayValue}</h4>
                  <Badge tone={d.hasData ? 'slate' : 'amber'}>{d.hasData ? '有数据' : '缺失降级'}</Badge>
                </div>
                <p className="mt-2 text-[12px] leading-5 text-slate-700">{d.conclusion}</p>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {d.meta.map((m, i) => (
                    <div key={i} className="rounded-lg bg-canvas px-2.5 py-1.5">
                      <p className="text-[11px] text-muted">{m.label}</p>
                      <p className="mt-0.5 text-[11px] font-medium text-ink">{m.value}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-3 border-t border-line pt-3">
                  <p className="mb-2 text-[11px] font-medium text-slate-700">证据链（{d.evidences.length} 条 · 可核验原文）</p>
                  {d.evidences.length ? d.evidences.slice(0, 4).map((e, i) => (
                    <div key={i} className="mb-1.5 rounded-lg border border-line bg-white px-2.5 py-2">
                      <p className="text-[11px] leading-4 text-slate-700">「{e.quote}」</p>
                      <p className="mt-1 text-[11px] text-muted">{e.label ?? '原文片段'} · {e.sourceUrl} · 抓取于 {e.fetchedAt}</p>
                    </div>
                  )) : <p className="text-[11px] text-muted">该维度无可核验证据，已按缺失维度处理，不按 0 分计入。</p>}
                </div>
              </Card>
            )
          })()}
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
            <span>综合分公式：</span>
            {DIMS.map((k) => (
              <span key={k} className={`lp-chip ${sc.weights[k] === 0 ? 'opacity-40 line-through' : ''}`}>
                {DIMENSION_LABELS[k].short} {(sc.weights[k] * 100).toFixed(1)}%
              </span>
            ))}
            <span>· 缺失维度权重按比例再归一化，不补零</span>
          </div>
        </section>

        <div className="grid grid-cols-2 gap-4">
          <section>
            <SectionTitle title="企业概况" />
            <Card className="divide-y divide-line px-3.5">
              {[
                ['公司全名', c.name], ['官网 / 域名', c.domain], ['国家 / 城市', `${c.country} · ${c.city ?? '未知'}`],
                ['成立年份', c.foundedYear ? `${c.foundedYear} 年` : '未知'],
                ['员工 / 营收', `${c.employeeRange ?? '规模未知'} · ${c.revenueRange ?? '规模未知'}`],
                ['规模档', `${c.sizeTier} · ${SIZE_LABELS[c.sizeTier].note}`],
                ['主营类目', c.categories.join(' / ') || '—'],
                ['代理品牌', c.brands.join('、') || '隐藏该模块（无数据）'],
              ].map(([k, v]) => (
                <div key={k} className="flex items-start justify-between gap-3 py-2 text-[11px]">
                  <span className="shrink-0 text-muted">{k}</span><span className="text-right text-ink">{v}</span>
                </div>
              ))}
              <div className="py-2"><p className="text-[11px] leading-4 text-slate-700">{c.description}</p></div>
            </Card>
          </section>

          <section>
            <SectionTitle title="联系方式" extra={<Badge tone={c.scoreCard.canSend ? 'emerald' : 'rose'}>{c.scoreCard.canSend ? '可直发 / 单条确认' : '不可发'}</Badge>} />
            <Card className="p-3.5">
              {c.contacts.map((ct) => (
                <div key={ct.id} className="rounded-lg border border-line p-2.5">
                  <div className="flex items-center gap-2">
                    <Mail size={13} className="text-muted" />
                    <span className="truncate font-mono text-[12px] text-ink">{ct.value}</span>
                    <span className="ml-auto"><GradeBadge grade={ct.grade} /></span>
                  </div>
                  <p className="mt-1.5 text-[11px] leading-4 text-muted">{GRADE_LABELS[ct.grade].desc}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted">
                    <span className="lp-chip">{ct.ownerName ?? '职位不明'} {ct.title ?? ''}</span>
                    <span className="lp-chip">验证 {ct.verifyCode}</span>
                    <span className="lp-chip">来源 {ct.source}</span>
                  </div>
                </div>
              ))}
              <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-emerald-50 px-2.5 py-2 text-[11px] leading-4 text-emerald-800">
                <ShieldCheck size={12} className="mt-0.5 shrink-0" />
                <span>数据最小化：发往模型的请求体已硬性剔除 {minimized.removed.join(' / ')}（PRD 11.4.1）。</span>
              </div>
            </Card>
          </section>
        </div>

        <section>
          <SectionTitle title="采购与贸易信号" desc="「为什么说他会买」的硬证据" />
          {c.tradeRecords.length ? (
            <Card className="overflow-hidden">
              <table className="w-full text-[11px]">
                <thead className="bg-canvas text-[11px] text-muted"><tr><th className="px-3 py-2 text-left font-medium">日期</th><th className="px-3 py-2 text-left font-medium">HS 编码</th><th className="px-3 py-2 text-left font-medium">品名</th><th className="px-3 py-2 text-left font-medium">原产地</th><th className="px-3 py-2 text-left font-medium">货值</th><th className="px-3 py-2 text-left font-medium">来源</th></tr></thead>
                <tbody>{c.tradeRecords.map((t) => (
                  <tr key={t.id} className="border-t border-line">
                    <td className="px-3 py-2 tabular-nums">{t.tradeDate}</td><td className="px-3 py-2 font-mono">{t.hsCode}</td>
                    <td className="px-3 py-2">{t.productDesc}</td><td className="px-3 py-2">{t.originCountry}</td>
                    <td className="px-3 py-2 tabular-nums">${t.valueUsd.toLocaleString()}</td><td className="px-3 py-2 text-muted">{t.dataSource}</td>
                  </tr>
                ))}</tbody>
              </table>
            </Card>
          ) : (
            <Card className="px-3.5 py-3 text-[11px] text-muted">无公开进口记录。该国海关数据{c.features.customsDataAvailable ? '可得但未命中' : '不公开'}，本维度已按权重转移处理，不显示 0 分（AC-07）。</Card>
          )}
        </section>

        <section>
          <SectionTitle title="状态时间轴与跟进" desc="每次变更留痕：时间 / from / to / 操作人 / 是否自动" />
          <Card className="p-3.5">
            <div className="space-y-2">
              {[...c.statusLog].reverse().slice(0, 6).map((l) => (
                <div key={l.id} className="flex items-center gap-2 text-[11px]">
                  <span className="w-32 shrink-0 tabular-nums text-muted">{new Date(l.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
                  <span className="text-slate-500">{l.from ? STATUS_DEFS.find((s) => s.key === l.from)?.zh : '入库'}</span>
                  <ChevronRight size={11} className="text-slate-300" />
                  <StatusBadge status={l.to} />
                  <span className="text-muted">{l.operator} · {l.automated ? '自动流转' : '人工确认'}</span>
                  {l.note && <span className="truncate text-slate-400">· {l.note}</span>}
                </div>
              ))}
            </div>
            {c.followups.length > 0 && (
              <div className="mt-3 border-t border-line pt-3">
                {c.followups.map((f) => <p key={f.id} className="flex items-center gap-1.5 text-[11px] text-amber-700"><ChevronDown size={11} /> 跟进 {f.dueDate} · {f.content} · {f.channel}</p>)}
              </div>
            )}
          </Card>
        </section>
      </div>
    </Drawer>
  )
}
