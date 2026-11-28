/**
 * F11 · 模板库（域层，纯函数）
 *
 * 边界先说清楚：
 *  - 模板只提供「结构与措辞」，**合规尾巴与发件人身份永远由代码注入**（PRD F6-5）。
 *    所以模板正文里一旦写死退订语句或发件人身份，就直接判非法 —— 否则会拼出双尾巴。
 *  - 变量只允许白名单内的七个，未知变量报错而不是静默留空。留着 `{{foo}}` 进正文，
 *    用户看到的是一封带着花括号的信，比报错更糟。
 *  - 缺变量时**保留原文并如实报出**（missingVars），不拿默认值编造事实 —— 与 B8
 *    「没有 productHint 就不生成模板」是同一条纪律。
 *  - 禁词与尾部检测复用 `domain/compliance`（与服务端 `validateEmailDraft` 共用
 *    `shared/model-protocol.json` 的词表），不另写一套会漂移的正则。
 *
 * 本批次只做模板库；多步序列（follow-up 排期）不在此文件，F11 因此只到 ⚠️ 不到 ✅。
 */
import type { Company, CompanyProfile } from '@/types'
import { validateEmail } from './compliance'
import { EMAIL_PURPOSES } from './constants'

export type TemplateStage = 'intro' | 'followup' | 'breakup'

export interface EmailTemplate {
  id: string
  name: string
  stage: TemplateStage
  /** 对应 EMAIL_PURPOSES 的 key */
  purpose: string
  subject: string
  body: string
  /** 内置模板：可套用、可复制，但不可删除（删了就没有基线了） */
  builtin?: boolean
  demo?: boolean
}

/** 保存入参：没有 id 即新建，有 id 即更新（内置 id 会被拒）。放域层，store 与 UI 共用同一份形状 */
export interface TemplateDraft {
  id?: string
  name: string
  stage: TemplateStage
  purpose: string
  subject: string
  body: string
}

/**
 * 变量白名单。新增变量必须同步加到这里，否则保存时会被判非法 ——
 * 目的是防止「模板里塞了 {{.secret}} 之类的字段名」这类注入式误用。
 */
export const TEMPLATE_VARIABLES = [
  'company', 'product', 'anchor', 'senderName', 'senderCompany', 'market', 'advantage',
] as const

export type TemplateVariable = typeof TEMPLATE_VARIABLES[number]

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

/** 提取模板里出现的全部占位符（去重、保序） */
export function extractTemplateVars(text: string): string[] {
  const found: string[] = []
  for (const m of String(text ?? '').matchAll(VARIABLE_PATTERN)) {
    const name = m[1]
    if (name && !found.includes(name)) found.push(name)
  }
  return found
}

/** `{{` 与 `}}` 数量必须配平：`{{company}` 这种半截占位符要当场拦下 */
function unbalancedBraces(text: string): boolean {
  const open = (text.match(/\{\{/g) ?? []).length
  const close = (text.match(/\}\}/g) ?? []).length
  return open !== close
}

export type TemplateVars = Partial<Record<TemplateVariable, string>>

export interface RenderResult {
  subject: string
  body: string
  /** 模板引用了白名单变量但调用方没给值：保留原文，如实报出 */
  missingVars: string[]
  /** 模板引用了白名单之外的变量：属于模板本身的缺陷 */
  unknownVars: string[]
}

/**
 * 渲染模板。只做字符串替换，不做任何「智能补全」：
 * 缺的变量原样留着 `{{x}}`，由调用方决定是报错还是让用户补。
 */
export function renderTemplate(tpl: Pick<EmailTemplate, 'subject' | 'body'>, vars: TemplateVars): RenderResult {
  const missing = new Set<string>()
  const unknown = new Set<string>()
  const apply = (text: string) => String(text ?? '').replace(VARIABLE_PATTERN, (raw, name: string) => {
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(name)) { unknown.add(name); return raw }
    const value = vars[name as TemplateVariable]
    if (value === undefined || value === null || String(value).trim() === '') { missing.add(name); return raw }
    return String(value)
  })
  return {
    subject: apply(tpl.subject).slice(0, 200),
    body: apply(tpl.body),
    missingVars: [...missing],
    unknownVars: [...unknown],
  }
}

