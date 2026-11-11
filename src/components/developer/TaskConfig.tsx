import { useMemo, useState } from 'react'
import { Check, ChevronDown, CloudCog, Coins, Globe2, HardDrive, Info, Play, Sparkles, X } from 'lucide-react'
import type { CustomerType, SizeTier, TaskConfig } from '@/types'
import { CUSTOMER_TYPES, CUSTOMS_AVAILABILITY, DEPTH_CONFIG, MARKET_PRESETS } from '@/domain/constants'
import { useAppStore } from '@/store/useAppStore'
import { Button, Card, DemoBanner, Field, SectionTitle, Toggle } from '@/components/ui'

const COUNTRIES = ['德国', '荷兰', '美国', '英国', '法国', '越南', '泰国', '印尼', '马来西亚', '阿联酋', '沙特', '巴西', '墨西哥', '智利', '日本', '波兰', '土耳其', '印度', '西班牙', '意大利']
const STOP_WORDS = new Set(['the', 'a', 'an', 'product', 'products', 'and', 'of', '的', '1', '2'])
const EXAMPLES: { label: string; desc: string; config: Partial<TaskConfig> }[] = [
  { label: '德国 · 五金工具 · 进口商', desc: 'L2 标准 · 100 家 · 无海关数据市场', config: { keywords: ['hydraulic fittings', 'brass fittings'], markets: ['德国'], customerTypes: ['importer', 'distributor'], depth: 2, targetCount: 100 } },
  { label: '美国 · 液压接头 · 分销商', desc: 'L3 深度 · 200 家 · 海关数据可得性高', config: { keywords: ['hydraulic hose fittings', 'JIC fittings'], markets: ['美国'], customerTypes: ['distributor', 'wholesaler'], depth: 3, targetCount: 200 } },
  { label: '越南 · 工业配件 · 批发商', desc: 'L1 快速 · 50 家 · 试水关键词', config: { keywords: ['brass fittings'], markets: ['越南'], customerTypes: ['wholesaler'], depth: 1, targetCount: 50 } },
]

const DEFAULT: TaskConfig = {
  keywords: [], excludeKeywords: [], markets: [], customerTypes: [], depth: 2, targetCount: 100,
  sizeTiers: ['S', 'M', 'L', 'XL'], foundedYearsMin: null, onlyVerifiedEmails: false, hsCode: '', name: '',
}

