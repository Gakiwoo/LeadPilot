/**
 * 发布门禁自检 · v0.8.0
 *
 * 目的：把「哪些能力已真实实现、哪些还没达标」变成可执行的断言，而不是文档里的一句话。
 * 这个脚本只做确定性本地检查，不启动服务、不联网、不调用任何 provider、不生成标注数据。
 *
 * v0.8.0 决策：不做 385 家人工标注基准集、不做商业数据源采购。
 *  - 标注契约降级为 legacy（格式与校验器保留），不再作为发布前置；
 *  - 评测口径改为 integrity + outcome（零人工），accuracyClaim 恒 false；
 *  - 门禁会静态扫描产品文案，禁止无标注却宣称准确率。
 *
 * 退出码：
 *  - 任何自检断言失败 → 1（CI 必须红）
 *  - 断言全绿但外部验证条件未满足 → 0，并明确打印 releaseBlocked=true 与阻断项
 *  - LEADPILOT_REQUIRE_BASELINE=1 时，外部验证条件未满足也 → 1（用于真正卡发布）
 */
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { protocol } from '../server/protocol.mjs'
import { createLedger } from '../server/ledger.mjs'
import { createMemoryStore, createStore } from '../server/store.mjs'
import {
  evaluateBaseline, baselineManifest, diffEvalRuns,
  evaluateIntegrity, evaluateOutcome, evaluateConsistency, releaseStatus,
  integrityManifest, outcomeManifest,
} from '../server/eval.mjs'
import { createOrchestrator } from '../server/orchestrator.mjs'
import { validateBaselineImport } from '../server/baseline.mjs'
import { extractFacts, reconcileWithT0 } from '../server/t0.mjs'
import { createDataSourceRegistry } from '../server/data-sources.mjs'
import {
  createBatchPipeline, validateRows, checkExportGates, buildMbox,
  computeBounceRate, normalizeDomain, BATCH_VERSION,
} from '../server/batch.mjs'
import {
  createFetcher, FETCH_VERSION as FETCH_GATE_VERSION, FETCH_ORIGIN as FETCH_GATE_ORIGIN,
} from '../server/fetch.mjs'

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

// 0. 类型严格性：noUncheckedIndexedAccess 必须保持开启
//    这条断言存在的原因很具体：`contacts[0]` / `tasks[0]` 这类索引访问在关闭该选项时
//    会被静默推断为非空，曾经导致「客户没有联系人」时直接读 undefined.value 抛错的隐患。
{
  const tsconfig = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8'))
  const co = tsconfig.compilerOptions ?? {}
  check('类型严格性：strict + noUncheckedIndexedAccess 保持开启（索引访问必须显式判空）',
    co.strict === true && co.noUncheckedIndexedAccess === true,
    `strict=${co.strict} noUncheckedIndexedAccess=${co.noUncheckedIndexedAccess}`)
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
  check('无标注样本时 legacy 评测返回 NO_DATA 且 ok=false',
    evalEmpty.status === 'NO_DATA' && evalEmpty.ok === false)
  const manifest = baselineManifest()
  check('标注契约降级为 legacy：不做 385 标注也保持诚实',
    manifest.status === 'NOT_LABELED' && manifest.releaseEligible === false
    && manifest.contractVersion === 'baseline-contract-v1'
    && manifest.legacy === true && manifest.labelsRequired === false && manifest.accuracyClaim === false,
    `importStatus=${manifest.importStatus}`)
  const contract = JSON.parse(readFileSync(join(ROOT, 'shared/baseline-contract.json'), 'utf8'))
  check('legacy 契约保留双人独立标注约束（不删除、不伪造）',
    contract.status === 'legacy' && contract.enabled === false
    && contract.baselineSize === 385 && contract.annotatorPolicy.developerMayAnnotate === false)
}

