/**
 * LeadPilot 云端服务入口 · Node 22 原生 http（零额外依赖）
 *
 * 启动：node server/index.mjs        （默认 127.0.0.1:5181）
 * 配置：DEEPSEEK_API_KEY / OPENAI_API_KEY / ... 见 shared/model-protocol.json 的 providers.envKey
 * 说明：未配置 Key / 未锁定模型快照时，网关返回 E6005 / E6008 降级；编排器事件带 demo:true。
 *      本服务不保存任何凭据、不记录客户原文或邮箱；任务游标、缓存与审计落本地持久化存储。
 */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { createGateway } from './gateway.mjs'
import { createOrchestrator, MAX_CONCURRENT } from './orchestrator.mjs'
import { protocol, assertNoPii } from './protocol.mjs'
import { evaluateBaseline, baselineManifest, diffEvalRuns } from './eval.mjs'
import { createStore } from './store.mjs'
import { createLedger, LEDGER_VERSION } from './ledger.mjs'
import { extractFacts, T0_RULES_VERSION } from './t0.mjs'
import { createDataSourceRegistry } from './data-sources.mjs'
import {
  contract as baselineContract, BASELINE_CONTRACT_VERSION,
  validateBaselineImport, checkLabeledBaseline,
} from './baseline.mjs'

const PORT = Number(process.env.LEADPILOT_PORT ?? 5181)
const HOST = process.env.LEADPILOT_HOST ?? '127.0.0.1'
const MAX_BODY = 256 * 1024
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const IS_LOOPBACK = LOOPBACK_HOSTS.has(HOST)
const API_TOKEN = process.env.LEADPILOT_API_TOKEN ?? ''
const CORS_LIST = (process.env.LEADPILOT_CORS ?? 'http://127.0.0.1:5180')
  .split(',').map((x) => x.trim()).filter(Boolean)
const RATE_LIMIT = Math.max(1, Number(process.env.LEADPILOT_RATE_LIMIT ?? 120))
const DEFAULT_SECURITY = {
  token: API_TOKEN,
  loopback: IS_LOOPBACK,
  cors: CORS_LIST,
  rateLimit: RATE_LIMIT,
}

