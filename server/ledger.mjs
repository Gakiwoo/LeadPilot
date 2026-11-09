/**
 * PRD F0-6 / 9.4 / AC-03 · 点数账本（事务化）
 *
 * 生命周期：创建云端任务 → reserve 预扣 → 完成/中止 settle 结算（多退少不补）
 *          → 未启动即释放 release 全额退还 → 进程重启靠持久化流水保证不重复扣。
 *
 * 硬约束：
 *  - 每次写操作都在 store.ledgerTransact 内完成（SQLite = BEGIN IMMEDIATE）。
 *  - 同一 refId 的同类操作由 idem_key 唯一约束保证幂等；同 key 不同金额返回 E4002。
 *  - available = granted - held - spent，任何情况下不允许为负（allowNegative=false）。
 *  - v0.6.0：账本范围从「仅云端任务」扩展到「云端任务 + 网关真实调用」，
 *    两者共用同一套事务与幂等键；未注入 ledger 的独立网关才只产出审计估值。
 *    health 必须如实暴露 scope 与 ledgerConsumers，绝不把审计估值说成已扣点。
 */
import { protocol } from './protocol.mjs'
import { createMemoryStore } from './store.mjs'

const CFG = protocol.billing.ledger
export const LEDGER_VERSION = CFG.version
export const DEFAULT_ACCOUNT = CFG.defaultAccount

/** 金额只允许非负整数；小数、负数、NaN、字符串一律拒绝，避免账本被脏值污染 */
function normalizeAmount(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null
  return n
}