// 2b. v0.8.0 决策：不做人工标注集，评测口径改为 integrity + outcome（零人工、永不宣称准确率）
{
  const ig = integrityManifest()
  const og = outcomeManifest()
  check('integrity / outcome 门禁契约：零标注、不宣称准确率',
    ig.gateVersion === 'integrity-gate-v1' && ig.labelsRequired === false
    && ig.accuracyClaim === false && ig.minSamples >= 1
    && og.gateVersion === 'outcome-gate-v1' && og.labelsRequired === false,
    `${ig.gateVersion} / ${og.gateVersion}`)

  const emptyIntegrity = evaluateIntegrity([])
  check('integrity 门禁无真实证据时返回 NO_DATA，不拿合成样本凑 PASSED',
    emptyIntegrity.status === 'NO_DATA' && emptyIntegrity.ok === false
    && emptyIntegrity.accuracyClaim === false,
    `status=${emptyIntegrity.status}`)

  const evidence = (i) => ({
    provenance: { matched: 1, total: 1 },
    rules: { passed: 2, total: 2 },
    schemaPass: true,
    refused: false,
    quote: `we import fittings ${i}`,
    sourceText: `api: we import fittings ${i} from asia`,
  })
  const consistent = evaluateConsistency([{ a: 1 }, { b: 2 }], [{ a: 1 }, { b: 2 }])
  const goodIntegrity = evaluateIntegrity(
    Array.from({ length: ig.minSamples }, (_, i) => evidence(i)),
    { consistency: consistent },
  )
  check('integrity 门禁：证据全核验 + 一致性达标 → PASSED（仅表示可内测）',
    goodIntegrity.status === 'PASSED' && goodIntegrity.ok === true
    && goodIntegrity.metrics.provenance_rate === 1
    && goodIntegrity.metrics.evidence_quote_rate === 1
    && goodIntegrity.accuracyClaim === false,
    `sampleSize=${goodIntegrity.sampleSize} p0Failures=${goodIntegrity.p0Failures.length}`)

  const badIntegrity = evaluateIntegrity(
    Array.from({ length: ig.minSamples }, () => ({
      provenance: { matched: 0, total: 1 },
      rules: { passed: 2, total: 2 },
      schemaPass: true,
      refused: false,
      quote: 'this quote is not in the source text',
      sourceText: 'api: unrelated text',
    })),
    { consistency: evaluateConsistency([{ a: 1 }], [{ a: 2 }]) },
  )
  check('integrity 门禁：可溯源率 / 逐字核验 / 一致性失败 → BLOCKED',
    badIntegrity.status === 'BLOCKED' && badIntegrity.ok === false
    && badIntegrity.p0Failures.length >= 2,
    `fails=${badIntegrity.p0Failures.join('；')}`)

  const smallIntegrity = evaluateIntegrity([evidence(0)], { consistency: consistent })
  check('integrity 门禁：样本数不足不判 PASSED（不拿小样本凑）',
    smallIntegrity.ok === false && smallIntegrity.sampleTooSmall === true)

  check('outcome 门禁无真实发送样本时返回 NO_DATA',
    evaluateOutcome([]).status === 'NO_DATA' && evaluateOutcome([]).ok === false)
  const sent = (n) => Array.from({ length: n }, () => 'sent')
  const goodOutcome = evaluateOutcome([...sent(40), 'replied'])
  check('outcome 门禁：真实退信率达标 → PASSED（只证明业务结果，不是准确率）',
    goodOutcome.status === 'PASSED' && goodOutcome.ok === true
    && goodOutcome.metrics.bounce_rate === 0 && goodOutcome.accuracyClaim === false)
  const badOutcome = evaluateOutcome([...sent(40), 'bounced', 'bounced'])
  check('outcome 门禁：退信率超 3% → BLOCKED',
    badOutcome.status === 'BLOCKED' && badOutcome.ok === false
    && badOutcome.p0Failures.some((f) => f.includes('硬退信率')))
  const insufficient = evaluateOutcome(sent(10))
  check('outcome 门禁：样本不足标 INSUFFICIENT，不宣告通过',
    insufficient.ok === false && insufficient.status === 'INSUFFICIENT')

  const release = releaseStatus({ integrity: goodIntegrity, outcome: goodOutcome })
  check('发布状态三分离：内测可 / 外部已验证 / 正式发布仍 false，且永不宣称准确率',
    release.internalPreviewReady === true && release.externalValidated === true
    && release.releaseEligible === false && release.accuracyClaim === false
    && Array.isArray(release.remainingExternalBlockers) && release.remainingExternalBlockers.length > 0,
    `internal=${release.internalPreviewReady} external=${release.externalValidated}`)
}

