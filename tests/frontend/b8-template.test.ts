/**
 * B8 / P2-6 · 批量出信的显式本地模板降级入口
 *
 * 纪律：模板必须自己声明 DEMO 来源，正文不得含合规尾巴 / 发件人身份 / 禁词 / 占位符，
 * 这些由调用方注入 footer；真实 T1 与模板端口径一致（服务端 validateEmailDraft 口径）。
 */
import { describe, expect, it } from 'vitest'
import { buildImportedTemplateDraft } from '@/services/email-generator'
import protocol from '../../shared/model-protocol.json'

const base = {
  companyName: 'Acme Trading GmbH',
  productHint: 'hydraulic fittings',
  anchor: 'We import hydraulic hose fittings from Asia',
}

describe('B8 · 本地模板（DEMO，非模型输出）', () => {
  it('显式返回 draftSource=local-template / demo=true，绝不冒充真实 T1', () => {
    const d = buildImportedTemplateDraft(base)
    expect(d).not.toBeNull()
    expect(d).toMatchObject({ draftSource: 'local-template', demo: true })
    expect(d?.subject).toContain('hydraulic fittings')
    expect(d?.body).toContain('We import hydraulic hose fittings from Asia')
  })

  it('正文不含退订尾巴 / 发件人身份 / 占位符，也不命中 F6-2 禁词', () => {
    const d = buildImportedTemplateDraft(base)
    expect(d).not.toBeNull()
    const body = d?.body ?? ''
    expect(body.length).toBeGreaterThanOrEqual(40)
    expect(body).not.toMatch(/unsubscribe|退订|reply\s+stop/i)
    expect(body).not.toMatch(/\[[^\]]{1,40}\]|\{\{[^}]*\}\}/)
    for (const banned of ['free', 'guarantee', '100%', 'click here', 'act now', '!!']) {
      expect(body.toLowerCase()).not.toContain(banned)
    }
    expect(body).not.toContain('Shenzhen')
  })

  it('原文片段命中禁词时退化为通用措辞，不引用不可核验 / 违规内容', () => {
    const d = buildImportedTemplateDraft({ ...base, anchor: 'Free samples, 100% guaranteed, act now' })
    expect(d?.body).toContain('your hydraulic fittings range')
    expect(d?.body.toLowerCase()).not.toContain('guaranteed')
  })

  it('无原文锚点时仍可生成，但明确是通用措辞而非可核验引用', () => {
    const d = buildImportedTemplateDraft({ ...base, anchor: null })
    expect(d?.body).toContain('your hydraulic fittings range')
    expect(d?.draftSource).toBe('local-template')
  })

  it('缺 product_hint 时返回 null：模板绝不替客户编造主营产品', () => {
    expect(buildImportedTemplateDraft({ ...base, productHint: '' })).toBeNull()
    expect(buildImportedTemplateDraft({ ...base, productHint: '   ' })).toBeNull()
  })

  it('共享协议里的每个 F6-2 禁词都会让原文锚点退化，不引用违规原文', () => {
    for (const word of protocol.emailPolicy.bannedWords) {
      const d = buildImportedTemplateDraft({ ...base, anchor: `We offer ${word} to distributors` })
      expect(d, `禁词 ${word} 未被拦截`).not.toBeNull()
      expect(d?.body).toContain('your hydraulic fittings range')
      expect(d?.body.toLowerCase()).not.toContain(word.toLowerCase())
    }
  })

  it('锚点自带退订尾巴 / 占位符时同样退化，绝不把模型禁用内容写进正文', () => {
    for (const anchor of ['Reply STOP to unsubscribe', 'Hi [name], {{company}} here']) {
      const d = buildImportedTemplateDraft({ ...base, anchor })
      expect(d?.body).toContain('your hydraulic fittings range')
    }
  })
})
