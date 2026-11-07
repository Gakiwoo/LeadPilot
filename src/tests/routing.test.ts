import { describe, expect, it } from 'vitest'
import { resolveRegionPolicy, route } from '@/services/adapters'

describe('PRD F0-2 · 三级路由与 11.4 地域策略', () => {
  it('抽取 / 分类走 T0，判断 / 写信走 T1', () => {
    expect(route({ type: 'extract' })).toBe('T0')
    expect(route({ type: 'classify' })).toBe('T0')
    expect(route({ type: 'expand_keywords' })).toBe('T0')
    expect(route({ type: 'judge_import' })).toBe('T1')
    expect(route({ type: 'judge_size' })).toBe('T1')
    expect(route({ type: 'write_email' })).toBe('T1')
  })

  it('低置信 / 冲突 / L4 高价值客户走 T2', () => {
    expect(route({ type: 'judge_import', confidence: 0.4 })).toBe('T2')
    expect(route({ type: 'judge_size', conflict: true })).toBe('T2')
    expect(route({ type: 'judge_import', depth: 4, valueTier: 'high' })).toBe('T2')
    expect(route({ type: 'extract', t0AllFailed: true })).toBe('T1')
  })

  it('EU/EEA/UK 客户 T0/T1 强制境内，T2 需显式同意且默认拒绝', () => {
    expect(resolveRegionPolicy('德国', 'T0', 'quality_first').group).toBe('domestic')
    expect(resolveRegionPolicy('德国', 'T1', 'quality_first').group).toBe('domestic')
    const t2 = resolveRegionPolicy('德国', 'T2', 'domestic_first')
    expect(t2.group).toBe('overseas')
    expect(t2.needsConsent).toBe(true)
    expect(resolveRegionPolicy('美国', 'T2', 'domestic_first').needsConsent).toBe(false)
  })
})
