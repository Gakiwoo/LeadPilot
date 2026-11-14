/**
 * 真实 provider 联调修复的行为级反例：
 *  - <context> 必须随原文下发可回填的 source_url / fetched_at（否则 evidence schema 校验失败 → E6003）
 *  - 内部格式（url / fetched_at）与 PRD 6.7.3 wire 格式（source_url / fetchedAt）都要生效
 *  - ISO 日期不是手机号；但剔除日期不得放宽真实 PII 终检
 */
import { describe, it, expect } from 'vitest'
import { buildJudgeMessages, assertNoPiiInMessages } from '../protocol.mjs'

const TEXT_A = 'Authorized distributor for Parker and Eaton across Benelux.'
const TEXT_B = 'We stock hydraulic hose fittings and brass adapters.'

function userContent(input) {
  return buildJudgeMessages(input).find((m) => m.role === 'user')?.content ?? ''
}

describe('buildJudgeMessages · 来源标注随 <context> 下发', () => {
  it('内部格式 url / fetched_at：context 带 source_url 与 fetched_at', () => {
    const c = userContent({
      companyId: 'c1',
      sourceTexts: [TEXT_A],
      sources: [{ url: 'https://x.example/about', text: TEXT_A, fetched_at: '2026-11-06' }],
    })
    expect(c).toContain('source_url=https://x.example/about')
    expect(c).toContain('fetched_at=2026-11-06')
    expect(c).toContain(TEXT_A)
  })

  it('PRD 6.7.3 wire 格式 source_url / fetchedAt 同样能带上来源（回归）', () => {
    const c = userContent({
      companyId: 'c1',
      sourceTexts: [TEXT_A],
      sources: [{ source_url: 'https://x.example/about', text: TEXT_A, fetchedAt: '2026-11-06T10:30:00.000Z' }],
    })
    expect(c).toContain('source_url=https://x.example/about')
    expect(c).toContain('fetched_at=2026-11-06T10:30:00.000Z')
  })

  it('多来源按索引一一对应，不把 URL 错配给另一段原文', () => {
    const c = userContent({
      companyId: 'c1',
      sourceTexts: [TEXT_A, TEXT_B],
      sources: [
        { url: 'https://x.example/about', text: TEXT_A, fetched_at: '2026-11-06' },
        { url: 'https://x.example/products', text: TEXT_B, fetched_at: '2026-11-07' },
      ],
    })
    expect(c).toContain(`[1] source_url=https://x.example/about fetched_at=2026-11-06\n${TEXT_A}`)
    expect(c).toContain(`[2] source_url=https://x.example/products fetched_at=2026-11-07\n${TEXT_B}`)
  })

  it('未提供 sources 时不伪造来源标注，原文仍按序号给出', () => {
    const c = userContent({ companyId: 'c1', sourceTexts: [TEXT_A] })
    expect(c).not.toContain('source_url=')
    expect(c).toContain(`[1] ${TEXT_A}`)
  })
})

describe('assertNoPiiInMessages · ISO 日期不是手机号', () => {
  it('fetched_at 日期与完整 ISO 时间戳不触发误拦截', () => {
    const r = assertNoPiiInMessages([{
      role: 'user',
      content: `source_url=https://x.example/about fetched_at=2026-11-06\n${TEXT_A}`,
    }])
    expect(r.ok).toBe(true)
    expect(r.hits).toHaveLength(0)
    expect(assertNoPiiInMessages([{ role: 'user', content: 'fetched_at=2026-11-06T10:30:00.000Z' }]).ok).toBe(true)
  })

  it('日期剔除不得放宽真实 PII 终检：手机号 / 邮箱 / 凭据仍被拦截', () => {
    expect(assertNoPiiInMessages([{ role: 'user', content: 'fetched_at=2026-11-06 +86 138 0013 8000' }]).ok).toBe(false)
    expect(assertNoPiiInMessages([{ role: 'user', content: 'fetched_at=2026-11-06 sales@example.com' }]).ok).toBe(false)
    expect(assertNoPiiInMessages([{ role: 'user', content: 'Authorization: Bearer sk-abcdefgh12345678' }]).ok).toBe(false)
  })
})
