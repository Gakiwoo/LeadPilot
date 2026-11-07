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
  check('云端服务健康检查', health.status === 200 && health.body.ok === true,
    `status=${health.status} mode=${health.body?.gateway?.mode ?? 'n/a'}`)

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
  check('云端任务创建成功', created.status === 201 && created.body?.task?.id,
    `status=${created.status} id=${created.body?.task?.id}`)

  const taskId = created.body?.task?.id
  if (taskId) {
    const events = await sseProbe(taskId)
    check('SSE 真实推送事件', events.includes('hello') && events.length >= 2,
      `events=${events.slice(0, 6).join(',')}`)

    const aborted = await post(`/v1/tasks/${taskId}/abort`, {})
    check('中止任务并保留游标', aborted.status === 200 && aborted.body?.task?.status === 'aborted',
      `status=${aborted.status} offset=${aborted.body?.task?.cursor?.offset}`)
  }

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
