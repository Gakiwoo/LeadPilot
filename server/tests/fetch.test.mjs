import { describe, expect, it } from 'vitest'
import {
  createFetcher, parseTargetUrl, parseRobots, robotsAllows, htmlToText,
  isPrivateAddress, FETCH_VERSION, FETCH_ORIGIN,
} from '../fetch.mjs'
import { protocol } from '../protocol.mjs'
import { createBatchPipeline } from '../batch.mjs'
import { createMemoryStore } from '../store.mjs'

const PUBLIC_ADDRESS = [{ address: '93.184.216.34', family: 4 }]
const resolveHost = async (host) => (host === 'private.example'
  ? [{ address: '10.0.0.8', family: 4 }]
  : PUBLIC_ADDRESS)

const response = (body = '', init = {}) => new Response(body, { status: 200, ...init })
const page = (html) => response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
const robots = (body) => response(body, { headers: { 'content-type': 'text/plain' } })
const notFound = () => response('not found', { status: 404 })
const redirect = (location) => response('', { status: 302, headers: { location } })

function setup(routes, opts = {}) {
  const calls = []
  const sleeps = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    const r = typeof routes === 'function' ? routes(String(url)) : routes[String(url)]
    return r === undefined ? notFound() : r
  }
  const fetcher = createFetcher({
    fetchImpl,
    resolveHost: opts.resolveHost ?? resolveHost,
    now: opts.now ?? (() => 1_000_000),
    sleep: async (ms) => { sleeps.push(ms) },
    limits: opts.limits,
  })
  return { fetcher, calls, sleeps }
}

