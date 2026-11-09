/**
 * v0.7.0 · 批量 SDR 管道（内测）
 *
 * 产品定位仍是「自动获客」，本面板不是把形态降成「研判提效」：
 * CSV 导入是批量 SDR 既有的线索投喂通道，自动化的是批量研判 / 出信 / 触达回写。
 * 三处硬标注：导入 ≠ 采集、导出 ≠ 发送、内测可跑 ≠ 可正式发布。
 */
import { useEffect, useState } from 'react'
import { Database, Download, ShieldAlert, Sparkles, Upload } from 'lucide-react'
import { Badge, Button, Card, SectionTitle } from '@/components/ui'
import { useAppStore } from '@/store/useAppStore'
import {
  importCompanies, runJudgeBatch, exportDrafts, getBatchHealth,
  fetchCompanySources, buildComplianceFooter, downloadMbox,
  type BatchImportResult, type BatchJudgeResult, type ExportDraftsResult,
  type BatchFetchSourcesResult, type DraftSender, type BatchState, type ExportDraftItem,
} from '@/services/adapters'

const CSV_HINT = `company_name,domain,source_url,fetched_at,raw_text,country,product_hint,contact_email
Acme Trading,https://www.acme.example/about,https://acme.example/about,2026-11-09,"We import hydraulic hose fittings from Asia.",Germany,hydraulic fittings,buyer@acme.example`