export interface TemplateValidation {
  ok: boolean
  issues: string[]
}

/**
 * 套用模板：在 renderTemplate 的基础上把「填不上的洞」变成可被发送校验拦截的形态。
 *
 * 为什么不能直接用 renderTemplate 的结果：缺值时它保留 `{{company}}`，而
 * `validateEmail.hasPlaceholder` 认的是**方括号** `[...]`，花括号占位符它能漏过去 ——
 * 一封带着 `{{product}}` 的信就这样混过发送校验发出去了，比报错难看得多。
 * 这里统一转成 `[待填：product]`，让 F7-2 那道闸门必然拦住。
 */
export function materializeTemplate(
  tpl: Pick<EmailTemplate, 'subject' | 'body'>,
  vars: TemplateVars,
): RenderResult & { ready: boolean } {
  const rendered = renderTemplate(tpl, vars)
  const fillGaps = (text: string) => String(text).replace(VARIABLE_PATTERN, (_raw, name: string) => `[待填：${name}]`)
  return {
    subject: fillGaps(rendered.subject),
    body: fillGaps(rendered.body),
    missingVars: rendered.missingVars,
    unknownVars: rendered.unknownVars,
    ready: rendered.missingVars.length === 0 && rendered.unknownVars.length === 0,
  }
}

/**
 * 保存前的模板校验。返回的 issues 直接给用户看，所以每条都要说「哪里错、为什么」，
 * 不能只回一个 false。
 */
export function validateTemplate(tpl: Pick<EmailTemplate, 'name' | 'subject' | 'body' | 'purpose'>): TemplateValidation {
  const issues: string[] = []
  const name = String(tpl.name ?? '').trim()
  const subject = String(tpl.subject ?? '').trim()
  const body = String(tpl.body ?? '').trim()

  if (!name) issues.push('模板名称不能为空')
  if (name.length > 40) issues.push('模板名称不超过 40 字')
  if (!EMAIL_PURPOSES.some((p) => p.key === tpl.purpose)) issues.push(`目的必须是 ${EMAIL_PURPOSES.map((p) => p.key).join(' / ')} 之一`)
  if (subject.length < 4) issues.push('主题至少 4 个字符')
  if (subject.length > 120) issues.push('主题不超过 120 个字符')
  if (body.length < 40) issues.push('正文至少 40 个字符（太短的信没有说服力）')
  if (body.length > 1200) issues.push('正文不超过 1200 个字符')

  if (unbalancedBraces(subject) || unbalancedBraces(body)) {
    issues.push('占位符花括号不配对：请写成 {{company}} 这样的完整形式')
  }
  const unknown = [...new Set([...extractTemplateVars(subject), ...extractTemplateVars(body)])]
    .filter((v) => !(TEMPLATE_VARIABLES as readonly string[]).includes(v))
  if (unknown.length) {
    issues.push(`存在不支持的变量：${unknown.map((v) => `{{${v}}}`).join('、')}；可用变量为 ${TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join('、')}`)
  }

  // 用样例值渲染后再跑 F6-2 同一条校验链，避免「带占位符的原文被误判」也避免漏检禁词
  const sample: TemplateVars = {}
  for (const v of TEMPLATE_VARIABLES) sample[v] = SAMPLE_VARS[v]
  const rendered = renderTemplate({ subject, body }, sample)
  const checked = validateEmail(rendered.body, { maxWords: 400, requirePersonalization: false })
  if (checked.bannedHits.length) {
    issues.push(`正文含 F6-2 禁词：${checked.bannedHits.join('、')}（该词表与服务端 F6-2 同一份）`)
  }
  if (checked.hasUnsubscribe) {
    issues.push('正文不得自带退订语句：合规尾巴由代码统一注入，模板再写一遍会拼成双尾巴')
  }

  // 身份检测单独渲染一次，把「专有名词类」变量全部留在占位符形态。
  //
  // 为什么必须这么做：validateEmail 的 hasSenderIdentity 用 COMPANY_SUFFIX 全局匹配
  // Ltd/Inc/Co/GmbH，正文里只要出现公司后缀就算「有发件人身份」。而
  //  · {{company}} 填的是**客户**公司名，真实值经常就是「Rhein Hydraulik GmbH」；
  //  · {{senderCompany}} 是我方公司名，白名单里本来就有；
  // 两类都合法引用，渲染后再检测必然全线误判。所以只让业务名词类变量参与渲染，
  // 专有名词保持未替换状态 —— 这样能命中的就只剩「模板自己写死的身份/签名块」。
  const IDENTITY_NEUTRAL_VARS: TemplateVariable[] = ['company', 'senderName', 'senderCompany']
  const identitySample: TemplateVars = { ...sample }
  for (const v of IDENTITY_NEUTRAL_VARS) identitySample[v] = undefined
  const identityProbe = renderTemplate({ subject, body }, identitySample)
  const identityChecked = validateEmail(identityProbe.body, { maxWords: 400, requirePersonalization: false })
  if (identityChecked.hasSenderIdentity) {
    issues.push('正文不得写死发件人身份或公司地址：由代码按设置页资料注入，写死会和实际发件人不一致')
  }

  return { ok: issues.length === 0, issues }
}

