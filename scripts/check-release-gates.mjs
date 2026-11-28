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
 * B4 修正：末尾的 5 条 BLOCKED 曾经是硬编码字符串，evaluateIntegrity([]) /
 * evaluateOutcome([]) 永远传空数组 —— 真实样本进不了门禁，属于「红得假」。
 * 现在判定走 server/release-evidence.mjs：证据目录 → 校验 → eval.mjs 真实计算 →
 * 快照/合规真实检查 → blockers 由结果生成。REQUIRE_BASELINE 也随之改为验证内测证据。
 *
 * 退出码：
 *  - 任何自检断言失败 → 1（CI 必须红）
 *  - 断言全绿但外部验证条件未满足 → 0，并明确打印 releaseBlocked=true 与真实阻断项
 *  - LEADPILOT_REQUIRE_BASELINE=1 且内测资格证据未达标 → 1；证据达标则放行
 *    （放行只代表「可内测」，releaseEligible 仍恒 false，发布另由外部合规项卡住）
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { protocol } from '../server/core/protocol.mjs'
import { createLedger } from '../server/core/ledger.mjs'
import { createGateway } from '../server/services/gateway.mjs'
import { createMemoryStore, createStore } from '../server/persistence/store.mjs'
import {
  evaluateBaseline, baselineManifest, diffEvalRuns,
  evaluateIntegrity, evaluateOutcome, evaluateConsistency, releaseStatus,
  integrityManifest, outcomeManifest,
} from '../server/core/eval.mjs'
import { createOrchestrator } from '../server/services/orchestrator.mjs'
import { validateBaselineImport } from '../server/core/baseline.mjs'
import { extractFacts, reconcileWithT0 } from '../server/core/t0.mjs'
import { createDataSourceRegistry } from '../server/core/data-sources.mjs'
import {
  createBatchPipeline, validateRows, checkExportGates, buildMbox,
  computeBounceRate, normalizeDomain, BATCH_VERSION,
} from '../server/services/batch.mjs'
import {
  createFetcher, FETCH_VERSION as FETCH_GATE_VERSION, FETCH_ORIGIN as FETCH_GATE_ORIGIN,
} from '../server/services/fetch.mjs'
import {
  evaluateReleaseEvidence, snapshotStatus, complianceStatus, readCompliance,
  EVIDENCE_FILES, EVIDENCE_CONTRACT_VERSION,
} from '../server/core/release-evidence.mjs'

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
    ...walkTs(join(ROOT, 'src/app')),
    ...walkTs(join(ROOT, 'src/components')),
    ...walkTs(join(ROOT, 'src/store')),
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
    !readFileSync(join(ROOT, 'server/core/eval.mjs'), 'utf8').includes('需在 CI'),
    'server/core/eval.mjs')

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
  const gates = checkExportGates([draft({ grade: 'D' }), draft({ grade: 'C' }), draft({ footer: '' }), draft()],
    { knownDomains: ['acme.example'] })
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

  // B7 / P2-1：G2 抑制名单必须由服务端持久化，导出不再依赖调用方传参
  const b7Store = createMemoryStore()
  const b7 = createBatchPipeline({ store: b7Store, gateway: null })
  b7.importCompanies({ rows: [{ company_name: 'B7', domain: 'b7.example' }] })
  const b7Draft = draft({ domain: 'b7.example', to: 'buyer@b7.example' })
  const b7Before = b7.exportDrafts({ items: [b7Draft] })
  b7.importSuppressions({ entries: [{ domain: 'b7.example', reason: 'unsubscribed' }] })
  const b7After = createBatchPipeline({ store: b7Store, gateway: null }).exportDrafts({ items: [b7Draft] })
  const b7Unknown = createBatchPipeline({ store: b7Store, gateway: null })
    .exportDrafts({ items: [draft({ domain: 'ghost.example', to: 'buyer@ghost.example' })] })
  const b7NoCtx = checkExportGates([b7Draft])
  check('B7 G2：不传 blacklist / 换实例仍被持久化名单拦下，未知域名与缺上下文 fail-closed',
    b7Before.ok === true && b7After.ok === false && /服务端持久化/.test(JSON.stringify(b7After.blocked))
    && b7Unknown.ok === false && /未导入客户库/.test(JSON.stringify(b7Unknown.blocked))
    && b7NoCtx.allowed.length === 0 && /fail-closed/.test(b7NoCtx.blocked[0].reasons.join()),
    `before=${b7Before.ok} after=${b7After.ok} unknown=${b7Unknown.ok}`)

  // B7 / P2-2：结算失败必须释放 held，不能让冻结额永久挂着
  const b7LedgerStore = createMemoryStore()
  const b7RealLedger = createLedger({ store: b7LedgerStore, openingBalance: 200 })
  const b7FakeLedger = Object.create(b7RealLedger)
  b7FakeLedger.settle = () => ({ ok: false, code: 'E4003', reason: '注入的结算失败' })
  const b7Pinned = Object.fromEntries(protocol.providers.map((p) => [
    `LEADPILOT_MODEL_VERSION_${p.key.toUpperCase().replace(/-/g, '_')}`, `${p.model}-2026-10-15`,
  ]))
  const b7Wire = {
    company_id: 'c_b7',
    customer_type: { value: 'distributor', confidence: 0.82, evidence: [{ quote: 'Authorized distributor for Parker and Eaton across Benelux', source_url: 'https://x.example/about', fetched_at: '2026-11-06' }] },
    import_signal: { value: 'confirmed', confidence: 0.9, evidence: [{ quote: 'We stock hydraulic hose fittings, JIC fittings and brass adapters', source_url: 'https://x.example/products', fetched_at: '2026-11-06' }] },
    size_estimate: { tier: 'M', employee_range: [11, 50], confidence: 0.61, evidence: [{ quote: 'Team of 23 across Rotterdam and Antwerp', source_url: 'https://x.example/team', fetched_at: '2026-11-06' }] },
    negative_flags: [], model_id: 'deepseek-flash', model_version: '2026-10-15',
    prompt_version: protocol.promptVersion, schema_version: protocol.schemaVersion,
  }
  const b7Gateway = createGateway({
    env: { ...b7Pinned, DEEPSEEK_API_KEY: 'k' },
    fetchImpl: async () => ({
      status: 200, ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(b7Wire) } }],
        usage: { prompt_tokens: 1000, completion_tokens: 200 },
      }),
    }),
    ledger: b7FakeLedger, sleep: async () => {}, now: () => 1_700_000_000_000,
  })
  const b7Judge = await b7Gateway.judge({
    companyId: 'c_b7', domain: 'x.example', country: '美国', requestId: 'b7-gate-settle-fail',
    sourceTexts: [
      'About: Authorized distributor for Parker and Eaton across Benelux.',
      'We stock hydraulic hose fittings, JIC fittings and brass adapters for industrial distributors.',
      'Team of 23 across Rotterdam and Antwerp. FOB Rotterdam, CIF terms available.',
    ],
    facts: { keywordHits: [{ term: 'hydraulic fittings', count: 14 }], customsRecords: 9 },
  })
  check('B7 账本：结算失败自动全额释放预扣，held 归零且不谎报已扣点',
    b7Judge.ok === true && b7Judge.billing?.settleFailed === true && b7Judge.billing?.released === true
    && b7Judge.billing?.charged === false
    && b7RealLedger.state().held === 0 && b7RealLedger.state().spent === 0
    && b7RealLedger.entries('gw:judge:b7-gate-settle-fail').map((e) => e.kind).join() === 'reserve,release',
    `settleFailed=${b7Judge.billing?.settleFailed} held=${b7RealLedger.state().held}`)

  // B7 / P2-3 / P2-8 / P3-3 / P3-4：验证链路配置必须在场，且契约门槛不再写死
  const ciYml = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  const smokeSrc = readFileSync(join(ROOT, 'scripts/e2e-smoke.mjs'), 'utf8')
  check('B7 验证链路：CI 补证据自检与 --noproxy，smoke 有前提探活且门槛读 manifest',
    /npm run evidence:check -- --self-test/.test(ciYml)
    && /--noproxy '\*'/.test(ciYml)
    && /SMOKE_PRECONDITION/.test(smokeSrc)
    && /\/v1\/eval\/integrity\/gates/.test(smokeSrc)
    && /\/v1\/eval\/outcome\/gates/.test(smokeSrc)
    && !/minSamples === 100/.test(smokeSrc),
    `ciSteps=${(ciYml.match(/- name:/g) ?? []).length} smokePrecondition=${/SMOKE_PRECONDITION/.test(smokeSrc)}`)

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