describe('v0.9.0 · 用户指定 URL 抓取器（ADR-032）', () => {
  it('契约固化：version / origin / robots / SSRF 策略来自单一真源', () => {
    expect(FETCH_VERSION).toBe('user-directed-fetch-v1')
    expect(FETCH_ORIGIN).toBe('user_directed_fetch')
    expect(protocol.fetchPolicy.version).toBe(FETCH_VERSION)
    expect(protocol.fetchPolicy.origin).toBe(FETCH_ORIGIN)
    expect(protocol.fetchPolicy.respectRobots).toBe(true)
    expect(protocol.fetchPolicy.ssrf.blockPrivate).toBe(true)
    expect(protocol.fetchPolicy.forbiddenOrigins).toContain('system_collected')
    const { fetcher } = setup({})
    const health = fetcher.health()
    expect(health.policy.respectRobots).toBe(true)
    expect(health.policy.perDomainMinIntervalMs).toBeGreaterThan(0)
    expect(health.note).toMatch(/不属于 6 类商业数据源/)
  })

  it('URL 校验：只允许 http(s)、无凭据、长度受限', () => {
    expect(parseTargetUrl('https://example.com/about').ok).toBe(true)
    expect(parseTargetUrl('http://example.com').ok).toBe(true)
    expect(parseTargetUrl('ftp://example.com').code).toBe('E4011')
    expect(parseTargetUrl('javascript:alert(1)').code).toBe('E4011')
    expect(parseTargetUrl('https://user:pass@example.com/').code).toBe('E4011')
    expect(parseTargetUrl('').code).toBe('E4011')
    expect(parseTargetUrl(`https://example.com/${'a'.repeat(3000)}`).code).toBe('E4011')
  })

  it('私网 / 回环 / link-local / 保留段判定', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254',
      '0.0.0.0', '100.64.0.1', '198.18.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
    for (const ip of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '2001:4860:4860::8888']) {
      expect(isPrivateAddress(ip), ip).toBe(false)
    }
  })

  it('HTML→文本：保留 title / description，去 script/style，解实体', () => {
    const text = htmlToText(`<html><head><title>Acme &amp; Co</title>
      <meta name="description" content="Hydraulic fittings distributor">
      <script>alert('x')</script><style>.a{color:red}</style></head>
      <body><!-- 注释 --><p>We <b>import</b> fittings&nbsp;from Asia.</p></body></html>`)
    expect(text).toContain('Acme & Co')
    expect(text).toContain('Hydraulic fittings distributor')
    expect(text).toContain('We import fittings from Asia.')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('color:red')
  })

  it('SSRF：回环字面量与解析到私网的域名都拒绝，且不发起任何请求', async () => {
    const { fetcher, calls } = setup({})
    const loop = await fetcher.fetchOne('http://127.0.0.1/secret')
    expect(loop.ok).toBe(false)
    expect(loop.code).toBe('E4011')
    const internal = await fetcher.fetchOne('https://private.example/')
    expect(internal.ok).toBe(false)
    expect(internal.code).toBe('E4011')
    expect(calls).toHaveLength(0)
  })

  it('robots.txt：命中 Disallow → E4013；未命中路径放行；404 视为放行', async () => {
    const routes = {
      'https://example.com/robots.txt': robots('User-agent: *\nDisallow: /private\n'),
      'https://example.com/private/a': page('<html><body>secret</body></html>'),
      'https://example.com/about': page('<html><body>public</body></html>'),
    }
    const { fetcher } = setup(routes)
    const blocked = await fetcher.fetchOne('https://example.com/private/a')
    expect(blocked.ok).toBe(false)
    expect(blocked.code).toBe('E4013')
    const allowed = await fetcher.fetchOne('https://example.com/about')
    expect(allowed.ok).toBe(true)
    expect(allowed.origin).toBe(FETCH_ORIGIN)

    const { fetcher: f2 } = setup({ 'https://example.com/about': page('<html><body>ok</body></html>') })
    const noRobots = await f2.fetchOne('https://example.com/about')
    expect(noRobots.ok).toBe(true)
  })

  it('robots 解析：最长匹配 + Allow 优先；无关 user-agent 不影响', () => {
    const groups = parseRobots(`
User-agent: Googlebot
Disallow: /

User-agent: LeadPilotBot
Disallow: /private
Allow: /private/public
`)
    expect(robotsAllows(groups, '/private/x').allowed).toBe(false)
    expect(robotsAllows(groups, '/private/public/x').allowed).toBe(true)
    expect(robotsAllows(groups, '/about').allowed).toBe(true)
    expect(robotsAllows([], '/anything').allowed).toBe(true)
  })

  it('抓取限制：内容类型 / 大小上限 / 重定向上限 / 重定向到私网', async () => {
    const pdf = await setup({
      'https://example.com/file': response('%PDF', { headers: { 'content-type': 'application/pdf' } }),
    }).fetcher.fetchOne('https://example.com/file')
    expect(pdf.code).toBe('E4012')
    expect(pdf.reason).toMatch(/内容类型不支持/)

    const big = await setup({
      'https://example.com/big': page(`<html><body>${'a'.repeat(200)}</body></html>`),
    }, { limits: { maxBytes: 40, maxTextChars: 10000 } }).fetcher.fetchOne('https://example.com/big')
    expect(big.ok).toBe(true)
    expect(big.truncated).toBe(true)

    const loop = await setup({
      'https://example.com/a': redirect('/b'),
      'https://example.com/b': redirect('/c'),
      'https://example.com/c': page('<html><body>deep</body></html>'),
    }, { limits: { maxRedirects: 1 } }).fetcher.fetchOne('https://example.com/a')
    expect(loop.code).toBe('E4012')
    expect(loop.reason).toMatch(/重定向超过/)

    const toPrivate = await setup({
      'https://example.com/a': redirect('http://127.0.0.1/secret'),
    }).fetcher.fetchOne('https://example.com/a')
    expect(toPrivate.code).toBe('E4011')

    // 重定向目标同样要过 robots：跳到被 Disallow 的外部路径 → E4013
    const redirectRobots = await setup({
      'https://example.com/a': redirect('https://other.example/private'),
      'https://other.example/robots.txt': robots('User-agent: *\nDisallow: /private'),
      'https://other.example/private': page('<html><body>secret</body></html>'),
    }).fetcher.fetchOne('https://example.com/a')
    expect(redirectRobots.code).toBe('E4013')
  })

  it('批量抓取：逐条返回、去重、同域限速、失败不整体抛错', async () => {
    const routes = {
      'https://example.com/robots.txt': notFound(),
      'https://example.com/a': page('<html><body>a</body></html>'),
      'https://example.com/b': page('<html><body>b</body></html>'),
    }
    const { fetcher, sleeps } = setup(routes)
    const r = await fetcher.fetchMany([
      'https://example.com/a',
      'https://example.com/b',
      'http://127.0.0.1/x',
      'https://example.com/a',
    ])
    expect(r.ok).toBe(true)
    expect(r.origin).toBe(FETCH_ORIGIN)
    expect(r.summary).toEqual({ requested: 4, fetched: 2, failed: 2 })
    expect(sleeps.some((ms) => ms > 0)).toBe(true)
    expect(r.failed.map((f) => f.code)).toContain('E4011')

    const tooMany = await setup(routes, { limits: { maxUrlsPerRequest: 1 } })
      .fetcher.fetchMany(['https://example.com/a', 'https://example.com/b'])
    expect(tooMany.ok).toBe(false)
    expect(tooMany.code).toBe('E4011')
  })

  it('批量抓取接口只接受调用方显式 URL（空数组不抓）', async () => {
    const { fetcher } = setup({})
    const empty = await fetcher.fetchMany([])
    expect(empty.ok).toBe(false)
    expect(empty.code).toBe('E4011')
  })
})

