/**
 * AC-03 跨进程恢复断言（纯 Node，不创建子进程）
 *
 * 进程编排由 scripts/verify-restart.sh 负责；本文件只做 HTTP 调用、SQLite 原文读取与断言，
 * 因此不依赖 jq、不依赖任何第三方包，也不受 Windows 会话 node 无法 spawn 的影响。
 *
 * mode:
 *   create     启动后调用：创建长任务并推进游标
 *   persisted  进程被杀后调用：直读 SQLite，把「落盘值」写入 state 作为比对基准
 *   verify     重启后调用：恢复值必须与落盘值逐项一致，resume 从原游标继续且不重复扣点
 */
import { readFileSync, writeFileSync } from 'node:fs'

const BASE = process.env.AC03_BASE ?? 'http://127.0.0.1:5193'
const DB = process.env.AC03_DB ?? './data/verify-restart.db'
const STATE = process.env.AC03_STATE ?? '.tmp/verify-restart-state.json'
const mode = process.argv[2] ?? 'create'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures++
}
const api = async (path, init) => {
  const r = await fetch(BASE + path, init)
  return { status: r.status, body: await r.json() }
}
const post = (path, body) => api(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
})
const readState = () => JSON.parse(readFileSync(STATE, 'utf8'))
const saveState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2))

if (mode === 'create') {
  const r = await post('/v1/tasks', {
    keywords: ['hydraulic fittings'], markets: ['德国'], depth: 2, targetCount: 1000,
  })
  check('创建云端任务', r.status === 201 && !!r.body?.task?.id, `status=${r.status} id=${r.body?.task?.id ?? 'n/a'}`)
  const id = r.body?.task?.id
  if (!id) process.exit(1)
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const t = (await api(`/v1/tasks/${id}`)).body?.task
  check('杀进程前任务仍在 running（避免测到自然完成）', t?.status === 'running', `status=${t?.status}`)
  check('游标已推进并落盘', (t?.cursor?.offset ?? 0) > 0, `offset=${t?.cursor?.offset}`)
  saveState({ id, beforeOffset: t?.cursor?.offset ?? 0 })
} else if (mode === 'persisted') {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const db = new DatabaseSync(DB, { readOnly: true })
  const rows = db.prepare('SELECT payload FROM tasks').all()
  const ledgerAccount = db.prepare('SELECT granted, held, spent FROM ledger_accounts WHERE account = ?').get('default')
  const s0 = readState()
  const reserveCount = db.prepare("SELECT COUNT(*) AS c FROM ledger_entries WHERE ref_id = ? AND kind = 'reserve'").get(s0.id)
  db.close()
  const p = rows.length ? JSON.parse(rows.at(-1).payload) : null
  check('SQLite 中存在任务记录', !!p, `rows=${rows.length}`)
  if (!p) process.exit(1)
  const s = s0
  s.persisted = {
    status: p.status, offset: p.cursor?.offset ?? 0, pointsUsed: p.pointsUsed ?? 0,
    ledgerHeld: Number(ledgerAccount?.held ?? -1),
    ledgerAvailable: Number(ledgerAccount?.granted ?? 0) - Number(ledgerAccount?.held ?? 0) - Number(ledgerAccount?.spent ?? 0),
    reserveCount: Number(reserveCount?.c ?? -1),
  }
  check('账本预扣已落盘且只有一条 reserve 流水',
    s.persisted.ledgerHeld > 0 && s.persisted.reserveCount === 1,
    `held=${s.persisted.ledgerHeld} reserveCount=${s.persisted.reserveCount}`)
  saveState(s)
  console.log(`PERSISTED ${JSON.stringify(s.persisted)}`)
  check('被杀瞬间落盘状态为 running（IPC 未收尾）', s.persisted.status === 'running', `status=${s.persisted.status}`)
} else if (mode === 'verify') {
  const s = readState()
  const p = s.persisted
  check('state 含落盘基准', !!p)
  if (!p) process.exit(1)

  const health = (await api('/health')).body
  check('health 如实上报 sqlite 持久化', health?.persistence?.mode === 'sqlite' && health?.persistence?.durable === true,
    `mode=${health?.persistence?.mode} durable=${health?.persistence?.durable}`)
  check('health 上报恢复任务数', (health?.persistence?.recoveredTasks ?? 0) >= 1,
    `recoveredTasks=${health?.persistence?.recoveredTasks}`)

  const r = await api(`/v1/tasks/${s.id}`)
  const t = r.body?.task
  check('任务从 SQLite 恢复', r.status === 200 && !!t, `status=${r.status}`)
  console.log(`RESTORED ${JSON.stringify({ status: t?.status, recovered: t?.recovered, offset: t?.cursor?.offset, pointsUsed: t?.pointsUsed })}`)
  check('活跃任务降为 paused（不自动续跑）', t?.status === 'paused', `status=${t?.status}`)
  check('标记 recovered=true', t?.recovered === true)
  check('恢复游标与落盘值一致、未从头重跑', t?.cursor?.offset === p.offset, `persisted=${p.offset} restored=${t?.cursor?.offset}`)
  check('已用点数与落盘值一致、不重复扣', t?.pointsUsed === p.pointsUsed, `persisted=${p.pointsUsed} restored=${t?.pointsUsed}`)
  check('恢复日志可核验', (t?.progress?.log ?? []).some((l) => l.text.includes('额度不重复扣减')))

  const pts = (await api('/v1/points')).body
  check('账本预扣跨进程保留，额度没有被重新冻结或凭空消失',
    pts?.held === p.ledgerHeld && pts?.available === p.ledgerAvailable,
    `persisted held=${p.ledgerHeld}/available=${p.ledgerAvailable} restored held=${pts?.held}/available=${pts?.available}`)
  const taskPoints = (await api(`/v1/points?refId=${encodeURIComponent(s.id)}`)).body
  const reserves = (taskPoints?.entries ?? []).filter((e) => e.kind === 'reserve')
  check('该任务只有一条预扣流水（AC-03 不重复扣点）', reserves.length === 1,
    `reserves=${reserves.length}`)

  const rr = await post(`/v1/tasks/${s.id}/resume`, { cursor: t?.cursor })
  check('显式点击继续即断点续跑', rr.status === 200 && rr.body?.task?.status === 'running', `status=${rr.body?.task?.status}`)
  check('续跑瞬间点数未重复扣', rr.body?.task?.pointsUsed === p.pointsUsed, `pointsUsed=${rr.body?.task?.pointsUsed}`)
  check('续跑从原游标继续', (rr.body?.task?.cursor?.offset ?? 0) >= p.offset, `offset=${rr.body?.task?.cursor?.offset}`)
  const afterResume = (await api('/v1/points')).body
  check('续跑后账本冻结额不变', afterResume?.held === p.ledgerHeld,
    `held=${afterResume?.held} expected=${p.ledgerHeld}`)
  await post(`/v1/tasks/${s.id}/abort`, {})
} else {
  console.error(`未知 mode：${mode}`)
  process.exit(1)
}

console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} · mode=${mode} · failures=${failures}`)
if (failures) process.exit(1)
