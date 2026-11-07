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

export function createMemoryStore(opts = {}) {
  const now = opts.now ?? (() => Date.now())
  const tasks = new Map()
  const cache = new Map()
  let audit = []
  return {
    mode: 'memory',
    dbPath: null,
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
    close() { tasks.clear(); cache.clear(); audit = [] },
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
  }
  const parse = (row) => { try { return JSON.parse(row.payload) } catch { return null } }
  return {
    mode: 'sqlite',
    dbPath: abs,
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
    close() { db.close() },
  }
}

function createJsonStore(opts) {
  const { filePath, now } = opts
  const abs = resolve(filePath)
  let state = { tasks: {}, cache: {}, audit: [] }
  if (existsSync(abs)) {
    try {
      const loaded = JSON.parse(readFileSync(abs, 'utf8'))
      state = { tasks: loaded.tasks ?? {}, cache: loaded.cache ?? {}, audit: loaded.audit ?? [] }
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