/** 样例值只用于校验，不会进入任何真实信件 */
const SAMPLE_VARS: Record<TemplateVariable, string> = {
  company: 'Rhein Hydraulik',
  product: 'hydraulic hose fittings',
  anchor: 'you distribute industrial fittings across Benelux',
  senderName: 'Sample Sender',
  senderCompany: 'Sample Trading Co., Ltd.',
  market: 'Germany',
  advantage: 'stable lead times on repeat orders',
}

/** 从客户与公司资料构造可用变量；anchor 由调用方传入（T0 规则抽取或本地 pickAnchor 的结果） */
export function buildTemplateVars(input: {
  company: Pick<Company, 'name' | 'country'>
  profile: Pick<CompanyProfile, 'mainProducts' | 'advantages' | 'senderName' | 'companyNameEn'>
  anchor: string
}): TemplateVars {
  const { company, profile, anchor } = input
  const shortName = String(company?.name ?? '').split(/[\s·]/)[0]?.slice(0, 24) || ''
  // advantages 来自持久化的公司资料，历史数据里可能是 undefined 或脏值，
  // 这里用 Array.isArray 兜住 —— 域层崩溃会连带整封信打不开发。
  // 空串与纯空白都要过滤：`filter(Boolean)` 过不了 `'  '`，会把一个空格当成优势渲染进正文。
  const advantages = (Array.isArray(profile?.advantages) ? profile.advantages : [])
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
  return {
    company: shortName,
    product: String(profile?.mainProducts ?? '').split(/[,，、\n]/)[0]?.trim().slice(0, 40) ?? '',
    anchor: String(anchor ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    senderName: profile?.senderName ?? '',
    senderCompany: profile?.companyNameEn ?? '',
    market: company?.country ?? '',
    advantage: (advantages[0] ?? '').slice(0, 80),
  }
}

/**
 * 内置模板：可套用、可复制，不可删除。
 * 全部不含退订尾巴与发件人身份（由代码注入），且通过 validateTemplate。
 */
export const DEFAULT_TEMPLATES: EmailTemplate[] = [
  {
    id: 'tpl_builtin_intro',
    name: '首次触达 · 引言式',
    stage: 'intro',
    purpose: 'intro',
    subject: '{{product}} supply for {{company}}',
    body: 'We noticed {{anchor}}. We supply {{product}} with {{advantage}} and can share our current catalogue. Would a short specification sheet be useful for your team this quarter?',
    builtin: true,
    demo: true,
  },
  {
    id: 'tpl_builtin_followup',
    name: '二次跟进 · 短问句',
    stage: 'followup',
    purpose: 'followup',
    subject: 'Following up: {{product}} for {{company}}',
    body: 'Quick follow-up on my note about {{product}} for {{company}}. If the timing is wrong, tell me and I will come back next quarter. If it helps, I can send the three sizes your team moves most, with lead times.',
    builtin: true,
    demo: true,
  },
  {
    id: 'tpl_builtin_breakup',
    name: '收尾 · 关闭话题',
    stage: 'breakup',
    purpose: 'followup',
    subject: 'Closing the loop on {{product}}',
    body: 'I have not heard back, so I will close the loop here. If {{product}} comes up later, reply and I will pick it up from there. No action needed if the timing is simply wrong.',
    builtin: true,
    demo: true,
  },
]
