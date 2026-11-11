import { describe, expect, it } from 'vitest'
import type { CompanyProfile, Contact } from '@/types'
import {
  assertNoBatchSend, checkSendGates, injectComplianceFooter, minimizeForModel, toCsv, validateEmail,
} from '@/domain/compliance'
import { makeFeatures } from './helpers'

const profile: CompanyProfile = {
  companyNameEn: 'Shenzhen Koude Precision Co., Ltd.', companyNameZh: '深圳寇德精密',
  address: 'Building 4, Longhua Industrial Park, Shenzhen, China', website: 'https://koude.example',
  mainProducts: 'hydraulic hose fittings', advantages: ['15-day lead time'],
  certifications: 'ISO 9001', moq: '500 pcs', leadTime: '15 days', caseStudies: '',
  senderName: 'Jiaqi Wu', senderTitle: 'Export Manager', phone: '+86 138 0000 0000',
}

const contact = (patch: Partial<Contact> = {}): Contact => ({
  id: 'c1', type: 'email', value: 'purchasing@acme.co', grade: 'A', verified: true,
  source: '官网', isBlacklisted: false, ...patch,
})

const gateBase = {
  blacklist: [], sentToday: 10, dailyLimit: 100, bounceRate: 0.01, consecutiveHardBounces: 0,
}

describe('B3-0 · 假设核查与红线加固', () => {
  it('合规尾巴幂等：已含尾巴的正文不会被重复注入（防双尾巴）', () => {
    const once = injectComplianceFooter('Saw that you distribute Parker fittings. Can I send a quote sheet?', profile)
    const twice = injectComplianceFooter(once, profile)
    expect(twice).toBe(once)
    expect((twice.match(/Reply STOP/gi) ?? []).length).toBe(1)
    expect(validateEmail(twice, { maxWords: 230 }).passed).toBe(true)
  })

  // P3：contacts[0] 在 noUncheckedIndexedAccess 下是 `Contact | undefined`。
  // 过去调用方用非空断言硬塞，客户没有联系人时会拿 undefined 去读 .value 直接抛错；
  // 现在必须走 G1 硬拦，而不是放行或崩溃。
  it('没有可用收件人时 G1 硬拦，绝不因 contact 缺失而放行或抛错', () => {
    const noContact = checkSendGates({ ...gateBase, contact: null, singleConfirmed: true })
    expect(noContact.allowed).toBe(false)
    expect(noContact.failed.some((f) => f.gate === 'G1' && f.code === 'E3004')).toBe(true)

    const missing = checkSendGates({ ...gateBase, singleConfirmed: true })
    expect(missing.allowed).toBe(false)
    expect(missing.failed.some((f) => f.gate === 'G1')).toBe(true)
  })

  it('黑名单为 @domain 时，空收件人不会被误判命中（domain 空串不吃 @ 规则）', () => {
    const r = checkSendGates({ ...gateBase, contact: null, blacklist: ['@'], singleConfirmed: true })
    expect(r.failed.some((f) => f.gate === 'G2')).toBe(false)
  })
})