// 7b. B8 / P2-6：三步管道共用服务端客户库；导出项不得退回前端演示草稿库
{
  const bp = protocol.batchPipeline
  const gd = bp.generateDrafts
  check('B8 协议：批量出信端点 / 来源白名单 / E4014·E4015 齐备，定位仍是自动获客',
    gd.endpoint.includes('/v1/batch/generate-drafts') && gd.batchSizeMax === 50
    && ['provider', 'local-template', 'unspecified'].every((s) => gd.draftSources.includes(s))
    && /批量出信/.test(protocol.errorCodes.E4014) && /草稿来源/.test(protocol.errorCodes.E4015)
    && bp.positioning === 'auto_prospecting' && bp.targetUser === 'bulk_sdr')

  const panel = readFileSync(join(ROOT, 'src/components/outreach/BatchPipelinePanel.tsx'), 'utf8')
  check('B8 前端：导出候选只来自批量出信结果或显式本地模板，不再读演示草稿库',
    !/s\.outreach/.test(panel) && !/checkSendGates/.test(panel)
    && /generateDraftsBatch/.test(panel) && /buildImportedTemplateDraft/.test(panel)
    && /draftSource/.test(panel))

  const b8Body = 'We noticed your company distributes industrial fittings across Benelux. We manufacture hydraulic hose fittings and can share our current catalogue and lead times. Would a short specification sheet be useful for your team this quarter?'
  const b8Sender = {
    name: 'Wu Jiaqi', email: 'sales@example.com', company: 'Example Trading Co',
    postalAddress: 'Room 301, Shenzhen, China', unsubscribe: 'Reply STOP to unsubscribe / 退订',
  }
  const b8Footer = [b8Sender.name, b8Sender.company, b8Sender.postalAddress, b8Sender.unsubscribe].join(' | ')
  const b8Draft = (over = {}) => ({
    domain: 'b8.example', to: 'buyer@b8.example', subject: 'Hydraulic fittings supply',
    body: b8Body, grade: 'B', sender: b8Sender, footer: b8Footer, ...over,
  })

  const missingStore = createMemoryStore()
  let providerCalls = 0
  const throwingGateway = { writeEmail: async () => { providerCalls += 1; throw new Error('前置校验失败时不应调用 provider') } }
  const missing = createBatchPipeline({ store: missingStore, gateway: throwingGateway })
  missing.importCompanies({ rows: [{ company_name: 'B8 no source', domain: 'b8-nosource.example' }] })
  const pre = await missing.generateDrafts({})
  check('B8 行为级：缺原文三件套逐条 failed，provider 零调用且 body=null（不伪造正文）',
    pre.summary.failed === 1 && pre.items[0].body === null && pre.items[0].draftSource === null
    && /missing_source/.test(pre.items[0].reason) && providerCalls === 0)

  const okStore = createMemoryStore()
  const okGateway = { writeEmail: async () => ({ ok: true, subject: 'Hydraulic fittings supply', body: b8Body, errorCodes: [] }) }
  const okPipeline = createBatchPipeline({ store: okStore, gateway: okGateway })
  okPipeline.importCompanies({ rows: [{
    company_name: 'B8 Co', domain: 'b8.example', source_url: 'https://b8.example/about',
    fetched_at: '2026-11-09', raw_text: 'We import hydraulic hose fittings from Asia.',
    product_hint: 'hydraulic fittings', contact_email: 'buyer@b8.example',
  }] })
  const gen = await okPipeline.generateDrafts({})
  check('B8 行为级：出信 domain 与导入清单同源，真实 T1 才标 draftSource=provider',
    gen.ok && gen.summary.succeeded === 1
    && gen.items[0].domain === okPipeline.listCompanies().companies[0].domain
    && gen.items[0].draftSource === 'provider' && gen.releaseEligible === false,
    `succeeded=${gen.summary?.succeeded}`)

  const illegalSource = checkExportGates([b8Draft({ draftSource: 'provider-fake' })], { knownDomains: ['b8.example'] })
  const templateMbox = buildMbox([b8Draft({ draftSource: 'local-template' })], { now: Date.UTC(2026, 10, 9) })
  const providerMbox = buildMbox([b8Draft({ draftSource: 'provider' })], { now: Date.UTC(2026, 10, 9) })
  check('B8 导出闸门：非法来源逐条 E4015，本地模板必写 DEMO 头且 provider 不带',
    illegalSource.allowed.length === 0 && illegalSource.blocked[0].code === 'E4015'
    && templateMbox.includes('X-LeadPilot-Demo: template-not-model')
    && !providerMbox.includes('X-LeadPilot-Demo'))

  const exportStore = createMemoryStore()
  const exportPipeline = createBatchPipeline({ store: exportStore, gateway: null })
  exportPipeline.importCompanies({ rows: [{ company_name: 'B8E', domain: 'b8e.example' }] })
  const rejected = exportPipeline.exportDrafts({ items: [b8Draft({ domain: 'b8e.example', draftSource: 'fake' })] })
  check('B8 HTTP 契约：非法来源在导出顶层返回 E4015，绝不退化成笼统 E4009',
    rejected.ok === false && rejected.code === 'E4015' && !rejected.content)
}

