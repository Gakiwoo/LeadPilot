/**
 * v0.7.0 起 · 批量 SDR 管道（内测）· B8 / P2-6 三步管道打通
 *
 * 产品定位仍是「自动获客」，本面板不是把形态降成「研判提效」：
 * CSV 导入是批量 SDR 既有的线索投喂通道，自动化的是批量研判 / 出信 / 触达回写。
 *
 * B8：导入 → 研判 → 批量出信 → 导出全部共用**服务端客户库同一批 domain**，
 * 不再从本地演示草稿库（useAppStore.outreach）拼导出项。导出项只有两种来源：
 *   1. /v1/batch/generate-drafts 的真实 T1 正文（draftSource=provider）
 *   2. 用户显式点击后生成的本地模板（DEMO，draftSource=local-template，mbox 带 DEMO 头）
 * 服务端 checkExportGates 仍是最终合规闸门；降级项 body=null，绝不伪造模型输出。
 *
 * 三处硬标注：导入 ≠ 采集、导出 ≠ 发送、内测可跑 ≠ 可正式发布。
 */
import { useEffect, useState } from 'react'
import { Database, Download, ShieldAlert, Sparkles, Upload } from 'lucide-react'
import { Badge, Button, Card, SectionTitle } from '@/components/ui'
import { useAppStore } from '@/store/useAppStore'
import {
  importCompanies, listImportedCompanies, runJudgeBatch, generateDraftsBatch, exportDrafts,
  getBatchHealth, fetchCompanySources, buildComplianceFooter, downloadMbox,
  buildImportedTemplateDraft,
  type BatchImportResult, type BatchJudgeResult, type GenerateDraftsResult,
  type ExportDraftsResult, type BatchFetchSourcesResult, type DraftSender,
  type BatchState, type ExportDraftItem, type ImportedCompany,
  type DraftSource, type ImportedTemplateDraft,
} from '@/services/adapters'

const CSV_HINT = `company_name,domain,source_url,fetched_at,raw_text,country,product_hint,contact_email,contact_grade
Acme Trading,https://www.acme.example/about,https://acme.example/about,2026-11-09,"We import hydraulic hose fittings from Asia.",Germany,hydraulic fittings,buyer@acme.example,B`

type GeneratedItem = NonNullable<GenerateDraftsResult['items']>[number]
type TemplatePair = { item: GeneratedItem; draft: ImportedTemplateDraft }
type Candidate = {
  key: string; domain: string; to: string; subject: string; body: string
  grade: ExportDraftItem['grade']; draftSource: DraftSource; label: string
}

