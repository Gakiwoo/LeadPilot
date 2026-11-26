/**
 * 应用装配 · createApp()
 *
 * 职责边界：
 *  - 依赖装配（store / ledger / gateway / orchestrator / batch / fetcher）集中在此；
 *  - 请求管线（CORS → 限流 → OPTIONS → 鉴权 → 路由）集中在此；
 *  - 具体端点实现在 routes/ 下，按域拆文件，新增端点不必改本文件。
 *
 * 纪律：任何异常都不能让进程退出，也不能把堆栈 / 路径 / 存储状态回显给调用方。
 * 畸形 URL、畸形请求行、超大体、非法 JSON 全部走结构化 4xx。
 */
import { createServer } from 'node:http'
import { DEFAULT_SECURITY, HOST, PORT } from './config.mjs'
import { createSecurity } from './http/security.mjs'
import { createResponder } from './http/respond.mjs'
import { createRouter } from './http/router.mjs'
import { createStore } from './persistence/store.mjs'
import { createLedger } from './core/ledger.mjs'
import { createGateway } from './services/gateway.mjs'
import { createOrchestrator } from './services/orchestrator.mjs'
import { createDataSourceRegistry } from './core/data-sources.mjs'
import { createBatchPipeline } from './services/batch.mjs'
import { createFetcher } from './services/fetch.mjs'
import { systemRoutes } from './routes/system.mjs'
import { gatewayRoutes } from './routes/gateway.mjs'
import { taskRoutes } from './routes/tasks.mjs'
import { batchRoutes } from './routes/batch.mjs'
import { sourceRoutes } from './routes/sources.mjs'
import { evalRoutes } from './routes/eval.mjs'

export function createApp(opts = {}) {
  const store = opts.store ?? createStore()
  const ledger = opts.ledger ?? createLedger({ store })
  // 系统默认账户只在启动时初始化一次（固定账户、幂等），
  // 之后所有 GET /v1/points 一律纯读，任意 account 查询参数都不会开户写流水。
  ledger.state()
  // 把同一个账本实例注入网关，judge / write_email 才产生真实预扣/结算；
  // 独立创建的网关（部分单测）没有 ledger，仍只产出审计估值并在响应里如实标注。
  const gateway = opts.gateway ?? createGateway({ store, ledger })
  const dataSources = opts.dataSources ?? opts.orchestratorOptions?.dataSources ?? createDataSourceRegistry()
  const orchestrator = opts.orchestrator ?? createOrchestrator({ ...(opts.orchestratorOptions ?? {}), store, ledger, dataSources })
  // 批量 SDR 管道与编排器共用同一 store / gateway / ledger，避免两本账；
  // 抓取器单独计数，不并入商业数据源 0/6。
  const fetcher = opts.fetcher ?? createFetcher()
  const batch = opts.batch ?? createBatchPipeline({ store, gateway, fetcher })

  // 允许测试注入独立的安全上下文，不污染进程级默认值
  const sec = { ...DEFAULT_SECURITY, ...(opts.security ?? {}) }
  const security = createSecurity(sec)
  const respond = createResponder(security)

  const ctx = {
    store, ledger, gateway, orchestrator, dataSources, fetcher, batch,
    security, respond, sec,
  }

  const router = createRouter([
    systemRoutes(ctx),
    gatewayRoutes(ctx),
    taskRoutes(ctx),
    batchRoutes(ctx),
    sourceRoutes(ctx),
    evalRoutes(ctx),
  ])

  const server = createServer(async (req, res) => {
    const { fail } = respond
    try {
      security.applyCors(req, res)
      let url
      try {
        url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)
      } catch {
        return fail(res, 400, 'E5002', '请求路径无法解析', 'URL 格式非法', '检查请求路径后重试')
      }
      const path = url.pathname
      const method = req.method ?? 'GET'

      if (!security.rateOk(req, res)) {
        return fail(res, 429, 'E6010', '请求过于频繁',
          `同一 IP 每分钟超过 ${sec.rateLimit} 次`, '稍后重试或调高 LEADPILOT_RATE_LIMIT')
      }
      // OPTIONS 预检与其它请求一样计入限流，但仍免鉴权（浏览器预检不会携带 Bearer）。
      if (method === 'OPTIONS') { security.cors(res); res.writeHead(204); res.end(); return }

      // /health 供探活与前端启动探测，其余 /v1/* 全部要求鉴权（配置了 token 或对外监听时）
      if (!(method === 'GET' && path === '/health') && !security.authOk(req)) {
        const proxied = !sec.token && security.looksProxied(req)
        return fail(res, 401, 'E6009', '访问令牌缺失或无效',
          proxied
            ? '请求带有反向代理标记，本机免鉴权不适用于经代理暴露的流量'
            : '服务端要求携带有效令牌',
          proxied
            ? '经反向代理 / Nginx 暴露时，必须设置 LEADPILOT_API_TOKEN 并由客户端携带该令牌'
            : '在请求头加 Authorization: Bearer <LEADPILOT_API_TOKEN>')
      }

      const matched = router.match(method, path)
      if (!matched) {
        return fail(res, 404, 'E5002', '接口不存在', `路径 ${path} 未注册`, '检查 API 路径与方法')
      }
      await matched.route.handler(req, res, url, matched.params)
    } catch (err) {
      const msg = String(err?.message ?? err)
      if (msg === 'INVALID_JSON') return fail(res, 400, 'E5002', '请求体不是合法 JSON', '序列化失败或内容被截断', '检查请求体格式')
      if (msg === 'BODY_TOO_LARGE') return fail(res, 413, 'E5002', '请求体过大', '超过 256 KB 限制', '压缩或分批提交')
      // 未预期异常只进服务端日志，绝不把堆栈 / 文件路径 / SQLite 状态回显给调用方
      // eslint-disable-next-line no-console
      console.error('[LeadPilot] 未处理的服务端异常：', err)
      return fail(res, 500, 'E5002', '服务内部错误', '内部错误已记录，不回显堆栈、路径与存储状态', '查看服务端日志并重试')
    }
  })

  // HTTP 解析层的畸形请求行 / 请求头也不能让进程退出，返回 400 后关闭连接
  server.on('clientError', (_err, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    } else {
      socket.destroy()
    }
  })

  return {
    server, gateway, orchestrator, store, ledger, batch,
    rateLimiter: security.rateLimiter, security, router,
  }
}
