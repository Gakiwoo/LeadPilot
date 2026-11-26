/**
 * F6 开发信生成 · 本地确定性模板（演示）
 *
 * 明确标注：未调用任何模型。真实实现应走 T0「个性化锚点提取」+ T1「正文生成」，
 * 且合规尾巴与发送前校验必须由代码完成，不经过模型（PRD F6-5）。
 * 本模块严格遵守 F6-2 的内容硬约束，保证这一层规则可独立测试。
 */
import type { Company, CompanyProfile, EmailValidation } from '@/types'
import { injectComplianceFooter, validateEmail } from '@/domain/compliance'
import { EMAIL_LENGTH_LIMIT } from '@/domain/constants'
import protocol from '../../shared/model-protocol.json'

export interface GeneratedEmail {
  variant: 'A' | 'B'
  angle: string
  subject: string
  body: string
  anchor: string
  tags: string[]
  validation: EmailValidation
}

export interface GenerateOptions {
  purpose: string
  tone: 'formal' | 'concise' | 'warm'
  length: 'short' | 'medium' | 'long'
  language?: string
}

/** 供云端 T1 写信复用同一套可核验锚点，避免模型端与模板端口径不一致 */
export function pickAnchor(company: Company): { text: string; tags: string[] } {
  const tags: string[] = []
  if (company.brands.length) {
    tags.push(`引用了：代理品牌 ${company.brands[0]}`)
    return { text: `you distribute ${company.brands[0]} fittings`, tags }
  }
  const batches = company.features.importBatches24m
  if (batches !== null && batches > 0) {
    tags.push(`引用了：近 24 个月 ${batches} 批次进口`)
    return { text: `your team has handled ${batches} import shipments in the last two years`, tags }
  }
  if (company.tradeRecords.length) {
    tags.push('引用了：进口记录')
    return { text: `you source HS 7307.19 tube assemblies`, tags }
  }
  tags.push('引用了：官网主营类目')
  return { text: `your ${company.categories[0] ?? 'industrial fittings'} range`, tags }
}

function subjectFor(company: Company, product: string): string {
  const shortName = (company.name.split(/[\s·]/)[0] ?? company.name).slice(0, 16)
  return `${product} supply for ${shortName}`
}

export function generateEmails(
  company: Company,
  profile: CompanyProfile,
  opts: GenerateOptions,
): GeneratedEmail[] {
  const product = profile.mainProducts.split(/[,，、\n]/)[0]?.trim().slice(0, 28) || 'hydraulic fittings'
  const { text: anchor, tags } = pickAnchor(company)
  const adv = profile.advantages.filter(Boolean).slice(0, 2)
  const a1 = adv[0] || 'stable lead times on repeat orders'
  const a2 = adv[1] || 'small-batch customization'
  const purposeMap: Record<string, string> = {
    intro: 'Would it help if I sent a 3-model quote sheet with FOB terms?',
    quote: 'Can I send a quote sheet for the three sizes you move most?',
    sample: 'Shall I arrange two samples for your team to test?',
    meeting: 'Would a 15-minute call next week be easier than email?',
    new_product: 'Would you like the one-page spec of our new crimp fitting line?',
    followup: 'Should I close the loop, or is a short spec sheet useful right now?',
  }
  const cta = purposeMap[opts.purpose] ?? purposeMap.intro
  const genericMailbox = /^(info|sales|contact)@/.test(company.contacts[0]?.value ?? '')
  const opener = genericMailbox
    ? `Could you forward this to your purchasing lead? I noticed ${anchor}.`
    : `Saw that ${anchor} — that is why I am writing to you directly.`

  const bodies = [
    [
      opener,
      `We supply ${product} with ${a1}. Two things usually matter for your line: ${a1} and ${a2}.`,
      cta,
    ].join(' '),
    [
      opener,
      `We build ${product} around ${a2}; for distributors this means fewer SKU changes and ${a1}.`,
      cta,
    ].join(' '),
  ]

  return (['A', 'B'] as const).map((variant, i) => {
    const body = injectComplianceFooter(bodies[i] ?? bodies[0] ?? '', profile)
    const validation = validateEmail(body, {
      maxWords: EMAIL_LENGTH_LIMIT[opts.length],
      requirePersonalization: true,
      anchor: genericMailbox ? anchor : anchor,
    })
    return {
      variant,
      angle: variant === 'A' ? '主打价格 / 交期' : '主打技术 / 定制',
      subject: subjectFor(company, product),
      body,
      anchor,
      tags: [...tags, ...(genericMailbox ? ['通用邮箱：已改为「请转交采购负责人」措辞'] : [])],
      validation,
    }
  })
}

/**
 * B8 / P2-6 · 显式本地模板降级入口（DEMO，非模型输出）。
 *
 * 只用于「批量出信端点已如实报 degraded / failed」之后的补齐，且必须由用户点按钮触发；
 * 返回项带 draftSource='local-template'，服务端 mbox 会写
 * `X-LeadPilot-Demo: template-not-model`，绝不冒充真实 T1 正文。
 * 正文不含合规尾巴 / 发件人身份（由调用方注入 footer），与服务端 validateEmailDraft 口径一致。
 */
export interface ImportedTemplateInput {
  companyName: string; productHint: string; anchor: string | null
}
export interface ImportedTemplateDraft {
  subject: string; body: string; demo: true; draftSource: 'local-template'
}
/**
 * 与服务端 validateEmailDraft 共用 shared/model-protocol.json 的禁词表（单一真源），
 * 另补「模型不得输出退订尾巴 / 占位符」两条服务端硬约束；绝不另写一套会漂移的正则词表。
 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const TEMPLATE_BLOCKED = new RegExp([
  ...(protocol.emailPolicy.bannedWords as string[]).map(escapeRe),
  String.raw`unsubscribe`, String.raw`退订`, String.raw`reply\s+stop`,
  String.raw`\[[^\]]{1,40}\]`, String.raw`\{\{[^}]*\}\}`,
].join('|'), 'i')

export function buildImportedTemplateDraft(input: ImportedTemplateInput): ImportedTemplateDraft | null {
  // B8：没有主营产品就不生成模板，绝不拿 'industrial fittings' 之类的默认值编造事实
  const product = String(input.productHint ?? '').trim().slice(0, 40)
  if (!product) return null
  const shortName = String(input.companyName ?? '').trim().split(/[\s·]/)[0]?.slice(0, 16) || 'your team'
  const rawAnchor = String(input.anchor ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  // 原文片段可能命中 F6-2 禁词或自带退订文案；命中时不引用，退化为通用措辞（不编造可核验引用）
  const anchor = rawAnchor && !TEMPLATE_BLOCKED.test(rawAnchor) ? rawAnchor : `your ${product} range`
  const subject = `${product} supply for ${shortName}`.slice(0, 120)
  const body = `We noticed ${anchor}. We supply ${product} with stable lead times on repeat orders and can share our current catalogue. Would a short specification sheet be useful for your team this quarter?`
  if (subject.length < 4 || body.length < 40 || TEMPLATE_BLOCKED.test(body)) return null
  return { subject, body, demo: true, draftSource: 'local-template' }
}
