/**
 * LeadPilot 云端服务入口 · Node 22 原生 http（零额外依赖）
 *
 * 启动：node server/index.mjs        （默认 127.0.0.1:5181）
 * 配置：DEEPSEEK_API_KEY / OPENAI_API_KEY / ... 见 shared/model-protocol.json 的 providers.envKey
 * 说明：未配置 Key / 未锁定模型快照时，网关返回 E6005 / E6008 降级；编排器事件带 demo:true。
 *      本服务不保存任何凭据、不记录客户原文或邮箱；任务游标、缓存与审计落本地持久化存储。
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createHash, timingSafeEqual } from 'node:crypto'
import { createGateway } from './gateway.mjs'
import { createOrchestrator, MAX_CONCURRENT } from './orchestrator.mjs'
import { protocol, assertNoPii } from './protocol.mjs'
import { evaluateBaseline, baselineManifest, diffEvalRuns } from './eval.mjs'
import {
  evaluateIntegrity, evaluateOutcome, integrityManifest, outcomeManifest,
  INTEGRITY_GATE_VERSION, OUTCOME_GATE_VERSION, RELEASE_POLICY_VERSION,
} from './eval.mjs'
import { createStore } from './store.mjs'
import { createLedger, LEDGER_VERSION } from './ledger.mjs'
import { extractFacts, T0_RULES_VERSION } from './t0.mjs'
import { createDataSourceRegistry } from './data-sources.mjs'
import { createBatchPipeline, BATCH_VERSION } from './batch.mjs'
import { createFetcher, FETCH_VERSION } from './fetch.mjs'
import {
  contract as baselineContract, BASELINE_CONTRACT_VERSION,
  validateBaselineImport, checkLabeledBaseline,
} from './baseline.mjs'
import { evaluateReleaseEvidence } from './release-evidence.mjs'

// B3-4：版本号从 package.json 读取，/health 不再硬编码字面量（README 早已这样声明）
const PKG_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
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

const RATE_TABLE_MAX = 4096

/**
 * 待验证假设 #2（本次核查确认为真缺口）：
 * 旧实现在无 token 时直接 `return sec.loopback`，只看「监听地址」这个静态事实。
 * 反向代理把公网流量 proxy_pass 到 127.0.0.1:5181 时，socket 仍是回环、监听仍是回环，
 * 于是全部 /v1/* 对外免鉴权——「本机」这个概念被代理拓扑放大了。
 *
 * 修正：免鉴权必须同时满足「回环监听 + 回环对端 + 没有任何代理标记」。
 * 这里只判断标记头是否**存在**，绝不信任头里的 IP 值：伪造这些头只会让自己被要求
 * token（fail-closed），不可能用来绕过鉴权。
 */
const PROXY_MARKER_HEADERS = [
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
  'x-real-ip', 'forwarded', 'via',
]

function loopbackPeer(req) {
  const addr = String(req.socket?.remoteAddress ?? '').toLowerCase()
  return LOOPBACK_HOSTS.has(addr)
    || addr === '::ffff:127.0.0.1'
    || addr.startsWith('::ffff:127.')
    || addr.startsWith('127.')
}

function looksProxied(req) {
  const headers = req.headers ?? {}
  if (PROXY_MARKER_HEADERS.some((k) => String(headers[k] ?? '').trim().length > 0)) return true
  // Host 指向非本机名字，说明请求是经域名 / 反代暴露进来的
  const host = String(headers.host ?? '').split(':')[0].toLowerCase().replace(/^\[|\]$/g, '')
  return host.length > 0 && !LOOPBACK_HOSTS.has(host) && host !== '::1'
}

/**
 * P2 · 令牌恒定时间比较：先做等长 SHA-256 摘要再比较。
 * 直接 timingSafeEqual(Buffer.from(a), Buffer.from(b)) 在长度不等时会抛 RangeError
 * （把 401 变成 500），且逐字符比较会泄漏前缀；摘要后两者都消失。
 * 任意长度输入都不抛异常，超长直接拒绝，避免用巨型 header 做 CPU DoS。
 */