// 2c. 禁止准确率宣称：没有人工标注就没有 accuracy，产品文案不得出现准确率数字断言
{
  const forbidden = protocol.evalGates.integrity.accuracyClaimForbiddenPatterns ?? []
  const patterns = forbidden.map((p) => new RegExp(p))
  const files = [
    join(ROOT, 'README.md'),
    ...walkTs(join(ROOT, 'src')),
  ].filter(existsSync)
  const offenders = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    for (const r of patterns) {
      const m = text.match(r)
      if (m) { offenders.push(`${f.slice(ROOT.length + 1)}: ${m[0]}`); break }
    }
  }
  check('产品文案不得宣称准确率（无标注即无准确率）',
    offenders.length === 0,
    offenders.length ? `违规：${offenders.join(' | ')}` : `${files.length} 个文件已扫描 · ${patterns.length} 条禁用模式`)
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

// 5b. v0.9.0 用户指定 URL 抓取：robots 遵从 / 限速 / 拒绝私网 / 抓取 ≠ 采集
{
  const fp = protocol.fetchPolicy
  check('抓取契约：只抓用户指定 URL、robots 遵从、每域限速、拒绝私网',
    FETCH_GATE_VERSION === 'user-directed-fetch-v1'
    && FETCH_GATE_ORIGIN === 'user_directed_fetch'
    && fp.respectRobots === true
    && fp.perDomainMinIntervalMs >= 500
    && fp.ssrf.blockPrivate === true
    && fp.ssrf.blockLoopback === true
    && fp.forbiddenOrigins.includes('system_collected'),
    `${FETCH_GATE_VERSION} · interval=${fp.perDomainMinIntervalMs}ms`)

  const calls = []
  const fakeFetch = async (url) => {
    calls.push(String(url))
    return new Response('User-agent: *\nDisallow: /private\n', { status: 200, headers: { 'content-type': 'text/plain' } })
  }
  const fetcher = createFetcher({
    fetchImpl: fakeFetch,
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
    now: () => 1_000_000,
    sleep: async () => {},
  })
  const ssrfLiteral = await fetcher.fetchOne('http://127.0.0.1/secret')
  const ssrfLoopback = await fetcher.fetchOne('https://localhost/')
  check('抓取器拒绝回环 / 私网地址，且不发起任何请求（SSRF）',
    ssrfLiteral.ok === false && ssrfLiteral.code === 'E4011'
    && ssrfLoopback.ok === false && ssrfLoopback.code === 'E4011'
    && calls.length === 0,
    `calls=${calls.length}`)

  // robots 命中 Disallow 时禁止抓取：robots URL 返回禁止规则，目标页不应被请求
  const robotsCalls = []
  const robotsFetcher = createFetcher({
    fetchImpl: async (url) => {
      robotsCalls.push(String(url))
      if (String(url).endsWith('/robots.txt')) {
        return new Response('User-agent: *\nDisallow: /private\n', { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      return new Response('<html><body>should not be fetched</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    },
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
    now: () => 1_000_000,
    sleep: async () => {},
  })
  const blockedByRobots = await robotsFetcher.fetchOne('https://public.example/private/page')
  check('robots.txt 命中 Disallow → E4013，目标页不被抓取',
    blockedByRobots.ok === false && blockedByRobots.code === 'E4013'
    && robotsCalls.length === 1 && robotsCalls[0] === 'https://public.example/robots.txt',
    `calls=${robotsCalls.length}`)

  const shown = await fetcher.fetchMany(['https://public.example/about'])
  check('批量抓取逐条返回，成功项标 origin=user_directed_fetch（抓取 ≠ 采集）',
    shown.origin === FETCH_GATE_ORIGIN
    && (shown.fetched.length + shown.failed.length) === 1
    && shown.note.includes('抓取 ≠ 采集'),
    `fetched=${shown.fetched.length} failed=${shown.failed.length} origin=${shown.origin}`)

  // 批量管道：抓取成功写回原文，公司 origin 仍是 user_imported
  const store = createMemoryStore()
  const pipeline = createBatchPipeline({
    store, gateway: null,
    fetcher: {
      version: FETCH_GATE_VERSION,
      origin: FETCH_GATE_ORIGIN,
      health: () => ({ counters: { fetched: 1, failed: 0, robotsBlocked: 0, ssrfBlocked: 0, lastFetchAt: null } }),
      fetchMany: async (urls) => ({
        ok: true, version: FETCH_GATE_VERSION, origin: FETCH_GATE_ORIGIN,
        fetched: [{
          ok: true, url: new URL(urls[0]).href, finalUrl: new URL(urls[0]).href,
          fetchedAt: '2026-11-09T00:00:00.000Z', text: 'We import hydraulic fittings.',
          textChars: 30, hash: 'gate-hash', truncated: false, piiRemoved: 0,
        }],
        failed: [], summary: { requested: 1, fetched: 1, failed: 0 },
      }),
    },
  })
  pipeline.importCompanies({ rows: [{ company_name: 'Gate Acme', domain: 'gate-acme.example' }] })
  const fetchedResult = await pipeline.fetchSources({ limit: 5 })
  const gateCompany = store.companyGet('gate-acme.example')
  check('批量抓取：原文标 user_directed_fetch，公司 origin 仍 user_imported（抓取 ≠ 采集）',
    fetchedResult.ok === true && fetchedResult.sourceOrigin === FETCH_GATE_ORIGIN
    && gateCompany.origin === 'user_imported'
    && gateCompany.sourceOrigin === FETCH_GATE_ORIGIN
    && String(gateCompany.rawText ?? '').includes('hydraulic')
    && fetchedResult.note.includes('抓取 ≠ 采集'),
    `origin=${gateCompany.origin} sourceOrigin=${gateCompany.sourceOrigin}`)

  const arch = readFileSync(join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8')
  const pmDoc = readFileSync(join(ROOT, 'docs/PM-REVIEW.md'), 'utf8')
  check('文档固化：ADR-032 + 用户指定抓取口径在场',
    /ADR-032/.test(arch) && /user_directed_fetch/.test(arch)
    && /用户指定/.test(pmDoc),
    'docs/ARCHITECTURE.md · docs/PM-REVIEW.md')
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

  // B3-0：上面是静态同源检查；服务端真正执行的是 allowedEvents，只读常量会给假保证。
  // 下面直接调用实现：非法事件被拒、终态未确认被拒、合法事件被接受，改坏实现 CI 必须红。
  const behaviorStore = createMemoryStore()
  const behaviorPipeline = createBatchPipeline({ store: behaviorStore, gateway: null })
  behaviorPipeline.importCompanies({ rows: [{ company_name: 'Gate', domain: 'gate.example' }] })
  const illegalEvent = behaviorPipeline.importOutcomes({ events: [{ domain: 'gate.example', event: 'drafted' }] })
  const noConfirm = behaviorPipeline.importOutcomes({ events: [{ domain: 'gate.example', event: 'unsubscribed' }] })
  const legalEvent = behaviorPipeline.importOutcomes({ events: [{ domain: 'gate.example', event: 'sent' }] })
  check('服务端 outcomes 按 allowedEvents 真实执行（行为级，不抄常量）',
    !bp.outcomes.allowedEvents.includes('drafted')
    && illegalEvent.rejected.length === 1 && /不在白名单/.test(illegalEvent.rejected[0].reasons.join())
    && noConfirm.rejected.length === 1 && /逐条人工确认/.test(noConfirm.rejected[0].reasons.join())
    && legalEvent.applied.length === 1 && legalEvent.applied[0].to === 'sent',
    `illegal=${illegalEvent.rejected.length} noConfirm=${noConfirm.rejected.length} legal=${legalEvent.applied.length}`)

  // B3-0（假设 #4）：G2 黑名单 / 退订必须在服务端导出链也生效，不能只靠前端自觉
  const g2Store = createMemoryStore()
  const g2Pipeline = createBatchPipeline({ store: g2Store, gateway: null })
  g2Pipeline.importCompanies({ rows: [{ company_name: 'G2', domain: 'g2.example' }] })
  const g2Draft = draft({ domain: 'g2.example', to: 'buyer@g2.example' })
  const listBlocked = g2Pipeline.exportDrafts({ items: [g2Draft], blacklist: ['buyer@g2.example'] })
  g2Pipeline.importOutcomes({ events: [{ domain: 'g2.example', event: 'unsubscribed', confirmed: true }] })
  const terminalBlocked = g2Pipeline.exportDrafts({ items: [g2Draft] })
  check('导出链 G2：黑名单与退订终态在服务端硬拦，直接调 API 也绕不过去',
    listBlocked.ok === false && /G2/.test(JSON.stringify(listBlocked.blocked ?? []))
    && terminalBlocked.ok === false && /G2|终态/.test(JSON.stringify(terminalBlocked.blocked ?? [])),
    `list=${listBlocked.blocked?.length ?? 0} terminal=${terminalBlocked.blocked?.length ?? 0}`)

  // B3-2（P2）：状态机不能任意回退，约束必须真实执行（不是只读协议常量）
  const monoStore = createMemoryStore()
  const mono = createBatchPipeline({ store: monoStore, gateway: null })
  mono.importCompanies({ rows: [{ company_name: 'Mono', domain: 'mono.example' }] })
  const earlyBounce = mono.importOutcomes({ events: [{ domain: 'mono.example', event: 'bounced' }] })
  mono.importOutcomes({ events: [{ domain: 'mono.example', event: 'sent' }] })
  const monoReplied = mono.importOutcomes({ events: [{ domain: 'mono.example', event: 'replied' }] })
  const rollback = mono.importOutcomes({ events: [{ domain: 'mono.example', event: 'sent' }] })
  check('结果回写单向流转（行为级）：new→bounced 与 replied→sent 被拒，合法链可回写',
    bp.outcomes.allowedEvents.every((e) => Array.isArray(bp.outcomes.allowedFrom?.[e]))
    && earlyBounce.rejected.length === 1 && /状态不可回退/.test(earlyBounce.rejected[0].reasons.join())
    && monoReplied.applied.length === 1
    && rollback.rejected.length === 1 && /状态不可回退/.test(rollback.rejected[0].reasons.join())
    && monoStore.companyGet('mono.example').status === 'replied',
    `early=${earlyBounce.rejected.length} replied=${monoReplied.applied.length} rollback=${rollback.rejected.length}`)

  // B3-2（P2）：恢复日志幂等 + recoveredActiveIds 语义（行为级）
  const restartStore = createMemoryStore()
  const r1 = createOrchestrator({ store: restartStore, tickMs: 10000 })
  r1.createTask({ keywords: ['fittings'], markets: ['德国'], depth: 1, targetCount: 10 })
  r1.dispose()
  const r2 = createOrchestrator({ store: restartStore, tickMs: 10000 })
  const log2 = r2.getTask(r2.recoveredIds[0]).progress.log.length
  r2.dispose()
  const r3 = createOrchestrator({ store: restartStore, tickMs: 10000 })
  const log3 = r3.getTask(r3.recoveredIds[0]).progress.log.length
  r3.dispose()
  check('重启恢复幂等（行为级）：连续 hydrate 不重复追加日志，只有首次算本次恢复',
    r2.recoveredActiveIds.length === 1 && r3.recoveredActiveIds.length === 0
    && r3.recoveredIds.length === 1 && log3 === log2,
    `active2=${r2.recoveredActiveIds.length} active3=${r3.recoveredActiveIds.length} log=${log2}/${log3}`)

  // B3-2（P2）：memory / json 账本事务失败回滚（行为级）
  const txStore = createMemoryStore()
  const txLedger = createLedger({ store: txStore, openingBalance: 200 })
  txLedger.state()
  const txBefore = txLedger.peek()
  const txAppend = txStore.ledgerAppend.bind(txStore)
  txStore.ledgerAppend = () => { throw new Error('gate 事务故障注入') }
  let txThrew = false
  try { txLedger.reserve({ refId: 'gate-tx', amount: 30 }) } catch { txThrew = true }
  txStore.ledgerAppend = txAppend
  check('账本事务回滚（行为级）：写入中途失败不留半写状态',
    txThrew && txLedger.peek().held === txBefore.held
    && txLedger.entries('gate-tx').length === 0,
    `threw=${txThrew} held=${txLedger.peek().held}/${txBefore.held}`)

  const pm = readFileSync(join(ROOT, 'docs/PM-REVIEW.md'), 'utf8')
  check('v0.8.0 决策固化：标注集与商业数据源不做；OAuth / EV 仍是发布前置',
    /v0\.8\.0 决策/.test(pm)
    && /不做 385 家人工标注基准集/.test(pm)
    && /不做商业数据源采购/.test(pm)
    && /integrity \+ outcome/.test(pm)
    && /OAuth/.test(pm) && /EV 签名/.test(pm)
    && bp.export.forbidDirectSend === true)
}

const width = Math.max(...results.map((r) => r.name.length))
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`)
console.log(`\n${results.length - failed}/${results.length} gate self-checks passed`)

const ds = createDataSourceRegistry().health()
const emptyIntegrity = evaluateIntegrity([])
const emptyOutcome = evaluateOutcome([])
const release = releaseStatus({ integrity: emptyIntegrity, outcome: emptyOutcome })
const blockers = [
  `integrity 门禁：${emptyIntegrity.status}（暂无真实原文样本，内部预览资格未验证）`,
  `业务结果门禁：${emptyOutcome.status}（无真实发送样本，不得宣称准确率 / 回复率）`,
  '用户指定抓取器已就绪（robots / 限速 / SSRF），但尚无真实站点抓取样本进入 integrity',
  'provider 模型快照需运行时注入 LEADPILOT_MODEL_VERSION_*（未锁即 E6008）',
  'Google OAuth / CASA Tier 2 / EV 代码签名 / PIPL·GDPR 法律意见：未开始',
]
console.log('\n发布门禁状态：releaseBlocked = true · releaseEligible = false · accuracyClaim = false')
for (const b of blockers) console.log(`  BLOCKED  ${b}`)
console.log('说明：以上为「尚未达标」，不是失败。自检全绿只证明边界没被伪造，不证明产品可发布。')
console.log('v0.9.0 抓取：只抓用户显式指定的 URL（robots 遵从 / 每域限速 / 拒绝私网），原文标 user_directed_fetch；抓取 ≠ 采集，商业源仍 0/6。')
console.log('v0.8.0 决策：不做 385 家人工标注基准集、不做商业数据源采购；两项已从阻断项移除（legacy 契约保留、不参与判定）。')
console.log(`  数据源仍如实报 ${ds.readyCount}/${ds.total}（用户投喂 + 用户指定抓取是唯一来源）；评测改看 integrity + outcome，accuracyClaim 恒 false。`)
console.log(`  internalPreviewReady=${release.internalPreviewReady} · externalValidated=${release.externalValidated}`)

if (failed) {
  console.error(`\nGATE FAILED：${failed} 项自检断言失败，CI 必须红。`)
  process.exit(1)
}
if (process.env.LEADPILOT_REQUIRE_BASELINE === '1') {
  console.error('\nGATE FAILED：LEADPILOT_REQUIRE_BASELINE=1 但外部验证条件未解除（integrity / outcome / provider 快照 / OAuth / EV）。')
  process.exit(1)
}
console.log('\nGATE OK：自检断言全绿；发布仍被上述阻断项明确卡住（符合预期）。')
