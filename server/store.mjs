/**
 * PRD 8.2 / AC-03 · 持久化存储契约
 *
 * 目标：任务游标、结果缓存、调用审计在进程重启后仍可恢复，且「额度不重复扣」。
 * 三种实现共用同一接口，health 会如实暴露 mode，绝不把 memory 说成已持久化。
 *
 *  - sqlite：Node 22 内置 node:sqlite（实验特性，零额外依赖），默认值
 *  - json  ：node:sqlite 不可用时的文件兜底，原子 rename 写入
 *  - memory：仅测试用，重启即丢
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'

/**
 * 必须用同步内建模块探测，不能用 `await import('node:sqlite')`：
 * Vite 的模块解析器会把动态 import 的 `node:` 前缀剥掉、重写成 `import('sqlite')`，
 * 导致 Vitest 下探测失败、createStore() 静默退到 JSON 兜底而与生产行为不一致。
 * process.getBuiltinModule（Node 22.3+）与 createRequire 都是运行时访问，不经过 Vite 重写。
 */
function probeSqlite() {
  try {
    const mod = typeof process.getBuiltinModule === 'function'
      ? process.getBuiltinModule('node:sqlite')
      : createRequire(import.meta.url)('node:sqlite')
    if (mod?.DatabaseSync) return { ctor: mod.DatabaseSync, error: null }
    return { ctor: null, error: 'node:sqlite 未提供 DatabaseSync' }
  } catch (err) {
    return { ctor: null, error: String(err?.message ?? err) }
  }
}

const probe = probeSqlite()
const SqliteDatabaseSync = probe.ctor
export const sqliteProbeError = probe.error

const clone = (v) => (v === undefined || v === null ? v : structuredClone(v))

/**
 * 点数账本的通用内存实现（memory / json 共用）。
 * state 必须是调用方持有的可变对象：{ ledgerAccounts, ledgerEntries, ledgerIdem }；
 * json 实现把 state 直接序列化到磁盘，onWrite 传入 flush 即可获得原子写入。
 * idem_key 唯一约束在这里以 Map/Object 查找模拟，SQLite 实现由 UNIQUE 索引保证。
 */
function makeLedgerTables(state, onWrite) {
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
  return {
    ledgerTransact(fn) { return fn() }, // 单进程同步执行，无并发写；SQLite 实现用 BEGIN IMMEDIATE
    ledgerAccount(account) { return clone(state.ledgerAccounts[account] ?? null) },
    ledgerAccountPut(account, rec) { state.ledgerAccounts[account] = clone(rec); onWrite() },
    ledgerEntryByIdem(key) { return clone(state.ledgerIdem[key] ?? null) },
    ledgerAppend(entry) {
      if (hasOwn(state.ledgerIdem, entry.idem_key)) return false
      const full = clone(entry)
      state.ledgerEntries.push(full)
      state.ledgerIdem[full.idem_key] = full
      onWrite()
      return true
    },
    ledgerEntries(refId, limit = 200) {
      return state.ledgerEntries.filter((e) => e.ref_id === refId).slice(-limit).map(clone)
    },
    ledgerAllEntries(limit = 500) { return state.ledgerEntries.slice(-limit).map(clone) },
    ledgerStats() {
      return { accounts: Object.keys(state.ledgerAccounts).length, entries: state.ledgerEntries.length }
    },
  }
}

const emptyLedgerState = () => ({ ledgerAccounts: {}, ledgerEntries: [], ledgerIdem: {} })

