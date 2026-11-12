/**
 * 云端服务端到端冒烟验证。
 *
 * 用法：node server/index.mjs  （另开终端）
 *       node scripts/e2e-smoke.mjs
 *
 * 纪律：只验证「真实实现」与「显式降级」，不把降级当成功，也不编造采集结果。
 * 未配置 API Key 时，/v1/judge 与 /v1/email/generate 必须明确返回 503 + E6005。
 */
import { readFileSync } from 'node:fs'

const BASE = process.env.LEADPILOT_API ?? 'http://127.0.0.1:5181'
// 版本从 package.json 读取，避免每次发版都漏改冒烟脚本里的硬编码
const PKG_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const results = []
let failures = 0

function check(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!ok) failures++
}

async function req(path, init) {
  try {
    const res = await fetch(`${BASE}${path}`, init)
    const text = await res.text()
    let body
    try { body = JSON.parse(text) } catch { body = text.slice(0, 160) }
    return { status: res.status, body }
  } catch (err) {
    return { status: 0, body: { error: String(err?.message ?? err) } }
  }
}

const post = (path, body) => req(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

async function sseProbe(taskId, maxEvents = 4) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2500)
  try {
    const res = await fetch(`${BASE}/v1/tasks/${taskId}/events`, { signal: controller.signal })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    const events = []
    while (events.length < maxEvents) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const chunks = buf.split('\n\n')
      buf = chunks.pop() ?? ''
      for (const chunk of chunks) {
        const line = chunk.split('\n').find((l) => l.startsWith('event: '))
        if (line) events.push(line.slice(7).trim())
      }
    }
    await reader.cancel().catch(() => {})
    return events
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const health = await req('/health')
  check('云端服务健康检查（版本与 package.json 一致）',
    health.status === 200 && health.body.ok === true && health.body.version === PKG_VERSION,
    `status=${health.status} version=${health.body?.version} expect=${PKG_VERSION} mode=${health.body?.gateway?.mode ?? 'n/a'}`)

  const points = health.body?.points
  check('点数账本健康如实暴露余额恒等式与范围（任务 + 网关共用一本账）',
    points && points.available + points.held + points.spent === points.granted
    && points.scope?.includes('task_reserve')
    && points.scope?.includes('gateway_reserve')
    && points.ledgerConsumers?.includes('judge')
    && points.auditOnlyConsumers?.length === 0,
    `available=${points?.available} held=${points?.held} spent=${points?.spent} scope=${points?.scope?.length ?? 0}`)
  check('评测契约如实标注不可发布，T0 → judge 事实链已接线',
    health.body?.baseline?.releaseEligible === false
    && health.body?.t0?.judgeFactChain?.enabled === true,
    `import=${health.body?.baseline?.importStatus} chain=${health.body?.t0?.judgeFactChain?.onConflict}`)
  check('billing 明确列出网关计费策略：成功才结算、失败/缓存不扣点',
    health.body?.billing?.ledgerConsumers?.includes('write_email') === true
    && health.body?.billing?.chargeOn === 'schema_and_content_validation_passed'
    && health.body?.billing?.releaseOn?.includes('degraded') === true
    && health.body?.billing?.noChargeOn?.includes('cache_hit') === true
    && Boolean(health.body?.billing?.reservePoints?.T1),
    `mode=${health.body?.billing?.mode} reserveT1=${health.body?.billing?.reservePoints?.T1}`)

  const pointsApi = await req('/v1/points')
  check('点数账本只读接口可用（不暴露充值写接口）',
    pointsApi.status === 200 && pointsApi.body?.account === 'default'
    && Array.isArray(pointsApi.body?.entries),
    `status=${pointsApi.status} entries=${pointsApi.body?.entries?.length ?? 0}`)

  const contract = await req('/v1/eval/baseline/contract')
  check('385 家基准集契约可读且只返回口径',
    contract.status === 200 && contract.body?.baselineSize === 385
    && Array.isArray(contract.body?.fields ? Object.keys(contract.body.fields) : null),
    `status=${contract.status} size=${contract.body?.baselineSize}`)

  const badBaseline = await post('/v1/eval/baseline/validate', {
    samples: [{ sample_id: 'INVALID-FIXTURE-SMOKE', score: 99 }],
  })
  check('非法标注导入被 400 E6004 拒绝（校验通过 ≠ 评测通过）',
    badBaseline.status === 400 && badBaseline.body?.code === 'E4004'
    && badBaseline.body?.releaseEligible === false,
    `status=${badBaseline.status} errors=${badBaseline.body?.errorCount ?? 0}`)

  const ds = health.body?.dataSources
  check('数据源注册表如实报告 0/6 已接入（不制造「已接入」假象）',
    ds?.total === 6 && ds?.readyCount === 0 && ds?.mode === 'demo',
    `ready=${ds?.readyCount ?? 'n/a'}/${ds?.total ?? 'n/a'} mode=${ds?.mode ?? 'n/a'}`)

  // v0.9.0 用户指定 URL 抓取：单独计数，不并入商业数据源 0/6；抓取 ≠ 采集
  const fetchHealth = await req('/v1/sources/health')
  check('用户指定抓取器健康可读（robots 遵从 / 每域限速 / 单独计数）',
    fetchHealth.status === 200
    && fetchHealth.body?.version === 'user-directed-fetch-v1'
    && fetchHealth.body?.origin === 'user_directed_fetch'
    && fetchHealth.body?.policy?.respectRobots === true
    && fetchHealth.body?.policy?.perDomainMinIntervalMs > 0
    && health.body?.fetch?.version === 'user-directed-fetch-v1',
    `version=${fetchHealth.body?.version} interval=${fetchHealth.body?.policy?.perDomainMinIntervalMs}`)

  const ssrfFetch = await post('/v1/sources/fetch', { urls: ['http://127.0.0.1/secret'] })
  check('抓取器拒绝回环地址且不发起请求（SSRF → E4011）',
    ssrfFetch.status === 400
    && ssrfFetch.body?.failed?.[0]?.code === 'E4011'
    && ssrfFetch.body?.summary?.fetched === 0,
    `status=${ssrfFetch.status} code=${ssrfFetch.body?.failed?.[0]?.code ?? 'n/a'}`)

  const batchFetch = await post('/v1/batch/fetch-sources', { domains: ['no-such-domain.example'], limit: 5 })
  check('批量抓取无候选时明确 E4008，不凭空发现公司',
    batchFetch.status === 400 && batchFetch.body?.code === 'E4008',
    `status=${batchFetch.status} code=${batchFetch.body?.code ?? 'n/a'}`)

  const gh = await req('/v1/gateway/health')
  check('网关 provider 清单可读', gh.status === 200 && Array.isArray(gh.body.providers),
    `configured=${gh.body?.configuredCount}/${gh.body?.totalProviders}`)

  const judge = await post('/v1/judge', {
    companyId: 'c_smoke', domain: 'smoke.demo.local', country: '美国',
    sourceTexts: ['Authorized distributor for Parker fittings across Benelux.'],
    facts: { keywordHits: 2 },
  })
  const judgeDegraded = judge.status === 503 && Array.isArray(judge.body.errorCodes) && judge.body.errorCodes.includes('E6005')
  const judgeReal = judge.status === 200 && judge.body.ok === true
  check('判断请求：真实调用或明确 E6005 降级', judgeDegraded || judgeReal,
    `status=${judge.status} codes=${JSON.stringify(judge.body?.errorCodes ?? [])} ok=${judge.body?.ok}`)

  const chainDoc = {
    url: 'https://smoke-chain.example/about',
    text: 'Authorized distributor for Parker fittings across Benelux. We import hydraulic hose fittings from Asia. Our team has 85 employees.',
    fetched_at: '2026-11-08',
  }
  const chain = await post('/v1/judge', {
    companyId: 'c_smoke_chain', domain: 'smoke-chain.example', country: '美国',
    sources: [chainDoc], keywords: ['hydraulic hose fittings'], facts: { keywordHits: 2 },
  })
  check('T0 → judge 事实链：提供可核验 sources 时启用，降级也不伪造规则来源',
    chain.body?.t0?.used === true && chain.body?.t0?.ok === true
    && chain.body?.t0?.rulesVersion === health.body?.t0?.rulesVersion
    && (chain.status === 503
      ? chain.body?.errorCodes?.includes('E6005') && !chain.body?.t0?.reconciliation
      : chain.body?.ok === true && Boolean(chain.body?.t0?.reconciliation)),
    `status=${chain.status} used=${chain.body?.t0?.used} conflicts=${chain.body?.t0?.reconciliation?.conflicts?.length ?? 0}`)

  const badChain = await post('/v1/judge', {
    companyId: 'c_smoke_chain', domain: 'smoke-chain.example', country: '美国',
    sources: [{ url: 'not-a-url', text: 'x', fetched_at: '2026-11-08' }], facts: {},
  })
  check('T0 事实链非法来源被拒，不向任何 provider 发请求',
    badChain.body?.t0?.ok === false && badChain.body?.errorCodes?.includes('E6004'),
    `status=${badChain.status} errors=${badChain.body?.t0?.errors?.length ?? 0}`)

  const email = await post('/v1/email/generate', {
    anchor: 'you distribute Parker fittings across Benelux', product: 'hydraulic hose fittings',
    advantages: ['stable lead times'], purpose: 'intro', tone: 'concise',
    maxWords: 90, language: 'en', country: '美国',
  })
  const emailDegraded = email.status === 503 && email.body.body === null && email.body.errorCodes?.includes('E6005')
  const emailReal = email.status === 200 && typeof email.body.body === 'string' && email.body.body.length > 40
  check('写信请求：真实 T1 或明确 E6005（正文为空）', emailDegraded || emailReal,
    `status=${email.status} bodyLength=${email.body?.body?.length ?? 0} codes=${JSON.stringify(email.body?.errorCodes ?? [])}`)

  check('网关计费如实标注：降级不扣点 / 真实调用才进账本',
    judgeDegraded
      ? judge.body?.billing?.charged === false && judge.body?.billing?.reason === 'no_provider'
      : judge.body?.billing?.charged === true && judge.body?.billing?.scope === 'ledger-v2',
    `judge=${judge.body?.billing?.reason ?? judge.body?.billing?.scope} charged=${judge.body?.billing?.charged}`)

  const pii = await post('/v1/email/generate', {
    anchor: 'write to purchasing@smoke.demo.local', product: 'hydraulic fittings',
    advantages: [], purpose: 'intro', tone: 'concise', maxWords: 90, language: 'en', country: '美国',
  })
  check('PII 请求被 400 E6004 拒绝', pii.status === 400 && pii.body.code === 'E6004',
    `status=${pii.status} code=${pii.body?.code}`)

  const t0Doc = {
    url: 'https://smoke.example/about',
    text: 'Authorized distributor for Parker fittings across Benelux. We stock hydraulic hose fittings for industrial buyers.',
    fetched_at: '2026-11-08',
  }
  const t0 = await post('/v1/t0/extract', {
    company_id: 'smoke_t0', sources: [t0Doc], keywords: ['hydraulic hose fittings'],
  })
  const t0QuotesVerifiable = t0.status === 200
    && Array.isArray(t0.body?.evidence)
    && t0.body.evidence.length > 0
    && t0.body.evidence.every((e) => t0Doc.text.includes(e.quote))
  check('T0 规则抽取：引用逐字可核验、不调模型、不补零',
    t0QuotesVerifiable && t0.body.extractor === 'rules' && t0.body.sourceMode === 'provided-text',
    `status=${t0.status} facts=${t0.body?.coverage?.hitFields?.length ?? 0}/${t0.body?.coverage?.dimensions?.length ?? 0} evidence=${t0.body?.evidence?.length ?? 0}`)

  const t0Bad = await post('/v1/t0/extract', {
    company_id: 'smoke_t0', sources: [{ url: 'not-a-url', text: 'x', fetched_at: '2026-11-08' }],
  })
  check('T0 非法来源被 400 E6004 拒绝（不拿缺失来源硬凑事实）',
    t0Bad.status === 400 && t0Bad.body.code === 'E6004',
    `status=${t0Bad.status} code=${t0Bad.body?.code}`)

  const t0Email = await post('/v1/email/generate', {
    anchor: 'client supplied anchor', product: 'hydraulic hose fittings',
    advantages: ['stable lead times'], purpose: 'intro', tone: 'concise',
    maxWords: 90, language: 'en', country: '美国', sources: [t0Doc],
  })
  check('写信链路接入 T0：锚点来源可核验，且降级时不伪造正文',
    t0Email.body?.anchorSource === 't0-rules'
    && t0Email.body?.t0?.ok === true
    && typeof t0Email.body?.anchor === 'string'
    && t0Doc.text.includes(t0Email.body.anchor)
    && (t0Email.status === 503 ? t0Email.body?.body === null : typeof t0Email.body?.body === 'string'),
    `status=${t0Email.status} anchorSource=${t0Email.body?.anchorSource}`)

  const pointsMid = await req('/v1/points')
  check('降级 / 校验拒绝 / T0 抽取类调用不消耗账本点数',
    pointsMid.status === 200 && pointsMid.body?.available === points?.available
    && pointsMid.body?.held === 0 && pointsMid.body?.spent === points?.spent,
    `before=${points?.available} after=${pointsMid.body?.available} held=${pointsMid.body?.held}`)

  const gates = await req('/v1/eval/gates')
  check('评测门禁清单可读', gates.status === 200 && gates.body.baselineSize === 385,
    `status=${gates.status} baseline=${gates.body?.baselineSize}`)

  // v0.8.0 决策：不做 385 人工标注集，口径改为 integrity + outcome（零人工、永不宣称准确率）
  check('v0.8.0 评测口径：标注契约 legacy、integrity + outcome、accuracyClaim=false',
    gates.status === 200 && gates.body?.accuracyClaim === false
    && gates.body?.labelsRequired === false
    && gates.body?.legacy === true
    && gates.body?.integrityGate?.gateVersion === 'integrity-gate-v1'
    && gates.body?.outcomeGate?.gateVersion === 'outcome-gate-v1'
    && gates.body?.release?.releaseEligible === false,
    `mode=${gates.body?.evalMode} accuracyClaim=${gates.body?.accuracyClaim} internal=${gates.body?.release?.internalPreviewReady}`)

  const integrityEmpty = await post('/v1/eval/integrity', { records: [] })
  check('integrity 门禁无真实样本返回 NO_DATA，不拿合成样本凑通过',
    integrityEmpty.status === 200 && integrityEmpty.body?.status === 'NO_DATA'
    && integrityEmpty.body?.accuracyClaim === false,
    `status=${integrityEmpty.body?.status}`)

  const outcomeEmpty = await post('/v1/eval/outcome', { events: [] })
  check('outcome 门禁无真实发送样本返回 NO_DATA，不伪造退信率',
    outcomeEmpty.status === 200 && outcomeEmpty.body?.status === 'NO_DATA',
    `status=${outcomeEmpty.body?.status}`)

  // B4：评测端点不得被请求参数绕过（下调样本门槛 / 放大窗口稀释退信率）
  const floorRecord = {
    provenance: { matched: 1, total: 1 }, rules: { passed: 2, total: 2 },
    schemaPass: true, refused: false,
    quote: 'we import fittings', sourceText: 'about: we import fittings from asia',
  }
  const floor = await post('/v1/eval/integrity', { records: [floorRecord], minSamples: 1 })
  check('评测端点不允许下调 minSamples：单条证据 + minSamples=1 仍被契约下限挡住',
    floor.status === 200 && floor.body?.minSamples === 100
    && floor.body?.ok === false && floor.body?.status === 'BLOCKED',
    `minSamples=${floor.body?.minSamples} status=${floor.body?.status}`)

  const diluted = await post('/v1/eval/outcome', {
    events: [
      ...Array.from({ length: 900 }, () => 'sent'),
      ...Array.from({ length: 100 }, (_, i) => (i < 4 ? 'bounced' : 'sent')),
    ],
    windowSize: 1000, minSamples: 1,
  })
  check('评测端点不允许放大 windowSize 稀释退信率：最近 100 条 4% 退信仍 BLOCKED',
    diluted.status === 200 && diluted.body?.windowSize === 100
    && diluted.body?.minSamples === 30 && diluted.body?.ok === false
    && diluted.body?.status === 'BLOCKED',
    `window=${diluted.body?.windowSize} min=${diluted.body?.minSamples} rate=${diluted.body?.metrics?.bounce_rate}`)

  const releaseProbe = await req('/v1/release/status')
  check('GET /v1/release/status：真实证据判定摘要，阻断项由结果生成（不回传原文）',
    releaseProbe.status === 200 && releaseProbe.body?.ok === true
    && releaseProbe.body?.releaseEligible === false
    && releaseProbe.body?.accuracyClaim === false
    && releaseProbe.body?.integrity?.status === 'NO_DATA'
    && Array.isArray(releaseProbe.body?.blockers) && releaseProbe.body.blockers.length >= 4
    && !JSON.stringify(releaseProbe.body).includes('"sourceText":'),
    `blockers=${releaseProbe.body?.blockers?.length} eligible=${releaseProbe.body?.releaseEligible}`)

  const evalRun = await post('/v1/eval/run', { results: [] })
  check('无标注样本返回 NO_DATA，不编造通过',
    evalRun.status === 200 && evalRun.body.status === 'NO_DATA'
    && evalRun.body.diffEndpoint === 'POST /v1/eval/diff'
    && !JSON.stringify(evalRun.body).includes('需在 CI'),
    `status=${evalRun.body?.status} diff=${evalRun.body?.diffEndpoint}`)

  const diffBad = await post('/v1/eval/diff', { prev: {}, current: {} })
  check('评测 diff 非法归档被 400 E4006 拒绝，不凑假报告',
    diffBad.status === 400 && diffBad.body?.code === 'E4006',
    `status=${diffBad.status} code=${diffBad.body?.code}`)

  const emptyArchive = { ok: false, status: 'NO_DATA', baselineVersion: 'none', metrics: {} }
  const diffNoData = await post('/v1/eval/diff', { prev: emptyArchive, current: emptyArchive })
  check('评测 diff：无基线时 NO_BASELINE，不生成数值 delta、不宣称可发布',
    diffNoData.status === 200 && diffNoData.body?.status === 'NO_BASELINE'
    && diffNoData.body?.releaseEligible === false
    && diffNoData.body?.rows?.every((r) => r.delta === null),
    `status=${diffNoData.body?.status} rows=${diffNoData.body?.rows?.length ?? 0}`)

  check('/health 暴露可执行 diff 端点与契约版本',
    health.body?.baseline?.diffEndpoint === 'POST /v1/eval/diff'
    && typeof health.body?.baseline?.diffVersion === 'string',
    `endpoint=${health.body?.baseline?.diffEndpoint} version=${health.body?.baseline?.diffVersion}`)

  const created = await post('/v1/tasks', {
    keywords: ['hydraulic fittings'], markets: ['德国'], customerTypes: ['distributor'],
    depth: 2, targetCount: 20,
  })
  check('云端任务创建成功且已幂等预扣点数',
    created.status === 201 && created.body?.task?.id && created.body?.task?.ledger?.reserved > 0,
    `status=${created.status} id=${created.body?.task?.id} reserved=${created.body?.task?.ledger?.reserved ?? 0}`)

  const noPoints = await post('/v1/tasks', {
    keywords: ['hydraulic fittings'], markets: ['德国'], depth: 4, targetCount: 1000,
  })
  check('点数不足时 402 E4001 拒绝创建，绝不先跑再补扣',
    noPoints.status === 402 && noPoints.body?.code === 'E4001',
    `status=${noPoints.status} code=${noPoints.body?.code}`)

  const taskId = created.body?.task?.id
  if (taskId) {
    const events = await sseProbe(taskId)
    check('SSE 真实推送事件', events.includes('hello') && events.length >= 2,
      `events=${events.slice(0, 6).join(',')}`)

    const aborted = await post(`/v1/tasks/${taskId}/abort`, {})
    check('中止任务并保留游标', aborted.status === 200 && aborted.body?.task?.status === 'aborted',
      `status=${aborted.status} offset=${aborted.body?.task?.cursor?.offset}`)
    check('任务快照显式标注 sourceMode=demo 且数据源未接入',
      aborted.body?.task?.sourceMode === 'demo'
      && aborted.body?.task?.dataSources?.ready === 0
      && aborted.body?.task?.progress?.sources?.every((s) => s.mode === 'unconfigured'),
      `sourceMode=${aborted.body?.task?.sourceMode} ready=${aborted.body?.task?.dataSources?.ready}`)
    check('中止后账本完成结算/释放并留痕，不重复扣点',
      ['settled', 'released'].includes(aborted.body?.task?.ledger?.settled)
      && aborted.body?.task?.progress?.log?.some((l) => l.text.includes('点数账本')),
      `settled=${aborted.body?.task?.ledger?.settled} used=${aborted.body?.task?.pointsUsed}`)
  }

  // v0.6.0：并发队列必须在真实 HTTP 链路上验证，不能只靠单测
  const queueCfg = { keywords: ['queue smoke'], markets: ['德国'], depth: 2, targetCount: 20 }
  const q = []
  for (let i = 0; i < 4; i++) q.push(await post('/v1/tasks', queueCfg))
  const qIds = q.map((r) => r.body?.task?.id).filter(Boolean)
  check('并发上限 3 真实生效，第 4 个任务如实排队并带队列位次',
    q.every((r) => r.status === 201)
    && q.filter((r) => r.body?.task?.status === 'running').length === 3
    && q[3]?.body?.task?.status === 'queued'
    && q[3]?.body?.task?.queuePosition === 1
    && q[3]?.body?.task?.maxConcurrent === 3,
    `statuses=${q.map((r) => r.body?.task?.status ?? r.status).join(',')} pos=${q[3]?.body?.task?.queuePosition}`)

  if (qIds.length === 4) {
    const firstAbort = await post(`/v1/tasks/${qIds[0]}/abort`, {})
    const dequeued = await req(`/v1/tasks/${qIds[3]}`)
    check('槽位释放后队首自动出队，无需手动继续',
      firstAbort.status === 200
      && dequeued.status === 200
      && dequeued.body?.task?.status === 'running'
      && dequeued.body?.task?.queuePosition === 0
      && dequeued.body?.task?.activeCount <= 3
      && dequeued.body?.task?.progress?.log?.some((l) => l.text.includes('队列出队')),
      `status=${dequeued.body?.task?.status} active=${dequeued.body?.task?.activeCount}`)

    const resumeQueued = await post(`/v1/tasks/${qIds[3]}/resume`, {})
    check('对运行中任务重复「继续」不会伪造排队状态',
      resumeQueued.status === 409 || resumeQueued.body?.task?.status === 'running',
      `status=${resumeQueued.status}`)

    for (const id of qIds.slice(1)) await post(`/v1/tasks/${id}/abort`, {})
  }

  const queueHealth = await req('/health')
  check('/health 如实暴露运行/排队计数与 FIFO 出队模式',
    queueHealth.body?.orchestrator?.maxConcurrent === 3
    && queueHealth.body?.orchestrator?.queueMode === 'fifo-auto-dequeue'
    && Number.isInteger(queueHealth.body?.orchestrator?.running)
    && Number.isInteger(queueHealth.body?.orchestrator?.queued)
    && queueHealth.body.orchestrator.queued === 0,
    `running=${queueHealth.body?.orchestrator?.running} queued=${queueHealth.body?.orchestrator?.queued}`)

  const pointsAfter = await req('/v1/points')
  check('任务收尾后账本余额恒等式仍成立',
    pointsAfter.status === 200
    && pointsAfter.body?.available + pointsAfter.body?.held + pointsAfter.body?.spent === pointsAfter.body?.granted,
    `available=${pointsAfter.body?.available} held=${pointsAfter.body?.held} spent=${pointsAfter.body?.spent}`)

  const audit = await req('/v1/gateway/audit')
  const entries = Array.isArray(audit.body?.entries) ? audit.body.entries : []
  check('调用审计记录元数据（含降级）', entries.length > 0 && entries.every((e) => !('prompt' in e)),
    `entries=${entries.length} last=${entries.at(-1)?.taskType ?? 'n/a'}/${entries.at(-1)?.code ?? 'ok'}`)

  // ---- v0.7.0 批量 SDR 管道（定位仍为自动获客）--------------------------------
  const batchHealth = await req('/v1/batch/health')
  check('/health 与 /v1/batch/health 如实暴露内测定位，且 releaseEligible 恒 false',
    batchHealth.status === 200
    && health.body?.batch?.positioning === 'auto_prospecting'
    && health.body?.batch?.releaseEligible === false
    && batchHealth.body?.stage === 'internal_preview'
    && batchHealth.body?.releaseEligible === false,
    `companies=${batchHealth.body?.companies} circuit=${batchHealth.body?.circuitOpen}`)

  const smokeDomain = `smoke-${Date.now()}.example`
  const imp = await post('/v1/import/companies', { rows: [
    { company_name: 'Smoke Trading', domain: smokeDomain, source_url: `https://${smokeDomain}/about`, fetched_at: '2026-11-09', raw_text: 'We import hydraulic hose fittings from Asia.' },
    { company_name: 'Bad row', domain: 'not-a-domain' },
  ] })
  check('批量导入：origin=user_imported，坏行逐条拒绝且不影响整批',
    imp.status === 200 && imp.body?.origin === 'user_imported'
    && imp.body?.summary?.accepted === 1 && imp.body?.summary?.rejected === 1
    && /导入 ≠ 采集/.test(imp.body?.note ?? ''),
    `status=${imp.status} accepted=${imp.body?.summary?.accepted} rejected=${imp.body?.summary?.rejected}`)

  const listed = await req('/v1/import/companies')
  check('导入清单可查且明确声明「不代表系统采集结果」',
    listed.status === 200 && listed.body?.companies?.some((c) => c.domain === smokeDomain)
    && /不代表系统采集结果/.test(listed.body?.note ?? ''),
    `count=${listed.body?.count}`)

  const batchJudge = await post('/v1/batch/judge', { domains: [smokeDomain] })
  check('批量研判端点返回逐条分桶，T0 规则事实链已执行且不解除发布门禁',
    batchJudge.status === 200 && batchJudge.body?.summary?.total === 1
    && batchJudge.body?.items?.[0]?.t0?.used === true
    && batchJudge.body?.releaseEligible === false,
    `succeeded=${batchJudge.body?.summary?.succeeded} degraded=${batchJudge.body?.summary?.degraded}`)

  const sender = {
    name: 'Smoke Sender', email: 'smoke@example.com', company: 'Smoke Trading Co',
    postalAddress: '1 Industrial Road, Shenzhen, China',
    unsubscribe: 'Reply STOP to unsubscribe / 退订',
  }
  const footer = [sender.name, sender.company, sender.postalAddress, sender.unsubscribe].join(' | ')
  const draftItem = {
    domain: smokeDomain, to: `buyer@${smokeDomain}`, subject: 'Hydraulic fittings supply',
    body: 'We noticed your company distributes industrial fittings across Benelux. We manufacture hydraulic hose fittings and can share our current catalogue and lead times. Would a short specification sheet be useful for your team this quarter?',
    grade: 'B', sender, footer,
  }
  const exp = await post('/v1/export/eml', { items: [draftItem, { ...draftItem, grade: 'D' }] })
  const circuitWasOpen = batchHealth.body?.circuitOpen === true
  check('草稿导出：合规草稿放行 / D 级禁发，导出 ≠ 发送（熔断时如实 423 E4010）',
    circuitWasOpen
      ? exp.status === 423 && exp.body?.code === 'E4010'
      : exp.status === 200 && exp.body?.count === 1 && exp.body?.blocked?.length === 1
        && exp.body?.exportedIsNotSent === true && exp.body?.statusAfterExport === 'drafted'
        && /X-LeadPilot-Status: drafted/.test(exp.body?.content ?? '')
        && /D 级/.test(exp.body?.blocked?.[0]?.reasons?.join('') ?? ''),
    `status=${exp.status} count=${exp.body?.count ?? 0} circuit=${circuitWasOpen}`)

  const outcomes = await post('/v1/import/outcomes', { events: [
    { domain: smokeDomain, event: 'replied' },
    { domain: smokeDomain, event: 'unsubscribed' },
  ] })
  check('结果回写：自动白名单放行，不可逆终态未确认时明确拒绝',
    outcomes.status === 200 && outcomes.body?.applied?.length === 1
    && outcomes.body?.applied?.[0]?.event === 'replied'
    && outcomes.body?.rejected?.[0]?.reasons?.join('')?.includes('人工确认') === true,
    `applied=${outcomes.body?.applied?.length} rejected=${outcomes.body?.rejected?.length}`)

  const width = Math.max(...results.map((r) => r.name.length))
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`)
  console.log(`\n${results.length - failures}/${results.length} checks passed · base=${BASE}`)
  if (failures) process.exitCode = 1
}

main().catch((err) => { console.error(err); process.exitCode = 1 })