export function createApp(opts = {}) {
  const store = opts.store ?? createStore()
  const ledger = opts.ledger ?? createLedger({ store })
  // v0.6.0：把同一个账本实例注入网关，judge / write_email 才产生真实预扣/结算；
  // 独立创建的网关（部分单测）没有 ledger，仍只产出审计估值并在响应里如实标注。
  const gateway = opts.gateway ?? createGateway({ store, ledger })
  const dataSources = opts.dataSources ?? opts.orchestratorOptions?.dataSources ?? createDataSourceRegistry()
  const orchestrator = opts.orchestrator ?? createOrchestrator({ ...(opts.orchestratorOptions ?? {}), store, ledger, dataSources })
  // 允许测试注入独立的安全上下文，不污染进程级默认值
  const sec = { ...DEFAULT_SECURITY, ...(opts.security ?? {}) }
  const hits = new Map() // ip -> { count, resetAt }

  function securityInfo() {
    return {
      mode: sec.token ? 'token' : 'local-open',
      loopback: sec.loopback,
      cors: sec.cors,
      rateLimitPerMinute: sec.rateLimit,
      note: '仅本机回环且未设置令牌时免鉴权；对外监听必须配置 LEADPILOT_API_TOKEN 且 CORS 不得为 *。',
    }
  }

  /** 每个请求按 Origin 白名单决定 Allow-Origin，绝不默认通配 */
  function applyCors(req, res) {
    const origin = req.headers?.origin
    const allowed = sec.cors.includes('*')
      ? '*'
      : (origin && sec.cors.includes(origin) ? origin : (sec.cors[0] ?? 'http://127.0.0.1:5180'))
    res.setHeader('Access-Control-Allow-Origin', allowed)
    res.setHeader('Vary', 'Origin')
  }

  function cors(res) {
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-leadpilot-token')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  }

  /** 本地回环默认免鉴权；一旦设置 token 或非本机部署，必须携带有效令牌 */
  function authOk(req) {
    if (!sec.token) return sec.loopback
    const bearer = String(req.headers?.authorization ?? '')
    const supplied = bearer.startsWith('Bearer ') ? bearer.slice(7) : String(req.headers?.['x-leadpilot-token'] ?? '')
    return supplied.length > 0 && supplied === sec.token
  }

  function rateOk(req, res) {
    const ip = req.socket?.remoteAddress ?? 'unknown'
    const now = Date.now()
    let rec = hits.get(ip)
    if (!rec || now >= rec.resetAt) { rec = { count: 0, resetAt: now + 60_000 }; hits.set(ip, rec) }
    rec.count += 1
    if (rec.count > sec.rateLimit) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rec.resetAt - now) / 1000))))
      return false
    }
    return true
  }

  function json(res, status, body) {
    cors(res)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  /** PRD A.2：错误文案统一「发生了什么 + 可能原因 + 你可以怎么做 + 错误码」 */
  function fail(res, status, code, what, why, action) {
    json(res, status, {
      ok: false, code,
      what, why, action,
      message: `${what}。可能原因：${why}。你可以：${action}（${code}）`,
    })
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (c) => {
        size += c.length
        if (size > MAX_BODY) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); return }
        chunks.push(c)
      })
      req.on('end', () => {
        if (!chunks.length) return resolve({})
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { reject(new Error('INVALID_JSON')) }
      })
      req.on('error', reject)
    })
  }

  function sse(req, res, taskId) {
    const task = orchestrator.getTask(taskId)
    if (!task) { fail(res, 404, 'E1003', '任务不存在', '任务 ID 有误或已被清理', '重新创建任务'); return }
    cors(res)
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    send('hello', {
      taskId, snapshot: task, demo: true,
      note: 'SSE 为真实推送；数据源适配器未接入，事件中的候选域名为占位标识',
    })
    const unsub = orchestrator.subscribe(taskId, (evt) => send(evt.type, evt))
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000)
    req.on('close', () => { clearInterval(keepAlive); unsub() })
  }

  const server = createServer(async (req, res) => {
    applyCors(req, res)
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)
    const path = url.pathname
    const method = req.method ?? 'GET'

    if (method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return }
    if (!rateOk(req, res)) {
      return fail(res, 429, 'E6010', '请求过于频繁', `同一 IP 每分钟超过 ${sec.rateLimit} 次`, '稍后重试或调高 LEADPILOT_RATE_LIMIT')
    }
    // /health 供探活与前端启动探测，其余 /v1/* 全部要求鉴权（配置了 token 或对外监听时）
    if (!(method === 'GET' && path === '/health') && !authOk(req)) {
      return fail(res, 401, 'E6009', '访问令牌缺失或无效', '服务端要求携带有效令牌', '在请求头加 Authorization: Bearer <LEADPILOT_API_TOKEN>')
    }

    try {
      if (method === 'GET' && path === '/health') {
        return json(res, 200, {
          ok: true, service: 'leadpilot-cloud', version: '0.6.0',
          gateway: gateway.health(),
          orchestrator: (() => {
            const list = orchestrator.listTasks()
            return {
              tasks: list.length,
              running: list.filter((t) => t.status === 'running').length,
              queued: list.filter((t) => t.status === 'queued').length,
              maxConcurrent: orchestrator.maxConcurrent ?? MAX_CONCURRENT,
              queueMode: 'fifo-auto-dequeue',
            }
          })(),
          protocol: { schemaVersion: protocol.schemaVersion, promptVersion: protocol.promptVersion },
          security: securityInfo(),
          persistence: {
            mode: store.mode,
            durable: store.mode !== 'memory',
            recoveredTasks: orchestrator.recoveredIds?.length ?? 0,
          },
          points: ledger.health(),
          billing: {
            ledgerVersion: LEDGER_VERSION,
            mode: 'unified-ledger-v1',
            gatewayVersion: protocol.billing.gatewayBilling.version,
            scope: protocol.billing.ledger.scope,
            ledgerConsumers: protocol.billing.ledger.ledgerConsumers,
            auditOnlyConsumers: protocol.billing.ledger.auditOnlyConsumers,
            reservePoints: protocol.billing.gatewayBilling.reservePoints,
            chargeOn: protocol.billing.gatewayBilling.chargeOn,
            releaseOn: protocol.billing.gatewayBilling.releaseOn,
            noChargeOn: protocol.billing.gatewayBilling.noChargeOn,
            note: '云端任务与网关真实调用共用一本账：有可用 provider 才预扣，内容校验通过才结算，失败/降级/缓存命中一律不扣点并全额释放。未注入账本的独立网关仍只产出审计估值。',
          },
          baseline: {
            contractVersion: BASELINE_CONTRACT_VERSION,
            importStatus: checkLabeledBaseline().status,
            requiredSize: baselineContract.baselineSize,
            diffEndpoint: protocol.evalDiff.endpoint,
            diffVersion: protocol.evalDiff.version,
            releaseEligible: false,
          },
          t0: {
            extractor: 'rules', rulesVersion: T0_RULES_VERSION, sourceMode: 'provided-text',
            judgeFactChain: {
              enabled: protocol.judgeFactChain.enabled,
              onConflict: protocol.judgeFactChain.onConflict,
              note: '调用方提供可核验 sources 时，T0 规则事实进入 judge Prompt；冲突由代码保守裁决，未命中维度不补零。',
            },
          },
          dataSources: (() => {
            const d = dataSources.health()
            return { mode: d.mode, total: d.total, configured: d.configured, readyCount: d.readyCount }
          })(),
          demo: gateway.health().mode === 'unconfigured-demo',
        })
      }
      if (method === 'GET' && path === '/v1/gateway/health') {
        return json(res, 200, {
          ...gateway.health(), security: securityInfo(),
          points: ledger.health(),
          billing: {
            mode: 'unified-ledger-v1',
            version: protocol.billing.gatewayBilling.version,
            scope: protocol.billing.ledger.scope,
            ledgerConsumers: protocol.billing.ledger.ledgerConsumers,
            auditOnlyConsumers: protocol.billing.ledger.auditOnlyConsumers,
            reservePoints: protocol.billing.gatewayBilling.reservePoints,
            releaseOn: protocol.billing.gatewayBilling.releaseOn,
          },
          baseline: {
            contractVersion: BASELINE_CONTRACT_VERSION,
            importStatus: checkLabeledBaseline().status,
            requiredSize: baselineContract.baselineSize,
            diffEndpoint: protocol.evalDiff.endpoint,
            diffVersion: protocol.evalDiff.version,
            releaseEligible: false,
          },
          t0: {
            extractor: 'rules', rulesVersion: T0_RULES_VERSION, sourceMode: 'provided-text',
            judgeFactChain: { enabled: protocol.judgeFactChain.enabled, onConflict: protocol.judgeFactChain.onConflict },
          },
          dataSources: (() => {
            const d = dataSources.health()
            return { mode: d.mode, total: d.total, configured: d.configured, readyCount: d.readyCount }
          })(),
        })
      }
      if (method === 'GET' && path === '/v1/gateway/audit') return json(res, 200, { entries: gateway.getAudit(), circuit: gateway.getCircuitState(), cache: gateway.getCacheStats() })
      if (method === 'GET' && path === '/v1/eval/gates') return json(res, 200, baselineManifest())
      if (method === 'GET' && path === '/v1/eval/baseline/contract') {
        return json(res, 200, { contractVersion: BASELINE_CONTRACT_VERSION, ...baselineContract, note: '本接口只返回契约，不返回任何标注样本。' })
      }
      if (method === 'POST' && path === '/v1/eval/baseline/validate') {
        const body = await readBody(req)
        const result = validateBaselineImport(body)
        return json(res, result.ok ? 200 : 400, result)
      }
      if (method === 'GET' && path === '/v1/points') {
        const account = url.searchParams.get('account') ?? undefined
        const refId = url.searchParams.get('refId') ?? undefined
        const state = ledger.state(account)
        const entries = refId ? ledger.entries(refId, 50) : ledger.allEntries(50)
        return json(res, 200, {
          ...state,
          entries,
          scope: protocol.billing.ledger.scope,
          ledgerConsumers: protocol.billing.ledger.ledgerConsumers,
          note: '只读接口。账本覆盖云端任务与网关真实调用的预扣/结算/释放；未注入账本的独立网关才只产出审计估值。',
        })
      }
      if (method === 'GET' && path === '/v1/tasks') return json(res, 200, { tasks: orchestrator.listTasks() })

      if (method === 'POST' && path === '/v1/judge') {
        const body = await readBody(req)
        const pii = assertNoPii({ facts: body.facts ?? {}, profile: body.profile ?? {} })
        if (!pii.ok) {
          return fail(res, 400, 'E6004', '请求体含禁止字段', `数据最小化要求剔除个人信息，命中：${pii.violations.join('、')}`, '移除邮箱/电话/联系人姓名/邮件正文后重试')
        }
        const result = await gateway.judge(body)
        // E4001 / E4005 是计费拒绝，不是「服务降级」；用 402 / 409 表达，避免前端误判为可重试的模型故障
        const status = result.ok ? 200 : result.needsConsent ? 403
          : result.code === 'E4001' ? 402 : result.code === 'E4005' ? 409 : 503
        return json(res, status, { ok: !!result.ok, ...result })
      }

      // T0 规则抽取：不调用模型、不联网；输入必须是调用方已拿到的原文
      if (method === 'POST' && path === '/v1/t0/extract') {
        const body = await readBody(req)
        const result = extractFacts(body)
        if (!result.ok) {
          return fail(res, 400, 'E6004', 'T0 抽取输入不合法', result.errors.join('；'), '补全 sources / url / fetched_at，并剔除个人信息后重试')
        }
        return json(res, 200, result)
      }

      if (method === 'POST' && path === '/v1/email/generate') {
        const body = await readBody(req)
        const pii = assertNoPii({ facts: {
          anchor: body.anchor, product: body.product, advantages: body.advantages,
          purpose: body.purpose, tone: body.tone, language: body.language,
        } })
        if (!pii.ok) {
          return fail(res, 400, 'E6004', '写信请求体含禁止字段', `数据最小化要求剔除个人信息，命中：${pii.violations.join('、')}`, '移除收件人邮箱/联系人姓名/邮件正文后重试')
        }
        const result = await gateway.writeEmail(body)
        const status = result.ok ? 200 : result.needsConsent ? 403
          : result.code === 'E4001' ? 402 : result.code === 'E4005' ? 409 : 503
        return json(res, status, { ok: !!result.ok, ...result })
      }

      if (method === 'POST' && path === '/v1/eval/run') {
        const body = await readBody(req)
        return json(res, 200, evaluateBaseline(body.results ?? [], body.baselineVersion ?? 'unversioned'))
      }

      // v0.6.0：版本 diff 是可执行的纯函数，不再是「需在 CI 中生成」的占位说明
      if (method === 'POST' && path === '/v1/eval/diff') {
        const body = await readBody(req)
        const result = diffEvalRuns(body.prev, body.current)
        return json(res, result.status === 'INVALID_INPUT' ? 400 : 200, result)
      }

      if (method === 'POST' && path === '/v1/tasks') {
        const body = await readBody(req)
        if (!body.keywords?.length || !body.markets?.length) {
          return fail(res, 400, 'E1003', '任务参数不完整', '关键词与目标市场为必填项', '补全参数后重新提交')
        }
        const created = orchestrator.createTask(body)
        if (created?.ok === false) {
          // 预扣失败：不创建任务、不扣点、不伪造 201
          return fail(res, 402, created.code ?? 'E4001',
            '点数预扣失败，任务未创建',
            created.reason ?? '账本拒绝预扣',
            created.action ?? '降低目标数量或采集深度后重试')
        }
        return json(res, 201, { ok: true, task: created, demo: true })
      }

      const taskMatch = path.match(/^\/v1\/tasks\/([^/]+)(?:\/(events|pause|resume|abort))?$/)
      if (taskMatch) {
        const [, id, action] = taskMatch
        if (method === 'GET' && action === 'events') return sse(req, res, id)
        if (method === 'GET' && !action) {
          const task = orchestrator.getTask(id)
          return task ? json(res, 200, { ok: true, task }) : fail(res, 404, 'E1003', '任务不存在', 'ID 有误或已清理', '重新创建任务')
        }
        if (method === 'POST' && ['pause', 'resume', 'abort'].includes(action)) {
          const body = await readBody(req)
          const task = action === 'pause' ? orchestrator.pause(id)
            : action === 'abort' ? orchestrator.abort(id)
              : orchestrator.resume(id, body.cursor)
          return task ? json(res, 200, { ok: true, task }) : fail(res, 409, 'E1003', '任务状态不允许该操作', '任务已完成或不存在', '检查任务状态后重试')
        }
      }

      return fail(res, 404, 'E5002', '接口不存在', `路径 ${path} 未注册`, '检查 API 路径与方法')
    } catch (err) {
      const msg = String(err?.message ?? err)
      if (msg === 'INVALID_JSON') return fail(res, 400, 'E5002', '请求体不是合法 JSON', '序列化失败或内容被截断', '检查请求体格式')
      if (msg === 'BODY_TOO_LARGE') return fail(res, 413, 'E5002', '请求体过大', '超过 256 KB 限制', '压缩或分批提交')
      return fail(res, 500, 'E5002', '服务内部错误', msg, '查看服务端日志并重试')
    }
  })

  return { server, gateway, orchestrator, store, ledger }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  // 启动前硬校验：绝不在「对外监听 + 无鉴权 / CORS 通配」的组合下静默放行
  if (!IS_LOOPBACK && !API_TOKEN) {
    // eslint-disable-next-line no-console
    console.error('[LeadPilot] SECURITY_CONFIG: 非本机监听必须设置 LEADPILOT_API_TOKEN，服务拒绝启动。')
    process.exit(1)
  }
  if (!IS_LOOPBACK && CORS_LIST.includes('*')) {
    // eslint-disable-next-line no-console
    console.error('[LeadPilot] SECURITY_CONFIG: 非本机监听禁止 CORS 通配 *，请显式列出允许的前端来源。')
    process.exit(1)
  }
  const { server, gateway, store, ledger } = createApp()
  server.listen(PORT, HOST, () => {
    const h = gateway.health()
    const p = ledger.health()
    // eslint-disable-next-line no-console
    console.log(`[LeadPilot] cloud API http://${HOST}:${PORT} · providers ${h.readyCount}/${h.totalProviders} ready (${h.configuredCount} keys / ${h.pinnedCount} pinned) · mode=${h.mode} · security=${API_TOKEN ? 'token' : 'local-open'} · persistence=${store.mode} · ledger=${p.available}/${p.granted} available (${p.held} held / ${p.spent} spent)`)
  })
  const shutdown = () => server.close(() => { store.close(); process.exit(0) })
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