export function createMemoryStore(opts = {}) {
  const now = opts.now ?? (() => Date.now())
  const tasks = new Map()
  const cache = new Map()
  const ledgerState = emptyLedgerState()
  const companyRecords = new Map()
  let outcomes = []
  let audit = []
  return {
    mode: 'memory',
    dbPath: null,
    ...makeLedgerTables(ledgerState, () => {}),
    taskUpsert(id, payload) { tasks.set(id, clone(payload)) },
    taskGet(id) { return clone(tasks.get(id) ?? null) },
    taskList() { return [...tasks.values()].map(clone) },
    taskDelete(id) { tasks.delete(id) },
    cacheGet(key) {
      const hit = cache.get(key)
      if (!hit) return null
      if (hit.expiresAt <= now()) { cache.delete(key); return null }
      return clone(hit.value)
    },
    cacheSet(key, value, ttlMs) { cache.set(key, { value: clone(value), expiresAt: now() + ttlMs }) },
    cacheStats() { return { entries: cache.size } },
    auditAppend(entry) { audit.push(clone(entry)); if (audit.length > 2000) audit.shift() },
    auditList(limit = 500) { return audit.slice(-limit).map(clone) },
    // v0.7.0 批量 SDR 管道：导入的客户库与发送结果事件
    companyUpsert(domain, payload) { companyRecords.set(domain, clone(payload)) },
    companyGet(domain) { return clone(companyRecords.get(domain) ?? null) },
    companyList() { return [...companyRecords.values()].map(clone) },
    companyDelete(domain) { companyRecords.delete(domain) },
    outcomeAppend(entry) { outcomes.push(clone(entry)); if (outcomes.length > 10000) outcomes.shift() },
    outcomeList(limit = 500) { return outcomes.slice(-limit).map(clone) },
    close() {
      tasks.clear(); cache.clear(); audit = []; outcomes = []; companyRecords.clear()
      Object.assign(ledgerState, emptyLedgerState())
    },
  }
}