describe('v0.9.0 · 批量管道接入用户指定抓取（抓取 ≠ 采集）', () => {
  const stubFetcher = (result) => ({
    version: FETCH_VERSION,
    origin: FETCH_ORIGIN,
    health: () => ({ counters: { fetched: 1, failed: 0, robotsBlocked: 0, ssrfBlocked: 0, lastFetchAt: null } }),
    fetchMany: async () => result,
  })

  it('抓取成功：公司 origin 仍 user_imported，原文标 user_directed_fetch', async () => {
    const store = createMemoryStore()
    const pipeline = createBatchPipeline({
      store,
      gateway: null,
      fetcher: stubFetcher({
        ok: true, version: FETCH_VERSION, origin: FETCH_ORIGIN,
        fetched: [{
          ok: true, url: 'https://acme.example/', finalUrl: 'https://acme.example/',
          fetchedAt: '2026-11-09T00:00:00.000Z', text: 'We import hydraulic hose fittings from Asia.',
          textChars: 44, hash: 'hash-1', truncated: false, piiRemoved: 0,
        }],
        failed: [],
        summary: { requested: 1, fetched: 1, failed: 0 },
      }),
    })
    pipeline.importCompanies({ rows: [{ company_name: 'Acme', domain: 'acme.example' }] })
    expect(store.companyGet('acme.example').origin).toBe('user_imported')
    const r = await pipeline.fetchSources({ limit: 5 })
    expect(r.ok).toBe(true)
    expect(r.sourceOrigin).toBe(FETCH_ORIGIN)
    expect(r.summary).toEqual({ requested: 1, fetched: 1, failed: 0 })
    expect(r.note).toMatch(/抓取 ≠ 采集/)
    const rec = store.companyGet('acme.example')
    expect(rec.origin).toBe('user_imported')
    expect(rec.sourceOrigin).toBe(FETCH_ORIGIN)
    expect(rec.rawText).toContain('hydraulic')
    expect(rec.missingSource).toBe(false)
    expect(rec.statusLog.at(-1).note).toMatch(/抓取 ≠ 采集/)
  })

  it('抓取失败：逐条标 missing_source，不编造原文', async () => {
    const store = createMemoryStore()
    const pipeline = createBatchPipeline({
      store,
      gateway: null,
      fetcher: stubFetcher({
        ok: false,
        fetched: [],
        failed: [{ ok: false, url: 'https://acme.example/', code: 'E4013', reason: 'robots.txt 禁止抓取 /' }],
        summary: { requested: 1, fetched: 0, failed: 1 },
      }),
    })
    pipeline.importCompanies({ rows: [{ company_name: 'Acme', domain: 'acme.example' }] })
    const r = await pipeline.fetchSources({ limit: 5 })
    expect(r.ok).toBe(false)
    expect(r.summary.fetched).toBe(0)
    expect(r.items[0].code).toBe('E4013')
    const rec = store.companyGet('acme.example')
    expect(rec.missingSource).toBe(true)
    expect(rec.rawText ?? '').toBe('')
    expect(rec.sourceFetchError.code).toBe('E4013')
  })

  it('没有缺原文的公司时明确拒绝，不凭空发现公司', async () => {
    const store = createMemoryStore()
    const pipeline = createBatchPipeline({ store, gateway: null, fetcher: stubFetcher({ ok: true, fetched: [], failed: [], summary: { requested: 0, fetched: 0, failed: 0 } }) })
    const r = await pipeline.fetchSources({ limit: 5 })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('E4008')
  })
})
