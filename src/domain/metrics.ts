/**
 * B9 / P2-7 · 演示 KPI 的单一口径
 *
 * 评估报告指出：OutreachView 与 CrmView 各自用不同的分母算「回复率 / 退信率」，
 * 两页出现 69% vs 80% 的矛盾，还把演示数据当作业务 KPI 与 `NO_DATA` 并存。
 * 这里把「算什么」与「能不能当结果展示」收进纯函数：
 *  - computeRateStats()：两页共用同一份状态白名单与分母，杜绝跨页漂移；
 *  - kpiDisplay()：结果型 KPI 在没有真实 outcome 样本时一律置灰显示「—」，
 *    绝不把本地演示数据伪装成已发送 / 已回复 / 退信率；
 *  - localCounterKpi()：本地计数器可以显示数字，但必须显式标「演示」。
 *
 * 纪律：本文件不依赖 React、不读 store、不发请求、不含随机数与时间；
 * 真实结果的唯一来源是服务端 `/v1/import/outcomes` 回写，前端当前不读取，
 * 因此两个视图都传 `null`（诚实标注 DEMO），接真实数据时把 RealOutcomes 传入即可。
 */

export type KpiTone = 'slate' | 'rose' | 'emerald'

export interface RateStats {
  sent: number
  bounced: number
  replied: number
  interested: number
  bounceRate: number
  replyRate: number
  sampleSize: number
}

/** 结果分母：包含 bounced（退信也是一次真实发送尝试）；两页必须完全一致 */
const SENT_STATUSES = new Set(['sent', 'delivered', 'opened', 'replied', 'interested', 'quoted', 'won', 'bounced'])
const REPLIED_STATUSES = new Set(['replied', 'interested', 'quoted', 'won'])

/** 供「已发送记录」列表复用同一份白名单，避免列表与 KPI 分母再次漂移 */
export function isSentStatus(status: string): boolean {
  return SENT_STATUSES.has(status)
}

export function computeRateStats(companies: readonly { status: string }[]): RateStats {
  const sent = companies.filter((c) => SENT_STATUSES.has(c.status)).length
  const bounced = companies.filter((c) => c.status === 'bounced').length
  const replied = companies.filter((c) => REPLIED_STATUSES.has(c.status)).length
  const interested = companies.filter((c) => c.status === 'interested' || c.status === 'won').length
  return {
    sent, bounced, replied, interested,
    bounceRate: sent ? bounced / sent : 0,
    replyRate: sent ? replied / sent : 0,
    sampleSize: sent,
  }
}

export interface RealOutcomes {
  sampleSize: number
  source: 'server_outcomes'
}

export interface KpiInput {
  label: string
  value: string | number
  sub?: string
  tone?: KpiTone
}

export interface KpiDisplay {
  label: string
  value: string | number
  sub: string
  tone: KpiTone
  demo: boolean
  note: string
}

export const DEMO_OUTCOME_NOTE = '演示数据 · 非真实发送结果；真实 outcome 由服务端 /v1/import/outcomes 回写'
export const DEMO_COUNTER_NOTE = '本地演示计数 · 非真实业务结果'

/** 结果型 KPI：无真实样本 → 置灰「—」+ DEMO 说明；有真实样本 → 原值、不带 DEMO 标 */
export function kpiDisplay(input: KpiInput, real: RealOutcomes | null = null): KpiDisplay {
  const hasReal = Boolean(real && real.source === 'server_outcomes' && real.sampleSize > 0)
  if (hasReal) {
    return {
      label: input.label, value: input.value, sub: input.sub ?? '',
      tone: input.tone ?? 'slate', demo: false, note: '真实结果由服务端 outcome 回写',
    }
  }
  return {
    label: input.label, value: '—',
    sub: input.sub ? `${DEMO_OUTCOME_NOTE} · ${input.sub}` : DEMO_OUTCOME_NOTE,
    tone: 'slate', demo: true, note: DEMO_OUTCOME_NOTE,
  }
}

/** 本地计数器型 KPI：数字是真实的本地计数，但绝不能说成真实发送 / 业务结果 */
export function localCounterKpi(input: KpiInput): KpiDisplay {
  return {
    label: input.label, value: input.value,
    sub: input.sub ? `${DEMO_COUNTER_NOTE} · ${input.sub}` : DEMO_COUNTER_NOTE,
    tone: input.tone ?? 'slate', demo: true, note: DEMO_COUNTER_NOTE,
  }
}

/** 只把 StatTile 需要的 props 透出去，避免把内部 note 之类的字段漏进 DOM */
export function toTileProps(d: KpiDisplay) {
  return { label: d.label, value: d.value, sub: d.sub, tone: d.tone, demo: d.demo }
}