export function verifyToken(supplied, expected) {
  const a = String(supplied ?? '')
  const b = String(expected ?? '')
  if (!a || !b || a.length > 4096 || b.length > 4096) return false
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

/**
 * P2 · 限流表有界：旧实现每个 IP 一条记录、过期后只重置计数不删 key，
 * 长时间运行 / 大量不同来源会无限膨胀。这里优先淘汰已过期项，
 * 仍超上限时按插入顺序淘汰最旧项，并把淘汰次数暴露给行为级反例。
 */
export function createRateLimiter({ limit, now = () => Date.now(), maxEntries = RATE_TABLE_MAX } = {}) {
  const cap = Math.max(1, Number(limit) || 1)
  const ceiling = Math.max(1, Number(maxEntries) || RATE_TABLE_MAX)
  const hits = new Map() // ip -> { count, resetAt }
  let evictions = 0

  function prune(current, keepIp = null) {
    if (hits.size <= ceiling) return
    for (const [ip, rec] of hits) {
      if (ip === keepIp) continue
      if (current >= rec.resetAt) { hits.delete(ip); evictions += 1 }
    }
    if (hits.size > ceiling) {
      let overflow = hits.size - ceiling
      for (const ip of hits.keys()) {
        if (overflow <= 0) break
        if (ip === keepIp) continue
        hits.delete(ip)
        evictions += 1
        overflow -= 1
      }
    }
  }

  return {
    check(ip, res) {
      const current = now()
      let rec = hits.get(ip)
      if (!rec || current >= rec.resetAt) {
        rec = { count: 0, resetAt: current + 60_000 }
        hits.set(ip, rec)
      }
      // 插入后也要收敛，保证「任意时刻」表大小都 ≤ 上限；
      // keepIp 保护正在计数的来源，避免淘汰把活跃计数清零而绕过限流。
      prune(current, ip)
      rec.count += 1
      if (rec.count > cap) {
        res?.setHeader?.('Retry-After', String(Math.max(1, Math.ceil((rec.resetAt - current) / 1000))))
        return false
      }
      return true
    },
    stats: () => ({ entries: hits.size, evictions, maxEntries: ceiling, limit: cap }),
  }
}

export function createApp(opts = {}) {
  const store = opts.store ?? createStore()
  const ledger = opts.ledger ?? createLedger({ store })
  // P1-06：系统默认账户只在启动时初始化一次（固定账户、幂等），
  // 之后所有 GET /v1/points 一律纯读，任意 account 查询参数都不会开户写流水。
  ledger.state()
  // v0.6.0：把同一个账本实例注入网关，judge / write_email 才产生真实预扣/结算；
  // 独立创建的网关（部分单测）没有 ledger，仍只产出审计估值并在响应里如实标注。
  const gateway = opts.gateway ?? createGateway({ store, ledger })
  const dataSources = opts.dataSources ?? opts.orchestratorOptions?.dataSources ?? createDataSourceRegistry()
  const orchestrator = opts.orchestrator ?? createOrchestrator({ ...(opts.orchestratorOptions ?? {}), store, ledger, dataSources })
  // v0.7.0 批量 SDR 管道：与编排器共用同一 store / gateway / ledger，避免两本账
  // v0.9.0：注入用户指定 URL 抓取器（单独计数，不并入商业数据源 0/6）
  const fetcher = opts.fetcher ?? createFetcher()
  const batch = opts.batch ?? createBatchPipeline({ store, gateway, fetcher })
  // 允许测试注入独立的安全上下文，不污染进程级默认值
  const sec = { ...DEFAULT_SECURITY, ...(opts.security ?? {}) }
  // P2 · 回环下也不回显 ACAO:*：本机无 token 时，通配等于任意网页都能读取本机 API 响应。
  // 启动前置校验只拦「非回环 + *」，此处把通配从有效白名单里剔除并如实上报，绝不静默放行。
  const rawCors = Array.isArray(sec.cors) ? sec.cors : []
  const corsWildcardRejected = rawCors.includes('*')
  const explicitCors = rawCors.map((x) => String(x ?? '').trim()).filter((x) => x && x !== '*')
  sec.cors = explicitCors.length ? explicitCors : ['http://127.0.0.1:5180']
  const rateLimiter = createRateLimiter({ limit: sec.rateLimit })

  function securityInfo() {
    return {
      mode: sec.token ? 'token' : 'local-open',
      loopback: sec.loopback,
      cors: sec.cors,
      corsWildcardRejected,
      proxyAware: true,
      rateLimitPerMinute: sec.rateLimit,
      rateTable: rateLimiter.stats(),
      note: '无令牌时仅「本机直连」免鉴权：需回环监听 + 回环对端 + 无代理标记头；经反向代理 / Nginx 暴露必须设置 LEADPILOT_API_TOKEN，CORS 通配 * 在任何模式下都会被剔除。',
    }
  }

  /** 每个请求按 Origin 白名单决定 Allow-Origin，绝不默认通配 */
  function applyCors(req, res) {
    const origin = req.headers?.origin
    const allowed = origin && sec.cors.includes(origin) ? origin : (sec.cors[0] ?? 'http://127.0.0.1:5180')
    res.setHeader('Access-Control-Allow-Origin', allowed)
    res.setHeader('Vary', 'Origin')
  }

  function cors(res) {
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-leadpilot-token')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  }

  /**
   * 本地回环默认免鉴权，但只限「浏览器直连本机」：
   * 设了 token 一律校验；未设 token 而请求带代理标记 / 非回环对端，一律要求 token。
   */
  function authOk(req) {
    if (!sec.token) return sec.loopback && loopbackPeer(req) && !looksProxied(req)
    const bearer = String(req.headers?.authorization ?? '')
    const supplied = bearer.startsWith('Bearer ') ? bearer.slice(7) : String(req.headers?.['x-leadpilot-token'] ?? '')
    // P2 · 恒定时间比较（等长摘要），不按字符短路、不泄漏令牌长度差异
    return verifyToken(supplied, sec.token)
  }

  function rateOk(req, res) {
    return rateLimiter.check(req.socket?.remoteAddress ?? 'unknown', res)
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
      let tooLarge = false
      req.on('data', (c) => {
        if (tooLarge) return
        size += c.length
        if (size > MAX_BODY) {
          // P1-09：不能用 req.destroy()，否则连接被重置，413 的结构化响应根本发不出去。
          // 丢弃已收数据、排空剩余流，让外层 catch 正常返回 413 E5002。
          tooLarge = true
          chunks.length = 0
          reject(new Error('BODY_TOO_LARGE'))
          req.resume()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        if (tooLarge) return
        if (!chunks.length) return resolve({})
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { reject(new Error('INVALID_JSON')) }
      })
      req.on('error', (err) => { if (!tooLarge) reject(err) })
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
    // P0-1：CORS / URL 解析 / 限流 / 鉴权必须全部落在 try 内。此前 new URL() 在 try 之外，
    // 畸形请求会在 async handler 里抛出未处理拒绝，直接终结进程（一个请求即可远程 DoS）。
    try {
      applyCors(req, res)
      let url
      try {
        url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)
      } catch {
        return fail(res, 400, 'E5002', '请求路径无法解析', 'URL 格式非法', '检查请求路径后重试')
      }
      const path = url.pathname
      const method = req.method ?? 'GET'

      if (method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return }
      if (!rateOk(req, res)) {
        return fail(res, 429, 'E6010', '请求过于频繁', `同一 IP 每分钟超过 ${sec.rateLimit} 次`, '稍后重试或调高 LEADPILOT_RATE_LIMIT')
      }
      // /health 供探活与前端启动探测，其余 /v1/* 全部要求鉴权（配置了 token 或对外监听时）
      if (!(method === 'GET' && path === '/health') && !authOk(req)) {
        const proxied = !sec.token && looksProxied(req)
        return fail(res, 401, 'E6009', '访问令牌缺失或无效',
          proxied
            ? '请求带有反向代理标记，本机免鉴权不适用于经代理暴露的流量'
            : '服务端要求携带有效令牌',
          proxied
            ? '经反向代理 / Nginx 暴露时，必须设置 LEADPILOT_API_TOKEN 并由客户端携带该令牌'
            : '在请求头加 Authorization: Bearer <LEADPILOT_API_TOKEN>')
      }

      if (method === 'GET' && path === '/health') {
        return json(res, 200, {
          ok: true, service: 'leadpilot-cloud', version: PKG_VERSION,
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
            // P2 · recoveredTasks 只报「本次启动真正从活跃态降级恢复」的任务，
            // 不再把全部历史任务都算成恢复；restoredTasks 单独如实报载入总数。
            recoveredTasks: orchestrator.recoveredActiveIds?.length ?? 0,
            restoredTasks: orchestrator.recoveredIds?.length ?? 0,
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
            contractStatus: baselineContract.status,
            importStatus: checkLabeledBaseline().status,
            requiredSize: baselineContract.baselineSize,
            diffEndpoint: protocol.evalDiff.endpoint,
            diffVersion: protocol.evalDiff.version,
            labelsRequired: false,
            accuracyClaim: false,
            releaseEligible: false,
            note: 'v0.8.0 决策：不再要求 385 家人工标注基准集，本契约降级为 legacy；当前评测口径见 evalGates。',
          },
          evalGates: (() => {
            // B4：health 里的发布状态同样读真实证据，不再用 releaseStatus() 的无参默认值假装恒 false。
            const evidence = evaluateReleaseEvidence()
            const release = evidence.release
            return {
              mode: protocol.evalGates.integrity.mode,
              evidence: {
                contractVersion: evidence.contractVersion,
                filesPresent: evidence.filesPresent,
                validationOk: evidence.validation.ok,
                internalPreviewReady: release.internalPreviewReady,
                externalValidated: release.externalValidated,
                snapshotLocked: evidence.snapshot.lockedCount,
                complianceCompleted: evidence.compliance.completed,
                blockerCount: evidence.blockers.length,
                endpoint: 'GET /v1/release/status',
              },
              integrityVersion: INTEGRITY_GATE_VERSION,
              outcomeVersion: OUTCOME_GATE_VERSION,
              policyVersion: RELEASE_POLICY_VERSION,
              labelsRequired: false,
              accuracyClaim: false,
              internalPreviewReady: release.internalPreviewReady,
              externalValidated: release.externalValidated,
              releaseEligible: release.releaseEligible,
              remainingExternalBlockers: release.remainingExternalBlockers,
              droppedByDecision: release.droppedByDecision,
              endpoints: {
                integrity: integrityManifest().endpoint,
                outcome: outcomeManifest().endpoint,
                manifest: 'GET /v1/eval/gates',
              },
            }
          })(),
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
          fetch: fetcher.health(),
          batch: (() => {
            const b = batch.state()
            return {
              version: BATCH_VERSION, positioning: b.positioning, targetUser: b.targetUser,
              stage: b.stage, companies: b.companies, judged: b.judged,
              exportedToday: b.exportedToday, circuitOpen: b.circuitOpen,
              bounce: b.bounce, releaseEligible: false,
              userDirectedFetch: b.userDirectedFetch,
              note: '定位仍为自动获客；批量导入是批量 SDR 的线索投喂通道，origin=user_imported，导入≠采集；官网原文由用户指定 URL 抓取（user_directed_fetch），抓取≠采集。外部依赖重分类为发布门禁，releaseEligible 恒 false。',
            }
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
            contractStatus: baselineContract.status,
            importStatus: checkLabeledBaseline().status,
            requiredSize: baselineContract.baselineSize,
            diffEndpoint: protocol.evalDiff.endpoint,
            diffVersion: protocol.evalDiff.version,
            labelsRequired: false,
            accuracyClaim: false,
            releaseEligible: false,
            note: 'v0.8.0 决策：不再要求 385 家人工标注基准集，本契约降级为 legacy；当前评测口径见 evalGates。',
          },
          t0: {
            extractor: 'rules', rulesVersion: T0_RULES_VERSION, sourceMode: 'provided-text',
            judgeFactChain: { enabled: protocol.judgeFactChain.enabled, onConflict: protocol.judgeFactChain.onConflict },
          },
          dataSources: (() => {
            const d = dataSources.health()
            return { mode: d.mode, total: d.total, configured: d.configured, readyCount: d.readyCount }
          })(),
          fetch: fetcher.health(),
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
        // P1-06：纯读。此前 ledger.state() 内部 ensureAccount 会为任意 account 参数开户
        // 并写入 2000 点流水，一个 GET 就能无限膨胀存储；改用 peek 后不存在即返回 exists:false。
        const state = ledger.peek(account)
        const entries = refId ? ledger.entries(refId, 50) : ledger.allEntries(50)
        return json(res, 200, {
          ...state,
          entries,
          scope: protocol.billing.ledger.scope,
          ledgerConsumers: protocol.billing.ledger.ledgerConsumers,
          note: '纯读接口：不为不存在的账户开户、不写任何流水（exists:false 即零值快照）。账本覆盖云端任务与网关真实调用的预扣/结算/释放；未注入账本的独立网关才只产出审计估值。',
        })
      }
      // ---- v0.7.0 批量 SDR 管道 ------------------------------------------------
      // 定位仍为「自动获客」：导入是批量 SDR 的线索投喂通道，绝不写成系统采集。
      if (method === 'GET' && path === '/v1/batch/health') return json(res, 200, batch.state())
      if (method === 'GET' && path === '/v1/import/companies') return json(res, 200, batch.listCompanies())

      if (method === 'POST' && path === '/v1/import/companies') {
        const body = await readBody(req)
        const result = batch.importCompanies(body)
        return json(res, result.ok ? 200 : 400, result)
      }

      // ---- v0.9.0 用户指定 URL 抓取（ADR-032；单独计数，不并入商业数据源 0/6）----
      if (method === 'GET' && path === '/v1/sources/health') return json(res, 200, fetcher.health())

      if (method === 'POST' && path === '/v1/sources/fetch') {
        const body = await readBody(req)
        if (!Array.isArray(body.urls) || !body.urls.length) {
          return fail(res, 400, 'E4011', '抓取请求不合法', 'urls 必须是非空数组，且每个地址由调用方显式提供', '传 { urls: ["https://example.com/about"] } 后重试')
        }
        const result = await fetcher.fetchMany(body.urls)
        return json(res, result.ok ? 200 : 400, result)
      }

      if (method === 'POST' && path === '/v1/batch/fetch-sources') {
        const body = await readBody(req)
        const result = await batch.fetchSources(body)
        return json(res, result.ok ? 200 : 400, result)
      }

      if (method === 'POST' && path === '/v1/batch/judge') {
        const body = await readBody(req)
        const result = await batch.runJudgeBatch(body)
        return json(res, result.ok ? 200 : 400, result)
      }

      if (method === 'POST' && path === '/v1/export/eml') {
        const body = await readBody(req)
        const result = batch.exportDrafts(body)
        const status = result.ok ? 200 : result.code === 'E4010' ? 423 : 400
        return json(res, status, result)
      }

      if (method === 'POST' && path === '/v1/import/outcomes') {
        const body = await readBody(req)
        const result = batch.importOutcomes(body)
        return json(res, result.ok ? 200 : 400, result)
      }
      // -------------------------------------------------------------------------

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

      // v0.8.0：不做人工标注集，评测口径改为 integrity（零人工）+ outcome（真实业务结果）。
      // 两个端点都只做确定性计算，不联网、不调模型；无真实样本一律 NO_DATA。
      if (method === 'GET' && path === '/v1/eval/integrity/gates') return json(res, 200, integrityManifest())
      if (method === 'GET' && path === '/v1/eval/outcome/gates') return json(res, 200, outcomeManifest())
      if (method === 'POST' && path === '/v1/eval/integrity') {
        const body = await readBody(req)
        // B4：调用方只能抬高门槛，不能下调 minSamples 把 1 条样本判成 PASSED。
        const floor = integrityManifest().minSamples
        const requested = Number.isInteger(body.minSamples) ? body.minSamples : floor
        const result = evaluateIntegrity(body.records ?? body.evidence ?? [], {
          consistency: body.consistency,
          minSamples: Math.max(requested, floor),
        })
        return json(res, 200, result)
      }
      if (method === 'POST' && path === '/v1/eval/outcome') {
        const body = await readBody(req)
        // B4：minSamples 不得下调；windowSize 不得放大（把历史 sent 拉进来稀释退信率也是一种绕过）。
        const manifest = outcomeManifest()
        const requestedMin = Number.isInteger(body.minSamples) ? body.minSamples : manifest.minSamples
        const requestedWindow = Number.isInteger(body.windowSize) ? body.windowSize : manifest.windowSize
        const result = evaluateOutcome(body.events ?? [], {
          windowSize: Math.min(requestedWindow, manifest.windowSize),
          minSamples: Math.max(requestedMin, manifest.minSamples),
        })
        return json(res, 200, result)
      }

      // B4：只读发布状态。证据原文不回传，只给摘要与由真实判定生成的阻断项。
      if (method === 'GET' && path === '/v1/release/status') {
        const e = evaluateReleaseEvidence()
        return json(res, 200, {
          ok: true,
          contractVersion: e.contractVersion,
          releaseBlocked: e.releaseBlocked,
          releaseEligible: e.release.releaseEligible,
          internalPreviewReady: e.release.internalPreviewReady,
          externalValidated: e.release.externalValidated,
          evidenceReady: e.evidenceReady,
          accuracyClaim: false,
          integrity: { status: e.integrity.status, sampleSize: e.integrity.sampleSize, minSamples: e.integrity.minSamples },
          outcome: { status: e.outcome.status, sampleSize: e.outcome.sampleSize, minSamples: e.outcome.minSamples },
          consistency: e.consistency
            ? { status: e.consistency.status, rate: e.consistency.rate }
            : { status: 'NO_DATA', rate: null },
          snapshot: {
            configuredCount: e.snapshot.configuredCount,
            lockedCount: e.snapshot.lockedCount,
            ok: e.snapshot.ok,
          },
          compliance: {
            completed: e.compliance.completed, total: e.compliance.total,
            pending: e.compliance.pending,
          },
          filesPresent: e.filesPresent,
          validation: { ok: e.validation.ok, errorCount: e.validation.errors.length },
          blockers: e.blockers,
          note: '只回传摘要，不回传证据原文；代码无法证明证据真实性，真实性由 attestation 签署人负责。',
        })
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
      // P1-08：未预期异常只进服务端日志，绝不把堆栈 / 文件路径 / SQLite 状态回显给调用方
      // eslint-disable-next-line no-console
      console.error('[LeadPilot] 未处理的服务端异常：', err)
      return fail(res, 500, 'E5002', '服务内部错误', '内部错误已记录，不回显堆栈、路径与存储状态', '查看服务端日志并重试')
    }
  })

  // P0-1：HTTP 解析层的畸形请求行 / 请求头也不能让进程退出，返回 400 后关闭连接
  server.on('clientError', (_err, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    } else {
      socket.destroy()
    }
  })

  return { server, gateway, orchestrator, store, ledger, batch, rateLimiter }
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
    if (IS_LOOPBACK && !API_TOKEN) {
      // eslint-disable-next-line no-console
      console.warn('[LeadPilot] SECURITY_NOTICE: 免鉴权仅对「浏览器直连本机」生效；若经反向代理 / Nginx 对外暴露，必须设置 LEADPILOT_API_TOKEN，否则代理流量会被 401 E6009 拒绝。')
    }
  })
  const shutdown = () => server.close(() => { store.close(); process.exit(0) })
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
