/**
 * F11 第二步 · 多步序列域层反例
 *
 * 重点不是「能算出日期」，而是三条边界：
 *  1. 序列**没有任何执行能力**（无定时器、不改状态、不建草稿）；
 *  2. 校验拒绝 4 步 / 非递增间隔 / 引用已删模板（不静默换一封）；
 *  3. 退订 / 已回复 / 硬退信的客户，序列直接终止而不是继续提醒。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_SEQUENCES, MAX_SEQUENCE_STEPS, MAX_STEP_GAP_DAYS, MAX_SEQUENCE_SPAN_DAYS,
  SEQUENCE_BLOCKED_STATUSES, planFollowUp, sequenceSpanDays, validateSequence,
  type FollowUpSequence,
} from '@/domain/follow-up'

const TEMPLATES = ['tpl_a', 'tpl_b', 'tpl_c']

const seq = (steps: Array<{ templateId?: string; gapDays?: number }>): FollowUpSequence['steps'] =>
  steps.map((s) => ({ templateId: s.templateId ?? 'tpl_a', gapDays: s.gapDays ?? 0 }))

const check = (steps: FollowUpSequence['steps'], name = '测试序列') =>
  validateSequence({ name, steps }, { templateIds: TEMPLATES })

/* ------------------------------------------------------------ 校验 */

describe('validateSequence · 结构校验', () => {
  it('名称为空或超 40 字被拒', () => {
    expect(check(seq([{}]), '').issues.some((i) => i.includes('名称不能为空'))).toBe(true)
    expect(check(seq([{}]), 'x'.repeat(41)).issues.some((i) => i.includes('40'))).toBe(true)
  })

  it('0 步被拒：空序列等于没有节奏', () => {
    expect(check([]).ok).toBe(false)
  })

  it('3 步通过、4 步被拒且提示上限', () => {
    expect(check(seq([{ gapDays: 0 }, { gapDays: 3 }, { gapDays: 10 }])).ok).toBe(true)
    const four = check(seq([{ gapDays: 0 }, { gapDays: 3 }, { gapDays: 10 }, { gapDays: 20 }]))
    expect(four.ok).toBe(false)
    expect(four.issues.join('；')).toContain(`最多 ${MAX_SEQUENCE_STEPS} 步`)
  })

  it('第 1 步的间隔必须为 0', () => {
    expect(check(seq([{ gapDays: 2 }])).issues.some((i) => i.includes('第 1 步的间隔天数必须是 0'))).toBe(true)
  })

  it('后续步骤间隔必须 ≥1 且 ≤上限', () => {
    expect(check(seq([{ gapDays: 0 }, { gapDays: 0 }])).issues.length).toBeGreaterThan(0)
    expect(check(seq([{ gapDays: 0 }, { gapDays: MAX_STEP_GAP_DAYS + 1 }]))
      .issues.some((i) => i.includes('不超过'))).toBe(true)
  })

  it('间隔必须是整数：1.5 天无法排期', () => {
    expect(check(seq([{ gapDays: 0 }, { gapDays: 1.5 }])).issues.some((i) => i.includes('必须是整数'))).toBe(true)
  })

  it('引用不存在的模板被拒，且明确不会自动换模板', () => {
    const r = check(seq([{ gapDays: 0, templateId: 'tpl_gone' }]))
    expect(r.ok).toBe(false)
    expect(r.issues.join('；')).toContain('不会自动换成别的模板')
  })

  it('整条跨度超过上限被拒（上限必须严格小于「步数 × 单步上限」，否则是死代码）', () => {
    expect(MAX_SEQUENCE_SPAN_DAYS).toBeLessThan(MAX_STEP_GAP_DAYS * MAX_SEQUENCE_STEPS)
    const r = check(seq([
      { gapDays: 0 },
      { gapDays: MAX_STEP_GAP_DAYS },
      { gapDays: MAX_STEP_GAP_DAYS },
    ]))
    expect(r.ok).toBe(false)
    expect(r.issues.join('；')).toContain('超过上限')
  })

  it('内置序列本身全部通过校验（基线不能是非法样例）', () => {
    for (const s of DEFAULT_SEQUENCES) {
      const r = validateSequence({ name: s.name, steps: s.steps }, {
        templateIds: ['tpl_builtin_intro', 'tpl_builtin_followup', 'tpl_builtin_breakup'],
      })
      expect(r.ok, `${s.name}: ${r.issues.join('；')}`).toBe(true)
    }
  })

  it('sequenceSpanDays 是各步间隔之和', () => {
    expect(sequenceSpanDays({ steps: seq([{ gapDays: 0 }, { gapDays: 3 }, { gapDays: 10 }]) })).toBe(13)
  })
})

/* ------------------------------------------------------------ 排期 */

const NOW = new Date('2026-11-28T00:00:00.000Z')
const SEQ3 = { steps: seq([{ gapDays: 0 }, { gapDays: 3 }, { gapDays: 10 }]) }

const plan = (input: Partial<Parameters<typeof planFollowUp>[0]>) => planFollowUp({
  sequence: SEQ3,
  startedAt: null,
  completedSteps: 0,
  status: 'new',
  now: NOW,
  ...input,
})

