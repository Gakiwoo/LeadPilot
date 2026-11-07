/**
 * PRD 11.2 三条产品级红线 + F6-2 Prompt 硬约束 + F7-2 发送闸门 + 11.4 数据最小化
 * 这些是「写进代码、不靠自觉」的硬约束，UI 不提供绕过开关。
 */
import type { CompanyProfile, Contact, EmailValidation, RuleFeatures } from '@/types'
import { BANNED_WORDS } from './constants'

/** 红线③：不提供无上限群发，批量直接发送在产品层禁用 */
export const BATCH_DIRECT_SEND_ENABLED = false

export function assertNoBatchSend(count: number): { allowed: false; message: string } | { allowed: true } {
  if (count > 1 && !BATCH_DIRECT_SEND_ENABLED) {
    return {
      allowed: false,
      message: '产品不提供「批量直接发送」。可批量建草稿，再由你逐条在 Gmail 中确认发出——批量与真发之间必须保留人的一次确认（PRD F3-3 / 7.7）',
    }
  }
  return { allowed: true }
}

/** 合规尾巴由代码注入，不经过模型（PRD F6-5）——防止模型「贴心」地删掉 */
export function injectComplianceFooter(body: string, profile: CompanyProfile): string {
  const identity = [
    profile.senderName, profile.senderTitle, profile.companyNameEn,
    profile.phone, profile.website, profile.address,
  ].filter(Boolean).join(' · ')
  return [
    body.trim(),
    '',
    '--',
    identity || '[填入发件人真实身份与公司地址]',
    'If this reached the wrong person, please forward it to the purchasing lead.',
    "Reply STOP and I won't contact you again.",
  ].join('\n')
}

export function countWords(text: string): number {
  const english = text.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g)?.length ?? 0
  const cjk = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0
  return english + cjk
}

export interface ValidateOptions {
  maxWords: number
  requirePersonalization?: boolean
  /** 个性化锚点：必须出现在正文里 */
  anchor?: string
}

export function validateEmail(body: string, opts: ValidateOptions): EmailValidation {
  const issues: string[] = []
  const wordCount = countWords(body)
  const lower = body.toLowerCase()
  const bannedHits = BANNED_WORDS.filter((w) => lower.includes(w.toLowerCase()))
  const hasUnsubscribe = /reply\s+stop|unsubscribe|退订/i.test(body)
  const hasSenderIdentity = /--[\s\S]{0,400}(@|www\.|http|地址|address|co\.,?\s|ltd|gmbh|inc\.?)/i.test(body) || /(GmbH|Ltd\.?|Inc\.?|Co\.,?)/.test(body)
  const hasPlaceholder = /\[[^\]]{1,40}\]/.test(body)
  const anchor = opts.anchor?.trim() ?? ''
  const hasPersonalization = !opts.requirePersonalization || (anchor.length > 0 && lower.includes(anchor.toLowerCase()))

  if (wordCount > opts.maxWords) issues.push(`正文 ${wordCount} 词，超过 ${opts.maxWords} 词硬限，需重写`)
  if (bannedHits.length) issues.push(`命中禁词：${bannedHits.join('、')}`)
  if (!hasUnsubscribe) issues.push('缺少退订说明（合规尾巴）')
  if (!hasSenderIdentity) issues.push('缺少真实发件人身份与物理地址')
  if (hasPlaceholder) issues.push('存在未填充占位符，禁止发送')
  if (!hasPersonalization) issues.push('首句未包含对方具体信息（个性化锚点）')

  return {
    wordCount, maxWords: opts.maxWords, bannedHits, hasUnsubscribe, hasSenderIdentity,
    hasPlaceholder, hasPersonalization, passed: issues.length === 0, issues,
  }
}

export interface SendGateInput {
  contact: Contact
  blacklist: string[]
  sentToday: number
  dailyLimit: number
  bounceRate: number
  consecutiveHardBounces: number
  singleConfirmed?: boolean
}

export interface SendGateResult {
  allowed: boolean
  queueInstead: boolean
  failed: { gate: string; code: string; message: string }[]
}

/** PRD F7-2 四道闸门 + 11.2 红线 */
export function checkSendGates(input: SendGateInput): SendGateResult {
  const failed: SendGateResult['failed'] = []
  const email = input.contact.value.toLowerCase()
  const domain = email.split('@')[1] ?? ''
  const blocked = (v: string) => input.blacklist.some((b) => {
    const x = b.toLowerCase().trim()
    return x.startsWith('@') ? domain === x.slice(1) : v === x
  })

  // G1 联系方式等级
  if (input.contact.grade === 'D' || input.contact.isBlacklisted) {
    failed.push({ gate: 'G1', code: 'E3004', message: 'D 级邮箱或已标记不可发，禁止进入发送队列' })
  } else if (input.contact.grade === 'C' && !input.singleConfirmed) {
    failed.push({ gate: 'G1', code: 'E3004', message: 'C 级邮箱需单条人工确认后才能发出' })
  }

  // G2 黑名单与退订（全局生效，不提供忽略开关）
  if (blocked(email) || blocked(domain)) {
    failed.push({ gate: 'G2', code: 'E3001', message: '收件人在退订/黑名单中，全局禁止发送' })
  }

  // G3 额度 → 进入队列而非丢弃
  const queueInstead = input.sentToday >= input.dailyLimit
  if (queueInstead) {
    failed.push({ gate: 'G3', code: 'E3002', message: `今日已发 ${input.sentToday}/${input.dailyLimit} 封，已加入明日队列` })
  }

  // G4 熔断
  if (input.bounceRate > 0.03 || input.consecutiveHardBounces >= 5) {
    failed.push({ gate: 'G4', code: 'E3003', message: `近 24h 硬退信率 ${(input.bounceRate * 100).toFixed(1)}%，已暂停发送，需治理后手动解除` })
  }

  return { allowed: failed.length === 0, queueInstead, failed }
}

/**
 * PRD 11.4.1 数据最小化：模型判断「分销商还是零售商」只需要官网文本，
 * 不需要邮箱 / 电话 / 联系人姓名。从协议层硬性剔除，既降合规面也降 token 成本。
 */
export function minimizeForModel(features: RuleFeatures, profile: CompanyProfile): {
  payload: Record<string, unknown>
  removed: string[]
} {
  const payload: Record<string, unknown> = {
    context: features.sourceTexts,
    facts: {
      keywordHits: features.keywordHits,
      categoryDistance: features.categoryDistance,
      semanticSimilarity: features.semanticSimilarity,
      importBatches24m: features.importBatches24m,
      customsRecords: features.customsRecords,
      distributedBrands: features.distributedBrands,
      tradeTermHits: features.tradeTermHits,
      employeeCount: features.employeeCount,
      foundedCountrySignals: features.marketMatch,
    },
    sender: { mainProducts: profile.mainProducts, advantages: profile.advantages },
  }
  return {
    payload,
    removed: ['联系人邮箱', '联系人电话', '联系人姓名 / 职位', '邮件正文与往来记录', 'Gmail 凭据'],
  }
}

/** PRD F9-2：CSV 使用 UTF-8 BOM，保证 Excel 打开中文不乱码 */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return '\uFEFF' + [headers, ...rows].map((r) => r.map(esc).join(',')).join('\r\n')
}

export function downloadCsv(filename: string, csv: string): void {
  if (typeof document === 'undefined') return
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