// 7c. B9 · 演示 KPI 护栏 / 文档数字动态化 / 截图可复现
//     边界：这里是「防 UI 回退」的静态护栏，B9 的行为级保证在
//     tests/frontend/b9-metrics.test.ts 与 b9-frontend.test.ts，由 CI Unit tests 步骤真实执行。
{
  const views = ['src/components/outreach/OutreachView.tsx', 'src/components/crm/CrmView.tsx']
    .map((f) => readFileSync(join(ROOT, f), 'utf8'))
  const tiles = views.flatMap((s) => [...s.matchAll(/<StatTile\b[\s\S]*?\/>/g)].map((m) => m[0]))
  check('B9 / P2-7 护栏：两页 9 张 KPI 卡全部走统一口径函数，不留裸数字 KPI',
    tiles.length === 9 && tiles.every((t) => t.includes('toTileProps(')),
    `tiles=${tiles.length} wrapped=${tiles.filter((t) => t.includes('toTileProps(')).length}`)
  check('B9 / P2-5 护栏：行为级反例文件纳入 vitest include 覆盖范围，且两页共用 metrics.ts',
    readFileSync(join(ROOT, 'config/vite.config.ts'), 'utf8').includes("tests/**/*.test.ts")
    && existsSync(join(ROOT, 'tests/frontend/b9-metrics.test.ts'))
    && existsSync(join(ROOT, 'tests/frontend/b9-frontend.test.ts'))
    && existsSync(join(ROOT, 'src/domain/metrics.ts'))
    && views.every((v) => v.includes('@/domain/metrics')))

  const coverage = readFileSync(join(ROOT, 'docs/PRD-COVERAGE.md'), 'utf8')
  const assessment = readFileSync(join(ROOT, 'docs/ASSESSMENT-2026-11-10.md'), 'utf8')
  check('B9 / P3-1·P3-2：文档不再写死「54 项 / 四条阻断」，历史数字改为动态表述与快照注',
    /数字口径（B9 收口）/.test(coverage)
    && !/\*\*54 项\*\*自检/.test(coverage)
    && !/与四条阻断（/.test(coverage)
    && /历史数字口径（B9/.test(assessment)
    && /12 步\*\*（B9 校正/.test(assessment),
    'PRD-COVERAGE / ASSESSMENT-2026-11-10')

  const capture = readFileSync(join(ROOT, 'scripts/capture-screenshots.mjs'), 'utf8')
  check('B9 截图链：attach 模式存在且不关闭外部启动的浏览器',
    /LEADPILOT_CDP_ATTACH/.test(capture) && /if \(chrome\) chrome\.kill/.test(capture))
}

