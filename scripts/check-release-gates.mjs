/**
 * 发布门禁自检 · v0.7.0
 *
 * 目的：把「哪些能力已真实实现、哪些还没达标」变成可执行的断言，而不是文档里的一句话。
 * 这个脚本只做确定性本地检查，不启动服务、不联网、不调用任何 provider、不生成标注数据。
 *
 * 退出码：
 *  - 任何自检断言失败 → 1（CI 必须红）
 *  - 断言全绿但发布条件未满足 → 0，并明确打印 releaseBlocked=true 与阻断项
 *  - LEADPILOT_REQUIRE_BASELINE=1 时，发布条件未满足也 → 1（用于真正卡发布）
 */
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { protocol } from '../server/protocol.mjs'
import { createLedger } from '../server/ledger.mjs'
import { createMemoryStore, createStore } from '../server/store.mjs'
import { evaluateBaseline, baselineManifest, diffEvalRuns } from '../server/eval.mjs'
import { createOrchestrator } from '../server/orchestrator.mjs'
import { validateBaselineImport } from '../server/baseline.mjs'
import { extractFacts, reconcileWithT0 } from '../server/t0.mjs'
import { createDataSourceRegistry } from '../server/data-sources.mjs'
import {
  createBatchPipeline, validateRows, checkExportGates, buildMbox,
  computeBounceRate, normalizeDomain, BATCH_VERSION,
} from '../server/batch.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const results = []
let failed = 0

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  if (!ok) failed++
}

function walkTs(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walkTs(p, out)
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p)
  }
  return out
}

// 1. 前端服务层边界：业务代码只能从 adapters.ts 取能力
{
  const files = [
    ...walkTs(join(ROOT, 'src/components')),
    ...walkTs(join(ROOT, 'src/store')),
    join(ROOT, 'src/App.tsx'),
  ].filter(existsSync)
  const direct = /from\s+['"]@\/services\/(gateway-client|task-runner|email-generator)['"]/g
  const offenders = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    if (direct.test(text)) offenders.push(f.slice(ROOT.length + 1))
    direct.lastIndex = 0
  }
  check('业务层不直接 import 具体服务实现（统一走 adapters）', offenders.length === 0,
    offenders.length ? `违规：${offenders.join(', ')}` : `${files.length} 个文件已检查`)

  const adapters = readFileSync(join(ROOT, 'src/services/adapters.ts'), 'utf8')
  const reExports = ['./gateway-client', './task-runner', './email-generator']
    .every((m) => adapters.includes(`export * from '${m}'`))
  check('adapters.ts 统一 re-export 三个服务实现', reExports)
}

// 2. 基准集契约：校验器必须拒绝反例、拒绝空集，评测无数据必须 NO_DATA
{
  const fixture = JSON.parse(readFileSync(join(ROOT, 'scripts/fixtures/invalid-baseline-sample.json'), 'utf8'))
  const invalid = validateBaselineImport(fixture)
  check('导入校验器拒绝非法反例（E4004）',
    !invalid.ok && invalid.code === 'E4004' && invalid.errorCount > 0,
    `errors=${invalid.errorCount}`)
  check('导入校验器拒绝空基准集', validateBaselineImport({ samples: [] }).ok === false)
  check('导入校验器拒绝合成/凑数的 385 行占位数据',
    invalid.errors.some((e) => /样本数/.test(e)), '样本数不符必须报错')

  const evalEmpty = evaluateBaseline([])
  check('无标注样本时评测返回 NO_DATA 且 ok=false',
    evalEmpty.status === 'NO_DATA' && evalEmpty.ok === false)
  const manifest = baselineManifest()
  check('基准集 manifest 如实标注 NOT_LABELED / 不可发布',
    manifest.status === 'NOT_LABELED' && manifest.releaseEligible === false && manifest.contractVersion === 'baseline-contract-v1',
    `importStatus=${manifest.importStatus}`)
  const contract = JSON.parse(readFileSync(join(ROOT, 'shared/baseline-contract.json'), 'utf8'))
  check('契约要求 385 家且禁止研发兼任标注',
    contract.baselineSize === 385 && contract.annotatorPolicy.developerMayAnnotate === false)
}

