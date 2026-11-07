/**
 * PRD F8：12 态状态机
 * 自动流转仅限「建草稿 / 发送 / 退信 / 回复」四种；其余一律人工确认，AI 不替用户判断有无意向。
 */
import type { Company, CompanyStatus, StatusLogEntry } from '@/types'
import { AUTOMATIC_TRANSITIONS, STATUS_DEFS } from './constants'

export interface TransitionRequest {
  from: CompanyStatus
  to: CompanyStatus
  automated: boolean
  operator?: string
  note?: string
  /** 批量操作已二次确认 */
  confirmed?: boolean
  batch?: boolean
}

export interface TransitionResult {
  allowed: boolean
  code?: string
  message?: string
  needsConfirm?: boolean
}

const def = (s: CompanyStatus) => STATUS_DEFS.find((d) => d.key === s)!

export function canTransition(req: TransitionRequest): TransitionResult {
  if (req.from === req.to) return { allowed: false, message: '状态未发生变化' }

  // 红线：退订/不可逆，全局生效
  if (def(req.from).terminal) {
    return { allowed: false, code: 'E3001', message: '该客户已退订或标记无效，属不可逆状态，任何账号与任务均不可再流转' }
  }

  // 自动流转白名单
  if (req.automated && !AUTOMATIC_TRANSITIONS.includes(req.to)) {
    return {
      allowed: false,
      code: 'E3004',
      message: `自动流转仅允许 ${AUTOMATIC_TRANSITIONS.map((s) => def(s).zh).join(' / ')}；「${def(req.to).zh}」必须人工确认`,
    }
  }

  // 批量流转到关键态需二次确认（PRD F8-2）
  if (req.batch && ['won', 'not_interested', 'unsubscribed'].includes(req.to) && !req.confirmed) {
    return { allowed: true, needsConfirm: true, message: `批量标记为「${def(req.to).zh}」需二次确认，避免误触污染数据` }
  }

  // 退订二次确认
  if (req.to === 'unsubscribed' && !req.confirmed) {
    return { allowed: true, needsConfirm: true, message: '退订与加入黑名单不可逆且全局生效，请确认' }
  }

  return { allowed: true }
}

/** 状态变更留痕：时间 / from / to / 操作人 / 是否自动 / 备注 */
export function applyTransition(company: Company, to: CompanyStatus, opts: {
  operator?: string
  automated?: boolean
  note?: string
} = {}): Company {
  const entry: StatusLogEntry = {
    id: `sl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    from: company.status,
    to,
    operator: opts.operator ?? '本地用户',
    automated: opts.automated ?? false,
    note: opts.note,
    createdAt: new Date().toISOString(),
  }
  return {
    ...company,
    status: to,
    statusLog: [...company.statusLog, entry],
    lastContactAt: ['sent', 'replied', 'quoted'].includes(to) ? entry.createdAt : company.lastContactAt,
  }
}

/** PRD F8-1：四种自动流转的业务事件映射 */
export const AUTO_EVENT: Record<'draft_created' | 'email_sent' | 'hard_bounce' | 'reply_detected', CompanyStatus> = {
  draft_created: 'drafted',
  email_sent: 'sent',
  hard_bounce: 'bounced',
  reply_detected: 'replied',
}

/** 跟进提醒：已发送 3 天无回复 → 推荐二次触达（PRD F8-3） */
export function suggestFollowup(company: Company, now = new Date()): { dueDate: string; content: string } | null {
  if (company.status !== 'sent' || !company.lastContactAt) return null
  const days = (now.getTime() - new Date(company.lastContactAt).getTime()) / 86400000
  if (days < 3) return null
  return {
    dueDate: new Date(now.getTime() + 2 * 86400000).toISOString().slice(0, 10),
    content: '二次触达：换个角度，不重复催问（PRD F8-3）',
  }
}