// 7d. B10 · AC-05 三重指纹去重（域名 + 公司名归一化 + 国家）
//     边界：这里只是静态护栏，防「规则只写在注释里、没接进管道」这类回退；
//     行为级保证由 tests/frontend/dedupe.test.ts 与 tests/server/ac05-dedupe.test.mjs 在 CI Unit tests 执行，
//     两侧同时对 tests/fixtures/dedupe-parity.json 对齐 —— 任一侧改规则没同步，两处一起红。
{
  const contractPath = join(ROOT, 'shared/dedupe-contract.json')
  const dedupeContract = existsSync(contractPath) ? JSON.parse(readFileSync(contractPath, 'utf8')) : null
  const clientDedupe = readFileSync(join(ROOT, 'src/domain/dedupe.ts'), 'utf8')
  const serverDedupe = readFileSync(join(ROOT, 'server/core/dedupe.mjs'), 'utf8')
  check('AC-05 唯一真源：去重规则只在 shared/dedupe-contract.json，客户端与服务端各读同一份',
    Boolean(dedupeContract) && dedupeContract.contract === 'dedupe-fingerprint-v1'
    && clientDedupe.includes("from '../../shared/dedupe-contract.json'")
    && serverDedupe.includes("'../../shared/dedupe-contract.json'")
    && clientDedupe.includes('export const DEDUPE_VERSION: string = contract.version')
    && serverDedupe.includes('export const DEDUPE_VERSION = dedupeContract.version'))

  const batchSrc = readFileSync(join(ROOT, 'server/services/batch.mjs'), 'utf8')
  check('AC-05 无第二份实现：batch.mjs 的 normalizeDomain 转出 core/dedupe.mjs，不再自己写一遍',
    /import \{[^}]*normalizeDomain[^}]*\} from '\.\.\/core\/dedupe\.mjs'/.test(batchSrc)
    && !/export function normalizeDomain/.test(batchSrc))

  check('AC-05 已接进导入管道：validateRows 收 existingFingerprints，importCompanies 真实传入',
    batchSrc.includes('opts.existingFingerprints')
    && /validateRows\(parsed\.rows, \{ existingDomains: existingDomains\(\), existingFingerprints: existingFingerprints\(\) \}\)/.test(batchSrc))

  // P3-6 拆分后 store 是多文件目录，按目录聚合扫描：
  // 断言的是「任务出库这条链路接了三重指纹」，不是「某一行必须待在某个文件里」。
  const storeSrc = walkTs(join(ROOT, 'src/store')).map((f) => readFileSync(f, 'utf8')).join('\n')
  check('AC-05 已接进任务出库：startTask 按三重指纹过滤，不再只看域名',
    storeSrc.includes("from '@/domain/dedupe'")
    && /dedupeByFingerprint\(candidates, \(c\) => c\)/.test(storeSrc)
    && !/existingDomains\.has\(c\.domain\)/.test(storeSrc))

  const fixturePath = join(ROOT, 'tests/fixtures/dedupe-parity.json')
  const parity = existsSync(fixturePath) ? JSON.parse(readFileSync(fixturePath, 'utf8')) : { cases: [], version: '' }
  const clientSpec = readFileSync(join(ROOT, 'tests/frontend/dedupe.test.ts'), 'utf8')
  const serverSpec = readFileSync(join(ROOT, 'tests/server/ac05-dedupe.test.mjs'), 'utf8')
  check('AC-05 跨语言夹具：≥16 条，两侧测试读同一份，防单边改规则',
    parity.cases.length >= 16 && parity.version === (dedupeContract?.version ?? '')
    && clientSpec.includes('dedupe-parity.json') && serverSpec.includes('dedupe-parity.json'),
    `cases=${parity.cases.length} version=${parity.version}`)

  const coverageAc05 = readFileSync(join(ROOT, 'docs/PRD-COVERAGE.md'), 'utf8')
  check('AC-05 文档：不再声称三重指纹未实现，且写明覆盖范围',
    /\| AC-05 \|[^|]*\| ✅ \|/.test(coverageAc05) && /三重指纹/.test(coverageAc05))
}

