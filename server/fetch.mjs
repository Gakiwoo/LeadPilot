/**
 * v0.9.0 · 用户指定 URL 抓取器（ADR-032）
 *
 * 定位：把「用户手动复制官网文本」升级为「用户指定 URL、系统代抓原文」，
 * 让 T0 → judge → integrity 评测第一次拿到真实原文。它**不是**自动获得的商业数据源：
 *
 * 不可绕过的纪律：
 *  1. 只抓调用方显式指定的 URL：不发现、不爬全站、不猜地址、不抓登录后内容。
 *  2. robots.txt 遵从（命中 Disallow → E4013），每域限速 1 req/s，超时 / 大小上限。
 *  3. 拒绝非 http(s)、带凭据 URL、回环 / 私网 / link-local 地址（SSRF，E4011），
 *     且 DNS 解析出的任一地址落在私网同样拒绝 —— 绝不向这类地址发起请求。
 *  4. 输出 origin=user_directed_fetch；抓到的原文经 sanitizeContext 去 PII 后进入 T0。
 *     抓取失败逐条如实降级为 missing_source，不生成公司事实、不拿演示文本补齐。
 *  5. 商业 6 类数据源仍如实报 0/6，本抓取器单独计数，不并入 0/6。
 *
 * 服务端零额外依赖：Node 内置 fetch / dns / crypto。测试通过注入 fetchImpl / resolveHost 完成。
 */
import { lookup } from 'node:dns/promises'
import { createHash } from 'node:crypto'
import { protocol, sanitizeContext } from './protocol.mjs'

const P = protocol.fetchPolicy
export const FETCH_VERSION = P.version
export const FETCH_ORIGIN = P.origin

const envInt = (name, fallback, min, max) => {
  const raw = Number(process.env[name])
  if (!Number.isFinite(raw)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(raw)))
}

export const FETCH_LIMITS = Object.freeze({
  timeoutMs: envInt('LEADPILOT_FETCH_TIMEOUT_MS', P.timeoutMs, 1000, 30000),
  maxBytes: envInt('LEADPILOT_FETCH_MAX_BYTES', P.maxBytes, 1024, 4 * 1024 * 1024),
  maxTextChars: envInt('LEADPILOT_FETCH_MAX_TEXT_CHARS', P.maxTextChars, 200, 60000),
  maxRedirects: envInt('LEADPILOT_FETCH_MAX_REDIRECTS', P.maxRedirects, 0, 5),
  maxUrlChars: P.maxUrlChars,
  perDomainMinIntervalMs: envInt('LEADPILOT_FETCH_MIN_INTERVAL_MS', P.perDomainMinIntervalMs, 0, 10000),
  maxUrlsPerRequest: P.maxUrlsPerRequest,
  maxUrlsPerBatch: P.maxUrlsPerBatch,
  robotsMaxBytes: P.robots.maxBytes,
  robotsCacheMs: envInt('LEADPILOT_FETCH_ROBOTS_CACHE_MS', P.robots.cacheMs, 0, 86400000),
})

const robotsEnabled = () => String(process.env.LEADPILOT_FETCH_ROBOTS ?? '1') !== '0'

function fail(code, reason, extra = {}) {
  return { ok: false, code, reason, ...extra }
}

/* --------------------------------------------------------------- URL / SSRF */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function ipv4ToInt(ip) {
  const m = IPV4_RE.exec(ip)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  if (parts.some((n) => n > 255)) return null
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}

const IPV4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, prefix]) => ({ base: ipv4ToInt(base), prefix }))

function isIpv4BlockedInt(v4) {
  return IPV4_BLOCKED.some(({ base, prefix }) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    return (v4 & mask) === (base & mask)
  })
}