export function createLedger(opts = {}) {
  const store = opts.store ?? createMemoryStore()
  const now = opts.now ?? (() => Date.now())
  const opening = normalizeAmount(opts.openingBalance ?? process.env.LEADPILOT_POINTS_BALANCE ?? CFG.openingBalancePoints)
  const openingBalance = opening ?? CFG.openingBalancePoints

  /** 内部方法：不自行开事务，由各公开操作统一包一层，避免 SQLite 嵌套 BEGIN */
  function readAccount(account) { return store.ledgerAccount(account) }

  function ensureAccount(account) {
    let rec = readAccount(account)
    if (!rec) {
      rec = { account, granted: openingBalance, held: 0, spent: 0, updated_at: now() }
      store.ledgerAccountPut(account, rec)
      store.ledgerAppend({
        idem_key: `grant:${account}:opening`, ref_id: `opening:${account}`, account,
        kind: 'grant', amount: openingBalance,
        granted_after: rec.granted, held_after: 0, spent_after: 0,
        at: now(), meta: { reason: '开户初始额度', source: 'LEADPILOT_POINTS_BALANCE' },
      })
    }
    return rec
  }

  function putAccount(rec) { store.ledgerAccountPut(rec.account, { ...rec, updated_at: now() }) }

  function append(rec, kind, amount, refId, idemKey, meta = {}) {
    return store.ledgerAppend({
      idem_key: idemKey, ref_id: refId, account: rec.account, kind, amount,
      granted_after: rec.granted, held_after: rec.held, spent_after: rec.spent,
      at: now(), meta,
    })
  }

  const availableOf = (rec) => rec.granted - rec.held - rec.spent
  const stateOf = (rec) => ({
    account: rec.account, granted: rec.granted, held: rec.held, spent: rec.spent,
    available: availableOf(rec), ledgerVersion: LEDGER_VERSION, persistence: store.mode,
  })

  function idempotentHit(existing, amount, resultOf) {
    if (existing.amount !== amount) {
      return {
        ok: false, code: 'E4002', idempotent: false,
        reason: `账本幂等键冲突：同一操作键此前记录的金额是 ${existing.amount} 点，本次请求 ${amount} 点。`,
      }
    }
    return { ok: true, idempotent: true, ...resultOf(existing) }
  }

  return {
    version: LEDGER_VERSION,
    mode: store.mode,
    scope: CFG.scope,
    ledgerConsumers: CFG.ledgerConsumers,
    auditOnlyConsumers: CFG.auditOnlyConsumers,

    /** 只读查询也确保账户已初始化，返回的结构即 /v1/points 的响应体 */
    state(account = DEFAULT_ACCOUNT) {
      return store.ledgerTransact(() => stateOf(ensureAccount(String(account))))
    },

    /**
     * 预扣。同一 refId 重复调用不会二次冻结额度（AC-03 重启、请求重试都安全）。
     * @returns {{ok:boolean, code?:string, idempotent?:boolean, held:number, available:number}}
     */
    reserve(input = {}) {
      const account = String(input.account ?? DEFAULT_ACCOUNT)
      const refId = String(input.refId ?? '')
      const amount = normalizeAmount(input.amount)
      if (!refId) return { ok: false, code: 'E4003', reason: 'reserve 缺少 refId' }
      if (amount === null || amount <= 0) return { ok: false, code: 'E4003', reason: `reserve 金额非法：${String(input.amount)}` }
      const idemKey = `reserve:${refId}`
      return store.ledgerTransact(() => {
        const existing = store.ledgerEntryByIdem(idemKey)
        if (existing) {
          const rec = ensureAccount(account)
          return idempotentHit(existing, amount, (e) => ({ held: e.amount, available: availableOf(rec) }))
        }
        const history = store.ledgerEntries(refId, 200)
        if (history.some((e) => e.kind === 'settle' || e.kind === 'release')) {
          return { ok: false, code: 'E4003', reason: `任务 ${refId} 已结算或已释放，不允许重新预扣。` }
        }
        const rec = ensureAccount(account)
        const available = availableOf(rec)
        if (amount > available) {
          return {
            ok: false, code: 'E4001', held: 0, available,
            reason: `点数不足：本次预计消耗 ${amount} 点，可用 ${available} 点。请降配或充值。`,
          }
        }
        rec.held += amount
        putAccount(rec)
        append(rec, 'reserve', amount, refId, idemKey, { reason: String(input.reason ?? '云端任务预扣') })
        return { ok: true, idempotent: false, held: amount, available: availableOf(rec) }
      })
    },

    /**
     * 结算。把该 refId 的全部预扣一次性转为「实际消耗 + 退还差额」。
     * amount 不得超过冻结额；重复调用返回首次结果，不会二次扣点。
     */
    settle(input = {}) {
      const account = String(input.account ?? DEFAULT_ACCOUNT)
      const refId = String(input.refId ?? '')
      const amount = normalizeAmount(input.amount)
      if (!refId) return { ok: false, code: 'E4003', reason: 'settle 缺少 refId' }
      if (amount === null) return { ok: false, code: 'E4003', reason: `settle 金额非法：${String(input.amount)}` }
      const idemKey = `settle:${refId}`
      return store.ledgerTransact(() => {
        const existing = store.ledgerEntryByIdem(idemKey)
        if (existing) {
          const rec = ensureAccount(account)
          return idempotentHit(existing, amount, (e) => ({
            charged: e.amount, refunded: Number(e.meta?.refunded ?? 0), available: availableOf(rec),
          }))
        }
        const history = store.ledgerEntries(refId, 200)
        const reserves = history.filter((e) => e.kind === 'reserve')
        if (!reserves.length) {
          return { ok: false, code: 'E4003', reason: `任务 ${refId} 没有活跃预扣记录，拒绝无预扣结算。` }
        }
        if (history.some((e) => e.kind === 'settle' || e.kind === 'release')) {
          return { ok: false, code: 'E4003', reason: `任务 ${refId} 已结算或已释放。` }
        }
        const held = reserves.reduce((s, e) => s + e.amount, 0)
        if (amount > held) {
          return { ok: false, code: 'E4003', reason: `结算 ${amount} 点超过冻结 ${held} 点，拒绝超额扣费。` }
        }
        const rec = ensureAccount(account)
        rec.held -= held
        rec.spent += amount
        putAccount(rec)
        append(rec, 'settle', amount, refId, idemKey, {
          reason: String(input.reason ?? '任务结算'), holdConsumed: held, refunded: held - amount,
        })
        return { ok: true, idempotent: false, charged: amount, refunded: held - amount, available: availableOf(rec) }
      })
    },

    /** 全额释放（任务从未启动 / 创建后立即废弃），不产生任何实际消耗 */
    release(input = {}) {
      const account = String(input.account ?? DEFAULT_ACCOUNT)
      const refId = String(input.refId ?? '')
      if (!refId) return { ok: false, code: 'E4003', reason: 'release 缺少 refId' }
      const idemKey = `release:${refId}`
      return store.ledgerTransact(() => {
        const existing = store.ledgerEntryByIdem(idemKey)
        if (existing) {
          const rec = ensureAccount(account)
          return { ok: true, idempotent: true, refunded: existing.amount, available: availableOf(rec) }
        }
        const history = store.ledgerEntries(refId, 200)
        const held = history.filter((e) => e.kind === 'reserve').reduce((s, e) => s + e.amount, 0)
        if (held <= 0) return { ok: false, code: 'E4003', reason: `任务 ${refId} 没有可释放的预扣。` }
        if (history.some((e) => e.kind === 'settle' || e.kind === 'release')) {
          return { ok: false, code: 'E4003', reason: `任务 ${refId} 已结算或已释放，拒绝重复释放。` }
        }
        const rec = ensureAccount(account)
        rec.held -= held
        putAccount(rec)
        append(rec, 'release', held, refId, idemKey, { reason: String(input.reason ?? '未启动任务全额释放') })
        return { ok: true, idempotent: false, refunded: held, available: availableOf(rec) }
      })
    },

    /** 直接扣费（无预扣场景，例如未来的单次调用计费）；当前版本不用于 gateway */
    charge(input = {}) {
      const account = String(input.account ?? DEFAULT_ACCOUNT)
      const refId = String(input.refId ?? '')
      const amount = normalizeAmount(input.amount)
      if (!refId || amount === null || amount <= 0) {
        return { ok: false, code: 'E4003', reason: 'charge 参数非法' }
      }
      const idemKey = `charge:${refId}`
      return store.ledgerTransact(() => {
        const existing = store.ledgerEntryByIdem(idemKey)
        if (existing) {
          const rec = ensureAccount(account)
          return idempotentHit(existing, amount, () => ({ charged: existing.amount, available: availableOf(rec) }))
        }
        const rec = ensureAccount(account)
        if (amount > availableOf(rec)) {
          return { ok: false, code: 'E4001', available: availableOf(rec), reason: `点数不足：需 ${amount} 点，可用 ${availableOf(rec)} 点。` }
        }
        rec.spent += amount
        putAccount(rec)
        append(rec, 'charge', amount, refId, idemKey, { reason: String(input.reason ?? '直接扣费') })
        return { ok: true, idempotent: false, charged: amount, available: availableOf(rec) }
      })
    },

    /** 充值/调额。只由服务端配置或运维调用，不暴露为公开 HTTP 接口 */
    grant(input = {}) {
      const account = String(input.account ?? DEFAULT_ACCOUNT)
      const amount = normalizeAmount(input.amount)
      const refId = String(input.refId ?? `grant:${now()}`)
      if (amount === null || amount <= 0) return { ok: false, code: 'E4003', reason: 'grant 金额非法' }
      const idemKey = `grant:${refId}`
      return store.ledgerTransact(() => {
        const existing = store.ledgerEntryByIdem(idemKey)
        if (existing) return idempotentHit(existing, amount, () => ({ granted: existing.amount }))
        const rec = ensureAccount(account)
        rec.granted += amount
        putAccount(rec)
        append(rec, 'grant', amount, refId, idemKey, { reason: String(input.reason ?? '额度充值') })
        return { ok: true, idempotent: false, granted: amount, available: availableOf(rec) }
      })
    },

    entries(refId, limit = 200) { return store.ledgerEntries(String(refId), limit) },
    allEntries(limit = 500) { return store.ledgerAllEntries(limit) },

    health() {
      return store.ledgerTransact(() => {
        const stats = store.ledgerStats()
        return {
          ...stateOf(ensureAccount(DEFAULT_ACCOUNT)),
          accounts: stats.accounts, entries: stats.entries,
          scope: CFG.scope,
          ledgerConsumers: CFG.ledgerConsumers,
          auditOnlyConsumers: CFG.auditOnlyConsumers,
          gatewayBilling: {
            version: protocol.billing.gatewayBilling.version,
            reservePoints: protocol.billing.gatewayBilling.reservePoints,
            chargeOn: protocol.billing.gatewayBilling.chargeOn,
            releaseOn: protocol.billing.gatewayBilling.releaseOn,
            noChargeOn: protocol.billing.gatewayBilling.noChargeOn,
          },
          note: '账本覆盖云端任务与网关真实调用的预扣/结算/释放；未注入 ledger 的独立网关仍只产出 token 折算审计估值，其响应会标注 audit-only。',
        }
      })
    },
  }
}
