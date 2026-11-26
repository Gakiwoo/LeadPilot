/**
 * LeadPilot 云端服务入口 · Node 原生 http（零额外依赖）
 *
 * 启动：node server/index.mjs        （默认 127.0.0.1:5181）
 * 配置：见 .env.example 与 server/config.mjs
 *
 * 本文件只做三件事：启动前置安全校验、监听、优雅退出。
 * 装配与路由分别在 server/app.mjs 与 server/routes/ 下，便于单测直接调 createApp()。
 *
 * 未配置 Key / 未锁定模型快照时，网关返回 E6005 / E6008 降级；编排器事件带 demo:true。
 * 本服务不保存任何凭据、不记录客户原文或邮箱；任务游标、缓存与审计落本地持久化存储。
 */
import { pathToFileURL } from 'node:url'
import { API_TOKEN, CORS_LIST, HOST, IS_LOOPBACK, PORT } from './config.mjs'
import { createApp } from './app.mjs'

// 兼容既有调用方与测试的导入路径；规范位置在 http/security.mjs 与 app.mjs
export { createApp } from './app.mjs'
export { verifyToken, createRateLimiter } from './http/security.mjs'

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