export default function BatchPipelinePanel() {
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
  // C 级必须逐条人工确认：key 用「草稿来源:域名」，不与演示草稿库共享状态
  const [confirmedC, setConfirmedC] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [imported, setImported] = useState<BatchImportResult | null>(null)
  const [fetched, setFetched] = useState<BatchFetchSourcesResult | null>(null)
  const [judged, setJudged] = useState<BatchJudgeResult | null>(null)
  const [generated, setGenerated] = useState<GenerateDraftsResult | null>(null)
  const [templatePairs, setTemplatePairs] = useState<TemplatePair[]>([])
  const [exported, setExported] = useState<ExportDraftsResult | null>(null)
  const [health, setHealth] = useState<BatchState | null>(null)
  const [serverCompanies, setServerCompanies] = useState<ImportedCompany[]>([])

  const refresh = () => {
    void getBatchHealth().then(setHealth)
    void listImportedCompanies().then((r) => setServerCompanies(r.companies ?? []))
  }
  useEffect(refresh, [])

  const setField = (key: keyof DraftSender, value: string) => setSender((s) => ({ ...s, [key]: value }))
  const footer = buildComplianceFooter(sender)
  const identityReady = Boolean(sender.name && sender.email && sender.company && sender.postalAddress)
  const withSource = serverCompanies.filter((c) => c.hasSource).length
  const withEmail = serverCompanies.filter((c) => c.hasContactEmail).length

  /* 导出候选只来自服务端批量出信结果 + 用户显式生成的本地模板，绝不掺入演示草稿库 */
  const providerCandidates: Candidate[] = (generated?.items ?? [])
    .filter((i) => i.bucket === 'succeeded' && i.to && i.subject && i.body)
    .map((i) => ({
      key: `provider:${i.domain}`, domain: i.domain, to: i.to,
      subject: String(i.subject ?? ''), body: String(i.body ?? ''),
      grade: i.grade, draftSource: 'provider', label: `${i.domain} · 真实 T1`,
    }))
  const templateCandidates: Candidate[] = templatePairs
    .filter((p) => p.item.to && p.draft)
    .map((p) => ({
      key: `local-template:${p.item.domain}`, domain: p.item.domain, to: p.item.to,
      subject: p.draft.subject, body: p.draft.body,
      grade: p.item.grade, draftSource: 'local-template', label: `${p.item.domain} · 本地模板 DEMO`,
    }))
  const candidates = [...providerCandidates, ...templateCandidates]
  const cCandidates = candidates.filter((c) => c.grade === 'C')

  async function doImport() {
    if (!csv.trim()) { showToast('请先粘贴 CSV 线索清单（表头需含 company_name 与 domain）', 'warn'); return }
    setBusy('import')
    const r = await importCompanies({ csv })
    // 新批次一律清空 C 级逐条确认，绝不复用上一批的人工确认（fail-closed）
    setImported(r); setGenerated(null); setTemplatePairs([]); setConfirmedC({}); setBusy(null); refresh()
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

  async function doGenerate() {
    setBusy('generate')
    const r = await generateDraftsBatch({ batchSize: 20 })
    setGenerated(r); setTemplatePairs([]); setConfirmedC({}); setExported(null); setBusy(null)
    if (!r.ok) showToast(`批量出信未启动：${r.code ?? 'E4014'}（${r.reason ?? '检查云端客户库'}）`, 'warn')
    else showToast(`批量出信：真实 T1 ${r.summary?.succeeded ?? 0} · 降级 ${r.summary?.degraded ?? 0} · 前置失败 ${r.summary?.failed ?? 0}；降级项无正文，不伪造`, r.summary?.succeeded ? 'ok' : 'warn')
  }

  /** 显式降级入口：必须由用户点击，生成的草稿标 DEMO，服务端 mbox 会写 X-LeadPilot-Demo 头 */
  function doLocalTemplate() {
    // 缺 product_hint 的行不生成模板：模板不能替客户编造主营产品
    const targets = (generated?.items ?? []).filter((i) => i.bucket !== 'succeeded' && i.to && i.anchor && i.productHint?.trim())
    const pairs: TemplatePair[] = []
    for (const item of targets) {
      const draft = buildImportedTemplateDraft({
        companyName: item.companyName, productHint: item.productHint, anchor: item.anchor,
      })
      if (draft) pairs.push({ item, draft })
    }
    setTemplatePairs(pairs); setConfirmedC({}); setExported(null)
    showToast(pairs.length
      ? `已用本地模板补齐 ${pairs.length} 封（DEMO · 非模型输出）；导出会带 X-LeadPilot-Demo 头`
      : '没有可用模板项：需同时有收件邮箱、可核验原文与主营产品', 'warn')
  }

  async function doExport() {
    if (!identityReady) { showToast('请先补全发件人身份（姓名 / 邮箱 / 公司 / 物理地址），合规尾巴不能为空', 'warn'); return }
    if (!candidates.length) {
      showToast('没有可导出的草稿：先执行「批量出信」；若模型降级，需显式点「用本地模板补齐（DEMO）」', 'warn')
      return
    }
    // 服务端 checkExportGates 是最终闸门（G2 抑制表 / D 级禁发 / C 级确认 / 正文与尾巴）；
    // 本地只做 C 级逐条确认与 D 级过滤，避免把明显不合规项送上去再显示一堆红字。
    const unconfirmed = cCandidates.filter((c) => !confirmedC[c.key])
    const usable = candidates.filter((c) => c.grade !== 'D' && !(c.grade === 'C' && !confirmedC[c.key]))
    if (unconfirmed.length) showToast(`${unconfirmed.length} 封 C 级草稿未逐条确认，本次不导出；请在下方逐条勾选`, 'warn')
    if (!usable.length) return
    const items: ExportDraftItem[] = usable.map((c) => ({
      domain: c.domain, to: c.to, subject: c.subject, body: c.body,
      grade: c.grade, confirmed: c.grade === 'C' ? Boolean(confirmedC[c.key]) : true,
      draftSource: c.draftSource, sender, footer,
    }))
    setBusy('export')
    const r = await exportDrafts({ items, blacklist: settings.blacklist })
    setExported(r); setBusy(null); refresh()
    if (r.ok && r.content && r.filename) {
      downloadMbox(r.filename, r.content)
      showToast(`已导出 ${r.count} 封 mbox 草稿；导出 ≠ 发送，请在邮件客户端逐封确认`, 'ok')
    } else {
      const firstReason = Array.isArray(r.blocked) && r.blocked[0]?.reasons?.length
        ? r.blocked[0].reasons.join('；')
        : (r.reason ?? '见下方闸门明细')
      const hint = /未导入客户库|knownDomains|服务端持久化|退订/.test(firstReason)
        ? ' · 请先在「导入线索」把域名导入云端客户库；命中 G2 抑制名单的域名不可导出'
        : ''
      showToast(`导出被拒绝：${r.code ?? 'E6005'}（${firstReason}）${hint}`, 'warn')
    }
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
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] leading-4 text-muted">
        <span>三步共用云端客户库：导出项只来自批量出信结果或显式本地模板（DEMO）</span>
        <span>导入 ≠ 采集：origin=user_imported；官网原文由你指定 URL 抓取（user_directed_fetch），仍非系统采集</span>
        <span>导出 ≠ 发送：只生成 mbox，状态不自动置 sent</span>
        <span>数据源仍 0/6 未接入 · 标注契约 legacy（v0.8.0 不做人工标注）</span>
        <span>云端客户库 {health?.companies ?? 0} 家 · 有原文 {withSource} · 有邮箱 {withEmail} · 已研判 {health?.judged ?? 0} · 今日导出 {health?.exportedToday ?? 0}/100</span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-3">
        {/* Step 1 */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink"><Upload size={13} />1 · 批量导入线索</div>
          <textarea
            value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={CSV_HINT}
            className="lp-input h-[104px] w-full resize-none font-mono text-[11px] leading-4"
            spellCheck={false}
          />
          <Button size="sm" variant="primary" disabled={busy === 'import'} onClick={doImport}>
            {busy === 'import' ? '导入中…' : '导入 CSV'}
          </Button>
          {imported && (
            <div className="space-y-0.5 text-[11px] leading-4 text-muted">
              <div>收到 {imported.summary?.received ?? 0} · 接受 <strong className="text-emerald-700">{imported.summary?.accepted ?? 0}</strong> · 拒绝 {imported.summary?.rejected ?? 0} · 重复 {imported.summary?.duplicates ?? 0}</div>
              {imported.rejected?.slice(0, 3).map((r) => <div key={r.rowIndex} className="text-rose-700">行 {r.rowIndex}：{r.reason}</div>)}
              {imported.companies?.slice(0, 3).map((c) => <div key={c.domain}>{c.domain}{c.missingSource ? ' · 缺原文，不进 T0' : ''}</div>)}
            </div>
          )}
        </div>

        {/* Step 2 */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink"><Sparkles size={13} />2 · 抓取原文 + 批量研判</div>
          <p className="h-[64px] overflow-auto rounded-lg border border-line bg-canvas px-2.5 py-2 text-[11px] leading-4 text-slate-700">
            抓取只针对你导入的公司：用 CSV 里的 website/source_url（缺省 <code>https://域名</code>），robots 遵从、每域限速、拒绝私网地址；原文标 <code>user_directed_fetch</code>，<strong>不是系统采集</strong>。抓不到就标 <code>missing_source</code>，不编造原文。
          </p>
          <Button size="sm" variant="primary" disabled={busy === 'fetch'} onClick={doFetch}>
            {busy === 'fetch' ? '抓取中…' : '抓取缺原文公司（最多 10 家）'}
          </Button>
          {fetched && (
            <div className="space-y-0.5 text-[11px] leading-4 text-muted">
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
            <div className="space-y-0.5 text-[11px] leading-4 text-muted">
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
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink"><Download size={13} />3 · 批量出信 → 导出草稿</div>
          <div className="grid grid-cols-2 gap-1">
            {([
              ['name', '发件人姓名'], ['email', '发件人邮箱'],
              ['company', '公司英文名'], ['postalAddress', '物理地址'],
            ] as const).map(([key, label]) => (
              <input key={key} value={sender[key]} onChange={(e) => setField(key, e.target.value)}
                placeholder={label} className="lp-input h-7 text-[11px]" />
            ))}
          </div>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="primary" disabled={busy === 'generate'} onClick={doGenerate}>
              {busy === 'generate' ? '出信中…' : '批量出信（真实 T1）'}
            </Button>
            <Button size="sm" disabled={!generated} onClick={doLocalTemplate}>
              用本地模板补齐（DEMO）
            </Button>
          </div>
          {generated?.summary && (
            <div className="space-y-0.5 text-[11px] leading-4 text-muted">
              <div>真实 T1 <strong className="text-emerald-700">{generated.summary.succeeded}</strong> · 降级 <strong className="text-amber-700">{generated.summary.degraded}</strong> · 前置失败 {generated.summary.failed}</div>
              {generated.items?.slice(0, 3).map((i) => (
                <div key={`${i.bucket}:${i.domain}`} className={i.bucket === 'succeeded' ? 'text-emerald-700' : 'text-amber-700'}>
                  {i.domain} · {i.bucket}{i.codes.length ? ` · ${i.codes.join(',')}` : ''}{i.bucket !== 'succeeded' ? ' · 无正文' : ''}
                </div>
              ))}
              {generated.summary.succeeded === 0 && (
                <div className="text-amber-700">模型正文不可用时不生成假正文；可显式点「用本地模板补齐（DEMO）」，导出会标明来源</div>
              )}
            </div>
          )}
          {cCandidates.length > 0 && (
            <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5">
              <p className="text-[11px] font-medium text-amber-800">
                C 级须逐条确认（{cCandidates.filter((c) => confirmedC[c.key]).length}/{cCandidates.length} 已确认；D 级一律禁发）
              </p>
              {cCandidates.map((c) => (
                <label key={c.key} className="flex items-center gap-1.5 text-[11px] text-slate-700">
                  <input type="checkbox" checked={Boolean(confirmedC[c.key])}
                    onChange={(e) => setConfirmedC((m) => ({ ...m, [c.key]: e.target.checked }))} />
                  <span className="truncate">{c.label}</span>
                </label>
              ))}
            </div>
          )}
          {templateCandidates.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-4 text-amber-900">
              {templateCandidates.length} 封为本地模板 DEMO 草稿（非模型输出），mbox 会写 <code>X-LeadPilot-Demo: template-not-model</code>
            </div>
          )}
          <Button size="sm" variant="primary" disabled={busy === 'export'} onClick={doExport}>
            {busy === 'export' ? '导出中…' : `导出 mbox 草稿（${candidates.length}）`}
          </Button>
          {exported && (
            <div className="space-y-0.5 text-[11px] leading-4 text-muted">
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

      <div className="mt-3 flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-4 text-amber-900">
        <ShieldAlert size={12} className="mt-0.5 shrink-0" />
        <span>内测边界：OAuth / CASA Tier 2、EV 签名、provider 快照与法务意见仍是正式发布门禁；v0.8.0 决策不做 385 人工标注与商业数据源采购，评测改看 integrity + outcome 且不宣称准确率。本面板不提供「批量直接发送」，批量与真发之间必须保留人的一次确认。</span>
      </div>
    </Card>
  )
}