describe('PRD 11.2 / F6-2 / F7-2 · 产品级红线', () => {
  it('合规尾巴由代码注入，含真实身份与退订说明', () => {
    const body = injectComplianceFooter('Saw that you distribute Parker fittings. Can I send a quote sheet?', profile)
    expect(body).toContain('Reply STOP')
    expect(body).toContain(profile.companyNameEn)
    expect(body).toContain(profile.address)
    const v = validateEmail(body, { maxWords: 230 })
    expect(v.passed).toBe(true)
  })

  it('禁词、超字数、占位符、缺退订尾巴都会被拦截', () => {
    expect(validateEmail('Dear Sir or Madam, we are a leading manufacturer with 20 years experience. Reply STOP. Shenzhen Koude Precision Co., Ltd.', { maxWords: 230 }).bannedHits.length).toBeGreaterThan(0)
    expect(validateEmail(injectComplianceFooter('word '.repeat(240), profile), { maxWords: 90 }).issues.some((i) => i.includes('超过'))).toBe(true)
    expect(validateEmail(injectComplianceFooter('Please quote [填入交期]', profile), { maxWords: 230 }).hasPlaceholder).toBe(true)
    expect(validateEmail('Saw that you distribute Parker fittings. Can I send a quote sheet?', { maxWords: 230 }).hasUnsubscribe).toBe(false)
  })

  it('G1：D 级邮箱禁止发送，C 级需单条确认', () => {
    expect(checkSendGates({ ...gateBase, contact: contact({ grade: 'D' }) }).failed.some((f) => f.gate === 'G1')).toBe(true)
    const c = checkSendGates({ ...gateBase, contact: contact({ grade: 'C' }) })
    expect(c.allowed).toBe(false)
    expect(checkSendGates({ ...gateBase, contact: contact({ grade: 'C' }), singleConfirmed: true }).allowed).toBe(true)
  })

  it('G2：黑名单按邮箱与域名全局生效', () => {
    expect(checkSendGates({ ...gateBase, contact: contact(), blacklist: ['purchasing@acme.co'] }).failed.some((f) => f.code === 'E3001')).toBe(true)
    expect(checkSendGates({ ...gateBase, contact: contact(), blacklist: ['@acme.co'] }).failed.some((f) => f.code === 'E3001')).toBe(true)
  })

  it('G3/G4：超额进队列，硬退信率 > 3% 熔断', () => {
    const over = checkSendGates({ ...gateBase, contact: contact(), sentToday: 100 })
    expect(over.queueInstead).toBe(true)
    expect(over.failed.some((f) => f.gate === 'G3')).toBe(true)
    expect(checkSendGates({ ...gateBase, contact: contact(), bounceRate: 0.04 }).failed.some((f) => f.code === 'E3003')).toBe(true)
    expect(checkSendGates({ ...gateBase, contact: contact(), consecutiveHardBounces: 5 }).failed.some((f) => f.code === 'E3003')).toBe(true)
    expect(checkSendGates({ ...gateBase, contact: contact() }).allowed).toBe(true)
  })

  it('红线③：批量直接发送在产品层禁用，不提供绕过', () => {
    expect(assertNoBatchSend(2).allowed).toBe(false)
    expect(assertNoBatchSend(1).allowed).toBe(true)
  })

  it('11.4 数据最小化：请求体不含邮箱、电话、联系人姓名', () => {
    const f = makeFeatures({ sourceTexts: ['Authorized distributor for Parker'] })
    const { payload, removed } = minimizeForModel(f, profile)
    const text = JSON.stringify(payload)
    expect(text).not.toContain('@')
    expect(text).not.toContain('138 0000')
    expect(removed).toContain('联系人邮箱')
    expect(removed).toContain('邮件正文与往来记录')
  })

  it('CSV 带 UTF-8 BOM 且中文不乱码', () => {
    const csv = toCsv(['公司名', '备注'], [['德国液压', '含,逗号与"引号"']])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv).toContain('德国液压')
    expect(csv).toContain('"含,逗号与""引号"""')
  })
})

describe('B3-5 · 校验细节与 CSV 安全', () => {
  it('禁词按整词匹配：freedom / carefree 不再被 free 误伤，独立 free 仍拦截', () => {
    const benign = validateEmail('Our freedom to choose suppliers and a carefree sourcing process. Reply STOP.', { maxWords: 230 })
    expect(benign.bannedHits).not.toContain('free')
    expect(validateEmail('Get free samples here. Reply STOP.', { maxWords: 230 }).bannedHits).toContain('free')
  })

  it('发件人身份按整词匹配：Include / Cooperation 不再冒充 Inc / Co', () => {
    expect(validateEmail('This will include cooperation details. Reply STOP.', { maxWords: 230 }).hasSenderIdentity).toBe(false)
    expect(validateEmail(injectComplianceFooter('Saw that you distribute Parker fittings.', profile), { maxWords: 230 }).hasSenderIdentity).toBe(true)
  })

  it('CSV 公式注入：= + - @ 开头的用户文本强制按文本导出', () => {
    const csv = toCsv(['备注'], [
      ['=HYPERLINK("http://evil.example")'], ['+SUM(1,1)'], ['-2+3'], ['@import'], ['普通备注'],
    ])
    expect(csv).toContain('"\'=HYPERLINK(""http://evil.example"")"')
    expect(csv).toContain("'+SUM(1,1)")
    expect(csv).toContain("'-2+3")
    expect(csv).toContain("'@import")
    expect(csv).toContain('普通备注')
  })
})
