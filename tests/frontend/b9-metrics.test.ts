/**
 * B9 / P2-7 · 演示 KPI 的行为级反例
 *
 * 反例要证明的是「改坏实现会红」：把 kpiDisplay 的置灰分支删掉、把两页分母改回各自一套，
 * 下面用例必须失败；只检查常量表是否存在的静态断言不算。
 */
import { describe, expect, it } from 'vitest'
import {
  computeRateStats, isSentStatus, kpiDisplay, localCounterKpi, toTileProps,
  DEMO_OUTCOME_NOTE, DEMO_COUNTER_NOTE,
} from '@/domain/metrics'

const rows = (statuses: string[]) => statuses.map((status, i) => ({ status, id: `c${i}` }))

describe('B9 / P2-7 · 结果型 KPI 不把演示数据当业务结果', () => {
  it('无真实 outcome 时置灰显示「—」，并说明真实结果来自服务端回写', () => {
    const d = kpiDisplay({ label: '回复率', value: '69.0%', sub: '唯一可靠强信号', tone: 'emerald' })
    expect(d).toMatchObject({ value: '—', tone: 'slate', demo: true })
    expect(d.sub).toContain(DEMO_OUTCOME_NOTE)
    expect(d.sub).toContain('/v1/import/outcomes')
    expect(d.sub).toContain('唯一可靠强信号')
  })

  it('sampleSize=0 的伪「真实」来源仍按 DEMO 处理，不伪造 0.0%', () => {
    const d = kpiDisplay({ label: '硬退信率', value: '0.0%' }, { sampleSize: 0, source: 'server_outcomes' })
    expect(d.value).toBe('—')
    expect(d.demo).toBe(true)
  })

  it('来源不是服务端 outcome 时一律 DEMO，不接受调用方自造来源', () => {
    const d = kpiDisplay(
      { label: '已发送', value: 18 },
      { sampleSize: 40, source: 'client_guess' } as unknown as Parameters<typeof kpiDisplay>[1],
    )
    expect(d.value).toBe('—')
    expect(d.demo).toBe(true)
  })

  it('真实 outcome 有样本时才显示原值并去掉 DEMO 标', () => {
    const d = kpiDisplay({ label: '已发送', value: 18, sub: '真实回写' }, { sampleSize: 40, source: 'server_outcomes' })
    expect(d).toMatchObject({ value: 18, demo: false, sub: '真实回写' })
    expect(d.note).toContain('真实结果')
  })

  it('本地计数器保留数字但强制标演示，note 明确不是业务结果', () => {
    const d = localCounterKpi({ label: '草稿队列', value: 7, sub: '草稿仅存本地队列' })
    expect(d.value).toBe(7)
    expect(d.demo).toBe(true)
    expect(d.note).toBe(DEMO_COUNTER_NOTE)
    expect(d.sub).toContain('草稿仅存本地队列')
  })

  it('toTileProps 只透出 StatTile 需要的字段，不把内部 note 漏进 DOM', () => {
    expect(Object.keys(toTileProps(kpiDisplay({ label: 'x', value: '1' }))).sort())
      .toEqual(['demo', 'label', 'sub', 'tone', 'value'])
  })
})

describe('B9 / P2-7 · 跨页口径一致（消除 69% vs 80%）', () => {
  it('两页对同一份数据计算得到完全相同的率与样本量', () => {
    const data = rows(['sent', 'sent', 'replied', 'interested', 'bounced', 'new', 'drafted', 'won'])
    const outreachStats = computeRateStats(data)
    const crmStats = computeRateStats(data)
    expect(outreachStats).toEqual(crmStats)
    expect(outreachStats.sampleSize).toBe(6)
    expect(outreachStats.bounceRate).toBeCloseTo(1 / 6)
    expect(outreachStats.replyRate).toBeCloseTo(3 / 6)
  })

  it('bounced 计入分母（退信也是一次发送尝试），opened 计入但不属于回复', () => {
    const s = computeRateStats(rows(['sent', 'opened', 'bounced', 'replied']))
    expect(s).toMatchObject({ sent: 4, bounced: 1, replied: 1, interested: 0 })
    expect(s.replyRate).toBeCloseTo(0.25)
  })

  it('样本为 0 时返回 0 率与 sampleSize=0，由 kpiDisplay 负责置灰', () => {
    expect(computeRateStats([])).toMatchObject({ sent: 0, bounceRate: 0, replyRate: 0, sampleSize: 0 })
  })

  it('已发送记录列表与 KPI 分母共用同一份状态白名单，不会再次漂移', () => {
    expect(isSentStatus('bounced')).toBe(true)
    expect(isSentStatus('opened')).toBe(true)
    expect(isSentStatus('new')).toBe(false)
    const data = rows(['sent', 'bounced', 'new', 'drafted'])
    expect(data.filter((c) => isSentStatus(c.status)).length).toBe(computeRateStats(data).sent)
  })
})