// 3. 点数账本：幂等 / 余额守恒 / 不足拒绝 / 结算释放互斥 / 跨进程恢复
{
  const ledger = createLedger({ store: createMemoryStore(), openingBalance: 100 })
  const initial = ledger.state()
  const r1 = ledger.reserve({ refId: 't1', amount: 40 })
  const r2 = ledger.reserve({ refId: 't1', amount: 40 })
  const conflict = ledger.reserve({ refId: 't1', amount: 41 })
  const insufficient = ledger.reserve({ refId: 't2', amount: 61 })
  check('预扣扣的是冻结额，可用额同步下降',
    r1.ok && r1.held === 40 && initial.available - r1.available === 40)
  check('同一 refId 重复预扣幂等，不二次冻结',
    r2.ok && r2.idempotent === true && ledger.state().held === 40)
  check('同 key 不同金额被 E4002 拒绝', conflict.ok === false && conflict.code === 'E4002')
  check('余额不足被 E4001 拒绝且不产生冻结',
    insufficient.ok === false && insufficient.code === 'E4001' && ledger.state().held === 40)

  const s1 = ledger.settle({ refId: 't1', amount: 25 })
  const s2 = ledger.settle({ refId: 't1', amount: 25 })
  check('结算实扣 25 / 退还 15，且幂等',
    s1.ok && s1.charged === 25 && s1.refunded === 15 && s2.idempotent === true)
  check('已结算任务不允许重复释放', ledger.release({ refId: 't1' }).code === 'E4003')
  check('无预扣任务不允许结算', ledger.settle({ refId: 'never', amount: 1 }).code === 'E4003')

  ledger.reserve({ refId: 't3', amount: 10 })
  const rel = ledger.release({ refId: 't3' })
  check('未启动任务全额释放且幂等',
    rel.ok && rel.refunded === 10 && ledger.release({ refId: 't3' }).idempotent === true)

  const st = ledger.state()
  check('账本恒等式 available + held + spent = granted',
    st.available + st.held + st.spent === st.granted && st.available >= 0,
    `${st.available}+${st.held}+${st.spent}=${st.granted}`)

  const tmpRoot = join(ROOT, '.tmp')
  mkdirSync(tmpRoot, { recursive: true })
  const dir = mkdtempSync(join(tmpRoot, 'gate-ledger-'))
  const dbPath = join(dir, 'ledger.json')
  try {
    const l1 = createLedger({ store: createStore({ mode: 'json', dbPath }), openingBalance: 80 })
    l1.reserve({ refId: 'restart-1', amount: 30 })
    const before = l1.state()
    const l2 = createLedger({ store: createStore({ mode: 'json', dbPath }), openingBalance: 80 })
    const after = l2.state()
    const again = l2.reserve({ refId: 'restart-1', amount: 30 })
    check('账本跨「进程重启」不丢预扣、不重复扣',
      after.held === before.held && after.available === before.available && again.idempotent === true,
      `held=${after.held} available=${after.available}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  check('账本 scope 与网关消费方显式列明，未注入账本时不得宣称已扣点',
    protocol.billing.ledger.scope.length === 6
    && protocol.billing.ledger.scope.includes('gateway_reserve')
    && protocol.billing.ledger.ledgerConsumers.includes('judge')
    && protocol.billing.ledger.ledgerConsumers.includes('write_email')
    && protocol.billing.ledger.auditOnlyConsumers.length === 0
    && protocol.billing.gatewayBilling.chargeOn === 'schema_and_content_validation_passed'
    && protocol.billing.gatewayBilling.releaseOn.includes('degraded')
    && protocol.billing.gatewayBilling.noChargeOn.includes('cache_hit'))
}

// 4. T0 → judge 事实链：引用逐字可核验，冲突由代码保守裁决
{
  const text = 'Authorized distributor for Parker fittings across Benelux. We import hydraulic hose fittings from Asia. Team of 23 employees supports local stock.'
  const doc = { url: 'https://gate.example/about', text, fetched_at: '2026-11-08' }
  const t0 = extractFacts({ company_id: 'gate_1', sources: [doc], keywords: ['hydraulic hose fittings'] })
  check('T0 抽取只产出原文连续子串引用',
    t0.ok && t0.extractor === 'rules' && t0.evidence.length > 0 && t0.evidence.every((e) => text.includes(e.quote)),
    `evidence=${t0.evidence?.length ?? 0} coverage=${t0.coverage?.rate ?? 0}`)

  const judgement = {
    company_id: 'gate_1',
    customer_type: { value: 'retailer', confidence: 0.9, evidence: [{ quote: text.slice(0, 40), source_url: doc.url, fetched_at: doc.fetched_at }] },
    import_signal: { value: 'contradicted', confidence: 0.9, evidence: [{ quote: text.slice(0, 40), source_url: doc.url, fetched_at: doc.fetched_at }] },
    size_estimate: { tier: 'XL', confidence: 0.9, evidence: [{ quote: text.slice(0, 40), source_url: doc.url, fetched_at: doc.fetched_at }] },
    negative_flags: [],
  }
  const rec = reconcileWithT0(judgement, t0)
  check('规则/模型冲突时代码保守取规则值且置信度归零',
    rec.applied && rec.conflicts.length > 0
    && Object.values(judgement).every((v) => typeof v !== 'object' || v === null || !('confidence' in v) || v.confidence === 0),
    `conflicts=${rec.conflicts.length} overrides=${rec.overrides.join(',')}`)
  check('T0 事实链开关与冲突策略已固化',
    protocol.judgeFactChain.enabled === true && protocol.judgeFactChain.onConflict === 'rules-win-zero-confidence')
}

// 5. 数据源注册表：如实报告未接入，绝不半接入
{
  const ds = createDataSourceRegistry().health()
  check('数据源注册表如实报告 0/6 已接入',
    ds.total === 6 && ds.readyCount === 0 && ds.mode === 'demo',
    `${ds.readyCount}/${ds.total} · ${ds.mode}`)
}

// 6. v0.6.0：评测 diff / 并发队列必须是真实实现，不能退回占位说明
{
  const archive = (over = {}) => ({
    ok: true, status: 'PASSED', baselineVersion: 'gate-fixture', sampleSize: 385,
    metrics: {
      provenance_rate: 0.97, signal_precision: 0.93, extraction_recall: 0.8,
      rule_compliance: 1, kappa: 0.72, spearman_rho: 0.81,
      schema_pass_rate: 0.995, refusal_rate: 0.02,
    },
    ...over,
  })
  const up = diffEvalRuns(archive(), archive({ baselineVersion: 'gate-fixture-2', metrics: { ...archive().metrics, provenance_rate: 0.99 } }))
  const down = diffEvalRuns(archive(), archive({ status: 'BLOCKED', ok: false, metrics: { ...archive().metrics, provenance_rate: 0.90 } }))
  check('评测版本 diff 为可执行纯函数：改善可核验、P0 回退被拦截',
    up.diffPassed === true && up.rows.find((r) => r.key === 'provenance_rate').delta === 0.02
    && down.status === 'REGRESSION' && down.p0Regressions.includes('provenance_rate'),
    `up=${up.status} down=${down.status}`)
  check('diff 通过仍不解除发布门禁，且 NO_DATA 不伪造 delta',
    up.releaseEligible === false
    && diffEvalRuns({ status: 'NO_DATA', metrics: {} }, archive()).status === 'NO_BASELINE'
    && diffEvalRuns({ status: 'NO_DATA', metrics: {} }, archive()).rows.every((r) => r.delta === null),
    `releaseEligible=${up.releaseEligible}`)
  check('源码中不再残留「需在 CI 中读取历史评测归档」占位字符串',
    !readFileSync(join(ROOT, 'server/eval.mjs'), 'utf8').includes('需在 CI'),
    'server/eval.mjs')

  const o = createOrchestrator({ tickMs: 10000, maxConcurrent: 1 })
  const cfg = { keywords: ['gate queue'], markets: ['德国'], depth: 1, targetCount: 10 }
  const t1 = o.createTask(cfg)
  const t2 = o.createTask(cfg)
  const stuckBefore = t2.status === 'queued' && o.getTask(t2.id).queuePosition === 1
  o.abort(t1.id)
  const dequeued = o.getTask(t2.id).status === 'running' && o.getTask(t2.id).queuePosition === 0
  check('并发队列 FIFO 自动出队，queued 不会永久卡死', stuckBefore && dequeued,
    `before=${t2.status} after=${o.getTask(t2.id).status}`)
  o.dispose()
}

// 7. v0.7.0：批量 SDR 管道不得改定位、不得伪造采集/发送，且发布门禁一条不撤
{
  const bp = protocol.batchPipeline
  check('v0.7.0 产品定位锁定自动获客 / 批量 SDR，内测阶段不等于可发布',
    BATCH_VERSION === 'batch-pipeline-v1'
    && bp.positioning === 'auto_prospecting' && bp.targetUser === 'bulk_sdr'
    && bp.stage === 'internal_preview' && baselineManifest().releaseEligible === false,
    `${bp.positioning}/${bp.targetUser}/${bp.stage}`)

  const rows = validateRows([
    { company_name: 'Acme', domain: 'https://WWW.Acme.example:443/about', contact_email: 'a@acme.example' },
    { company_name: 'Acme dup', domain: 'acme.example' },
    { company_name: 'Fake', domain: 'fake.example', origin: 'system_collected' },
    { company_name: 'Bad', domain: 'not-a-domain' },
  ], { existingDomains: new Set() })
  check('批量导入：origin 恒 user_imported，伪称系统采集与非法行被逐条拒绝且不留沉默丢弃',
    rows.accepted.length === 1 && rows.accepted[0].origin === bp.import.origin
    && rows.accepted[0].piiFields.includes('contact_email')
    && rows.rejected.some((r) => r.reason.includes('伪称系统采集'))
    && rows.duplicates.length === 1,
    `accepted=${rows.accepted.length} rejected=${rows.rejected.length} dup=${rows.duplicates.length}`)
  check('域名规范化去 scheme / www / 端口 / 路径',
    normalizeDomain('https://WWW.Acme.example:443/about?x=1') === 'acme.example')

  const store = createMemoryStore()
  const pipeline = createBatchPipeline({ store, gateway: null })
  const imported = pipeline.importCompanies({ rows: [{ company_name: 'Acme', domain: 'acme.example' }] })
  check('导入 ≠ 采集：响应带 origin 与明确说明，客户库不宣称系统抓取',
    imported.ok && imported.origin === 'user_imported' && /导入 ≠ 采集/.test(imported.note))

  const judged = await pipeline.runJudgeBatch({ batchSize: 1 })
  check('无 provider 时批量研判如实降级，T0 规则结果不伪装成模型判断',
    judged.ok && judged.summary.succeeded === 0 && judged.items[0].codes.includes('E6005')
    && judged.items[0].modelJudgement === null
    && pipeline.state().judged === 0,
    `succeeded=${judged.summary?.succeeded} degraded=${judged.summary?.degraded}`)

  const sender = {
    name: 'Wu Jiaqi', email: 'sales@example.com', company: 'Example Trading Co',
    postalAddress: 'Room 301, 12 Industrial Road, Shenzhen, China',
    unsubscribe: 'Reply STOP to unsubscribe / 退订',
  }
  const footer = [sender.name, sender.company, sender.postalAddress, sender.unsubscribe].join(' | ')
  const draft = (over = {}) => ({
    domain: 'acme.example', to: 'buyer@acme.example', subject: 'Hydraulic fittings supply',
    body: 'We noticed your company distributes industrial fittings across Benelux. We manufacture hydraulic hose fittings and can share our current catalogue and lead times. Would a short specification sheet be useful for your team this quarter?',
    grade: 'B', sender, footer, ...over,
  })
  const gates = checkExportGates([draft({ grade: 'D' }), draft({ grade: 'C' }), draft({ footer: '' }), draft()])
  check('导出闸门：D 级禁发 / C 级需逐条确认 / 合规尾巴缺失，且只放行合规草稿',
    gates.allowed.length === 1 && gates.blocked.length === 3
    && /D 级/.test(gates.blocked[0].reasons.join())
    && /人工确认/.test(gates.blocked[1].reasons.join()),
    `allowed=${gates.allowed.length} blocked=${gates.blocked.length}`)
  const mbox = buildMbox(gates.allowed, { now: Date.UTC(2026, 10, 9) })
  check('mbox 显式标注 drafted / user_imported / exported-not-sent，绝不冒充已发送',
    mbox.includes('X-LeadPilot-Status: drafted')
    && mbox.includes('X-LeadPilot-Origin: user_imported')
    && mbox.includes('exported-not-sent'))

  const exported = pipeline.exportDrafts({ items: [draft()] })
  const outcomes = pipeline.importOutcomes({ events: [
    { domain: 'acme.example', event: 'sent' }, { domain: 'acme.example', event: 'bounced' },
  ] })
  check('导出 ≠ 发送：导出不进退信率，结果回写超 3% 立即熔断并阻断后续导出',
    exported.ok && exported.exportedIsNotSent === true
    && pipeline.state().exportedToday === 1
    && computeBounceRate([]).rate === null
    && outcomes.state.bounce.rate === 0.5 && outcomes.state.circuitOpen === true
    && pipeline.exportDrafts({ items: [draft()] }).code === 'E4010',
    `bounce=${outcomes.state.bounce.rate} circuit=${outcomes.state.circuitOpen}`)

  // 前后端白名单必须同源，避免服务端悄悄放开自动流转
  const constants = readFileSync(join(ROOT, 'src/domain/constants.ts'), 'utf8')
  const stateMachine = readFileSync(join(ROOT, 'src/domain/state-machine.ts'), 'utf8')
  const autoList = constants.match(/AUTOMATIC_TRANSITIONS[^=]*=\s*\[([^\]]+)\]/)?.[1]
    ?.split(',').map((s) => s.replace(/['"\s]/g, '')).filter(Boolean) ?? []
  const autoEvent = Object.fromEntries(
    [...stateMachine.matchAll(/^\s*(\w+):\s*'(\w+)'/gm)].map((m) => [m[1], m[2]]),
  )
  const serverMap = bp.outcomes.autoTransitions
  check('服务端自动流转白名单与前端 state-machine / constants 完全一致',
    autoList.length === 4 && autoList.every((s) => Object.values(serverMap).includes(s))
    && Object.entries(serverMap).every(([k, v]) => autoEvent[k] === v),
    `front=[${autoList.join(',')}] server=[${Object.values(serverMap).join(',')}]`)

  const pm = readFileSync(join(ROOT, 'docs/PM-REVIEW.md'), 'utf8')
  check('Go / No-Go 四条外部判据一条未撤（标注员 / OAuth / 数据源合同 / EV 签名）',
    /385 家基准集标注启动/.test(pm) && /OAuth/.test(pm)
    && /数据源合同/.test(pm) && /EV 签名/.test(pm)
    && bp.export.forbidDirectSend === true)
}

const width = Math.max(...results.map((r) => r.name.length))
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`)
console.log(`\n${results.length - failed}/${results.length} gate self-checks passed`)

const ds = createDataSourceRegistry().health()
const blockers = [
  `385 家人工标注基准集：${baselineManifest().importStatus}（releaseEligible=false）`,
  `真实数据源：${ds.readyCount}/${ds.total} 已接入`,
  'provider 模型快照需运行时注入 LEADPILOT_MODEL_VERSION_*（未锁即 E6008）',
  'Google OAuth / CASA Tier 2 / 数据源采购 / 30 封真实开发信人工复核：未开始',
]
console.log('\n发布门禁状态：releaseBlocked = true')
for (const b of blockers) console.log(`  BLOCKED  ${b}`)
console.log('说明：以上为「尚未达标」，不是失败。自检全绿只证明边界没被伪造，不证明产品可发布。')
console.log('v0.7.0 补充：批量 SDR 管道定位仍为 auto_prospecting，当前阶段 internal_preview（内测可跑）。四项外部依赖从「阻塞研发」重分类为「发布门禁」，判据本身一条未撤。')

if (failed) {
  console.error(`\nGATE FAILED：${failed} 项自检断言失败，CI 必须红。`)
  process.exit(1)
}
if (process.env.LEADPILOT_REQUIRE_BASELINE === '1') {
  console.error('\nGATE FAILED：LEADPILOT_REQUIRE_BASELINE=1 但发布阻断项未解除。')
  process.exit(1)
}
console.log('\nGATE OK：自检断言全绿；发布仍被上述阻断项明确卡住（符合预期）。')
