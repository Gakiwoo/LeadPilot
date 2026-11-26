/**
 * PRD 9.3 / F0-5 / F2-3 · 统一数据源适配器注册表
 *
 * 三条不可绕过的纪律：
 *  1. 未注册实现 = unconfigured，health 明确 ok:false，绝不把 DEMO 说成「已接入 N 源」。
 *  2. 编排器只消费 health() 与 planBatch()。planBatch 在无 ready 源时返回占位标识并标
 *     sourceMode='demo'；即便有人注入了实现，也返回 'blocked' + 空 domains，
 *     **绝不生成「看起来像真公司」的候选**，直到真实采集链路与客户端写入契约一起评审完成。
 *  3. collect() 是给未来真实接入用的异步入口，当前编排器不调用它。保留半条未验证链路
 *     比诚实标注「未接入」危险得多（PRD 红线：真 SSE + 假候选域名的混合体）。
 *
 * 服务端适配器契约（与前端 src/services/adapters.ts 的 DataSourceAdapter 对齐）：
 *  search(query, { count, lang?, region? }) -> { hits: [{ domain, url, title? }], failures: number }
 *  healthCheck() -> { ok: boolean, latencyMs?: number, reason?: string }   // 同步
 */
export const SOURCE_DEFS = [
  { key: 'search', name: '搜索引擎适配器（SerpAPI / Bing / CSE）', capability: 'search' },
  { key: 'company_registry', name: '企业注册库适配器', capability: 'detail' },
  { key: 'customs', name: '海关数据适配器（授权）', capability: 'tradeRecords' },
  { key: 'website', name: '官网抓取器（Playwright + 代理池）', capability: 'fetch' },
  { key: 'email_discovery', name: '邮箱发现适配器', capability: 'contacts' },
  { key: 'email_verifier', name: '邮箱验证器（MX + SMTP 自建）', capability: 'verify' },
]

const PLACEHOLDER_DOMAIN = (n) => `candidate-${n}.demo.local`

export function createDataSourceRegistry(opts = {}) {
  const implementations = new Map(Object.entries(opts.implementations ?? {}))

  function register(key, adapter) {
    if (!SOURCE_DEFS.some((d) => d.key === key)) throw new Error(`未知数据源 key：${key}`)
    implementations.set(key, adapter)
  }

  function statusOf(def) {
    const impl = implementations.get(def.key)
    const base = { key: def.key, name: def.name, capability: def.capability }
    if (!impl) {
      return { ...base, mode: 'unconfigured', ok: false, reason: '未注册数据源实现（真实采集未接入）' }
    }
    if (typeof impl.search !== 'function') {
      return { ...base, mode: 'not_implemented', ok: false, reason: '已注册实现但缺少 search() 接口' }
    }
    let check
    try { check = typeof impl.healthCheck === 'function' ? impl.healthCheck() : { ok: false, reason: '缺少 healthCheck()' } }
    catch (err) { check = { ok: false, reason: String(err?.message ?? err) } }
    return {
      ...base,
      mode: check?.ok ? 'ready' : 'unhealthy',
      ok: Boolean(check?.ok),
      latencyMs: check?.latencyMs ?? null,
      reason: check?.reason ?? (check?.ok ? '健康检查通过' : '健康检查未通过'),
    }
  }

  /** 同步：供 health 端点、编排器与 UI 消费，绝不发起网络请求 */
  function health() {
    const sources = SOURCE_DEFS.map(statusOf)
    const configured = sources.filter((s) => s.mode !== 'unconfigured').length
    const readyCount = sources.filter((s) => s.ok).length
    return {
      total: sources.length,
      configured,
      readyCount,
      mode: readyCount > 0 ? 'real' : 'demo',
      sources,
      note: readyCount === 0
        ? `${sources.length} 类数据源均未接入；编排器事件为演示占位，不写入任何客户记录`
        : `已注册 ${configured} 类实现、${readyCount} 类健康；真实采集链路仍未接入，编排器返回 blocked 而非生成候选`,
    }
  }

  /** 同步：编排器每 tick 只取「本批次计划」，不触发任何真实采集 */
  function planBatch({ count = 1, cursorOffset = 0 } = {}) {
    const h = health()
    const skipped = h.sources.filter((s) => !s.ok).map((s) => ({ key: s.key, name: s.name, reason: s.reason }))
    if (h.readyCount === 0) {
      return {
        sourceMode: 'demo',
        domains: Array.from({ length: count }, (_, i) => PLACEHOLDER_DOMAIN(cursorOffset + i + 1)),
        realHits: 0, skipped, completeness: 0,
        note: '数据源未接入：候选域名为占位标识，仅用于演示 SSE 编排，不代表真实采集结果',
      }
    }
    // 有 ready 源也不放行：客户端写入契约尚未评审，宁可显式 blocked
    return {
      sourceMode: 'blocked',
      domains: [], realHits: 0, skipped, completeness: 0,
      note: '已注册数据源实现，但真实采集→客户端写入链路尚未接入；本批次不生成任何候选域名',
    }
  }

  /**
   * 异步：未来真实接入入口。当前编排器不调用，供单测与接入评审验证契约。
   * 单源失败显式计入 failures，不静默降级；域名去重后不编造任何实体。
   */
  async function collect(query, opts = {}) {
    const h = health()
    if (h.readyCount === 0) {
      return { ok: false, sourceMode: 'demo', hits: [], failures: 0, skipped: h.sources.map((s) => s.key), reason: h.note }
    }
    const hits = []
    const failures = []
    let failureCount = 0
    for (const def of SOURCE_DEFS) {
      const s = h.sources.find((x) => x.key === def.key)
      if (!s?.ok) { failures.push({ key: def.key, reason: s?.reason ?? '未就绪' }); continue }
      try {
        const r = await implementations.get(def.key).search(query, {
          count: opts.count ?? 10, lang: opts.lang, region: opts.region,
        })
        for (const hit of r?.hits ?? []) {
          if (hit && typeof hit.domain === 'string' && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(hit.domain)) hits.push(hit)
        }
        failureCount += Number(r?.failures ?? 0)
      } catch (err) {
        failures.push({ key: def.key, reason: String(err?.message ?? err) })
        failureCount += 1
      }
    }
    const seen = new Set()
    const unique = hits.filter((x) => !seen.has(x.domain) && seen.add(x.domain))
    return {
      ok: unique.length > 0,
      sourceMode: unique.length > 0 ? 'real' : 'no_hits',
      hits: unique, failures, failureCount,
      skipped: failures.map((f) => f.key),
      reason: unique.length > 0 ? '真实数据源返回可核验候选' : '真实数据源未返回有效域名（不补零、不编造）',
    }
  }

  return { register, health, planBatch, collect, sourceDefs: SOURCE_DEFS }
}
