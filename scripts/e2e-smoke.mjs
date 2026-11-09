/**
 * 云端服务端到端冒烟验证。
 *
 * 用法：node server/index.mjs  （另开终端）
 *       node scripts/e2e-smoke.mjs
 *
 * 纪律：只验证「真实实现」与「显式降级」，不把降级当成功，也不编造采集结果。
 * 未配置 API Key 时，/v1/judge 与 /v1/email/generate 必须明确返回 503 + E6005。
 */
const BASE = process.env.LEADPILOT_API ?? 'http://127.0.0.1:5181'
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
  check('云端服务健康检查', health.status === 200 && health.body.ok === true && health.body.version === '0.5.0',
    `status=${health.status} version=${health.body?.version} mode=${health.body?.gateway?.mode ?? 'n/a'}`)

  const points = health.body?.points
  check('点数账本健康如实暴露余额恒等式与范围',
    points && points.available + points.held + points.spent === points.granted
    && points.scope?.includes('task_reserve')
    && points.auditOnlyConsumers?.includes('judge'),
    `available=${points?.available} held=${points?.held} spent=${points?.spent} scope=${points?.scope?.length ?? 0}`)
  check('评测契约如实标注不可发布，T0 → judge 事实链已接线',
    health.body?.baseline?.releaseEligible === false
    && health.body?.t0?.judgeFactChain?.enabled === true,
    `import=${health.body?.baseline?.importStatus} chain=${health.body?.t0?.judgeFactChain?.onConflict}`)
  check('billing 明确区分账本扣点与 gateway 审计估值',
    health.body?.billing?.auditOnlyConsumers?.includes('write_email') === true,
    `mode=${health.body?.billing?.mode}`)

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

  const gates = await req('/v1/eval/gates')
  check('评测门禁清单可读', gates.status === 200 && gates.body.baselineSize === 385,
    `status=${gates.status} baseline=${gates.body?.baselineSize}`)

  const evalRun = await post('/v1/eval/run', { results: [] })
  check('无标注样本返回 NO_DATA，不编造通过',
    evalRun.status === 200 && evalRun.body.status === 'NO_DATA',
    `status=${evalRun.body?.status}`)

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

  const pointsAfter = await req('/v1/points')
  check('任务收尾后账本余额恒等式仍成立',
    pointsAfter.status === 200
    && pointsAfter.body?.available + pointsAfter.body?.held + pointsAfter.body?.spent === pointsAfter.body?.granted,
    `available=${pointsAfter.body?.available} held=${pointsAfter.body?.held} spent=${pointsAfter.body?.spent}`)

  const audit = await req('/v1/gateway/audit')
  const entries = Array.isArray(audit.body?.entries) ? audit.body.entries : []
  check('调用审计记录元数据（含降级）', entries.length > 0 && entries.every((e) => !('prompt' in e)),
    `entries=${entries.length} last=${entries.at(-1)?.taskType ?? 'n/a'}/${entries.at(-1)?.code ?? 'ok'}`)

  const width = Math.max(...results.map((r) => r.name.length))
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`)
  console.log(`\n${results.length - failures}/${results.length} checks passed · base=${BASE}`)
  if (failures) process.exitCode = 1
}

main().catch((err) => { console.error(err); process.exitCode = 1 })
