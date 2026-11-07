import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, CloudCog, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react'
import type { Company } from '@/types'
import { EMAIL_LENGTH_LIMIT, EMAIL_PURPOSES } from '@/domain/constants'
import { injectComplianceFooter, validateEmail } from '@/domain/compliance'
import { generateEmails, pickAnchor, type GeneratedEmail } from '@/services/email-generator'
import { generateEmailWithGateway, type EmailGenerateResponse } from '@/services/gateway-client'
import { useAppStore } from '@/store/useAppStore'
import { Badge, Button, Field, Modal } from '@/components/ui'

export default function EmailComposer({ company, onClose }: { company: Company | null; onClose(): void }) {
  const settings = useAppStore((s) => s.settings)
  const addOutreach = useAppStore((s) => s.addOutreach)
  const showToast = useAppStore((s) => s.showToast)
  const gateway = useAppStore((s) => s.gateway)
  const [purpose, setPurpose] = useState('intro')
  const [tone, setTone] = useState<'formal' | 'concise' | 'warm'>('concise')
  const [length, setLength] = useState<'short' | 'medium' | 'long'>('short')
  const [mails, setMails] = useState<GeneratedEmail[]>([])
  const [active, setActive] = useState<0 | 1>(0)
  const [edited, setEdited] = useState('')
  const [regens, setRegens] = useState(0)
  const [generating, setGenerating] = useState(false)
  const [source, setSource] = useState<'local' | 'gateway'>('local')
  const [gatewayNote, setGatewayNote] = useState('')

  useEffect(() => {
    if (!company) return
    setMails([]); setEdited(''); setRegens(0); setActive(0)
    setGenerating(false); setSource('local'); setGatewayNote('')
  }, [company?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const current = mails[active]
  const validation = useMemo(() => edited
    ? validateEmail(edited, { maxWords: EMAIL_LENGTH_LIMIT[length], requirePersonalization: true, anchor: current?.anchor })
    : current?.validation ?? null,
  [edited, length, current])

  if (!company) return null

  const fallbackToLocal = (note: string) => {
    if (!company) return
    setMails(generateEmails(company, settings.profile, { purpose, tone, length }))
    setSource('local')
    setGatewayNote(note)
  }

  /** 网关已配 Key → 走真实 T1 两次生成 2 版；任何失败都显式回退本地模板，绝不把模板说成模型输出 */
  const generate = async (isRegen = false) => {
    if (!company || generating) return
    setGenerating(true)
    setEdited(''); setActive(0)
    if (!isRegen) setRegens(0)

    const canUseGateway = Boolean(gateway?.online && gateway.mode === 'configured' && gateway.configuredCount > 0)
    if (!canUseGateway) {
      fallbackToLocal(gateway?.online
        ? '网关在线但未配置任何 API Key：/v1/email/generate 会明确返回 E6005。本次使用本地确定性模板，未调用任何模型。'
        : '云端网关离线。本次使用本地确定性模板，未调用任何模型。')
      setGenerating(false)
      return
    }

    const { text: anchor, tags } = pickAnchor(company)
    const product = settings.profile.mainProducts.split(/[,，、\n]/)[0]?.trim().slice(0, 28) || 'hydraulic fittings'
    const base = {
      anchor, product,
      advantages: settings.profile.advantages.filter(Boolean).slice(0, 2),
      purpose, tone, maxWords: EMAIL_LENGTH_LIMIT[length], language: 'en',
      country: company.country, regionPolicy: settings.llm.regionPolicy,
    }
    try {
      const [a, b] = await Promise.all([
        generateEmailWithGateway({ ...base, angle: 'price_and_lead_time' }),
        generateEmailWithGateway({ ...base, angle: 'technical_and_customization' }),
      ])
      if (a.ok && b.ok && a.body && b.body && a.subject && b.subject) {
        const built: GeneratedEmail[] = ([a, b] as EmailGenerateResponse[]).map((r, i) => {
          const body = injectComplianceFooter(String(r.body), settings.profile)
          return {
            variant: (i === 0 ? 'A' : 'B') as 'A' | 'B',
            angle: i === 0 ? '主打价格 / 交期' : '主打技术 / 定制',
            subject: String(r.subject), body, anchor,
            tags: [...tags, `T1 真实生成 · ${r.audit?.model ?? '网关'}`, `消耗 ${r.audit?.points ?? 0} 点`],
            validation: validateEmail(body, {
              maxWords: EMAIL_LENGTH_LIMIT[length], requirePersonalization: true, anchor,
            }),
          }
        })
        setMails(built); setSource('gateway')
        setGatewayNote(`正文由云端 T1 网关真实生成（2 次调用 · ${a.audit?.model ?? '模型'}）。合规尾巴与发送前校验仍由本地代码执行，模型不接触发件人手机号与地址。`)
        showToast('云端 T1 写信完成：2 版正文均由模型生成，已过 F6-2 硬约束', 'ok')
      } else {
        const reason = a.reason ?? b.reason ?? '网关未返回可用正文'
        fallbackToLocal(`云端写信已降级（${a.errorCodes?.join(' / ') ?? 'E6005'}）：${reason} 本次使用本地确定性模板。`)
        showToast('云端 T1 写信降级，已显式回退本地模板并标注 DEMO', 'warn')
      }
    } catch {
      fallbackToLocal('云端写信请求异常，已显式回退本地确定性模板；本次未产生任何模型正文。')
      showToast('云端 T1 写信异常，已回退本地模板', 'warn')
    } finally {
      setGenerating(false)
    }
  }

  const createDraft = () => {
    if (!current) return
    if (company.contacts[0]?.grade === 'D') {
      showToast('E3004：D 级邮箱禁止进入发送队列，草稿未创建', 'error'); return
    }
    if (validation && !validation.passed) {
      showToast(`发送前校验未通过：${validation.issues[0]}`, 'error'); return
    }
    const body = edited || current.body
    addOutreach({
      id: `out_${Date.now()}`, companyId: company.id, contactId: company.contacts[0]?.id ?? '',
      subject: current.subject, bodyText: body, bodyHtml: `<pre>${body}</pre>`,
      language: 'en', purpose, status: 'draft',
      personalizationTags: current.tags, validation: validation ?? current.validation,
      createdAt: new Date().toISOString(), demo: true,
    })
    onClose()
    showToast('已写入本地草稿队列，状态自动回写「已生成草稿」；演示模式未调用 Gmail API', 'ok')
  }

  return (
    <Modal
      open={!!company}
      onClose={onClose}
      title={`开发信 · ${company.name}`}
      width="860px"
      footer={
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 text-[11px] text-muted"><ShieldCheck size={12} className="text-emerald-600" /> 合规尾巴由代码注入，不经过模型</span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onClose}>取消</Button>
          <Button variant="primary" size="sm" disabled={!current} onClick={createDraft}>写入草稿队列</Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className={`rounded-lg border px-3 py-2 text-[11px] leading-4 ${source === 'gateway' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
          {source === 'gateway' ? <CloudCog size={12} className="mr-1 inline" /> : null}
          <strong>{source === 'gateway' ? '真实 T1 生成' : '演示模式'}</strong>：
          {gatewayNote || (gateway?.mode === 'configured'
            ? '网关已配置 Key，点击「生成 2 版」将向云端 T1 发起真实调用；失败时明确降级并标注本地模板。'
            : '网关未配置 API Key，写信走本地确定性模板（未调用任何模型）。')}
          <span className="ml-1 opacity-80">F6-2 内容硬约束、个性化锚点、字数/禁词校验与合规尾巴注入始终由代码执行，与生成来源无关。</span>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label="本次目的"><select value={purpose} onChange={(e) => setPurpose(e.target.value)} className="lp-input">{EMAIL_PURPOSES.map((p) => <option key={p.key} value={p.key}>{p.zh}</option>)}</select></Field>
          <Field label="语气"><select value={tone} onChange={(e) => setTone(e.target.value as typeof tone)} className="lp-input"><option value="formal">正式商务</option><option value="concise">简洁直白</option><option value="warm">热情亲切</option></select></Field>
          <Field label="长度"><select value={length} onChange={(e) => setLength(e.target.value as typeof length)} className="lp-input"><option value="short">短 ≤ 90 词</option><option value="medium">中 ≤ 160 词</option><option value="long">长 ≤ 230 词</option></select></Field>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" disabled={generating} onClick={() => void generate()}>
            <Sparkles size={13} /> {generating ? '云端生成中…' : '生成 2 版'}
          </Button>
          <Button size="sm" disabled={!current || regens >= 5 || generating} onClick={() => {
            setRegens((n) => n + 1)
            void generate(true)
            showToast(`已重新生成（${regens + 1}/5）`, 'info')
          }}><RefreshCw size={12} /> 换一种说法 {regens}/5</Button>
          <span className="ml-auto text-[11px] text-muted">一版主打价格/交期，一版主打技术/定制</span>
        </div>

        {mails.length > 0 && (
          <>
            <div className="flex gap-1.5">
              {mails.map((m, i) => (
                <button key={m.variant} onClick={() => { setActive(i as 0 | 1); setEdited('') }} className={`rounded-lg px-3 py-1.5 text-[11px] font-medium transition ${active === i ? 'bg-brand-50 text-brand-700 ring-1 ring-brand-100' : 'bg-canvas text-slate-600'}`}>
                  版本 {m.variant} · {m.angle}
                </button>
              ))}
            </div>

            <div className="rounded-lg border border-line">
              <div className="border-b border-line bg-canvas px-3 py-2">
                <span className="text-[11px] text-muted">Subject</span>
                <p className="text-[13px] font-medium text-ink">{current.subject}</p>
              </div>
              <textarea
                value={edited || current.body}
                onChange={(e) => setEdited(e.target.value)}
                className="h-[230px] w-full resize-none bg-white px-3 py-3 text-[12px] leading-5 text-ink outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-line p-3">
                <p className="mb-1.5 text-[11px] font-medium text-ink">个性化依据</p>
                <div className="flex flex-wrap gap-1.5">{current.tags.map((t) => <Badge key={t} tone="brand">{t}</Badge>)}</div>
                <p className="mt-2 text-[10px] leading-4 text-muted">首句必须引用一条可核验的公开事实；事实抓准比文采重要 3 倍以上（PRD F6-5）。</p>
              </div>
              <div className={`rounded-lg border p-3 ${validation?.passed ? 'border-emerald-200 bg-emerald-50/50' : 'border-rose-200 bg-rose-50/50'}`}>
                <p className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-ink">
                  {validation?.passed ? <CheckCircle2 size={12} className="text-emerald-600" /> : <AlertTriangle size={12} className="text-rose-600" />}
                  发送前校验（代码执行，不经过模型）
                </p>
                {validation ? (
                  <ul className="space-y-0.5 text-[10px] leading-4 text-slate-700">
                    <li>字数 {validation.wordCount}/{validation.maxWords} 词 · 禁词 {validation.bannedHits.length} 处</li>
                    <li>退订尾巴 {validation.hasUnsubscribe ? '✓' : '✗'} · 真实身份 {validation.hasSenderIdentity ? '✓' : '✗'} · 未填占位符 {validation.hasPlaceholder ? '✗' : '✓'}</li>
                    <li>个性化锚点 {validation.hasPersonalization ? '✓' : '✗'}</li>
                    {!validation.passed && <li className="pt-1 text-rose-700">{validation.issues.join('；')}</li>}
                  </ul>
                ) : <p className="text-[10px] text-muted">生成后自动校验</p>}
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
