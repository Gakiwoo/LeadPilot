import { useState } from 'react'
import { AlertTriangle, FileText, Gauge, Mail, ShieldAlert, ShieldCheck } from 'lucide-react'
import { assertNoBatchSend, checkSendGates, type SendGateResult } from '@/domain/compliance'
import { useAppStore } from '@/store/useAppStore'
import { Badge, Button, Card, DemoBanner, EmptyState, SectionTitle, StatTile, StatusBadge } from '@/components/ui'

export default function OutreachView() {
  const companies = useAppStore((s) => s.companies)
  const outreach = useAppStore((s) => s.outreach)
  const settings = useAppStore((s) => s.settings)
  const showToast = useAppStore((s) => s.showToast)
  const openComposer = useAppStore((s) => s.openComposer)
  const [gateCompanyId, setGateCompanyId] = useState('')
  const [gateResult, setGateResult] = useState<SendGateResult | null>(null)

  const gateCompany = companies.find((c) => c.id === gateCompanyId) ?? companies[0]
  const sentCompanies = companies.filter((c) => ['sent', 'delivered', 'replied', 'interested', 'quoted', 'won', 'bounced'].includes(c.status))
  const bounceRate = sentCompanies.length ? companies.filter((c) => c.status === 'bounced').length / sentCompanies.length : 0
  const replyRate = sentCompanies.length ? companies.filter((c) => ['replied', 'interested', 'quoted', 'won'].includes(c.status)).length / sentCompanies.length : 0

  const runGate = () => {
    if (!gateCompany) return
    const r = checkSendGates({
      contact: gateCompany.contacts[0], blacklist: settings.blacklist,
      sentToday: settings.gmail.sentToday, dailyLimit: settings.gmail.dailyLimit,
      bounceRate, consecutiveHardBounces: 0, singleConfirmed: false,
    })
    setGateResult(r)
    showToast(r.allowed ? '四道闸门全部通过' : `${r.failed.length} 道闸门未通过，已阻止发送`, r.allowed ? 'ok' : 'warn')
  }

  return (
    <div className="space-y-3">
      <DemoBanner text="草稿队列保存在本地，未调用 Gmail API；直接发送属 V1 范围（需 CASA Tier 2 与 gmail.send restricted scope）。" />

      <div className="grid grid-cols-4 gap-3">
        <StatTile label="今日已发 / 额度" value={`${settings.gmail.sentToday} / ${settings.gmail.dailyLimit}`} sub="个人 Gmail 上限 500，产品默认 100 留安全余量" />
        <StatTile label="硬退信率" value={`${(bounceRate * 100).toFixed(1)}%`} sub={bounceRate > 0.03 ? '超过 3%：发送熔断' : '阈值 ≤ 2%，3% 触发熔断'} tone={bounceRate > 0.03 ? 'rose' : 'emerald'} />
        <StatTile label="回复率" value={`${(replyRate * 100).toFixed(1)}%`} sub="唯一可靠强信号，不以打开率为核心指标" tone="emerald" />
        <StatTile label="草稿队列" value={outreach.length} sub="Gmail API 失败时自动重试 3 次并保留" />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Card className="p-4">
          <SectionTitle title="Gmail 接入" desc="MVP 只申请 gmail.compose（sensitive scope），仅建草稿" extra={<Badge tone={settings.gmail.connected ? 'emerald' : 'amber'}>{settings.gmail.connected ? '已授权' : '未授权'}</Badge>} />
          <div className="space-y-2 text-[11px] leading-5 text-slate-700">
            <p><strong>为什么需要授权：</strong>只用于创建草稿与发信，<strong>不读取历史邮件</strong>。凭据用 Windows DPAPI 加密存本地，不上传云端。</p>
            <p><strong>为什么 MVP 不直接发送：</strong>gmail.send 属 restricted scope，需通过 CASA Tier 2 年度安全评估（4–8 周、数千美元/年）；新账号直接自动发信会打穿域名信誉。MVP 交付「一键建好草稿，用户点开 Gmail 自己按发送」。</p>
          </div>
          <div className="mt-3 flex items-center gap-1.5">
            <Button size="sm" onClick={() => showToast('演示模式：OAuth PKCE + loopback 回调待接入真实 Google 凭据', 'warn')}>模拟接入 Gmail</Button>
            <Button size="sm" variant="soft" onClick={() => openComposer(companies[0]?.id ?? null)}>先看草稿，暂不授权</Button>
            <span className="ml-auto text-[10px] text-muted">F5 · P0</span>
          </div>
        </Card>

        <Card className="p-4">
          <SectionTitle title="发送闸门检查器" desc="F7-2 四道闸门 · G1 等级 / G2 黑名单 / G3 额度 / G4 熔断" extra={<Gauge size={15} className="text-brand-500" />} />
          <div className="flex items-center gap-2">
            <select value={gateCompanyId} onChange={(e) => { setGateCompanyId(e.target.value); setGateResult(null) }} className="lp-input h-8 text-[11px]">
              <option value="">选择客户（默认第一家）</option>
              {companies.slice(0, 30).map((c) => <option key={c.id} value={c.id}>{c.name} · {c.contacts[0]?.grade} 级</option>)}
            </select>
            <Button size="sm" variant="primary" onClick={runGate}>检查闸门</Button>
          </div>
          {gateCompany && (
            <p className="mt-2 text-[11px] text-muted">当前：{gateCompany.name} · {gateCompany.contacts[0]?.grade} 级 · {gateCompany.contacts[0]?.value}</p>
          )}
          {gateResult && (
            <div className="lp-fade mt-2 space-y-1">
              {(['G1', 'G2', 'G3', 'G4'] as const).map((g) => {
                const f = gateResult.failed.find((x) => x.gate === g)
                return (
                  <div key={g} className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] ${f ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
                    {f ? <ShieldAlert size={12} /> : <ShieldCheck size={12} />}
                    <strong>{g}</strong><span className="truncate">{f ? `${f.code} ${f.message}` : '通过'}</span>
                  </div>
                )
              })}
              <p className="pt-1 text-[10px] text-muted">{gateResult.queueInstead ? '超额部分进入明日队列，不丢弃。' : ''}</p>
            </div>
          )}
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <SectionTitle title="草稿队列" desc="建草稿成功 → 客户状态自动置为「已生成草稿」（自动流转白名单之一）" />
          <Badge tone="brand">{outreach.length} 封</Badge>
        </div>
        {outreach.length === 0 ? (
          <div className="p-5"><EmptyState title="草稿队列为空" desc="在客户详情中生成开发信，或在客户名单中批量建草稿。生成时会自动做字数、禁词、退订尾巴与占位符校验。" action={<Button size="sm" variant="soft" onClick={() => openComposer(companies.find((c) => c.scoreCard.canSend)?.id ?? null)}>写第一封开发信</Button>} /></div>
        ) : (
          <table className="w-full text-[11px]">
            <thead className="bg-canvas text-[10px] text-muted"><tr>{['公司', '收件人', '主题', '个性化依据', '校验', '创建时间', '状态'].map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr></thead>
            <tbody>{outreach.slice(0, 20).map((o) => {
              const c = companies.find((x) => x.id === o.companyId)
              return (
                <tr key={o.id} className="border-t border-line">
                  <td className="px-3 py-2 font-medium text-ink">{c?.name ?? o.companyId}</td>
                  <td className="px-3 py-2 font-mono text-muted">{c?.contacts[0]?.value}</td>
                  <td className="px-3 py-2">{o.subject}</td>
                  <td className="px-3 py-2 text-muted">{o.personalizationTags[0] ?? '—'}</td>
                  <td className="px-3 py-2">{o.validation.passed ? <Badge tone="emerald">通过</Badge> : <Badge tone="rose">{o.validation.issues.length} 项问题</Badge>}</td>
                  <td className="px-3 py-2 tabular-nums text-muted">{new Date(o.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</td>
                  <td className="px-3 py-2"><Badge tone="indigo">本地草稿 · 未同步 Gmail</Badge></td>
                </tr>
              )
            })}</tbody>
          </table>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Card className="p-4">
          <SectionTitle title="已发送记录（演示）" desc="送达/打开/回复/退信 · 回复是唯一可靠强信号" />
          <div className="max-h-[190px] space-y-1 overflow-y-auto">
            {sentCompanies.slice(0, 10).map((c) => (
              <div key={c.id} className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-[11px]">
                <Mail size={12} className="text-muted" /><span className="truncate font-medium text-ink">{c.name}</span>
                <span className="ml-auto"><StatusBadge status={c.status} /></span>
                <span className="w-20 text-right tabular-nums text-muted">{c.lastContactAt?.slice(0, 10) ?? '—'}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card className="p-4">
          <SectionTitle title="模板库与红线" desc="模板库 V1 提供最多 3 步序列；以下是产品级硬约束" />
          <div className="space-y-1.5">
            {[
              { icon: FileText, text: '系统模板：首次建立联系（短） / 报价跟进 / 二次触达', tone: 'brand' },
              { icon: AlertTriangle, text: assertNoBatchSend(2).allowed ? '' : '不提供「批量直接发送」：批量与真发之间必须保留人的一次确认', tone: 'rose' },
              { icon: ShieldCheck, text: '每封信必须带真实身份与退订说明，由系统注入且不可删除', tone: 'emerald' },
              { icon: ShieldCheck, text: '退订即刻生效且不可绕过，全局黑名单不提供忽略开关', tone: 'emerald' },
              { icon: Gauge, text: '产品层硬编码节流：个人 100 封/日、20 封/小时、间隔随机 45–120 秒', tone: 'slate' },
            ].filter((x) => x.text).map((x, i) => (
              <div key={i} className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11px] leading-4 ${x.tone === 'rose' ? 'border-rose-200 bg-rose-50 text-rose-700' : x.tone === 'emerald' ? 'border-emerald-100 bg-emerald-50/50 text-emerald-800' : 'border-line text-slate-700'}`}>
                <x.icon size={12} className="mt-0.5 shrink-0" />{x.text}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
