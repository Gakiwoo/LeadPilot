/**
 * LeadPilot 云端服务入口 · Node 22 原生 http（零额外依赖）
 *
 * 启动：node server/index.mjs        （默认 127.0.0.1:5181）
 * 配置：DEEPSEEK_API_KEY / OPENAI_API_KEY / ... 见 shared/model-protocol.json 的 providers.envKey
 * 说明：未配置任何 Key 时，网关返回 E6005 降级；采集编排器事件带 demo:true。
 *      本服务不保存任何凭据、不落库、不记录客户原文或邮箱。
 */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { createGateway } from './gateway.mjs'
import { createOrchestrator } from './orchestrator.mjs'
import { protocol, assertNoPii } from './protocol.mjs'
import { evaluateBaseline, baselineManifest } from './eval.mjs'

const PORT = Number(process.env.LEADPILOT_PORT ?? 5181)
const HOST = process.env.LEADPILOT_HOST ?? '127.0.0.1'
const MAX_BODY = 256 * 1024

export function createApp(opts = {}) {
  const gateway = opts.gateway ?? createGateway()
  const orchestrator = opts.orchestrator ?? createOrchestrator(opts.orchestratorOptions)

  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', process.env.LEADPILOT_CORS ?? '*')
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
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
    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return }
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)
    const path = url.pathname
    const method = req.method ?? 'GET'

    try {
      if (method === 'GET' && path === '/health') {
        return json(res, 200, {
          ok: true, service: 'leadpilot-cloud', version: '0.2.0',
          gateway: gateway.health(),
          orchestrator: { tasks: orchestrator.listTasks().length, maxConcurrent: 3 },
          protocol: { schemaVersion: protocol.schemaVersion, promptVersion: protocol.promptVersion },
          demo: gateway.health().mode === 'unconfigured-demo',
        })
      }
      if (method === 'GET' && path === '/v1/gateway/health') return json(res, 200, gateway.health())
      if (method === 'GET' && path === '/v1/gateway/audit') return json(res, 200, { entries: gateway.getAudit(), circuit: gateway.getCircuitState(), cache: gateway.getCacheStats() })
      if (method === 'GET' && path === '/v1/eval/gates') return json(res, 200, baselineManifest())
      if (method === 'GET' && path === '/v1/tasks') return json(res, 200, { tasks: orchestrator.listTasks() })

      if (method === 'POST' && path === '/v1/judge') {
        const body = await readBody(req)
        const pii = assertNoPii({ facts: body.facts ?? {}, profile: body.profile ?? {} })
        if (!pii.ok) {
          return fail(res, 400, 'E6004', '请求体含禁止字段', `数据最小化要求剔除个人信息，命中：${pii.violations.join('、')}`, '移除邮箱/电话/联系人姓名/邮件正文后重试')
        }
        const result = await gateway.judge(body)
        const status = result.ok ? 200 : result.needsConsent ? 403 : 503
        return json(res, status, { ok: !!result.ok, ...result })
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
        const status = result.ok ? 200 : result.needsConsent ? 403 : 503
        return json(res, status, { ok: !!result.ok, ...result })
      }

      if (method === 'POST' && path === '/v1/eval/run') {
        const body = await readBody(req)
        return json(res, 200, evaluateBaseline(body.results ?? [], body.baselineVersion ?? 'unversioned'))
      }

      if (method === 'POST' && path === '/v1/tasks') {
        const body = await readBody(req)
        if (!body.keywords?.length || !body.markets?.length) {
          return fail(res, 400, 'E1003', '任务参数不完整', '关键词与目标市场为必填项', '补全参数后重新提交')
        }
        return json(res, 201, { ok: true, task: orchestrator.createTask(body), demo: true })
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

  return { server, gateway, orchestrator }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  const { server, gateway } = createApp()
  server.listen(PORT, HOST, () => {
    const h = gateway.health()
    // eslint-disable-next-line no-console
    console.log(`[LeadPilot] cloud API http://${HOST}:${PORT} · providers ${h.configuredCount}/${h.totalProviders} configured · mode=${h.mode}`)
  })
  const shutdown = () => server.close(() => process.exit(0))
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