export default function BatchPipelinePanel() {
  const companies = useAppStore((s) => s.companies)
  const outreach = useAppStore((s) => s.outreach)
  const settings = useAppStore((s) => s.settings)
  const showToast = useAppStore((s) => s.showToast)

  const profile = settings.profile
  const [csv, setCsv] = useState('')
  const [sender, setSender] = useState<DraftSender>({
    name: profile.senderName ?? '',
    email: '',
    company: profile.companyNameEn ?? '',
    postalAddress: profile.address ?? '',
    unsubscribe: "Reply STOP and I won't contact you again (unsubscribe / 退订)",
  })
  const [confirmC, setConfirmC] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [imported, setImported] = useState<BatchImportResult | null>(null)
  const [fetched, setFetched] = useState<BatchFetchSourcesResult | null>(null)
  const [judged, setJudged] = useState<BatchJudgeResult | null>(null)
  const [exported, setExported] = useState<ExportDraftsResult | null>(null)
  const [health, setHealth] = useState<BatchState | null>(null)

  const refresh = () => { void getBatchHealth().then(setHealth) }
  useEffect(refresh, [])

  const setField = (key: keyof DraftSender, value: string) => setSender((s) => ({ ...s, [key]: value }))
  const footer = buildComplianceFooter(sender)
  const identityReady = Boolean(sender.name && sender.email && sender.company && sender.postalAddress)

  async function doImport() {
    if (!csv.trim()) { showToast('请先粘贴 CSV 线索清单（表头需含 company_name 与 domain）', 'warn'); return }
    setBusy('import')
    const r = await importCompanies({ csv })
    setImported(r); setBusy(null); refresh()
    showToast(r.ok ? `已导入 ${r.summary?.accepted ?? 0} 家；拒绝 ${r.summary?.rejected ?? 0} / 重复 ${r.summary?.duplicates ?? 0}` : `导入失败：${r.code ?? 'E6005'}`, r.ok ? 'ok' : 'warn')
  }

  async function doFetch() {
    setBusy('fetch')
    const r = await fetchCompanySources({ limit: 10 })
    setFetched(r); setBusy(null); refresh()
    if (!r.ok) showToast(`抓取未完成：${r.code ?? 'E4012'}（${r.reason ?? '见下方明细'}）`, 'warn')
    else if (r.summary?.failed) {
      showToast(`已抓取 ${r.summary.fetched} 家，失败 ${r.summary.failed} 家（逐条标 missing_source，不编造原文）`, 'warn')
    } else showToast(`已抓取 ${r.summary?.fetched ?? 0} 家官网原文；抓取 ≠ 采集，商业数据源仍 0/6`, 'ok')
  }

  async function doJudge() {
    setBusy('judge')
    const r = await runJudgeBatch({ batchSize: 20 })
    setJudged(r); setBusy(null); refresh()
    if (!r.ok) showToast(`批量研判未启动：${r.code ?? 'E6005'}`, 'warn')
    else if (r.summary?.degraded || r.summary?.failed) {
      showToast(`T0 规则抽取已执行；模型判断成功 ${r.summary.succeeded} / 降级 ${r.summary.degraded} / 失败 ${r.summary.failed}（未配 Key 时如实降级）`, 'warn')
    } else showToast(`批量研判完成：${r.summary?.succeeded ?? 0} 家取得真实模型判断`, 'ok')
  }

  async function doExport() {
    if (!identityReady) { showToast('请先补全发件人身份（姓名 / 邮箱 / 公司 / 物理地址），合规尾巴不能为空', 'warn'); return }
    const drafts = outreach.filter((o) => o.status === 'draft' || o.status === 'queued')
    if (!drafts.length) { showToast('草稿队列为空，先在客户详情生成开发信', 'warn'); return }
    const items: ExportDraftItem[] = drafts.map((o) => {
      const c = companies.find((x) => x.id === o.companyId)
      const contact = c?.contacts[0]
      const grade = (contact?.grade ?? 'D') as ExportDraftItem['grade']
      // 客户端已注入过合规尾巴，这里拆开后用本面板的显式身份重新拼装，避免重复尾巴
      const body = (o.bodyText.split('\n--\n')[0] ?? o.bodyText).trim()
      return {
        domain: c?.domain ?? '', to: contact?.value ?? '',
        subject: o.subject, body, grade,
        confirmed: grade === 'C' ? confirmC : true,
        sender, footer,
      }
    })
    setBusy('export')
    const r = await exportDrafts({ items })
    setExported(r); setBusy(null); refresh()
    if (r.ok && r.content && r.filename) {
      downloadMbox(r.filename, r.content)
      showToast(`已导出 ${r.count} 封 mbox 草稿；导出 ≠ 发送，请在邮件客户端逐封确认`, 'ok')
    } else showToast(`导出被拒绝：${r.code ?? 'E6005'}（${r.reason ?? '见下方闸门明细'}）`, 'warn')
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle
          title="批量 SDR 管道（内测）"
          desc="导入线索 → 批量研判 → 批量出信 → 导出草稿 / 回写结果"
          extra={<Database size={15} className="text-brand-500" />}
        />
        <Badge tone="brand">定位 · 自动获客</Badge>
        <Badge tone="amber">内测可跑 ≠ 可发布</Badge>
        {health?.circuitOpen && <Badge tone="rose">退信熔断中</Badge>}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] leading-4 text-muted">
        <span>导入 ≠ 采集：origin=user_imported；官网原文由你指定 URL 抓取（user_directed_fetch），仍非系统采集</span>
        <span>导出 ≠ 发送：只生成 mbox，状态不自动置 sent</span>
        <span>数据源仍 0/6 未接入 · 标注契约 legacy（v0.8.0 不做人工标注）</span>
        <span>云端客户库 {health?.companies ?? 0} 家 · 已研判 {health?.judged ?? 0} 家 · 今日导出 {health?.exportedToday ?? 0}/100</span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-3">
        {/* Step 1 */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink"><Upload size={13} />1 · 批量导入线索</div>
          <textarea
            value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={CSV_HINT}
            className="lp-input h-[104px] w-full resize-none font-mono text-[10px] leading-4"
            spellCheck={false}
          />
          <Button size="sm" variant="primary" disabled={busy === 'import'} onClick={doImport}>
            {busy === 'import' ? '导入中…' : '导入 CSV'}
          </Button>
          {imported && (
            <div className="space-y-0.5 text-[10px] leading-4 text-muted">
              <div>收到 {imported.summary?.received ?? 0} · 接受 <strong className="text-emerald-700">{imported.summary?.accepted ?? 0}</strong> · 拒绝 {imported.summary?.rejected ?? 0} · 重复 {imported.summary?.duplicates ?? 0}</div>
              {imported.rejected?.slice(0, 3).map((r) => <div key={r.rowIndex} className="text-rose-700">行 {r.rowIndex}：{r.reason}</div>)}
              {imported.companies?.slice(0, 3).map((c) => <div key={c.domain}>{c.domain}{c.missingSource ? ' · 缺原文，不进 T0' : ''}</div>)}
            </div>
          )}
        </div>

        {/* Step 2 */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink"><Sparkles size={13} />2 · 抓取原文 + 批量研判</div>
          <p className="h-[64px] overflow-auto rounded-lg border border-line bg-canvas px-2.5 py-2 text-[10px] leading-4 text-slate-700">
            抓取只针对你导入的公司：用 CSV 里的 website/source_url（缺省 <code>https://域名</code>），robots 遵从、每域限速、拒绝私网地址；原文标 <code>user_directed_fetch</code>，<strong>不是系统采集</strong>。抓不到就标 <code>missing_source</code>，不编造原文。
          </p>
          <Button size="sm" variant="primary" disabled={busy === 'fetch'} onClick={doFetch}>
            {busy === 'fetch' ? '抓取中…' : '抓取缺原文公司（最多 10 家）'}
          </Button>
          {fetched && (
            <div className="space-y-0.5 text-[10px] leading-4 text-muted">
              <div>抓取成功 <strong className="text-emerald-700">{fetched.summary?.fetched ?? 0}</strong> · 失败 {fetched.summary?.failed ?? 0}{fetched.fetchVersion ? ` · ${fetched.fetchVersion}` : ''}</div>
              {fetched.items?.slice(0, 3).map((i) => (
                <div key={i.domain} className={i.ok ? 'text-emerald-700' : 'text-rose-700'}>
                  {i.domain} · {i.ok ? `${i.textChars ?? 0} 字 · ${i.origin}` : `${i.code ?? 'E4012'} ${String(i.reason ?? '').slice(0, 40)}`}
                </div>
              ))}
            </div>
          )}
          <Button size="sm" disabled={busy === 'judge'} onClick={doJudge}>
            {busy === 'judge' ? '研判中…' : '研判前 20 家'}
          </Button>
          {judged?.summary && (
            <div className="space-y-0.5 text-[10px] leading-4 text-muted">
              <div>成功 <strong className="text-emerald-700">{judged.summary.succeeded}</strong> · 降级 <strong className="text-amber-700">{judged.summary.degraded}</strong> · 失败 {judged.summary.failed}</div>
              {judged.items?.slice(0, 3).map((i) => (
                <div key={i.domain} className={i.bucket === 'succeeded' ? 'text-emerald-700' : 'text-amber-700'}>
                  {i.domain} · {i.bucket} · T0 {i.t0.used ? `${i.t0.evidenceCount ?? 0} 条引用` : '未执行'}{i.codes.length ? ` · ${i.codes.join(',')}` : ''}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Step 3 */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink"><Download size={13} />3 · 批量导出草稿</div>
          <div className="grid grid-cols-2 gap-1">
            {([
              ['name', '发件人姓名'], ['email', '发件人邮箱'],
              ['company', '公司英文名'], ['postalAddress', '物理地址'],
            ] as const).map(([key, label]) => (
              <input key={key} value={sender[key]} onChange={(e) => setField(key, e.target.value)}
                placeholder={label} className="lp-input h-7 text-[10px]" />
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-[10px] text-slate-700">
            <input type="checkbox" checked={confirmC} onChange={(e) => setConfirmC(e.target.checked)} />
            C 级联系人已逐条人工确认（D 级一律禁发）
          </label>
          <Button size="sm" variant="primary" disabled={busy === 'export'} onClick={doExport}>
            {busy === 'export' ? '导出中…' : '导出 mbox 草稿'}
          </Button>
          {exported && (
            <div className="space-y-0.5 text-[10px] leading-4 text-muted">
              {exported.ok
                ? <div className="text-emerald-700">已导出 {exported.count} 封 · {exported.filename} · 状态 drafted</div>
                : <div className="text-rose-700">{exported.code} {exported.reason ?? ''}</div>}
              {exported.blocked?.slice(0, 3).map((b) => (
                <div key={b.index} className="text-rose-700">#{b.index} {b.domain ?? ''}：{b.reasons[0]}</div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[10px] leading-4 text-amber-900">
        <ShieldAlert size={12} className="mt-0.5 shrink-0" />
        <span>内测边界：OAuth / CASA Tier 2、EV 签名、provider 快照与法务意见仍是正式发布门禁；v0.8.0 决策不做 385 人工标注与商业数据源采购，评测改看 integrity + outcome 且不宣称准确率。本面板不提供「批量直接发送」，批量与真发之间必须保留人的一次确认。</span>
      </div>
    </Card>
  )
}