function createSqliteStore(opts) {
  const { dbPath, now } = opts
  const abs = resolve(dbPath)
  mkdirSync(dirname(abs), { recursive: true })
  const db = new SqliteDatabaseSync(abs)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ledger_accounts (
      account TEXT PRIMARY KEY, granted INTEGER NOT NULL, held INTEGER NOT NULL,
      spent INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idem_key TEXT NOT NULL UNIQUE, ref_id TEXT NOT NULL, account TEXT NOT NULL,
      kind TEXT NOT NULL, amount INTEGER NOT NULL,
      granted_after INTEGER NOT NULL, held_after INTEGER NOT NULL, spent_after INTEGER NOT NULL,
      at INTEGER NOT NULL, meta TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_ref ON ledger_entries(ref_id);
    CREATE TABLE IF NOT EXISTS companies (
      domain TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL,
      event TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outcomes_at ON outcomes(at);
  `)
  const q = {
    taskUpsert: db.prepare('INSERT INTO tasks(id,payload,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at'),
    taskGet: db.prepare('SELECT payload FROM tasks WHERE id = ?'),
    taskList: db.prepare('SELECT payload FROM tasks ORDER BY updated_at DESC'),
    taskDelete: db.prepare('DELETE FROM tasks WHERE id = ?'),
    cacheGet: db.prepare('SELECT payload, expires_at FROM cache WHERE key = ?'),
    cacheSet: db.prepare('INSERT INTO cache(key,payload,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, expires_at=excluded.expires_at'),
    cacheDelete: db.prepare('DELETE FROM cache WHERE key = ?'),
    cacheCount: db.prepare('SELECT COUNT(*) AS c FROM cache'),
    auditAdd: db.prepare('INSERT INTO audit(payload,at) VALUES(?,?)'),
    auditList: db.prepare('SELECT payload FROM audit ORDER BY id DESC LIMIT ?'),
    ledgerAccountGet: db.prepare('SELECT granted, held, spent, updated_at FROM ledger_accounts WHERE account = ?'),
    ledgerAccountPut: db.prepare('INSERT INTO ledger_accounts(account,granted,held,spent,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(account) DO UPDATE SET granted=excluded.granted, held=excluded.held, spent=excluded.spent, updated_at=excluded.updated_at'),
    ledgerEntryByIdem: db.prepare('SELECT * FROM ledger_entries WHERE idem_key = ?'),
    ledgerAppend: db.prepare('INSERT OR IGNORE INTO ledger_entries(idem_key,ref_id,account,kind,amount,granted_after,held_after,spent_after,at,meta) VALUES(?,?,?,?,?,?,?,?,?,?)'),
    ledgerEntries: db.prepare('SELECT * FROM ledger_entries WHERE ref_id = ? ORDER BY id DESC LIMIT ?'),
    ledgerAllEntries: db.prepare('SELECT * FROM ledger_entries ORDER BY id DESC LIMIT ?'),
    ledgerAccountCount: db.prepare('SELECT COUNT(*) AS c FROM ledger_accounts'),
    ledgerEntryCount: db.prepare('SELECT COUNT(*) AS c FROM ledger_entries'),
    companyUpsert: db.prepare('INSERT INTO companies(domain,payload,updated_at) VALUES(?,?,?) ON CONFLICT(domain) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at'),
    companyGet: db.prepare('SELECT payload FROM companies WHERE domain = ?'),
    companyList: db.prepare('SELECT payload FROM companies ORDER BY updated_at ASC'),
    companyDelete: db.prepare('DELETE FROM companies WHERE domain = ?'),
    outcomeAdd: db.prepare('INSERT INTO outcomes(domain,event,payload,at) VALUES(?,?,?,?)'),
    outcomeList: db.prepare('SELECT payload FROM outcomes ORDER BY id DESC LIMIT ?'),
  }
  const parse = (row) => { try { return JSON.parse(row.payload) } catch { return null } }
  const parseEntry = (row) => {
    if (!row) return null
    let meta = {}
    try { meta = JSON.parse(row.meta) } catch { /* meta 损坏不影响流水主体 */ }
    return {
      idem_key: row.idem_key, ref_id: row.ref_id, account: row.account,
      kind: row.kind, amount: Number(row.amount),
      granted_after: Number(row.granted_after), held_after: Number(row.held_after),
      spent_after: Number(row.spent_after), at: Number(row.at), meta,
    }
  }
  const ledgerTables = {
    /** 账本写操作必须原子：BEGIN IMMEDIATE 保证并发下账户余额与流水一致 */
    ledgerTransact(fn) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
    ledgerAccount(account) {
      const row = q.ledgerAccountGet.get(account)
      return row ? { account, granted: Number(row.granted), held: Number(row.held), spent: Number(row.spent), updated_at: Number(row.updated_at) } : null
    },
    ledgerAccountPut(account, rec) {
      q.ledgerAccountPut.run(account, rec.granted, rec.held, rec.spent, rec.updated_at)
    },
    ledgerEntryByIdem(key) { return parseEntry(q.ledgerEntryByIdem.get(key)) },
    ledgerAppend(e) {
      const r = q.ledgerAppend.run(e.idem_key, e.ref_id, e.account, e.kind, e.amount,
        e.granted_after, e.held_after, e.spent_after, e.at, JSON.stringify(e.meta ?? {}))
      return Number(r.changes) === 1
    },
    ledgerEntries(refId, limit = 200) { return q.ledgerEntries.all(refId, limit).map(parseEntry).reverse() },
    ledgerAllEntries(limit = 500) { return q.ledgerAllEntries.all(limit).map(parseEntry).reverse() },
    ledgerStats() {
      return {
        accounts: Number(q.ledgerAccountCount.get()?.c ?? 0),
        entries: Number(q.ledgerEntryCount.get()?.c ?? 0),
      }
    },
  }
  return {
    mode: 'sqlite',
    dbPath: abs,
    ...ledgerTables,
    taskUpsert(id, payload) { q.taskUpsert.run(id, JSON.stringify(payload), now()) },
    taskGet(id) { const row = q.taskGet.get(id); return row ? parse(row) : null },
    taskList() { return q.taskList.all().map(parse).filter(Boolean) },
    taskDelete(id) { q.taskDelete.run(id) },
    cacheGet(key) {
      const row = q.cacheGet.get(key)
      if (!row) return null
      if (Number(row.expires_at) <= now()) { q.cacheDelete.run(key); return null }
      return parse(row)
    },
    cacheSet(key, value, ttlMs) { q.cacheSet.run(key, JSON.stringify(value), now() + ttlMs) },
    cacheStats() { return { entries: Number(q.cacheCount.get()?.c ?? 0) } },
    auditAppend(entry) { q.auditAdd.run(JSON.stringify(entry), now()) },
    auditList(limit = 500) { return q.auditList.all(limit).map(parse).filter(Boolean).reverse() },
    companyUpsert(domain, payload) { q.companyUpsert.run(domain, JSON.stringify(payload), now()) },
    companyGet(domain) { const row = q.companyGet.get(domain); return row ? parse(row) : null },
    companyList() { return q.companyList.all().map(parse).filter(Boolean) },
    companyDelete(domain) { q.companyDelete.run(domain) },
    outcomeAppend(entry) {
      q.outcomeAdd.run(String(entry.domain ?? ''), String(entry.event ?? ''), JSON.stringify(entry), Number(entry.at ?? now()))
    },
    outcomeList(limit = 500) { return q.outcomeList.all(limit).map(parse).filter(Boolean).reverse() },
    close() { db.close() },
  }
}

function createJsonStore(opts) {
  const { filePath, now } = opts
  const abs = resolve(filePath)
  let state = { tasks: {}, cache: {}, audit: [], companies: {}, outcomes: [], ...emptyLedgerState() }
  if (existsSync(abs)) {
    try {
      const loaded = JSON.parse(readFileSync(abs, 'utf8'))
      const ledger = emptyLedgerState()
      state = {
        tasks: loaded.tasks ?? {}, cache: loaded.cache ?? {}, audit: loaded.audit ?? [],
        companies: loaded.companies ?? {}, outcomes: loaded.outcomes ?? [],
        ledgerAccounts: loaded.ledgerAccounts ?? ledger.ledgerAccounts,
        ledgerEntries: loaded.ledgerEntries ?? ledger.ledgerEntries,
        ledgerIdem: loaded.ledgerIdem ?? ledger.ledgerIdem,
      }
    } catch (err) {
      // 损坏时明确告警并重建，不假装读到了历史数据
      // eslint-disable-next-line no-console
      console.warn(`[LeadPilot] 持久化文件 ${abs} 无法解析，已重建：${String(err?.message ?? err)}`)
    }
  }
  function flush() {
    mkdirSync(dirname(abs), { recursive: true })
    const tmp = `${abs}.tmp`
    writeFileSync(tmp, JSON.stringify(state), 'utf8')
    renameSync(tmp, abs)
  }
  return {
    mode: 'json',
    dbPath: abs,
    ...makeLedgerTables(state, flush),
    taskUpsert(id, payload) { state.tasks[id] = clone(payload); flush() },
    taskGet(id) { return clone(state.tasks[id] ?? null) },
    taskList() { return Object.values(state.tasks).map(clone) },
    taskDelete(id) { delete state.tasks[id]; flush() },
    cacheGet(key) {
      const hit = state.cache[key]
      if (!hit) return null
      if (hit.expiresAt <= now()) { delete state.cache[key]; flush(); return null }
      return clone(hit.value)
    },
    cacheSet(key, value, ttlMs) { state.cache[key] = { value: clone(value), expiresAt: now() + ttlMs }; flush() },
    cacheStats() { return { entries: Object.keys(state.cache).length } },
    auditAppend(entry) {
      state.audit.push(clone(entry))
      if (state.audit.length > 2000) state.audit.shift()
      flush()
    },
    auditList(limit = 500) { return state.audit.slice(-limit).map(clone) },
    companyUpsert(domain, payload) { state.companies[domain] = clone(payload); flush() },
    companyGet(domain) { return clone(state.companies[domain] ?? null) },
    companyList() { return Object.values(state.companies).map(clone) },
    companyDelete(domain) { delete state.companies[domain]; flush() },
    outcomeAppend(entry) {
      state.outcomes.push(clone(entry))
      if (state.outcomes.length > 10000) state.outcomes.shift()
      flush()
    },
    outcomeList(limit = 500) { return state.outcomes.slice(-limit).map(clone) },
    close() { flush() },
  }
}

/** 选择实现。sqlite 不可用时明确回退并标注 mode=json，绝不静默降级为 memory。 */
export function createStore(opts = {}) {
  const mode = opts.mode ?? process.env.LEADPILOT_STORE ?? 'sqlite'
  const dbPath = opts.dbPath ?? process.env.LEADPILOT_DB_PATH ?? './data/leadpilot.db'
  const now = opts.now ?? (() => Date.now())
  if (mode === 'memory') return createMemoryStore({ now })
  if (mode === 'json') return createJsonStore({ filePath: dbPath, now })
  if (mode === 'sqlite' && !SqliteDatabaseSync) {
    // eslint-disable-next-line no-console
    console.warn(`[LeadPilot] node:sqlite 不可用（${sqliteProbeError ?? 'unknown'}），回退 JSON 文件持久化。`)
    return createJsonStore({ filePath: dbPath.replace(/\.db$/, '.json'), now })
  }
  return createSqliteStore({ dbPath, now })
}

export const sqliteAvailable = Boolean(SqliteDatabaseSync)