describe('planFollowUp · 排期推算', () => {
  it('未开始时第 1 步可做，后续无基准日期（给 null 而不是编一个）', () => {
    const p = plan({})
    expect(p.steps[0]?.state).toBe('due')
    expect(p.steps[0]?.dueAt).toBeNull()
    expect(p.steps[1]?.state).toBe('waiting')
    expect(p.steps[1]?.dueAt).toBeNull()
    expect(p.nextIndex).toBe(1)
    expect(p.blocked).toBe(false)
  })

  it('今天开始：第 1 步今天到期，第 2/3 步分别在 +3 / +13 天', () => {
    const p = plan({ startedAt: NOW.toISOString() })
    expect(p.steps[0]?.daysUntilDue).toBe(0)
    expect(p.steps[0]?.state).toBe('due')
    expect(p.steps[1]?.dueAt).toBe('2026-12-01T00:00:00.000Z')
    expect(p.steps[2]?.dueAt).toBe('2026-12-11T00:00:00.000Z')
    expect(p.steps[1]?.state).toBe('waiting')
  })

  it('已完成步数按调用方给的值判定，不由域层猜测', () => {
    const p = plan({ startedAt: NOW.toISOString(), completedSteps: 2 })
    expect(p.steps[0]?.state).toBe('done')
    expect(p.steps[1]?.state).toBe('done')
    expect(p.steps[2]?.state).toBe('waiting')
    expect(p.nextIndex).toBeNull()
  })

  it('逾期按天数如实计算，不四舍五入成今天', () => {
    const p = plan({
      startedAt: '2026-11-18T00:00:00.000Z',
      completedSteps: 1,
    })
    expect(p.steps[1]?.state).toBe('overdue')
    expect(p.steps[1]?.daysUntilDue).toBe(-7)
    expect(p.nextIndex).toBe(2)
  })

  it('全部完成时 nextIndex 为 null，不会催用户再发一封', () => {
    const p = plan({ startedAt: NOW.toISOString(), completedSteps: 3 })
    expect(p.steps.every((s) => s.state === 'done')).toBe(true)
    expect(p.nextIndex).toBeNull()
  })

  it('传入负的完成步数被夹到 0，不出现负索引', () => {
    const p = plan({ startedAt: NOW.toISOString(), completedSteps: -5 })
    expect(p.steps[0]?.state).toBe('due')
  })

  it('不改写入参：序列与配置都保持原样（纯函数）', () => {
    const input = {
      sequence: SEQ3,
      startedAt: null,
      completedSteps: 0,
      status: 'new' as const,
      now: NOW,
    }
    const snapshot = JSON.stringify(input)
    planFollowUp(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})

/* ------------------------------------------------------------ 终止条件 */

describe('planFollowUp · 不该继续跟进的状态', () => {
  it('退订 / 无意向 / 硬退信 / 已回复等状态一律终止', () => {
    for (const status of ['unsubscribed', 'not_interested', 'bounced', 'replied', 'interested', 'quoted', 'won'] as const) {
      const p = plan({ status, startedAt: NOW.toISOString() })
      expect(p.blocked, status).toBe(true)
      expect(p.nextIndex, status).toBeNull()
      expect(p.steps.every((s) => s.state === 'blocked'), status).toBe(true)
      expect(p.reason, status).toBeTruthy()
    }
  })

  it('终止原因按状态区分，不是一句笼统的「已终止」', () => {
    expect(plan({ status: 'unsubscribed' }).reason).toContain('退订')
    expect(plan({ status: 'bounced' }).reason).toContain('硬退信')
    expect(plan({ status: 'replied' }).reason).toContain('人工')
  })

  it('正常推进中的状态不被误拦', () => {
    for (const status of ['new', 'sent', 'delivered', 'opened', 'draft'] as never[]) {
      if (SEQUENCE_BLOCKED_STATUSES.includes(status)) continue
      expect(plan({ status }).blocked, status).toBe(false)
    }
  })
})

/* ------------------------------------------------------------ 能力边界 */

describe('能力边界 · 序列没有执行能力', () => {
  const raw = readFileSync(fileURLToPath(new URL('../../src/domain/follow-up.ts', import.meta.url)), 'utf8')
  // 只扫代码，不扫注释：注释里出现「不自动建草稿（走 addOutreach）」是说明，不是能力
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it('域层不含任何定时器（不排程、不轮询）', () => {
    expect(source).not.toMatch(/setInterval|setTimeout|requestAnimationFrame|queueMicrotask/)
  })

  it('域层不发送、不改状态、不建草稿', () => {
    expect(source).not.toMatch(/addOutreach|setCompanyStatus|fetch\(|sendEmail|autoSend|autoSchedule/)
  })

  it('终止状态集合显式列出，不靠「不认识的都放过」', () => {
    expect(SEQUENCE_BLOCKED_STATUSES).toEqual(
      expect.arrayContaining(['unsubscribed', 'not_interested', 'bounced', 'replied']),
    )
  })
})