/** 把 IPv6 字面量（含 :: 压缩与嵌入 IPv4）展开成 8 个 16 位组；无法解析返回 null */
function ipv6Groups(raw) {
  let s = raw
  const v4Tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s)
  if (v4Tail) {
    const n = ipv4ToInt(v4Tail[1])
    if (n === null) return null
    s = `${s.slice(0, -v4Tail[1].length)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : []
  const parts = [...head, ...tail]
  if (parts.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null
  const groups = parts.map((x) => parseInt(x, 16))
  if (halves.length === 1) return groups.length === 8 ? groups : null
  if (groups.length >= 8) return null
  return [...groups.slice(0, head.length), ...Array(8 - groups.length).fill(0), ...groups.slice(head.length)]
}

/**
 * 私网 / 回环 / link-local / 保留段判定（地址字面量）。
 * P0-2：WHATWG URL 会把 [::ffff:127.0.0.1] 规范化成 ::ffff:7f00:1，
 * 旧实现只认点分十进制的 mapped 形式，把回环误判为公网（SSRF 直通内网）。
 */
export function isPrivateAddress(ip) {
  const v = String(ip ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!v) return false
  const v4 = ipv4ToInt(v)
  if (v4 !== null) return isIpv4BlockedInt(v4)
  if (!v.includes(':')) return false
  const g = ipv6Groups(v)
  if (!g) return true // 无法解析的 IPv6 字面量一律保守拒绝
  // IPv4-mapped（::ffff:a.b.c.d / ::ffff:xx:xx）：取末 32 位按 IPv4 规则判定
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return isIpv4BlockedInt(((g[6] << 16) | g[7]) >>> 0)
  }
  // :: / ::1 / IPv4-compatible（::a.b.c.d）整段保守拒绝
  if (g.slice(0, 6).every((x) => x === 0)) return true
  if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  return false
}

function hostnameBlobIsBlocked(hostname) {
  const h = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true
  if (h === 'metadata.google.internal' || h === '169.254.169.254') return true
  return false
}

/** 只允许 http(s)、无凭据、长度受限；返回规范化 URL */
export function parseTargetUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return fail('E4011', 'URL 为空或不是字符串')
  const s = raw.trim()
  if (s.length > FETCH_LIMITS.maxUrlChars) return fail('E4011', `URL 超过 ${FETCH_LIMITS.maxUrlChars} 字符上限`)
  let u
  try { u = new URL(s) } catch { return fail('E4011', 'URL 无法解析') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail('E4011', `只允许 http/https，收到 ${u.protocol}`)
  if (u.username || u.password) return fail('E4011', 'URL 不得携带账号或口令')
  if (!u.hostname) return fail('E4011', 'URL 缺少主机名')
  return { ok: true, url: u }
}

/**
 * SSRF 校验：主机名字面量或 DNS 解析结果命中私网/回环即拒绝。
 * resolveHost 可注入（测试用），默认 node:dns。
 */
export async function assertPublicHost(url, opts = {}) {
  const resolveHost = opts.resolveHost ?? ((host) => lookup(host, { all: true, family: 0 }))
  const h = String(url.hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  if (hostnameBlobIsBlocked(h)) return fail('E4011', `主机名被 SSRF 策略拒绝：${h}`)
  const literal = IPV4_RE.test(h) || h.includes(':')
  if (literal) {
    if (isPrivateAddress(h)) return fail('E4011', `地址落在回环/私网/保留段：${h}`)
    return { ok: true, addresses: [{ address: h, family: h.includes(':') ? 6 : 4 }] }
  }
  let addresses
  try { addresses = await resolveHost(h) } catch (err) {
    return fail('E4012', `DNS 解析失败：${h}（${String(err?.message ?? err)}）`)
  }
  const list = Array.isArray(addresses) ? addresses : (addresses ? [addresses] : [])
  if (!list.length) return fail('E4012', `DNS 未返回任何地址：${h}`)
  for (const item of list) {
    const address = String(item?.address ?? item)
    if (isPrivateAddress(address)) {
      return fail('E4011', `域名 ${h} 解析到回环/私网/保留地址 ${address}，拒绝抓取`)
    }
  }
  return { ok: true, addresses: list }
}

/* ----------------------------------------------------------------- robots.txt */

/** 极简 robots.txt 解析：返回 [{ agents:[], rules:[{allow,path}] }] */
export function parseRobots(text) {
  const groups = []
  let current = null
  for (const line0 of String(text ?? '').split(/\r?\n/)) {
    const line = line0.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const field = m[1].toLowerCase()
    const value = m[2].trim()
    if (field === 'user-agent') {
      if (!current || (current.rules.length > 0)) {
        current = { agents: [], rules: [] }
        groups.push(current)
      }
      if (value) current.agents.push(value.toLowerCase())
    } else if (field === 'allow' || field === 'disallow') {
      if (!current) { current = { agents: ['*'], rules: [] }; groups.push(current) }
      if (!value) continue // 空 Disallow 表示全部允许
      current.rules.push({ allow: field === 'allow', path: value })
    }
  }
  return groups
}

function robotsPatternToRegex(pattern) {
  const hasEnd = pattern.endsWith('$')
  const body = hasEnd ? pattern.slice(0, -1) : pattern
  const parts = body.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp('^' + parts.join('.*') + (hasEnd ? '$' : ''))
}

/** 最长匹配优先；等长时 Allow 优先；无匹配默认放行 */
export function robotsAllows(groups, pathAndQuery, opts = {}) {
  const ua = String(opts.userAgent ?? P.robots.userAgent).toLowerCase()
  const matchedGroups = (Array.isArray(groups) ? groups : []).filter((g) => (g.agents ?? []).some((a) => {
    if (!a) return false
    if (a === '*') return true
    return ua.includes(a) || a.includes('leadpilotbot')
  }))
  if (!matchedGroups.length) return { allowed: true, matched: null }
  const rules = matchedGroups.flatMap((g) => g.rules ?? [])
  const target = String(pathAndQuery || '/')
  let best = null
  for (const rule of rules) {
    if (!robotsPatternToRegex(rule.path).test(target)) continue
    if (!best || rule.path.length > best.path.length
      || (rule.path.length === best.path.length && rule.allow && !best.allow)) best = rule
  }
  if (!best) return { allowed: true, matched: null }
  return { allowed: Boolean(best.allow), matched: best }
}

/* --------------------------------------------------------------- HTML→文本 */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ',
  ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', euro: '€', pound: '£',
}

function decodeEntities(input) {
  return String(input ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
    if (g.startsWith('#x') || g.startsWith('#X')) {
      const code = Number.parseInt(g.slice(2), 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
    }
    if (g.startsWith('#')) {
      const code = Number.parseInt(g.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
    }
    return ENTITIES[g.toLowerCase()] ?? m
  })
}

/** 只保留可核验正文：去 script/style/注释，保留 title 与 meta description，压缩空白 */
export function htmlToText(html) {
  const src = String(html ?? '')
  const title = decodeEntities((src.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim())
  const desc = decodeEntities(
    (src.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i)?.[1]
      ?? src.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i)?.[1] ?? '').trim(),
  )
  let s = src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  s = s.replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|td|th)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const head = [title, desc].filter(Boolean).join(' · ')
  return (head ? `${head}\n` : '') + s
}

/* --------------------------------------------------------------- 抓取实现 */

async function readLimited(res, maxBytes) {
  if (res?.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader()
    const chunks = []
    let bytes = 0
    let truncated = false
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      if (bytes + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - bytes))
        truncated = true
        try { await reader.cancel() } catch { /* 忽略取消失败 */ }
        break
      }
      chunks.push(chunk)
      bytes += chunk.length
    }
    return { buffer: Buffer.concat(chunks), truncated }
  }
  const text = await res.text()
  const buffer = Buffer.from(String(text ?? ''), 'utf8')
  const truncated = buffer.length > maxBytes
  return { buffer: truncated ? buffer.subarray(0, maxBytes) : buffer, truncated }
}

function contentTypeBase(headers) {
  const raw = headers?.get?.('content-type') ?? ''
  return String(raw).split(';')[0].trim().toLowerCase()
}

/**
 * 创建抓取器。所有外部依赖可注入，测试无需联网：
 *  - fetchImpl(url, init) -> Response（默认 globalThis.fetch）
 *  - resolveHost(host) -> [{address,family}]（默认 node:dns lookup）
 *  - now() / sleep(ms) 用于限速与 robots 缓存
 */
export function createFetcher(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const resolveHost = opts.resolveHost
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const robotsCache = new Map()
  const counters = { fetched: 0, failed: 0, robotsBlocked: 0, ssrfBlocked: 0, lastFetchAt: null }
  const L = { ...FETCH_LIMITS, ...(opts.limits ?? {}) }

  const publicPolicy = () => ({
    version: FETCH_VERSION,
    origin: FETCH_ORIGIN,
    respectRobots: robotsEnabled(),
    timeoutMs: L.timeoutMs,
    maxBytes: L.maxBytes,
    maxTextChars: L.maxTextChars,
    maxRedirects: L.maxRedirects,
    perDomainMinIntervalMs: L.perDomainMinIntervalMs,
    maxUrlsPerRequest: L.maxUrlsPerRequest,
    maxUrlsPerBatch: L.maxUrlsPerBatch,
    allowedContentTypes: P.allowedContentTypes,
    ssrf: P.ssrf,
    userAgent: P.robots.userAgent,
  })

  async function loadRobots(url) {
    if (!robotsEnabled()) return { status: 'disabled', groups: [], allowAll: true, note: 'robots 校验被环境变量关闭' }
    const robotsUrl = new URL('/robots.txt', url.origin)
    // P0-2：robots.txt 同样是一次出站请求，必须复用 SSRF 校验并复核 DNS（防重绑定）
    const hostCheck = await assertPublicHost(robotsUrl, { resolveHost })
    if (!hostCheck.ok) {
      counters.ssrfBlocked++
      return { status: 'ssrf-blocked', groups: [], allowAll: false, note: `robots.txt 主机校验未通过：${hostCheck.reason}` }
    }
    try {
      const res = await fetchImpl(robotsUrl.href, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(L.timeoutMs, 5000)),
        headers: { 'user-agent': P.robots.userAgent, accept: 'text/plain' },
      })
      if (res.status === 404 || res.status === 410) return { status: 'missing', groups: [], allowAll: true }
      if (res.status === 401 || res.status === 403) return { status: 'forbidden', groups: [], allowAll: false, note: `robots.txt HTTP ${res.status}，视为禁止` }
      if (!res.ok) return { status: 'unavailable', groups: [], allowAll: true, note: `robots.txt HTTP ${res.status}，无法判定，按放行处理并标注` }
      const { buffer } = await readLimited(res, L.robotsMaxBytes)
      return { status: 'ok', groups: parseRobots(buffer.toString('utf8')), allowAll: false }
    } catch (err) {
      return { status: 'unavailable', groups: [], allowAll: true, note: `robots.txt 抓取失败：${String(err?.message ?? err)}` }
    }
  }

  async function robotsFor(url) {
    const origin = url.origin
    const cached = robotsCache.get(origin)
    if (cached && now() < cached.expiresAt) return cached.value
    const value = await loadRobots(url)
    robotsCache.set(origin, { value, expiresAt: now() + L.robotsCacheMs })
    return value
  }

  async function followAndFetch(startUrl) {
    let current = startUrl
    const chain = []
    for (let i = 0; i <= L.maxRedirects; i++) {
      // P0-2：连接前再解析一次，拦截「校验时公网、连接前改指私网」的 DNS 重绑定
      const recheck = await assertPublicHost(current, { resolveHost })
      if (!recheck.ok) {
        counters.ssrfBlocked++
        return { ...recheck, redirects: chain }
      }
      let res
      try {
        res = await fetchImpl(current.href, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(L.timeoutMs),
          headers: {
            'user-agent': P.robots.userAgent,
            accept: P.allowedContentTypes.join(', '),
            'accept-language': 'en,zh-CN;q=0.8',
          },
        })
      } catch (err) {
        return fail('E4012', `抓取失败：${String(err?.message ?? err)}`, { redirects: chain })
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers?.get?.('location')
        if (!location) return fail('E4012', `HTTP ${res.status} 重定向缺少 Location`, { redirects: chain })
        if (i === L.maxRedirects) return fail('E4012', `重定向超过 ${L.maxRedirects} 次上限`, { redirects: chain })
        let next
        try { next = new URL(location, current) } catch { return fail('E4012', '重定向目标无法解析', { redirects: chain }) }
        const parsed = parseTargetUrl(next.href)
        if (!parsed.ok) return { ...parsed, redirects: chain }
        const hostCheck = await assertPublicHost(parsed.url, { resolveHost })
        if (!hostCheck.ok) return { ...hostCheck, redirects: chain }
        // 重定向目标同样是「用户未显式指定」的跳转：robots 必须重新裁决
        const nextRobots = await robotsFor(parsed.url)
        if (!nextRobots.allowAll) {
          const verdict = robotsAllows(nextRobots.groups, parsed.url.pathname + parsed.url.search)
          if (!verdict.allowed) {
            return fail('E4013', `robots.txt 禁止重定向目标 ${verdict.matched?.path ?? parsed.url.pathname}`, {
              url: startUrl.href, redirects: chain,
            })
          }
        }
        chain.push(current.href)
        current = parsed.url
        continue
      }
      return { ok: true, res, finalUrl: current, redirects: chain }
    }
    return fail('E4012', '重定向链异常')
  }

  async function fetchOne(rawUrl) {
    const parsed = parseTargetUrl(rawUrl)
    if (!parsed.ok) return { ...parsed, url: typeof rawUrl === 'string' ? rawUrl : '' }
    const target = parsed.url
    const hostCheck = await assertPublicHost(target, { resolveHost })
    if (!hostCheck.ok) {
      counters.ssrfBlocked++
      return { ...hostCheck, url: target.href }
    }
    const robots = await robotsFor(target)
    if (robots.status === 'ssrf-blocked') {
      return fail('E4011', `robots.txt 主机校验未通过，拒绝抓取：${robots.note ?? ''}`, { url: target.href })
    }
    if (!robots.allowAll) {
      const verdict = robotsAllows(robots.groups, target.pathname + target.search)
      if (!verdict.allowed) {
        counters.robotsBlocked++
        return fail('E4013', `robots.txt 禁止抓取 ${verdict.matched?.path ?? target.pathname}`, {
          url: target.href, robots: { status: robots.status, matched: verdict.matched, note: robots.note },
        })
      }
    }

    const fetched = await followAndFetch(target)
    if (!fetched.ok) {
      counters.failed++
      return { ...fetched, url: target.href }
    }
    const { res, finalUrl, redirects } = fetched
    if (res.status < 200 || res.status >= 300) {
      counters.failed++
      return fail('E4012', `HTTP ${res.status}`, { url: target.href, finalUrl: finalUrl.href, redirects })
    }
    const type = contentTypeBase(res.headers)
    if (type && !P.allowedContentTypes.includes(type)) {
      counters.failed++
      return fail('E4012', `内容类型不支持：${type}`, { url: target.href, finalUrl: finalUrl.href, contentType: type })
    }
    const { buffer, truncated } = await readLimited(res, L.maxBytes)
    const rawText = buffer.toString('utf8')
    const isHtml = type === 'text/html' || type === 'application/xhtml+xml' || (!type && /<html[\s>]/i.test(rawText))
    const plain = isHtml ? htmlToText(rawText) : rawText
    const cleaned = sanitizeContext([plain]).texts[0] ?? ''
    const text = cleaned.slice(0, L.maxTextChars)
    const fetchedAt = new Date(now()).toISOString()
    counters.fetched++
    counters.lastFetchAt = fetchedAt
    return {
      ok: true,
      version: FETCH_VERSION,
      origin: FETCH_ORIGIN,
      url: target.href,
      finalUrl: finalUrl.href,
      fetchedAt,
      status: res.status,
      contentType: type || 'unknown',
      bytes: buffer.length,
      truncated,
      hash: createHash('sha256').update(buffer).digest('hex'),
      textChars: text.length,
      text,
      redirects,
      robots: { status: robots.status, matched: null, note: robots.note },
      piiRemoved: sanitizeContext([plain]).removed,
      note: '抓取 ≠ 采集：只抓取调用方显式指定的 URL；原文经 PII 清洗后进入 T0，不生成公司事实。',
    }
  }

  /** 批量抓取：去重 + 每域限速 + robots 缓存；逐条返回成功/失败，绝不整体抛错 */
  async function fetchMany(rawUrls, opts = {}) {
    const input = Array.isArray(rawUrls) ? rawUrls : []
    if (!input.length) return { ok: false, code: 'E4011', reason: 'urls 必须是非空数组', version: FETCH_VERSION, origin: FETCH_ORIGIN }
    const limit = opts.maxUrlsPerRequest ?? L.maxUrlsPerRequest
    if (input.length > limit) {
      return { ok: false, code: 'E4011', reason: `单次最多抓取 ${limit} 个 URL，请分批`, version: FETCH_VERSION, origin: FETCH_ORIGIN }
    }
    const seen = new Set()
    const results = []
    const lastByHost = new Map()
    for (const raw of input) {
      const key = typeof raw === 'string' ? raw.trim() : String(raw ?? '')
      if (!key) { results.push(fail('E4011', 'URL 为空', { url: '' })); continue }
      if (seen.has(key)) { results.push(fail('E4011', 'batch 内重复 URL', { url: key })); continue }
      seen.add(key)
      const parsed = parseTargetUrl(key)
      if (parsed.ok) {
        const host = parsed.url.hostname
        const last = lastByHost.get(host)
        if (last !== undefined) {
          const wait = L.perDomainMinIntervalMs - (now() - last)
          if (wait > 0) await sleep(wait)
        }
        lastByHost.set(host, now())
      }
      results.push(await fetchOne(key))
    }
    const fetched = results.filter((r) => r.ok)
    const failed = results.filter((r) => !r.ok)
    return {
      ok: fetched.length > 0,
      version: FETCH_VERSION,
      origin: FETCH_ORIGIN,
      fetched,
      failed,
      summary: { requested: results.length, fetched: fetched.length, failed: failed.length },
      policy: publicPolicy(),
      note: '抓取 ≠ 采集：只抓取调用方显式指定的 URL；origin=user_directed_fetch；不发现、不爬全站、不抓登录后内容。失败的 URL 逐条如实标注，不编造原文。',
    }
  }

  function health() {
    return {
      version: FETCH_VERSION,
      enabled: true,
      origin: FETCH_ORIGIN,
      policy: publicPolicy(),
      counters: { ...counters },
      note: '用户指定 URL 抓取器：不属于 6 类商业数据源，不并入 0/6；robots 遵从、每域限速、拒绝私网地址。',
    }
  }

  return { version: FETCH_VERSION, origin: FETCH_ORIGIN, policy: publicPolicy(), fetchOne, fetchMany, health }
}