// 7e. P3-6 · store 巨石拆分
//     边界：静态护栏只能防「又长回巨石」和「拆一半留残骸」；
//     行为等价由 tests/frontend/store-actions.test.ts 的 30 条特征测试在 CI Unit tests 执行。
//     拆分顺序是「先绿 → 再重构 → 再绿」，那 30 条在拆分前后必须一字不差通过。
{
  const entryPath = join(ROOT, 'src/store/useAppStore.ts')
  const entry = readFileSync(entryPath, 'utf8')
  const entryLines = entry.split('\n').length
  check('P3-6 组合根不再长成巨石：useAppStore.ts ≤ 80 行，且不自己写任何动作实现',
    entryLines <= 80
    && !/startTask:\s*\(/.test(entry)
    && !/setCompanyStatus:\s*\(/.test(entry)
    && !/judgeWithGateway:\s*async/.test(entry),
    `lines=${entryLines}`)

  const requiredStoreFiles = [
    'src/store/types.ts', 'src/store/defaults.ts', 'src/store/demo-bootstrap.ts',
    'src/store/runtime.ts', 'src/store/cloud-events.ts', 'src/store/persistence.ts',
    'src/store/slices/ui.ts', 'src/store/slices/task.ts', 'src/store/slices/company.ts',
    'src/store/slices/outreach.ts', 'src/store/slices/settings.ts',
    'src/store/slices/gateway.ts', 'src/store/slices/reset.ts',
  ]
  const missing = requiredStoreFiles.filter((f) => !existsSync(join(ROOT, f)))
  check('P3-6 拆分骨架齐备：slice 与支撑模块各就各位，没有拆一半留残骸',
    missing.length === 0, `missing=${missing.join(',') || 'none'}`)

  check('P3-6 对外契约未变：AppState 定义在 types，ViewKey 等仍从组合根可导入',
    /export type \{ Filters, QuickFilter, SortKey, ViewKey, ToastTone \} from '\.\/types'/.test(entry)
    && readFileSync(join(ROOT, 'src/store/types.ts'), 'utf8').includes('export interface AppState'))

  check('P3-6 行为等价有据：30 条特征测试在仓库内且纳入 vitest include',
    existsSync(join(ROOT, 'tests/frontend/store-actions.test.ts'))
    && readFileSync(join(ROOT, 'config/vite.config.ts'), 'utf8').includes('tests/**/*.test.ts'))
}

// 7f. F11 · 模板库
//     边界：本批次只做模板库，多步序列未做，所以文档只能 🟡 不能 ✅。
//     静态护栏防四类倒退：另写一套禁词表、保存动作绕开校验、内置模板被就地改坏、
//     缺变量的花括号漏过发送闸门（这条最阴：{{x}} 不属于 hasPlaceholder 认的方括号形态）。
{
  const tplDomain = readFileSync(join(ROOT, 'src/domain/email-template.ts'), 'utf8')

  check('F11 模板域层单一真源：变量白名单只定义一次（TEMPLATE_VARIABLES），各处引用同一份',
    /export const TEMPLATE_VARIABLES = \[/.test(tplDomain)
    // 除这一处定义外，不允许再出现第二份「变量清单」数组定义
    && (tplDomain.match(/const [A-Z_]*VARIABLES\s*(?::[^=]+)?= \[/g) ?? []).length === 1
    && (tplDomain.match(/TEMPLATE_VARIABLES/g) ?? []).length >= 4)

  check('F11 不另写禁词表：模板校验复用 domain/compliance 的 validateEmail（与服务端 F6-2 同一份词表）',
    /import \{ validateEmail \} from '\.\/compliance'/.test(tplDomain)
    && !/BANNED_WORDS\s*=/.test(tplDomain)
    && !/dear sir or madam/i.test(tplDomain))

  check('F11 合规尾巴与发件人身份不进模板：内置模板正文不含退订语句与公司后缀',
    !/unsubscribe|reply\s+stop|退订/i.test(
      (tplDomain.match(/body: '[^']*'/g) ?? []).join(' '),
    )
    && !/\b(?:GmbH|Ltd|Inc)\b/.test((tplDomain.match(/body: '[^']*'/g) ?? []).join(' ')))

  const tplSlice = readFileSync(join(ROOT, 'src/store/slices/templates.ts'), 'utf8')
  check('F11 保存动作必过校验：saveTemplate 先跑 validateTemplate，不合法就不进 state',
    /validateTemplate\(\{ name, subject, body, purpose \}\)/.test(tplSlice)
    && /if \(!checked\.ok\)/.test(tplSlice))
  check('F11 内置模板不可篡改：覆盖与删除两条路径都按 id 前缀拒绝',
    /isBuiltin\(targetId\)/.test(tplSlice) && /isBuiltin\(id\)/.test(tplSlice)
    && tplSlice.includes('内置模板不可修改') && tplSlice.includes('内置模板不可删除'))

  check('F11 缺变量的洞转方括号：materializeTemplate 产出 [待填：x]，让 hasPlaceholder 必然拦住',
    /export function materializeTemplate/.test(tplDomain)
    && tplDomain.includes('`[待填：${name}]`'))

  const composer = readFileSync(join(ROOT, 'src/components/outreach/EmailComposer.tsx'), 'utf8')
  const library = readFileSync(join(ROOT, 'src/components/outreach/TemplateLibrary.tsx'), 'utf8')
  check('F11 已接进写信链路：写信页可套用模板，且套用后照旧注入合规尾巴',
    composer.includes('TemplateLibrary')
    && composer.includes('materializeTemplate')
    && /injectComplianceFooter\(rendered\.body, settings\.profile\)/.test(composer)
    && library.includes('saveTemplate'))

  const coverageF11 = readFileSync(join(ROOT, 'docs/PRD-COVERAGE.md'), 'utf8')
  check('F11 文档口径诚实：模板库 + 多步序列都落地，但整体仍 🟡（不做自动节奏，也不发信）',
    /\| F11 \|[^\n]*\| 🟡 \|/.test(coverageF11)
    && !/\| F11 \|[^\n]*\| ❌ \|/.test(coverageF11)
    && coverageF11.includes('多步序列')
    && coverageF11.includes('人工推进'))
}

// 7g. F11 第二步 · 多步序列
//     边界：序列只做「排期提示」，不做自动发送 / 自动建草稿 / 自动改状态。
//     静态护栏防五类倒退：偷偷加定时器、能力校验变成死代码、保存绕开校验、
//     内置序列被就地改坏、以及「配了序列但界面上没有任何落点」。
{
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const fuDomainRaw = readFileSync(join(ROOT, 'src/domain/follow-up.ts'), 'utf8')
  const fuDomain = stripComments(fuDomainRaw)
  const fuSlice = readFileSync(join(ROOT, 'src/store/slices/sequences.ts'), 'utf8')

  check('F11 序列域层无执行能力：代码里没有定时器 / 发送 / 改状态 / 建草稿的调用',
    !/setInterval|setTimeout|requestAnimationFrame|queueMicrotask/.test(fuDomain)
    && !/addOutreach|setCompanyStatus|sendEmail|autoSend|autoSchedule/.test(fuDomain))

  check('F11 序列上限可达：总跨度上限严格小于「步数上限 × 单步上限」，否则就是一段死校验',
    /MAX_SEQUENCE_SPAN_DAYS = (\d+)/.test(fuDomain)
    && Number((fuDomain.match(/MAX_SEQUENCE_SPAN_DAYS = (\d+)/) ?? [])[1])
      < Number((fuDomain.match(/MAX_SEQUENCE_STEPS = (\d+)/) ?? [])[1])
        * Number((fuDomain.match(/MAX_STEP_GAP_DAYS = (\d+)/) ?? [])[1]))

  check('F11 序列保存必过校验：saveSequence 先跑 validateSequence，不合法就不进 state',
    /validateSequence\(\{ name, steps \}, \{ templateIds \}\)/.test(fuSlice)
    && /if \(!checked\.ok\)/.test(fuSlice))

  check('F11 内置序列不可篡改：覆盖与删除两条路径都按 id 前缀拒绝',
    /isBuiltin\(targetId\)/.test(fuSlice) && /isBuiltin\(id\)/.test(fuSlice)
    && fuSlice.includes('内置序列不可修改') && fuSlice.includes('内置序列不可删除'))

  const detail = readFileSync(join(ROOT, 'src/components/developer/SequenceProgress.tsx'), 'utf8')
  const lib = readFileSync(join(ROOT, 'src/components/outreach/SequenceLibrary.tsx'), 'utf8')
  check('F11 序列有真实落点：详情页按 planFollowUp 展示进度，模板库弹窗可编辑',
    detail.includes('planFollowUp') && lib.includes('planFollowUp')
    && readFileSync(join(ROOT, 'src/components/outreach/TemplateLibrary.tsx'), 'utf8').includes('SequenceLibrary'))

  check('F11 界面上写明「不自动发送」：序列面板与详情页都要有这句，否则用户会以为是自动节奏',
    lib.includes('不自动发送') && detail.includes('不自动发送'))
}

// 8. B4 · 门禁不能再「红得假」：真实证据必须能改变判定，伪造证据必须被拦
//    旧实现末尾写死 evaluateIntegrity([]) / evaluateOutcome([]) + 5 条硬编码 BLOCKED，
//    即使真实样本存在也永远 NO_DATA。下面用行为级断言证明判定随输入真实变化。
//    注意：此处样本只是链路自检夹具，写在 .tmp/ 临时目录、用完即删，绝不入库，
//    也绝不进入生产门禁默认读取的 .evidence/ 目录。
{
  const tmpRoot = join(ROOT, '.tmp')
  mkdirSync(tmpRoot, { recursive: true })
  const evidenceDir = mkdtempSync(join(tmpRoot, 'gate-evidence-'))
  const attestation = {
    attestedReal: true, signedBy: '门禁链路自检夹具', signedAt: '2026-11-12T00:00:00.000Z',
    statement: '仅用于证明判定链路会随输入变化，非真实证据，不用于任何发布判定。',
  }
  const rec = (i) => ({
    sourceUrl: `https://gate-evidence.example.com/about/${i}`,
    capturedAt: '2026-11-12', sourceOrigin: 'user_directed_fetch',
    quote: `we import fittings ${i}`,
    sourceText: `about: we import fittings ${i} from asia`,
    provenance: { matched: 1, total: 1 }, rules: { passed: 2, total: 2 },
    schemaPass: true, refused: false,
  })
  const write = (name, data) => writeFileSync(join(evidenceDir, name), JSON.stringify(data))
  const clean = () => { for (const f of Object.values(EVIDENCE_FILES)) rmSync(join(evidenceDir, f), { force: true }) }
  const pinnedEnv = Object.fromEntries(protocol.providers.flatMap((p) => [
    [p.envKey, 'gate-selfcheck-key'],
    [`LEADPILOT_MODEL_VERSION_${p.key.toUpperCase().replace(/-/g, '_')}`, `${p.model}-2026-10-15`],
  ]))
  try {
    const empty = evaluateReleaseEvidence({ dir: evidenceDir, env: {} })
    check('B4 空证据目录：NO_DATA / 阻断项由真实判定生成，releaseEligible 恒 false',
      empty.integrity.status === 'NO_DATA' && empty.outcome.status === 'NO_DATA'
      && empty.blockers.length >= 5 && empty.release.releaseEligible === false
      && empty.release.accuracyClaim === false && empty.evidenceReady === false,
      `blockers=${empty.blockers.length} contract=${empty.contractVersion}`)

    write(EVIDENCE_FILES.integrity, { attestation, synthetic: true, records: [rec(0)] })
    const synthetic = evaluateReleaseEvidence({ dir: evidenceDir, env: {} })
    write(EVIDENCE_FILES.integrity, { records: [rec(0)] })
    const unsigned = evaluateReleaseEvidence({ dir: evidenceDir, env: {} })
    write(EVIDENCE_FILES.integrity, { attestation, records: [rec(0), rec(0)] })
    const duplicated = evaluateReleaseEvidence({ dir: evidenceDir, env: {} })
    check('B4 伪造证据（合成标记 / 缺签署 / 复制凑数）整份不采信，判定仍 NO_DATA',
      [synthetic, unsigned, duplicated].every((r) => r.validation.ok === false
        && r.integrity.status === 'NO_DATA' && r.evidenceReady === false),
      `errors=${synthetic.validation.errors.length}/${unsigned.validation.errors.length}/${duplicated.validation.errors.length}`)

    clean()
    const ig = integrityManifest()
    const records = Array.from({ length: ig.minSamples }, (_, i) => rec(i))
    const runs = records.map((r) => ({ quote: r.quote }))
    write(EVIDENCE_FILES.integrity, { attestation, records })
    write(EVIDENCE_FILES.consistency, { attestation, prevRun: runs, currentRun: runs.map((r) => ({ ...r })) })
    write(EVIDENCE_FILES.outcome, {
      attestation,
      events: [
        ...Array.from({ length: 40 }, (_, i) => ({ event: 'sent', refId: `sent-${i}`, occurredAt: '2026-11-12', source: 'smtp-log' })),
        { event: 'replied', refId: 'reply-0', occurredAt: '2026-11-12', source: 'mailbox' },
      ],
    })
    const ready = evaluateReleaseEvidence({ dir: evidenceDir, env: pinnedEnv })
    check('B4 达标证据真的能改变判定（行为级）：integrity/outcome/一致性 PASSED 且 evidenceReady=true',
      ready.validation.ok === true && ready.integrity.status === 'PASSED'
      && ready.outcome.status === 'PASSED' && ready.consistency?.status === 'PASSED'
      && ready.evidenceReady === true && ready.release.internalPreviewReady === true
      && ready.release.externalValidated === true,
      `integrity=${ready.integrity.status} outcome=${ready.outcome.status} consistency=${ready.consistency?.status}`)
    check('B4 证据达标也不等于可发布：releaseEligible 恒 false，外部合规阻断项仍在',
      ready.release.releaseEligible === false && ready.accuracyClaim === false
      && ready.blockers.some((b) => b.includes('外部合规'))
      && ready.compliance.ok === false,
      `blockers=${ready.blockers.length} compliance=${ready.compliance.completed}/${ready.compliance.total}`)
  } finally {
    rmSync(evidenceDir, { recursive: true, force: true })
  }

  const latestEnv = Object.fromEntries(protocol.providers.map((p) => [
    `LEADPILOT_MODEL_VERSION_${p.key.toUpperCase().replace(/-/g, '_')}`, `${p.model}-latest`,
  ]))
  check('B4 快照锁定读真实环境变量：-latest 不锁定，具体版本才锁定',
    EVIDENCE_CONTRACT_VERSION === 'release-evidence-v1'
    && snapshotStatus({}).ok === false
    && snapshotStatus(latestEnv).ok === false
    && snapshotStatus(pinnedEnv).lockedCount > 0)
  const forgedCompliance = {
    ...readCompliance(),
    items: readCompliance().items.map((i) => ({ ...i, status: 'completed' })),
  }
  check('B4 合规清单：只改 status 不填证据/签署人/日期仍不算完成',
    complianceStatus(readCompliance()).ok === false
    && complianceStatus(forgedCompliance).ok === false)
}

const width = Math.max(...results.map((r) => r.name.length))
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`)
console.log(`\n${results.length - failed}/${results.length} gate self-checks passed`)

// B4：这里不再写死 evaluateIntegrity([]) / evaluateOutcome([]) 与 5 条硬编码 BLOCKED。
// 判定来自真实证据目录 + 真实环境变量 + 真实合规清单，阻断项由结果生成。
const ds = createDataSourceRegistry().health()
const evidence = evaluateReleaseEvidence()
const release = evidence.release
console.log(`\n发布门禁状态：releaseBlocked = ${evidence.releaseBlocked} · releaseEligible = ${release.releaseEligible} · accuracyClaim = ${release.accuracyClaim}`)
console.log(`证据通道：${evidence.contractVersion} · ${evidence.evidenceDir}`)
console.log(`  已提供 ${evidence.filesPresent.length ? evidence.filesPresent.join(', ') : '（无）'}；校验 ${evidence.validation.ok ? 'PASS' : `FAIL（${evidence.validation.errors.length} 条）`}；样本 integrity=${evidence.sampleCounts.integrityRecords} / outcome=${evidence.sampleCounts.outcomeEvents} / 抓取来源=${evidence.sampleCounts.fetchedRecords}`)
console.log(`  provider 快照 已配置 ${evidence.snapshot.configuredCount} 家 Key / 锁定 ${evidence.snapshot.lockedCount} 家；外部合规 ${evidence.compliance.completed}/${evidence.compliance.total} 完成`)
for (const b of evidence.blockers) console.log(`  BLOCKED  ${b}`)
if (evidence.blockers.length === 0) console.log('  （无 BLOCKED 条目；releaseEligible 仍由发布策略锁定为 false）')
console.log('说明：以上为「尚未达标」，不是失败。自检全绿只证明边界没被伪造，不证明产品可发布。')
console.log('v0.9.0 抓取：只抓用户显式指定的 URL（robots 遵从 / 每域限速 / 拒绝私网），原文标 user_directed_fetch；抓取 ≠ 采集，商业源仍 0/6。')
console.log('v0.8.0 决策：不做 385 家人工标注基准集、不做商业数据源采购；两项已从阻断项移除（legacy 契约保留、不参与判定）。')
console.log(`  数据源仍如实报 ${ds.readyCount}/${ds.total}（用户投喂 + 用户指定抓取是唯一来源）；评测改看 integrity + outcome，accuracyClaim 恒 false。`)
console.log(`  internalPreviewReady=${release.internalPreviewReady} · externalValidated=${release.externalValidated} · evidenceReady=${evidence.evidenceReady}`)
console.log(`  ${evidence.note}`)

if (failed) {
  console.error(`\nGATE FAILED：${failed} 项自检断言失败，CI 必须红。`)
  process.exit(1)
}
// B4：REQUIRE_BASELINE 现在验证「内测资格证据是否达标」，不再无条件 exit 1。
// 证据真的达标时这个开关会放行，但 releaseEligible 仍恒 false（发布由外部合规项与产品决策卡住）。
if (process.env.LEADPILOT_REQUIRE_BASELINE === '1' && !evidence.evidenceReady) {
  console.error('\nGATE FAILED：LEADPILOT_REQUIRE_BASELINE=1 要求内测资格证据达标，当前未达标。真实阻断项：')
  for (const b of evidence.blockers) console.error(`  BLOCKED  ${b}`)
  process.exit(1)
}
console.log('\nGATE OK：自检断言全绿；发布仍由 releaseEligible=false 与外部合规项明确卡住（符合预期）。')
