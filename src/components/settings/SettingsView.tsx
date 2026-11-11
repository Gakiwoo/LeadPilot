import { useEffect, useState } from 'react'
import { Activity, CloudCog, Coins, Cpu, Database, Globe2, KeyRound, LockKeyhole, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import type { CompanyProfile, Settings } from '@/types'
import {
  PROVIDERS, resolveRegionPolicy, route, gatewayBaseUrl, getGatewayDiagnostics, runEvalGate,
  type EvalRunResult, type GatewayDiagnostics,
} from '@/services/adapters'
import { minimizeForModel } from '@/domain/compliance'
import { useAppStore } from '@/store/useAppStore'
import { Badge, Button, Card, DemoBanner, Field, SectionTitle, Toggle } from '@/components/ui'

const SECTIONS = ['公司资料', '模型接入与路由', '云端网关', 'Gmail 账号', '额度与订阅', '黑名单与隐私', '待决策项'] as const

export default function SettingsView() {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const addBlacklist = useAppStore((s) => s.addBlacklist)
  const resetDemo = useAppStore((s) => s.resetDemo)
  const showToast = useAppStore((s) => s.showToast)
  const gateway = useAppStore((s) => s.gateway)
  const probing = useAppStore((s) => s.probing)
  const probeGateway = useAppStore((s) => s.probeGateway)
  const [section, setSection] = useState<(typeof SECTIONS)[number]>('公司资料')
  const [blacklistInput, setBlacklistInput] = useState('')
  const [diag, setDiag] = useState<GatewayDiagnostics | null>(null)
  const [diagLoading, setDiagLoading] = useState(false)
  const [evalResult, setEvalResult] = useState<EvalRunResult | null>(null)

  const loadDiagnostics = async () => {
    setDiagLoading(true)
    setDiag(await getGatewayDiagnostics())
    setDiagLoading(false)
  }

  useEffect(() => {
    if (section === '云端网关') void loadDiagnostics()
  }, [section]) // eslint-disable-line react-hooks/exhaustive-deps

  const setProfile = (patch: Partial<CompanyProfile>) => updateSettings({ profile: { ...settings.profile, ...patch } })
  const setLlm = (patch: Partial<Settings['llm']>) => updateSettings({ llm: { ...settings.llm, ...patch } })
  const demoFeatures = {
    keywordHits: [], categoryDistance: 0 as const, semanticSimilarity: 0.8, marketMatch: 1,
    importBatches24m: 5, purchaseValueRatio: 1.2, seasonWindow: 1, supplierChangeSignal: 0.5,
    activitySignals: 3, employeeCount: 30, revenueUsd: 8_000_000, sizeTier: 'M' as const,
    sizeEvidenceLevel: 'mid' as const, customsRecords: null, customsDataAvailable: false,
    importWording: 'inferred' as const, distributedBrands: 2, tradeTermHits: 2,
    emailGrade: 'A' as const, mxValid: true, smtpVerified: true, domainMatch: true,
    hasNamedContact: true, sourceTexts: ['Authorized distributor for Parker and Eaton across Benelux.'],
  }
  const region = resolveRegionPolicy('德国', 'T2', settings.llm.regionPolicy)

  const nav = (
    <div className="w-40 shrink-0 space-y-0.5">
      {SECTIONS.map((s) => (
        <button key={s} onClick={() => setSection(s)} className={`w-full rounded-lg px-2.5 py-2 text-left text-[12px] transition ${section === s ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}>{s}</button>
      ))}
    </div>
  )

  return (
    <div className="space-y-3">
      <DemoBanner text="客户记录、BYOK / Gmail 凭据与采集数据源仍为演示。云端 LLM 网关与任务编排为真实服务；API Key 只从服务端环境变量读取，本页不会保存或回显任何密钥。" />
      <div className="flex gap-4">
        {nav}
        <div className="min-w-0 flex-1 space-y-3">
          {section === '公司资料' && (
            <Card className="p-5">
              <SectionTitle title="公司资料" desc="这是 AI 写信唯一的事实来源，必须引导用户填完。缺失字段用 [填入xx] 占位符，绝不允许模型推测。" extra={<Badge tone="brand">F10 · F6-1</Badge>} />
              <div className="grid grid-cols-2 gap-3">
                <Field label="公司名（英文）"><input className="lp-input" value={settings.profile.companyNameEn} onChange={(e) => setProfile({ companyNameEn: e.target.value })} /></Field>
                <Field label="公司名（中文）"><input className="lp-input" value={settings.profile.companyNameZh} onChange={(e) => setProfile({ companyNameZh: e.target.value })} /></Field>
                <Field label="主营产品" hint="用于开发信中的产品词与匹配锚点"><input className="lp-input" value={settings.profile.mainProducts} onChange={(e) => setProfile({ mainProducts: e.target.value })} /></Field>
                <Field label="官网"><input className="lp-input" value={settings.profile.website} onChange={(e) => setProfile({ website: e.target.value })} /></Field>
                <Field label="物理地址" hint="CAN-SPAM 要求每封信带真实物理地址"><input className="lp-input" value={settings.profile.address} onChange={(e) => setProfile({ address: e.target.value })} /></Field>
                <Field label="认证"><input className="lp-input" value={settings.profile.certifications} onChange={(e) => setProfile({ certifications: e.target.value })} /></Field>
                <Field label="MOQ"><input className="lp-input" value={settings.profile.moq} onChange={(e) => setProfile({ moq: e.target.value })} /></Field>
                <Field label="交期"><input className="lp-input" value={settings.profile.leadTime} onChange={(e) => setProfile({ leadTime: e.target.value })} /></Field>
                <Field label="核心优势（每行一条，最多 2 条进信）"><textarea className="lp-input h-20 resize-none" value={settings.profile.advantages.join('\n')} onChange={(e) => setProfile({ advantages: e.target.value.split('\n').filter(Boolean) })} /></Field>
                <Field label="成功案例"><textarea className="lp-input h-20 resize-none" value={settings.profile.caseStudies} onChange={(e) => setProfile({ caseStudies: e.target.value })} /></Field>
                <Field label="发件人"><input className="lp-input" value={settings.profile.senderName} onChange={(e) => setProfile({ senderName: e.target.value })} /></Field>
                <Field label="职位"><input className="lp-input" value={settings.profile.senderTitle} onChange={(e) => setProfile({ senderTitle: e.target.value })} /></Field>
                <Field label="电话"><input className="lp-input" value={settings.profile.phone} onChange={(e) => setProfile({ phone: e.target.value })} /></Field>
              </div>
              <div className="mt-3 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-[11px] text-emerald-800">
                <ShieldCheck size={13} /> 数据最小化检查：发往模型的字段已剔除 {minimizeForModel(demoFeatures, settings.profile).removed.join(' / ')}。
              </div>
            </Card>
          )}

          {section === '模型接入与路由' && (
            <>
              <Card className="p-5">
                <SectionTitle title="三级路由" desc="业务层只依赖统一适配器，路由判定写在网关里" extra={<Badge tone="brand">F0 · v1.1 核心</Badge>} />
                <div className="grid grid-cols-3 gap-3">
                  {(['T0', 'T1', 'T2'] as const).map((tier) => (
                    <div key={tier} className="rounded-lg border border-line p-3">
                      <div className="flex items-center justify-between"><span className="text-[13px] font-semibold text-ink">{tier}</span><Badge tone={tier === 'T0' ? 'emerald' : tier === 'T1' ? 'blue' : 'violet'}>{{ T0: '~85%', T1: '~13%', T2: '~2%' }[tier]}</Badge></div>
                      <p className="mt-1 text-[10px] leading-4 text-muted">{{ T0: '抽取 / 分类 / 关键词扩展 · 成本极敏感', T1: '五维判断 / 开发信生成 · 质量优先', T2: '冲突仲裁 / 低置信复议 · 量小质优' }[tier]}</p>
                      <select className="lp-input mt-2 h-8 text-[11px]" value={settings.llm[tier.toLowerCase() as 't0' | 't1' | 't2']} onChange={(e) => setLlm({ [tier.toLowerCase()]: e.target.value } as Partial<Settings['llm']>)}>
                        {PROVIDERS.filter((p) => p.tier === tier).map((p) => <option key={p.key} value={p.name}>{p.name}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                  <span>路由示例：</span>
                  <span className="lp-chip">extract → {route({ type: 'extract' })}</span>
                  <span className="lp-chip">write_email → {route({ type: 'write_email' })}</span>
                  <span className="lp-chip">confidence 0.4 → {route({ type: 'judge_import', confidence: 0.4 })}</span>
                  <span className="lp-chip">conflict → {route({ type: 'judge_size', conflict: true })}</span>
                  <span className="lp-chip">L4 高价值 → {route({ type: 'judge_import', depth: 4, valueTier: 'high' })}</span>
                </div>
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-4 text-amber-800">
                  PM 判断：8 家全接的代价是 8 套鉴权 / 限流 / 错误码 / 合规审查。MVP 只落地 2 家跑通路由骨架，其余按适配器接口预留；「支持 8 家」是功能清单，不是 MVP 交付范围。
                </div>
              </Card>
              <Card className="p-5">
                <SectionTitle title="成本、评测与合规" desc="9.4 / 9.5 / 11.4 的工程纪律" />
                <div className="grid grid-cols-3 gap-3 text-[11px]">
                  <div className="rounded-lg border border-line p-3"><p className="font-medium text-ink">单任务成本（L2/200）</p><p className="mt-1 text-[18px] font-semibold text-emerald-600">≈ ¥9.9</p><p className="mt-1 leading-4 text-muted">三级路由方案 B；全 GPT-5 约 ¥80，差 8 倍。路由不是优化项，是订阅制的生死线。</p></div>
                  <div className="rounded-lg border border-line p-3"><p className="font-medium text-ink">上线门槛</p><p className="mt-1 text-[18px] font-semibold text-brand-600">integrity + outcome</p><p className="mt-1 leading-4 text-muted">v0.8.0 不做人工标注：可溯源率 ≥ 95%、Rule Compliance 100%、证据逐字可核验 ≥ 95%、真实退信率 ≤ 3%；无真实样本返回 NO_DATA，且不宣称准确率。</p></div>
                  <div className="rounded-lg border border-line p-3"><p className="font-medium text-ink">数据出境</p><p className="mt-1 text-[13px] font-semibold text-ink">{region.group === 'domestic' ? '默认境内组' : '境外需同意'}</p><p className="mt-1 leading-4 text-muted">{region.reason}。EU/EEA/UK 客户 T0/T1 强制境内，T2 默认拒绝。</p></div>
                </div>
                <div className="mt-4 space-y-1 border-t border-line pt-3">
                  <Toggle checked={settings.llm.byokEnabled} onChange={(v) => setLlm({ byokEnabled: v })} label="BYOK 用户自带 API Key（高级选项，默认关闭）" desc="MVP 支持 DeepSeek + OpenAI；DPAPI 加密存本地绝不上传，保存时发一次 1-token 探活。演示模式不保存任何密钥。" />
                  <Toggle checked={settings.llm.regionPolicy === 'domestic_first'} onChange={(v) => setLlm({ regionPolicy: v ? 'domestic_first' : 'quality_first' })} label="默认境内组（合规优先）" desc="关闭则按模型质量最优路由——企业客户会在 IT 审核阶段直接出局，不建议。" />
                </div>
              </Card>
            </>
          )}

          {section === '云端网关' && (
            <>
              <Card className="p-5">
                <SectionTitle
                  title="云端网关实时状态"
                  desc={`真实运行于 ${gatewayBaseUrl}；Key 只从服务端环境变量读取，不落库、不进日志、不回传前端`}
                  extra={<Badge tone={gateway?.mode === 'configured' ? 'emerald' : 'amber'}>{gateway?.mode === 'configured' ? '已配置 Key' : gateway?.online ? '在线 · 未配 Key' : gateway ? '离线' : '探测中'}</Badge>}
                />
                <div className="grid grid-cols-5 gap-3 text-[11px]">
                  {[
                    { label: '可真实调用', value: gateway ? `${gateway.readyCount} / ${gateway.totalProviders}` : '—' },
                    { label: '已配 Key / 已锁快照', value: gateway ? `${gateway.configuredCount} / ${gateway.pinnedCount}` : '—' },
                    { label: '结果缓存', value: gateway ? `${gateway.cacheEntries} 条 · TTL ${diag?.cache.ttlDays ?? 30} 天` : '—' },
                    { label: '调用审计', value: gateway ? `${gateway.auditEntries} 条` : '—' },
                    { label: '熔断中', value: diag ? `${diag.circuit.length} 家` : '—' },
                  ].map((x) => (
                    <div key={x.label} className="rounded-lg border border-line bg-canvas p-3">
                      <p className="text-[10px] text-muted">{x.label}</p>
                      <p className="mt-1 text-[14px] font-semibold tabular-nums text-ink">{x.value}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button size="sm" disabled={probing} onClick={() => void probeGateway()}><RefreshCw size={12} className={probing ? 'animate-spin' : ''} /> {probing ? '检测中…' : '重新检测网关'}</Button>
                  <Button size="sm" disabled={diagLoading} onClick={() => void loadDiagnostics()}><Activity size={12} /> 刷新审计</Button>
                  <span className="text-[11px] text-muted">{gateway?.reason ?? '探测失败时界面明确显示离线，不会伪造在线状态。'}</span>
                </div>
                {gateway?.mode === 'offline' && (
                  <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] leading-5 text-rose-800">
                    <strong>云端服务不可达（offline）</strong>：这既不是 E6005「未配 Key」，也不是 E6008「快照未锁定」。
                    请先启动 <code>npm run cloud</code> 并确认 {gatewayBaseUrl} 可访问；在此之前界面只显示本地规则估算，未经模型校验，也不会引导你去配 Key。
                    {gateway.reason && <span className="mt-1 block opacity-80">{gateway.reason}</span>}
                  </p>
                )}
                {gateway && gateway.mode !== 'configured' && gateway.mode !== 'offline' && (
                  <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
                    <strong>{(gateway?.configuredCount ?? 0) > 0 && gateway?.pinnedCount === 0 ? '当前为 E6008 降级模式（快照未锁定）' : '当前为 E6005 降级模式'}</strong>：判断与写信请求不会转发给任何 provider，界面把分数改为区间显示并标注「未经模型校验」。
                    {(gateway?.configuredCount ?? 0) > 0 && gateway?.pinnedCount === 0
                      ? '已配 Key 但未锁定 model_version 快照，禁止 -latest 浮动指针。请设置 LEADPILOT_MODEL_VERSION_<PROVIDER_KEY> 为官网可查的具体版本 ID 后重启服务。'
                      : '配置任一 Key（如 DEEPSEEK_API_KEY）并锁定对应快照后重启云端服务即可走真实调用链，无需改前端代码。'}
                    {gateway?.reason && <span className="mt-1 block opacity-80">{gateway.reason}</span>}
                  </p>
                )}
                {gateway?.security && (
                  <p className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line pt-2 text-[10px] text-muted">
                    <ShieldCheck size={12} className="text-emerald-600" />
                    网关安全：
                    <Badge tone={gateway.security.mode === 'token' ? 'emerald' : 'slate'}>{gateway.security.mode === 'token' ? 'Bearer 令牌鉴权' : '仅本机免鉴权'}</Badge>
                    <span>CORS {gateway.security.cors.join(' / ')}</span>
                    <span>· 限流 {gateway.security.rateLimitPerMinute} 次/分钟/IP</span>
                  </p>
                )}
                {gateway?.online && (
                  <p className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line pt-2 text-[10px] text-muted">
                    <Database size={12} className="text-slate-500" />
                    采集数据源：
                    <Badge tone={gateway.dataSources?.readyCount ? 'emerald' : 'slate'}>
                      {gateway.dataSources ? `${gateway.dataSources.readyCount} / ${gateway.dataSources.total} 已就绪` : '—'}
                    </Badge>
                    <span>注册表 6 类 · 未接入时编排器显式 demo，绝不写入客户记录</span>
                    <span className="mx-1">·</span>
                    <Cpu size={12} className="text-slate-500" />
                    T0 规则抽取：
                    <Badge tone="blue">{gateway.t0?.rulesVersion ?? '—'}</Badge>
                    <span>确定性规则，不调模型、不联网、不补零</span>
                  </p>
                )}
              </Card>

              <Card className="p-5">
                <SectionTitle
                  title="点数账本 · T0 事实链 · 评测契约"
                  desc="v0.6.0 工程口径：服务端如实暴露能力边界，未标注、未扣费、未接数据源一律标出来"
                  extra={<Badge tone={gateway?.points ? 'blue' : 'slate'}>{gateway?.points?.ledgerVersion ?? '账本离线'}</Badge>}
                />
                <div className="grid grid-cols-4 gap-3 text-[11px]">
                  {[
                    { label: '可用点数', value: gateway?.points ? `${gateway.points.available} / ${gateway.points.granted}` : '—' },
                    { label: '预扣中 / 已结算', value: gateway?.points ? `${gateway.points.held} / ${gateway.points.spent}` : '—' },
                    { label: '账本流水', value: gateway?.points ? `${gateway.points.entries} 条 · ${gateway.points.persistence}` : '—' },
                    { label: '标注契约（legacy）', value: gateway?.baseline ? `${gateway.baseline.contractStatus ?? 'legacy'} · 不做 385` : '—' },
                  ].map((x) => (
                    <div key={x.label} className="rounded-lg border border-line bg-canvas p-3">
                      <p className="text-[10px] text-muted">{x.label}</p>
                      <p className="mt-1 text-[13px] font-semibold tabular-nums text-ink">{x.value}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-3 space-y-1.5 text-[10px] leading-5 text-muted">
                  <p className="flex flex-wrap items-center gap-1.5">
                    <Coins size={12} className="text-amber-600" />
                    账本范围：
                    <Badge tone="emerald">任务预扣</Badge><Badge tone="emerald">任务结算/释放</Badge>
                    <Badge tone="blue">judge / write_email 真实调用预扣</Badge><Badge tone="blue">校验通过才结算</Badge>
                    <span>同一 refId 幂等，进程重启不重复扣（AC-03）。</span>
                  </p>
                  <p className="flex flex-wrap items-center gap-1.5">
                    <ShieldCheck size={12} className="text-rose-600" />
                    <strong className="text-ink">网关计费口径</strong>：
                    <span>
                      预扣上限 T0={gateway?.billing?.reservePoints?.T0 ?? '—'} / T1={gateway?.billing?.reservePoints?.T1 ?? '—'} / T2={gateway?.billing?.reservePoints?.T2 ?? '—'} 点；
                      仅内容校验通过才结算，失败/降级/缓存命中一律全额释放、不扣点；未注入账本的独立网关仍为 audit-only。
                    </span>
                  </p>
                  <p className="flex flex-wrap items-center gap-1.5">
                    <ShieldCheck size={12} className="text-slate-500" />
                    <strong className="text-ink">明确边界</strong>：
                    <span>{gateway?.points?.note ?? '账本覆盖云端任务与网关真实调用；审计里的 points 是 token 折算估值，只有 billing.charged=true 才代表实际扣点。'}</span>
                  </p>
                  <p className="flex flex-wrap items-center gap-1.5">
                    <Cpu size={12} className="text-blue-600" />
                    T0 → judge 事实链：
                    <Badge tone={gateway?.t0?.judgeFactChain?.enabled ? 'emerald' : 'slate'}>
                      {gateway?.t0?.judgeFactChain?.enabled ? '已接线' : '未接线'}
                    </Badge>
                    <span>{gateway?.t0?.judgeFactChain?.onConflict ?? '—'}</span>
                    <span>· 仅当调用方提供可核验 sources 时启用；演示数据不伪造来源。</span>
                  </p>
                  <p className="flex flex-wrap items-center gap-1.5">
                    <LockKeyhole size={12} className="text-slate-500" />
                    评测口径：
                    <Badge tone="emerald">integrity + outcome</Badge>
                    <span>v0.8.0 决策不做人工标注：完整性 / 可溯源 / 一致性 + 真实退信率；无真实样本返回 NO_DATA，accuracyClaim 恒 false。</span>
                  </p>
                </div>
              </Card>

              <Card className="p-5">
                <SectionTitle title="Provider 健康与降级链" desc="按 T0 → T1 → T2 组顺位；5xx 立即切下家，连续 10 次失败熔断 15 分钟" extra={<Badge tone="brand">F0-4</Badge>} />
                <div className="space-y-1">
                  {(gateway?.providers ?? []).map((p) => (
                    <div key={p.key} className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-[11px]">
                      <Badge tone={p.tier === 'T0' ? 'emerald' : p.tier === 'T1' ? 'blue' : 'violet'}>{p.tier}</Badge>
                      <span className="font-medium text-ink">{p.name}</span>
                      <span className="text-muted">{p.region === 'domestic' ? '境内组' : '境外组'}</span>
                      {p.modelVersion && <code className="max-w-[180px] truncate text-[10px] text-slate-500" title={p.modelVersion}>{p.modelVersion}</code>}
                      <span className="ml-auto flex items-center gap-1.5">
                        {p.configured && !p.pinned && <Badge tone="amber">快照未锁定</Badge>}
                        {p.pinned && <Badge tone="violet">快照已锁</Badge>}
                        {p.circuitOpen ? <Badge tone="rose">熔断中</Badge> : p.configured ? <Badge tone="emerald">已配 Key</Badge> : <Badge tone="slate">未配置</Badge>}
                      </span>
                    </div>
                  ))}
                  {!gateway?.online && <p className="text-[11px] text-muted">云端服务不可达，无法读取 provider 清单。启动命令：<code>node server/index.mjs</code></p>}
                </div>
              </Card>

              <Card className="p-5">
                <SectionTitle title="调用审计" desc="只记录元数据（provider / 模型 / token / 点数 / 延迟 / 是否降级），绝不记录 prompt、官网原文或客户邮箱（11.4.4）" />
                <div className="max-h-[220px] space-y-1 overflow-y-auto">
                  {(diag?.entries ?? []).slice(-14).reverse().map((e, i) => (
                    <div key={`${e.at}-${i}`} className="flex flex-wrap items-center gap-2 rounded-lg bg-canvas px-2.5 py-1.5 font-mono text-[10px]">
                      <span className="text-slate-400">{new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                      <span className="text-ink">{e.taskType ?? 'unknown'}</span>
                      <span className="text-slate-500">{e.tier ?? '—'}</span>
                      <span className="text-slate-500">{e.providerKey ?? 'none'}</span>
                      {e.cached && <Badge tone="slate">cache</Badge>}
                      {e.points !== undefined && <span className="text-slate-500">{e.points} 点</span>}
                      {e.provenanceRate !== undefined && <span className="text-slate-500">溯源 {Math.round(e.provenanceRate * 100)}%</span>}
                      {e.latencyMs !== undefined && <span className="text-slate-400">{e.latencyMs}ms</span>}
                      {e.degraded && <Badge tone="rose">{e.code ?? 'DEGRADED'}</Badge>}
                    </div>
                  ))}
                  {(!diag || diag.entries.length === 0) && <p className="text-[11px] text-muted">暂无调用记录。点击详情页的「云端判断」或写信页的「生成 2 版」即可产生一条真实审计（含 E6005 降级记录）。</p>}
                </div>
              </Card>

              <Card className="p-5">
                <SectionTitle title="发布评测门禁" desc="v0.8.0：不做 385 家人工标注；口径为 integrity + outcome。P0 任一不达标阻断内测，没有真实样本就返回 NO_DATA" extra={<Badge tone="rose">P0 阻断项</Badge>} />
                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  {(diag?.gates?.integrityGate?.p0 ?? diag?.gates?.p0 ?? []).map((k) => {
                    const m = diag?.gates?.integrityGate?.metrics?.[k] ?? diag?.gates?.metrics[k]
                    return (
                      <div key={k} className="rounded-lg border border-line p-2.5">
                        <p className="font-medium text-ink">{m?.name ?? k}</p>
                        <p className="mt-1 text-muted">{m?.direction ?? '>='} {m?.threshold ?? '—'} · <code>{k}</code></p>
                      </div>
                    )
                  })}
                  {!diag?.gates && <p className="text-muted">评测门禁配置不可读（云端服务离线）。</p>}
                </div>
                <p className="mt-2 text-[11px] text-muted">
                  outcome 门禁：硬退信率 ≤ 3%（P0）· 回复率仅观测；样本不足返回 NO_DATA / INSUFFICIENT，永不生成准确率断言。
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={async () => {
                    const r = await runEvalGate([])
                    setEvalResult(r)
                    showToast(r.status === 'NO_DATA' ? '没有真实样本：门禁返回 NO_DATA，不编造通过' : `门禁结果：${r.status}`, r.ok ? 'ok' : 'warn')
                  }}><CloudCog size={12} /> 以空样本试跑 legacy 门禁</Button>
                  <span className="text-[11px] text-muted">integrity 指标 {diag?.gates?.integrityGate ? Object.keys(diag.gates.integrityGate.metrics).length : '—'} 项 · outcome 2 项 · 不宣称准确率</span>
                </div>
                {evalResult && (
                  <p className={`mt-2 rounded-lg border px-3 py-2 text-[11px] leading-4 ${evalResult.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
                    <strong>{evalResult.status}</strong> · {evalResult.message ?? '无更多说明'}
                  </p>
                )}
              </Card>
            </>
          )}

          {section === 'Gmail 账号' && (
            <Card className="p-5">
              <SectionTitle title="Gmail 账号管理" desc="OAuth 2.0 + PKCE · loopback 127.0.0.1 回调 · 不使用内嵌 WebView" />
              <div className="space-y-2">
                {[
                  { scope: 'openid / userinfo.email / userinfo.profile', level: '非敏感', use: '识别账号、显示发信人身份', mvp: true },
                  { scope: 'gmail.compose', level: 'Sensitive', use: '创建草稿、读取自己创建的草稿', mvp: true },
                  { scope: 'gmail.send', level: 'Restricted', use: '直接发送邮件（需 CASA Tier 2）', mvp: false },
                  { scope: 'gmail.readonly（限 threads）', level: 'Restricted', use: '读取回复邮件、自动回写状态', mvp: false },
                ].map((s) => (
                  <div key={s.scope} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2 text-[11px]">
                    <code className="font-mono text-ink">{s.scope}</code>
                    <Badge tone={s.level === 'Restricted' ? 'rose' : s.level === 'Sensitive' ? 'amber' : 'slate'}>{s.level}</Badge>
                    <span className="text-muted">{s.use}</span>
                    <span className={`ml-auto ${s.mvp ? 'text-emerald-600' : 'text-slate-400'}`}>{s.mvp ? 'MVP ✓' : 'V1'}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
                <div className="rounded-lg bg-canvas p-3"><p className="font-medium text-ink">接入后账号体检</p><p className="mt-1 leading-5 text-muted">SPF / DKIM / DMARC 记录、账号类型（个人 500 / Workspace 2,000）、账号年龄与预热曲线、历史退信统计。</p></div>
                <div className="rounded-lg bg-canvas p-3"><p className="font-medium text-ink">凭据存储</p><p className="mt-1 leading-5 text-muted">access_token 仅内存；refresh_token 用 Windows DPAPI（CurrentUser）加密写本地 SQLite；服务端只存订阅与额度，不接触任何 token。</p></div>
              </div>
              <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-4 text-amber-800"><Globe2 size={13} className="mt-0.5 shrink-0" /> 用个人 Gmail 做 B2B 开发信本身处于 Google 使用条款灰色地带。产品只能把风险降到最低，无法承诺账号绝不被限制；同时提供 EML 导出兜底。</p>
            </Card>
          )}

          {section === '额度与订阅' && (
            <Card className="p-5">
              <SectionTitle title="额度与订阅" desc="采集点数 + 订阅期双轨；发信不额外计费" />
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-lg border border-line p-3"><p className="text-[11px] text-muted">当前套餐</p><p className="mt-1 text-[14px] font-semibold text-ink">{settings.plan}</p></div>
                <div className="rounded-lg border border-line p-3"><p className="text-[11px] text-muted">剩余点数</p><p className="mt-1 flex items-center gap-1 text-[20px] font-semibold tabular-nums text-ink"><Coins size={16} className="text-amber-500" />{settings.pointsBalance.toLocaleString()}</p></div>
                <div className="rounded-lg border border-line p-3"><p className="text-[11px] text-muted">深度点数系数</p><p className="mt-1 text-[13px] font-medium text-ink">L1=1 / L2=2 / L3=4 / L4=8 点每客户</p></div>
              </div>
              <p className="mt-3 text-[11px] leading-5 text-muted">L2/200 任务约 ¥9.9，¥199 套餐含 7.5 个 L2 任务时毛利约 63%；若用户全部跑 L4 会吃光毛利，建议给 L4 单独设更高点数系数并在 UI 明示（Q11）。</p>
            </Card>
          )}

          {section === '黑名单与隐私' && (
            <Card className="p-5">
              <SectionTitle title="黑名单与数据隐私" desc="退订即刻生效、全局生效、不可逆；UI 不提供忽略黑名单开关" />
              <div className="flex gap-2">
                <input className="lp-input" placeholder="邮箱或 @域名" value={blacklistInput} onChange={(e) => setBlacklistInput(e.target.value)} />
                <Button size="sm" onClick={() => { if (!blacklistInput.trim()) return; addBlacklist(blacklistInput.trim()); setBlacklistInput(''); showToast('已加入全局黑名单', 'warn') }}><KeyRound size={12} /> 添加</Button>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {settings.blacklist.map((b) => <Badge key={b} tone="rose"><LockKeyhole size={10} /> {b}</Badge>)}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4 text-[11px]">
                <div className="rounded-lg bg-canvas p-3"><p className="flex items-center gap-1 font-medium text-ink"><Database size={13} /> 本地数据</p><p className="mt-1 leading-5 text-muted">演示数据存 localStorage；桌面版为本地 SQLite（客户库 / 任务 / 状态 / 草稿队列 / 设置），可选 SQLCipher 加密。</p></div>
                <div className="rounded-lg bg-canvas p-3"><p className="flex items-center gap-1 font-medium text-ink"><Trash2 size={13} /> 清除与导出</p><p className="mt-1 leading-5 text-muted">支持一键导出全部数据、清空客户数据、关闭使用数据统计上报；日志导出自动脱敏（不含 token / 完整邮箱 / 公司名）。</p></div>
              </div>
              <Button size="sm" variant="danger" className="mt-3" onClick={() => { if (window.confirm('将清空所有本地演示数据并重新生成，确认？')) resetDemo() }}><Trash2 size={12} /> 清空并重置演示数据</Button>
            </Card>
          )}

          {section === '待决策项' && (
            <Card className="p-5">
              <SectionTitle title="M0 结束前必须拍板的 11 项" desc="PM 建议已给出，红色为会阻塞研发的关键路径" />
              <div className="space-y-1.5 text-[11px]">
                {[
                  ['Q1', '海关数据源预算', '建议 A：先采购美/印/越 3 国，用真实使用数据验证付费意愿后再扩'],
                  ['Q2', 'Google 验证路径', '建议 A：MVP 只做 sensitive（草稿），M0 同步启动 restricted 申请'],
                  ['Q3', '定价模型', '建议 B：订阅 + 点数，基础点数给足'],
                  ['Q4', '是否做免费版', '建议 B：只做 14 天试用，采集是实打实花钱的'],
                  ['Q5', '非 Gmail 邮箱', '建议 V1 加 SMTP 通道，中国外贸企业大量用企业邮箱'],
                  ['Q6', '团队版数据归属', 'V2 议题：B（数据归企业）更符老板诉求，需员工接受度设计'],
                  ['Q7', 'macOS 版', '建议 V2 再议，目标用户 95% 在 Windows'],
                  ['Q8', 'T0/T1/T2 选哪家', '建议 B 起步但 MVP 只落地 2 家；决策依据应是基准集跑分而非拍脑袋'],
                  ['Q9', 'BYOK 定位', '建议 B：高级选项、成本兜底，不做主推模式'],
                  ['Q10', '数据出境默认策略', '建议 A + C：默认境内，企业版强制境内/本地'],
                  ['Q11', '按新成本重算定价', 'L4 单独设更高点数系数，¥199 含 7.5 个 L2 任务毛利 63% 可接受'],
                ].map(([id, title, advice]) => (
                  <div key={id} className="flex items-start gap-2 rounded-lg border border-line px-3 py-2">
                    <Badge tone={['Q1', 'Q2', 'Q8', 'Q10'].includes(id) ? 'rose' : 'slate'}>{id}</Badge>
                    <span className="w-28 shrink-0 font-medium text-ink">{title}</span>
                    <span className="leading-4 text-muted">{advice}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
