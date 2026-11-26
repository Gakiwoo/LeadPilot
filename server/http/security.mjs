/**
 * HTTP 安全层：令牌比较、限流表、CORS 白名单、免鉴权边界。
 *
 * 待验证假设 #2（确认为真缺口并已修）：
 * 旧实现在无 token 时直接 `return sec.loopback`，只看「监听地址」这个静态事实。
 * 反向代理把公网流量 proxy_pass 到 127.0.0.1:5181 时，socket 仍是回环、监听仍是回环，
 * 于是全部 /v1/* 对外免鉴权——「本机」这个概念被代理拓扑放大了。
 *
 * 修正：免鉴权必须同时满足「回环监听 + 回环对端 + 没有任何代理标记」。
 * 这里只判断标记头是否**存在**，绝不信任头里的 IP 值：伪造这些头只会让自己被要求
 * token（fail-closed），不可能用来绕过鉴权。
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { LOOPBACK_HOSTS, RATE_TABLE_MAX } from '../config.mjs'

const PROXY_MARKER_HEADERS = [
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
  'x-real-ip', 'forwarded', 'via',
]

export function loopbackPeer(req) {
  const addr = String(req.socket?.remoteAddress ?? '').toLowerCase()
  return LOOPBACK_HOSTS.has(addr)
    || addr === '::ffff:127.0.0.1'
    || addr.startsWith('::ffff:127.')
    || addr.startsWith('127.')
}

export function looksProxied(req) {
  const headers = req.headers ?? {}
  if (PROXY_MARKER_HEADERS.some((k) => String(headers[k] ?? '').trim().length > 0)) return true
  // Host 指向非本机名字，说明请求是经域名 / 反代暴露进来的
  const host = String(headers.host ?? '').split(':')[0].toLowerCase().replace(/^\[|\]$/g, '')
  return host.length > 0 && !LOOPBACK_HOSTS.has(host) && host !== '::1'
}

/**
 * 令牌恒定时间比较：先做等长 SHA-256 摘要再比较。
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
 * 限流表有界：旧实现每个 IP 一条记录、过期后只重置计数不删 key，
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

/** 组装一次请求全部需要的安全能力（CORS / 鉴权 / 限流 / 对外自述） */
export function createSecurity(sec) {
  const rateLimiter = createRateLimiter({ limit: sec.rateLimit })
  // 回环下也不回显 ACAO:*：本机无 token 时，通配等于任意网页都能读取本机 API 响应。
  // 启动前置校验只拦「非回环 + *」，此处把通配从有效白名单里剔除并如实上报，绝不静默放行。
  const rawCors = Array.isArray(sec.cors) ? sec.cors : []
  const corsWildcardRejected = rawCors.includes('*')
  const explicitCors = rawCors.map((x) => String(x ?? '').trim()).filter((x) => x && x !== '*')
  sec.cors = explicitCors.length ? explicitCors : ['http://127.0.0.1:5180']

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

  /**
   * 每个请求按 Origin 白名单决定 Allow-Origin，绝不默认通配。
   * 不在白名单时**不设置该响应头**（而不是回填首个白名单值）：
   * 回填会让响应看起来「已允许」，掩盖真实的拒绝语义。
   */
  function applyCors(req, res) {
    const origin = req.headers?.origin
    if (origin && sec.cors.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    } else if (!origin) {
      // 非浏览器来源（curl / 服务端调用）不需要 ACAO；工具链探活也走这条路径
      res.setHeader('Access-Control-Allow-Origin', sec.cors[0] ?? 'http://127.0.0.1:5180')
    }
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
    // 恒定时间比较（等长摘要），不按字符短路、不泄漏令牌长度差异
    return verifyToken(supplied, sec.token)
  }

  function rateOk(req, res) {
    return rateLimiter.check(req.socket?.remoteAddress ?? 'unknown', res)
  }

  return { sec, rateLimiter, securityInfo, applyCors, cors, authOk, rateOk, looksProxied }
}