export default function TaskConfigPanel() {
  const [config, setConfig] = useState<TaskConfig>(DEFAULT)
  const [keywordInput, setKeywordInput] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [error, setError] = useState('')
  const settings = useAppStore((s) => s.settings)
  const startTask = useAppStore((s) => s.startTask)
  const showToast = useAppStore((s) => s.showToast)
  const tasks = useAppStore((s) => s.tasks)
  const runnerMode = useAppStore((s) => s.runnerMode)
  const setRunnerMode = useAppStore((s) => s.setRunnerMode)
  const gateway = useAppStore((s) => s.gateway)

  const cost = config.targetCount * DEPTH_CONFIG[config.depth].pointsPerCompany
  const running = tasks.some((t) => ['running', 'paused', 'queued'].includes(t.status))
  const availability = useMemo(() => {
    if (!config.markets.length) return null
    const levels = config.markets.map((m) => CUSTOMS_AVAILABILITY[m] ?? 'low')
    const worst = levels.includes('low') ? '低' : levels.includes('mid') ? '中' : '高'
    return { level: worst, text: worst === '高' ? '可直接用海关记录判断采购行为' : worst === '中' ? '需走「官网信号 + 分销结构」推断路径' : '无公开海关数据，进口可能性权重将转移至官网信号' }
  }, [config.markets])

  const patch = (p: Partial<TaskConfig>) => { setConfig((c) => ({ ...c, ...p })); setError('') }

  const addKeywords = (raw: string) => {
    const words = raw.split(/[,，\n]/).map((w) => w.trim()).filter(Boolean)
    const invalid = words.find((w) => /^\d+$/.test(w) || w.length < 2 || STOP_WORDS.has(w.toLowerCase()))
    if (invalid) { setError(`「${invalid}」不是有效关键词：纯数字、单字符或停用词不允许提交`); return }
    const next = Array.from(new Set([...config.keywords, ...words])).slice(0, 10)
    if (words.length + config.keywords.length > 10) setError('单任务最多 10 个关键词，建议拆成多个任务以避免稀释匹配准确度')
    patch({ keywords: next })
    setKeywordInput('')
  }

  const toggleCountry = (c: string) => patch({ markets: config.markets.includes(c) ? config.markets.filter((x) => x !== c) : [...config.markets, c] })
  const toggleType = (t: CustomerType) => patch({ customerTypes: config.customerTypes.includes(t) ? config.customerTypes.filter((x) => x !== t) : [...config.customerTypes, t] })
  const toggleSize = (t: SizeTier) => patch({ sizeTiers: config.sizeTiers.includes(t) ? config.sizeTiers.filter((x) => x !== t) : [...config.sizeTiers, t] })

  const submit = () => {
    if (!config.keywords.length) { setError('至少填写 1 个产品关键词'); return }
    if (!config.markets.length) { setError('必须选择至少一个目标市场（全局搜索会产生大量无关结果）'); return }
    if (!config.customerTypes.length) { setError('至少选择一种客户类型'); return }
    if (cost > settings.pointsBalance) { setError(`点数不足：本次需 ${cost} 点，剩余 ${settings.pointsBalance} 点`); return }
    const result = startTask(config)
    if (!result.ok) { setError(result.message ?? '任务启动失败'); return }
    showToast(result.message ?? '任务已启动', 'ok')
  }

  return (
    <div className="space-y-4">
      <DemoBanner text={runnerMode === 'cloud'
        ? '云端编排器为真实服务（任务状态机 + SSE 流式推送 + 游标续跑），但数据源适配器未接入：只推阶段/统计事件，不产生任何客户记录，也不做真实采集。'
        : '本地运行器用预置数据模拟流式采集并写入演示客户；不发起任何真实搜索、模型调用或额度扣费（点数仅作界面演示）。'} />

      <Card className="p-4">
        <SectionTitle
          title="运行方式"
          desc="两种运行器的边界必须一眼看清：真实编排 ≠ 真实采集，演示客户 ≠ 真实线索"
          extra={<span className="lp-chip">{gateway?.online ? '云端服务在线' : '云端服务离线'}</span>}
        />
        <div className="grid grid-cols-2 gap-2.5">
          <button
            onClick={() => setRunnerMode('local')}
            className={`rounded-lg border px-3 py-2.5 text-left transition ${runnerMode === 'local' ? 'border-brand-500 bg-brand-50/50' : 'border-line bg-white hover:border-slate-300'}`}
          >
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink"><HardDrive size={13} /> 本地演示运行器</div>
            <p className="mt-1 text-[11px] leading-4 text-muted">流式写入演示客户，可完整体验评分 / 筛选 / 建草稿链路。零真实请求。</p>
          </button>
          <button
            onClick={() => setRunnerMode('cloud')}
            className={`rounded-lg border px-3 py-2.5 text-left transition ${runnerMode === 'cloud' ? 'border-brand-500 bg-brand-50/50' : 'border-line bg-white hover:border-slate-300'}`}
          >
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink"><CloudCog size={13} /> 云端编排器（SSE）</div>
            <p className="mt-1 text-[11px] leading-4 text-muted">真实任务状态机与流式事件、暂停/续跑/中止、单源降级告警。数据源未接入，不写入客户库。</p>
          </button>
        </div>
        {runnerMode === 'cloud' && !gateway?.online && (
          <p className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-2 text-[11px] text-rose-700">
            云端服务当前不可达，提交后会明确标记任务失败并退还预扣点数。启动命令：<code>node server/index.mjs</code>
          </p>
        )}
      </Card>

      <Card className="p-4">
        <SectionTitle title="一键示例任务" desc="PRD 5.3：空态不放插画，直接给可点的示例" />
        <div className="grid grid-cols-3 gap-2.5">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              onClick={() => { setConfig({ ...DEFAULT, ...ex.config }); setError('') }}
              className="group rounded-lg border border-line bg-white px-3 py-2.5 text-left transition hover:border-brand-500 hover:bg-brand-50/40"
            >
              <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink"><Sparkles size={13} className="text-brand-500" />{ex.label}</div>
              <div className="mt-1 text-[11px] leading-4 text-muted">{ex.desc}</div>
            </button>
          ))}
        </div>
      </Card>

      <Card className="p-5">
        <SectionTitle title="创建开发任务" desc="五参数表达清楚「我要找什么样的客户」· 60 秒内可完成" extra={<span className="lp-chip">F1 · P0 · MVP</span>} />
        <div className="grid grid-cols-2 gap-5">
          <div className="space-y-4">
            <Field label="产品关键词" required hint="中英混输，回车成词；支持逗号 / 换行批量粘贴。双语与同义词扩展尚未实现，关键词按你输入的原文使用。">
              <div className="flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-lg border border-line bg-white px-2 py-1.5 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-50">
                {config.keywords.map((k) => (
                  <span key={k} className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700">
                    {k}<button onClick={() => patch({ keywords: config.keywords.filter((x) => x !== k) })}><X size={11} /></button>
                  </span>
                ))}
                <input
                  value={keywordInput}
                  onChange={(e) => setKeywordInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addKeywords(keywordInput) } }}
                  onBlur={() => { if (keywordInput.trim()) addKeywords(keywordInput) }}
                  placeholder={config.keywords.length ? '' : '如 hydraulic fittings'}
                  className="min-w-[120px] flex-1 border-0 text-[12px] outline-none placeholder:text-slate-400"
                />
              </div>
              <div className="mt-1 flex items-center justify-between text-[11px] text-muted"><span>{config.keywords.length}/10 个关键词</span><span>排除词可在高级选项中设置</span></div>
            </Field>

            <Field label="目标市场" required hint="默认不选任何市场，强制表达明确意图">
              <div className="mb-2 flex flex-wrap gap-1.5">
                {MARKET_PRESETS.map((p) => (
                  <button key={p.name} onClick={() => patch({ markets: p.countries })} className="lp-chip transition hover:border-brand-500 hover:text-brand-700">{p.name}</button>
                ))}
              </div>
              <div className="flex flex-wrap gap-1.5 rounded-lg border border-line bg-canvas p-2">
                {COUNTRIES.map((c) => {
                  const on = config.markets.includes(c)
                  return (
                    <button key={c} onClick={() => toggleCountry(c)} className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition ${on ? 'border-brand-500 bg-brand-50 font-medium text-brand-700' : 'border-line bg-white text-slate-600 hover:border-slate-300'}`}>
                      {on && <Check size={10} />}{c}
                    </button>
                  )
                })}
              </div>
              {availability && (
                <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-blue-100 bg-blue-50/60 px-2.5 py-2 text-[11px] leading-4 text-blue-800">
                  <Globe2 size={13} className="mt-0.5 shrink-0" />
                  <span>该市场海关数据可得性：<strong>{availability.level}</strong> · {availability.text}</span>
                </div>
              )}
            </Field>

            <Field label="客户类型" required hint="八类外贸语义，可多选">
              <div className="grid grid-cols-2 gap-1.5">
                {CUSTOMER_TYPES.map((t) => {
                  const on = config.customerTypes.includes(t.key)
                  return (
                    <button key={t.key} onClick={() => toggleType(t.key)} title={t.feature} className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-left text-[11px] transition ${on ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-line bg-white text-slate-600 hover:border-slate-300'}`}>
                      <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${on ? 'border-brand-500 bg-brand-500 text-white' : 'border-slate-300'}`}>{on && <Check size={9} />}</span>
                      <span className="truncate">{t.zh}</span>
                    </button>
                  )
                })}
              </div>
            </Field>
          </div>

          <div className="space-y-4">
            <Field label="搜索深度" hint="「花多少时间换多少准确度」必须讲清楚">
              <div className="grid grid-cols-2 gap-1.5">
                {([1, 2, 3, 4] as const).map((d) => {
                  const info = DEPTH_CONFIG[d]
                  const on = config.depth === d
                  return (
                    <button key={d} onClick={() => patch({ depth: d })} className={`rounded-lg border px-2.5 py-2 text-left transition ${on ? 'border-brand-500 bg-brand-50' : 'border-line bg-white hover:border-slate-300'}`}>
                      <div className="flex items-center justify-between">
                        <span className={`text-[12px] font-medium ${on ? 'text-brand-700' : 'text-ink'}`}>{info.label}</span>
                        {d === 2 && <span className="rounded bg-slate-100 px-1 text-[9px] text-slate-500">默认</span>}
                      </div>
                      <div className="mt-1 text-[11px] text-muted">{info.duration} · {info.sources} 源 · {info.pointsPerCompany} 点/客户</div>
                    </button>
                  )
                })}
              </div>
              <p className="mt-1.5 text-[11px] leading-4 text-muted">{DEPTH_CONFIG[config.depth].desc}</p>
            </Field>

            <Field label="客户数量" hint="档位 20 / 50 / 100 / 200 / 500 / 1000，单任务最大 1000">
              <div className="flex items-center gap-3">
                <input type="range" min={10} max={1000} step={10} value={config.targetCount} onChange={(e) => patch({ targetCount: Number(e.target.value) })} className="h-1.5 flex-1 accent-brand-500" />
                <input type="number" min={10} max={1000} value={config.targetCount} onChange={(e) => patch({ targetCount: Math.min(1000, Math.max(10, Number(e.target.value))) })} className="lp-input w-20 text-center tabular-nums" />
              </div>
              {config.targetCount > 500 && <p className="mt-1 text-[11px] text-amber-600">建议分批：单任务过大影响质量</p>}
            </Field>

            <div>
              <button onClick={() => setAdvanced(!advanced)} className="flex w-full items-center justify-between rounded-lg border border-line bg-canvas px-3 py-2 text-[12px] font-medium text-slate-700">
                高级选项（默认收起）<ChevronDown size={14} className={`transition ${advanced ? 'rotate-180' : ''}`} />
              </button>
              {advanced && (
                <div className="lp-fade mt-2 space-y-3 rounded-lg border border-line p-3">
                  <Field label="公司规模范围">
                    <div className="flex gap-1.5">{(['S', 'M', 'L', 'XL'] as SizeTier[]).map((t) => (
                      <button key={t} onClick={() => toggleSize(t)} className={`lp-chip flex-1 justify-center ${config.sizeTiers.includes(t) ? 'border-brand-500 bg-brand-50 text-brand-700' : ''}`}>{t}</button>
                    ))}</div>
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="成立年限 ≥"><input type="number" min={0} className="lp-input" placeholder="如 3" value={config.foundedYearsMin ?? ''} onChange={(e) => patch({ foundedYearsMin: e.target.value ? Number(e.target.value) : null })} /></Field>
                    <Field label="HS 编码"><input className="lp-input font-mono" placeholder="7307.19" value={config.hsCode} onChange={(e) => patch({ hsCode: e.target.value })} /></Field>
                  </div>
                  <Field label="排除词"><input className="lp-input" placeholder="repair, used" value={config.excludeKeywords.join(', ')} onChange={(e) => patch({ excludeKeywords: e.target.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean) })} /></Field>
                  <Field label="任务命名"><input className="lp-input" placeholder="默认：关键词 + 市场 + 日期" value={config.name} onChange={(e) => patch({ name: e.target.value })} /></Field>
                  <Toggle checked={config.onlyVerifiedEmails} onChange={(v) => patch({ onlyVerifiedEmails: v })} label="仅返回有可验证邮箱的客户" desc="开启后只返回 A/B 级联系方式，结果会显著变少" />
                </div>
              )}
            </div>
          </div>
        </div>

        {error && <div className="mt-4 flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700"><Info size={14} className="mt-0.5 shrink-0" />{error}</div>}

        <div className="mt-5 flex items-center gap-4 border-t border-line pt-4">
          <div className="flex items-center gap-2 text-[12px] text-muted">
            <Coins size={15} className="text-amber-500" />
            本次预计消耗 <strong className="tabular-nums text-ink">{cost.toLocaleString()}</strong> 点
            <span className="text-slate-400">（{DEPTH_CONFIG[config.depth].label} × {config.targetCount} 客户）</span>
            · 剩余 <span className="tabular-nums text-ink">{settings.pointsBalance.toLocaleString()}</span> 点
          </div>
          <Button variant="primary" className="ml-auto" disabled={running} onClick={submit}>
            <Play size={14} /> {running ? '有任务运行中' : runnerMode === 'cloud' ? '提交云端任务' : '开始采集'}
          </Button>
        </div>
        <p className="mt-1.5 text-right text-[11px] text-muted">额度在任务开始后不可退，提交前明示（PRD F1-4：不做事后惊讶）</p>
      </Card>

      <Card className="p-4">
        <SectionTitle title="最近任务 / 模板复用" desc="同一批关键词每周换市场跑一遍，复用能力决定周活" />
        <div className="space-y-1.5">
          {tasks.slice(0, 4).map((t) => (
            <div key={t.id} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
              <span className="text-[12px] font-medium text-ink">{t.name}</span>
              <span className="text-[11px] text-muted">{t.config.markets.join('+') || '未指定市场'} · {DEPTH_CONFIG[t.config.depth].label} · {t.config.targetCount} 家</span>
              <span className="ml-auto text-[11px] tabular-nums text-muted">{t.pointsUsed || t.pointsEstimated} 点</span>
              <button className="lp-chip" onClick={() => { setConfig({ ...DEFAULT, ...t.config }); showToast('已复用该任务配置，可微调后提交') }}>复用</button>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
