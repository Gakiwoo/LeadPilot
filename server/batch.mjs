/**
 * v0.9.0 · 批量 SDR 管道（定位仍为「自动获客」）
 *
 * 产品边界（必须原样对外表达）：
 *  - 批量导入是批量 SDR 既有的线索投喂通道（展会名录 / 海关导出 / CRM 存量），
 *    origin 恒为 user_imported。**导入 ≠ 采集**，绝不写 system_collected。
 *  - v0.9.0 新增「用户指定 URL 抓取」：把导入行缺的原文由系统代抓（origin=user_directed_fetch），
 *    抓取失败逐条降级为 missing_source；**抓取 ≠ 采集**，商业 6 类源仍 0/6。
 *  - 自动化的对象是「批量补全 → 批量研判 → 批量出信 → 批量触达与回写」，
 *    不是「系统凭空发现公司」。数据源 0/6 仍如实上报。
 *  - 导出 mbox 是 PRD MVP 承诺的「一键建好草稿，用户自己按发送」的等价实现，
 *    **导出 ≠ 发送**，状态不自动置 sent，禁止批量直接发送。
 *  - 本模块不生成标注、不伪造 provider 调用、不解除任何 Go / No-Go 判据。
 */
import { protocol, validateEmailDraft, sanitizeContext } from './protocol.mjs'
import { extractFacts } from './t0.mjs'
import { createFetcher, FETCH_VERSION } from './fetch.mjs'

const CFG = protocol.batchPipeline
export const BATCH_VERSION = CFG.version
export const BATCH_FETCH_VERSION = FETCH_VERSION

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const iso = (ms) => new Date(ms).toISOString()

/* ------------------------------------------------------------------ 域名规范化 */

/** 去 scheme / userinfo / www / 端口 / 路径 / 尾点，统一小写；不做 DNS、不联网 */
export function normalizeDomain(raw) {
  let s = String(raw ?? '').trim().toLowerCase()
  if (!s) return ''
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  s = s.split(/[/?#]/)[0]
  if (s.includes('@')) s = s.split('@').pop()
  s = s.replace(/:\d+$/, '')
  s = s.replace(/^www\./, '')
  return s.replace(/^\.+|\.+$/g, '')
}

export function isDomain(v) {
  if (typeof v !== 'string' || v.length > 253 || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v)) return false
  const labels = v.split('.')
  return labels.every((l) => l.length > 0 && l.length <= 63 && !l.startsWith('-') && !l.endsWith('-'))
    && /^[a-z]{2,}$/.test(labels[labels.length - 1])
}

/* ------------------------------------------------------------------ CSV 解析 */

/** 支持引号包裹、转义双引号、CRLF、BOM；不引第三方依赖 */
export function parseCsv(text) {
  const s = String(text ?? '').replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c === '\r') { /* CRLF 的 \r 交给 \n 处理 */ }
    else field += c
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

const ALIASES = {
  company_name: ['company_name', 'company', 'name', '公司名称', '公司'],
  domain: ['domain', 'website', 'url', 'site', '域名', '官网'],
  source_url: ['source_url', 'sourceurl', 'source', '原文地址'],
  fetched_at: ['fetched_at', 'fetchedat', 'fetched', '抓取时间'],
  raw_text: ['raw_text', 'rawtext', 'text', 'about', '原文'],
  country: ['country', 'market', '国家', '市场'],
  product_hint: ['product_hint', 'producthint', 'product', '产品'],
  contact_email: ['contact_email', 'contactemail', 'email', '邮箱'],
  contact_name: ['contact_name', 'contactname', 'contact', '联系人'],
  origin: ['origin', '来源'],
}

function csvRows(text) {
  const matrix = parseCsv(text).filter((r) => r.some((c) => String(c).trim() !== ''))
  if (!matrix.length) return { rows: [], errors: ['CSV 为空'] }
  const header = matrix[0].map((h) => String(h).trim().toLowerCase())
  const lookup = {}
  for (const [canonical, names] of Object.entries(ALIASES)) {
    const idx = header.findIndex((h) => names.includes(h))
    if (idx >= 0) lookup[canonical] = idx
  }
  if (lookup.company_name === undefined || lookup.domain === undefined) {
    return { rows: [], errors: ['CSV 表头缺少 company_name 与 domain（可用别名：公司/公司名称、域名/官网）'] }
  }
  return {
    rows: matrix.slice(1).map((cells) => {
      const row = {}
      for (const [key, idx] of Object.entries(lookup)) row[key] = String(cells[idx] ?? '').trim()
      return row
    }),
    errors: [],
  }
}

/* ------------------------------------------------------------------ 导入校验 */

/**
 * 纯函数：逐行校验 + 域名去重，绝不静默丢数据。
 * 联系人邮箱/姓名允许本地存储，但登记 piiFields，发往模型前必须剥离。
 */
export function validateRows(rows, opts = {}) {
  const existing = opts.existingDomains instanceof Set ? opts.existingDomains : new Set()
  const errors = []
  const accepted = []
  const rejected = []
  const duplicates = []
  if (!Array.isArray(rows)) return { ok: false, errors: ['rows 必须是数组'], accepted, rejected, duplicates }
  if (!rows.length) return { ok: false, errors: ['没有可导入的数据行'], accepted, rejected, duplicates }
  if (rows.length > CFG.import.maxRows) {
    return { ok: false, errors: [`单批 ${rows.length} 行超过上限 ${CFG.import.maxRows}，请分批提交`], accepted, rejected, duplicates }
  }

  const seen = new Set()
  rows.forEach((raw, i) => {
    const rowIndex = i + 1
    if (!isObj(raw)) { rejected.push({ rowIndex, reason: '该行不是对象' }); return }

    const declaredOrigin = String(raw.origin ?? '').trim().toLowerCase()
    if (declaredOrigin && CFG.import.forbiddenOrigins.includes(declaredOrigin)) {
      rejected.push({ rowIndex, reason: `来源标识 ${declaredOrigin} 伪称系统采集；导入数据的 origin 只能是 ${CFG.import.origin}` })
      return
    }

    const companyName = String(raw.company_name ?? '').trim()
    if (!companyName || companyName.length > 200) { rejected.push({ rowIndex, reason: 'company_name 为空或超过 200 字' }); return }
    const domain = normalizeDomain(raw.domain)
    if (!isDomain(domain)) { rejected.push({ rowIndex, reason: `domain 非法：${String(raw.domain ?? '').slice(0, 80)}` }); return }

    const sourceUrl = String(raw.source_url ?? '').trim()
    const fetchedAt = String(raw.fetched_at ?? '').trim()
    const rawText = String(raw.raw_text ?? '')
    if (sourceUrl && !/^https?:\/\//.test(sourceUrl)) { rejected.push({ rowIndex, reason: 'source_url 必须是 http/https 原文地址' }); return }
    if (fetchedAt && !/^\d{4}-\d{2}-\d{2}/.test(fetchedAt)) { rejected.push({ rowIndex, reason: 'fetched_at 需 ISO 日期（YYYY-MM-DD…）' }); return }
    if (rawText.length > CFG.import.maxTextChars) { rejected.push({ rowIndex, reason: `raw_text 超过 ${CFG.import.maxTextChars} 字上限` }); return }

    const contactEmail = String(raw.contact_email ?? '').trim()
    const contactName = String(raw.contact_name ?? '').trim()
    if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contactEmail)) {
      rejected.push({ rowIndex, reason: 'contact_email 格式非法' }); return
    }

    if (seen.has(domain)) { duplicates.push({ rowIndex, domain, reason: '批内重复（同一规范化域名）' }); return }
    seen.add(domain)
    if (existing.has(domain)) { duplicates.push({ rowIndex, domain, reason: '库内已存在（不覆盖既有研判与状态）' }); return }

    const hasSource = Boolean(sourceUrl && fetchedAt && rawText.trim())
    const piiFields = []
    if (contactEmail) piiFields.push('contact_email')
    if (contactName) piiFields.push('contact_name')
    accepted.push({
      rowIndex, domain, companyName,
      country: String(raw.country ?? '').trim().slice(0, 80),
      productHint: String(raw.product_hint ?? '').trim().slice(0, 120),
      sourceUrl, fetchedAt, rawText,
      contactEmail, contactName, piiFields,
      origin: CFG.import.origin,
      missingSource: !hasSource,
    })
  })

  const summary = {
    received: rows.length, accepted: accepted.length,
    rejected: rejected.length, duplicates: duplicates.length,
  }
  if (!accepted.length) errors.push('没有任何可接受行：请检查 domain / company_name / 原文长度')
  return { ok: accepted.length > 0, errors, accepted, rejected, duplicates, summary }
}

/** 发往模型的结构化请求：只保留非 PII 字段；原文另行清洗 */
export function stripPiiForModel(rec) {
  return {
    facts: {
      domain: rec.domain,
      country: rec.country ?? '',
      productHint: rec.productHint ?? '',
      sourceMode: rec.missingSource ? 'missing_source' : CFG.import.origin,
    },
    profile: {},
    keywords: rec.productHint ? [rec.productHint] : [],
    markets: rec.country ? [rec.country] : [],
  }
}

/* ------------------------------------------------------------------ 导出合规闸门 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
/** 身份字段：email 进 From 头，其余必须出现在合规尾巴正文里 */
const SENDER_KEYS = ['name', 'email', 'company', 'postalAddress', 'unsubscribe']
const FOOTER_KEYS = ['name', 'company', 'postalAddress', 'unsubscribe']

/**
 * 纯函数：导出前的合规闸门。
 * 注意：本路径不调用任何模型，因此允许出现收件人邮箱；
 * assertNoPii 约束的是「发往 provider 的结构化请求」，不是本地客户库与本地导出文件。
 */
export function checkExportGates(items, ctx = {}) {
  const allowed = []
  const blocked = []
  const circuitOpen = Boolean(ctx.circuitOpen)
  const dailyLimit = Number(ctx.dailyLimit ?? CFG.export.draftExportDailyLimit)
  let usedToday = Number(ctx.exportedToday ?? 0)
  // B3-0（假设 #4 核查）：G2 不能只靠前端自觉。服务端同时接收调用方黑名单，
  // 并联合客户库里的不可逆终态做硬拦截，直接调 /v1/export/eml 也绕不过去。
  const blacklist = Array.isArray(ctx.blacklist)
    ? ctx.blacklist.map((b) => String(b).toLowerCase().trim()).filter(Boolean) : []
  const terminalDomains = Array.isArray(ctx.terminalDomains)
    ? ctx.terminalDomains.map((d) => String(d).toLowerCase().trim()).filter(Boolean) : []

  if (!Array.isArray(items) || !items.length) {
    return { allowed, blocked, errors: ['items 为空'], circuitOpen, exportedToday: usedToday }
  }
  items.forEach((item, i) => {
    const reasons = []
    if (circuitOpen) reasons.push(`退信率 ${ctx.bounceRate ?? '>3%'} 已触发熔断，导出与发送均暂停（E4010）`)
    if (!isObj(item)) reasons.push('该草稿不是对象')
    else {
      const to = String(item.to ?? '').trim()
      if (!EMAIL_RE.test(to)) reasons.push('收件人邮箱非法')
      const email = to.toLowerCase()
      const emailDomain = email.split('@')[1] ?? ''
      if (blacklist.some((b) => (b.startsWith('@') ? emailDomain === b.slice(1) : email === b))) {
        reasons.push('收件人命中黑名单/退订（G2，全局禁止发送）')
      }
      if (terminalDomains.includes(String(item.domain ?? '').toLowerCase().trim())) {
        reasons.push('客户已处于退订/无效终态（G2，不可逆，禁止导出）')
      }
      const grade = String(item.grade ?? '').toUpperCase()
      if (grade === 'D') reasons.push('D 级联系人禁止发信（PRD 11.2）')
      if (grade === 'C' && item.confirmed !== true) reasons.push('C 级联系人需逐条人工确认（PRD 11.2）')
      if (!['A', 'B', 'C', 'D'].includes(grade)) reasons.push('grade 必须是 A/B/C/D')

      const draft = validateEmailDraft({ subject: item.subject, body: item.body })
      if (!draft.valid) reasons.push(...draft.errors)

      const sender = isObj(item.sender) ? item.sender : {}
      const missing = SENDER_KEYS.filter((k) => !String(sender[k] ?? '').trim())
      if (missing.length) reasons.push(`合规尾巴身份字段缺失：${missing.join('、')}`)
      if (String(sender.unsubscribe ?? '').trim() && !/unsubscribe|退订/i.test(String(sender.unsubscribe))) {
        reasons.push('退订说明必须含 unsubscribe / 退订')
      }
      const footer = String(item.footer ?? '').trim()
      if (!footer) reasons.push('合规尾巴 footer 缺失（由调用方注入，服务端不代生成、不落库）')
      else {
        for (const k of FOOTER_KEYS) {
          if (String(sender[k] ?? '').trim() && !footer.includes(String(sender[k]).trim())) {
            reasons.push(`footer 未包含 sender.${k}`)
          }
        }
        if (!/unsubscribe|退订/i.test(footer)) reasons.push('footer 缺少退订说明')
      }
      if (usedToday + 1 > dailyLimit) reasons.push(`今日草稿导出已达 ${dailyLimit} 封上限，超额部分进明日队列`)
    }

    if (reasons.length) blocked.push({ index: i, domain: item?.domain ?? null, code: 'E4009', reasons })
    else { usedToday += 1; allowed.push({ ...item, _wordCount: validateEmailDraft({ subject: item.subject, body: item.body }).value?.wordCount ?? 0 }) }
  })
  return { allowed, blocked, errors: [], circuitOpen, exportedToday: usedToday }
}

const headerSafe = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim()
const mimeSubject = (s) => (/[^\x00-\x7F]/.test(s)
  ? `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`
  : headerSafe(s))

/** mbox：主流邮件客户端可直接导入；零依赖、单文件、可批量。绝不执行任何发送动作。 */
export function buildMbox(items, opts = {}) {
  const date = new Date(opts.now ?? Date.now()).toUTCString()
  const chunks = items.map((it) => {
    const sender = it.sender ?? {}
    const bodyText = `${String(it.body ?? '').trim()}\n\n${String(it.footer ?? '').trim()}`
      .split('\n').map((l) => (/^From /.test(l) ? `>${l}` : l)).join('\n')
      .replace(/\r?\n/g, '\r\n')
    return [
      `From leadpilot-export ${date}`,
      `From: ${headerSafe(sender.company || sender.name)} <${headerSafe(sender.email)}>`,
      `To: ${headerSafe(it.to)}`,
      `Subject: ${mimeSubject(String(it.subject ?? ''))}`,
      `Date: ${date}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      `X-LeadPilot-Domain: ${headerSafe(it.domain)}`,
      'X-LeadPilot-Status: drafted',
      `X-LeadPilot-Origin: ${CFG.import.origin}`,
      'X-LeadPilot-Note: exported-not-sent',
      '',
      bodyText,
    ].join('\r\n')
  })
  return chunks.join('\r\n\r\n') + '\r\n'
}

/* ------------------------------------------------------------------ 结果回写 / 熔断 */

/** 纯函数：最近窗口内的退信率；样本为 0 时返回 null，绝不伪造 0% */
export function computeBounceRate(events, windowSize = CFG.outcomes.bounceWindow) {
  const relevant = (Array.isArray(events) ? events : [])
    .filter((e) => e?.event === 'sent' || e?.event === 'bounced')
    .slice(-windowSize)
  if (!relevant.length) return { sent: 0, bounced: 0, rate: null, sampleSize: 0 }
  const bounced = relevant.filter((e) => e.event === 'bounced').length
  const sent = relevant.length - bounced
  return { sent, bounced, rate: bounced / relevant.length, sampleSize: relevant.length }
}

export function outcomeEventsForExport(store, now = Date.now()) {
  const events = typeof store.outcomeList === 'function' ? store.outcomeList(5000) : []
  const dayStart = new Date(now).toISOString().slice(0, 10)
  const exportedToday = events
    .filter((e) => e?.event === 'exported' && iso(Number(e.at ?? 0)).slice(0, 10) === dayStart)
    .reduce((sum, e) => sum + Number(e?.meta?.count ?? 0), 0)
  return { events, exportedToday }
}

/* ------------------------------------------------------------------ 管道实例 */

export function createBatchPipeline({ store, gateway, fetcher = createFetcher(), now = () => Date.now() } = {}) {
  if (!store) throw new Error('createBatchPipeline 需要 store')
  const batchId = () => `b${now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

  function companies() { return typeof store.companyList === 'function' ? store.companyList() : [] }
  function existingDomains() { return new Set(companies().map((c) => c.domain)) }

  function importCompanies(payload = {}) {
    const parsed = typeof payload.csv === 'string' && payload.csv.trim()
      ? csvRows(payload.csv)
      : { rows: payload.rows, errors: [] }
    if (parsed.errors.length) {
      return { ok: false, code: 'E4007', errors: parsed.errors, summary: { received: 0, accepted: 0, rejected: 0, duplicates: 0 } }
    }
    const v = validateRows(parsed.rows, { existingDomains: existingDomains() })
    if (!v.ok) {
      return { ok: false, code: 'E4007', errors: v.errors, rejected: v.rejected, duplicates: v.duplicates, summary: v.summary }
    }
    const at = iso(now())
    for (const row of v.accepted) {
      store.companyUpsert(row.domain, {
        ...row,
        importedAt: at,
        status: 'new',
        judgement: null,
        statusLog: [{ from: null, to: 'new', at, automated: false, note: `批量导入 · row ${row.rowIndex}` }],
      })
    }
    return {
      ok: true, version: BATCH_VERSION, origin: CFG.import.origin,
      summary: v.summary,
      rejected: v.rejected, duplicates: v.duplicates,
      companies: v.accepted.map((r) => ({ domain: r.domain, companyName: r.companyName, missingSource: r.missingSource })),
      partial: v.summary.rejected > 0 || v.summary.duplicates > 0,
      note: '导入 ≠ 采集：这些线索由调用方提供，origin=user_imported；系统未发起任何抓取。缺少 source_url/fetched_at/raw_text 三件套的行已标 missing_source，不进入 T0 事实链，也不会拿演示文本补齐。联系人信息仅本地存储，发往模型前剥离。',
    }
  }

  function listCompanies() {
    return {
      ok: true, version: BATCH_VERSION, origin: CFG.import.origin,
      count: companies().length,
      companies: companies().map((c) => ({
        domain: c.domain, companyName: c.companyName, country: c.country,
        status: c.status, missingSource: Boolean(c.missingSource),
        hasSource: !c.missingSource && Boolean(String(c.rawText ?? '').trim()),
        sourceOrigin: c.sourceOrigin ?? null,
        sourceUrl: c.sourceUrl ?? null,
        hasJudgement: Boolean(c.judgement), piiFields: c.piiFields ?? [],
      })),
      note: '本接口只返回调用方导入的线索，不代表系统采集结果；sourceOrigin=user_directed_fetch 表示原文由用户指定 URL 抓取。',
    }
  }

  const normalizeUrlKey = (u) => {
    try { return new URL(String(u)).href } catch { return String(u ?? '') }
  }

  /**
   * v0.9.0 · 用户指定 URL 抓取（ADR-032）。
   * 只抓已导入公司显式提供的 website / source_url（缺省 https://<domain>）：
   * 不发现、不爬全站、不抓登录后内容；抓取成功把原文写回 company，
   * 公司 origin 仍是 user_imported，原文来源标 user_directed_fetch；失败逐条 missing_source。
   */
  async function fetchSources(payload = {}) {
    const all = companies()
    const limit = Math.min(
      Math.max(1, Number(payload.limit ?? 10)),
      protocol.fetchPolicy.maxUrlsPerBatch,
    )
    const wanted = Array.isArray(payload.domains) && payload.domains.length
      ? payload.domains.map(normalizeDomain).map((d) => all.find((c) => c.domain === d)).filter(Boolean)
      : all.filter((c) => c.missingSource || !String(c.rawText ?? '').trim())
    const selected = wanted.slice(0, limit)
    if (!selected.length) {
      return {
        ok: false, code: 'E4008',
        reason: '没有缺少原文的已导入公司：先导入线索（或这些公司已有 source_url/fetched_at/raw_text）',
        note: '抓取不会凭空发现公司；请先 POST /v1/import/companies。',
      }
    }
    const targets = selected.map((c) => {
      const raw = String(c.website ?? c.sourceUrl ?? '').trim()
      const url = /^https?:\/\//i.test(raw) ? raw : `https://${c.domain}`
      return { domain: c.domain, url }
    })
    // P2 · 分批调用抓取器：每批不超过 fetchPolicy.maxUrlsPerRequest，
    // 且绝不再用 targets.length 覆盖抓取器自身的单次上限（旧实现会绕过契约限制）。
    const perCall = Math.max(1, Math.trunc(Number(protocol.fetchPolicy.maxUrlsPerRequest) || 10))
    const fetched = []
    const failed = []
    for (let i = 0; i < targets.length; i += perCall) {
      const slice = targets.slice(i, i + perCall)
      const part = await fetcher.fetchMany(slice.map((t) => t.url))
      const partFetched = part.fetched ?? []
      const partFailed = part.failed ?? []
      fetched.push(...partFetched)
      failed.push(...partFailed)
      // 整批被拒（上限 / 参数非法）时逐条如实标注，不伪装成「抓取未返回结果」
      if (part.ok === false && !partFetched.length && !partFailed.length) {
        for (const t of slice) {
          failed.push({ url: t.url, code: part.code ?? 'E4012', reason: part.reason ?? '抓取被拒绝' })
        }
      }
    }
    const fetchedByKey = new Map(fetched.map((r) => [normalizeUrlKey(r.url), r]))
    const failedByKey = new Map(failed.map((r) => [normalizeUrlKey(r.url), r]))
    const items = []
    for (const t of targets) {
      const key = normalizeUrlKey(t.url)
      const rec = store.companyGet(t.domain)
      if (!rec) {
        items.push({ domain: t.domain, url: t.url, ok: false, code: 'E4012', reason: '客户记录已不存在' })
        continue
      }
      const hit = fetchedByKey.get(key)
      if (hit) {
        const at = iso(now())
        store.companyUpsert(t.domain, {
          ...rec,
          website: t.url,
          sourceUrl: hit.url,
          fetchedAt: hit.fetchedAt,
          rawText: hit.text,
          sourceHash: hit.hash,
          sourceOrigin: protocol.fetchPolicy.origin,
          sourceFetchedAt: at,
          missingSource: false,
          statusLog: [...(rec.statusLog ?? []), {
            from: rec.status, to: rec.status, at, automated: true,
            note: `用户指定 URL 抓取 · ${hit.url}（origin=${protocol.fetchPolicy.origin}，抓取 ≠ 采集）`,
          }],
        })
        items.push({
          domain: t.domain, url: t.url, ok: true, finalUrl: hit.finalUrl,
          fetchedAt: hit.fetchedAt, textChars: hit.textChars, hash: hit.hash,
          truncated: hit.truncated, piiRemoved: hit.piiRemoved,
          origin: protocol.fetchPolicy.origin,
        })
      } else {
        const failed = failedByKey.get(key) ?? { code: 'E4012', reason: '抓取未返回结果' }
        store.companyUpsert(t.domain, {
          ...rec,
          missingSource: true,
          sourceFetchError: { code: failed.code ?? 'E4012', reason: String(failed.reason ?? '抓取失败'), at: iso(now()) },
        })
        items.push({
          domain: t.domain, url: t.url, ok: false,
          code: failed.code ?? 'E4012', reason: failed.reason ?? '抓取失败', missingSource: true,
        })
      }
    }
    const okCount = items.filter((x) => x.ok).length
    return {
      ok: okCount > 0,
      version: BATCH_VERSION,
      fetchVersion: FETCH_VERSION,
      origin: CFG.import.origin,
      sourceOrigin: protocol.fetchPolicy.origin,
      summary: { requested: items.length, fetched: okCount, failed: items.length - okCount },
      items,
      releaseEligible: false,
      note: '抓取 ≠ 采集：只抓取已导入公司显式提供的 website/source_url（缺省 https://<domain>），不发现、不爬全站、不抓登录后内容。原文 origin=user_directed_fetch，公司 origin 仍为 user_imported；失败逐条标 missing_source，不编造原文。商业 6 类数据源仍 0/6。',
    }
  }

  async function runJudgeBatch(payload = {}) {
    const all = companies()
    const size = Math.min(Math.max(1, Number(payload.batchSize ?? CFG.judge.batchSizeDefault)), CFG.judge.batchSizeMax)
    const selected = Array.isArray(payload.domains) && payload.domains.length
      ? payload.domains.map(normalizeDomain).map((d) => all.find((c) => c.domain === d)).filter(Boolean)
      : all.filter((c) => !c.judgement).slice(0, size)
    if (!selected.length) {
      return { ok: false, code: 'E4008', reason: '没有待研判的已导入公司；先调用 POST /v1/import/companies' }
    }
    if (selected.length > CFG.judge.batchSizeMax) {
      return { ok: false, code: 'E4008', reason: `单次最多 ${CFG.judge.batchSizeMax} 家，请分批` }
    }

    const id = String(payload.batchId ?? batchId())
    const items = []
    for (const rec of selected) {
      const hasSource = !rec.missingSource && rec.sourceUrl && rec.fetchedAt && String(rec.rawText ?? '').trim()
      const cleaned = hasSource ? sanitizeContext([rec.rawText]).texts[0] : ''
      const sources = hasSource ? [{ url: rec.sourceUrl, text: cleaned, fetched_at: rec.fetchedAt }] : []
      const modelInput = stripPiiForModel(rec)
      // T0 是确定性规则，不调模型不联网；先跑一遍让「无 provider」时也有可核验事实可交付
      const t0 = sources.length
        ? extractFacts({ company_id: rec.domain, sources, keywords: modelInput.keywords, markets: modelInput.markets })
        : null
      let judged = null
      let bucket = 'failed'
      let reason = ''
      try {
        judged = gateway
          ? await gateway.judge({
            companyId: rec.domain, domain: rec.domain, country: rec.country,
            sources, sourceTexts: sources.map((s) => s.text),
            facts: modelInput.facts, profile: modelInput.profile,
            keywords: modelInput.keywords, markets: modelInput.markets,
            requestId: `${id}:${rec.domain}`,
          })
          : { ok: false, degraded: true, errorCodes: ['E6005'], reason: '未注入网关实例，未发起任何模型调用' }
      } catch (err) {
        judged = { ok: false, degraded: true, errorCodes: ['E6005'], reason: String(err?.message ?? err) }
      }
      if (judged.ok) bucket = 'succeeded'
      else if (judged.degraded || judged.needsConsent) bucket = 'degraded'
      reason = String(judged.reason ?? judged.errorCodes?.join(',') ?? '')

      if (judged.ok) {
        store.companyUpsert(rec.domain, { ...rec, judgement: judged.clientJudgement ?? judged.judgement })
      }
      items.push({
        domain: rec.domain, bucket,
        missingSource: !hasSource,
        t0: t0?.ok ? {
          used: true, extractor: 'rules', rulesVersion: t0.rulesVersion,
          coverage: t0.coverage, evidenceCount: t0.evidence?.length ?? 0,
        } : { used: false, reason: t0?.errors?.join('；') ?? '未提供可核验原文，T0 未执行' },
        modelJudgement: judged.ok ? (judged.clientJudgement ?? judged.judgement) : null,
        codes: judged.errorCodes ?? [], reason,
        billing: judged.billing ?? null,
        note: judged.ok
          ? '真实模型判断已写入（经证据校验与 T0 冲突裁决）'
          : '模型判断未执行或未通过校验；T0 规则事实不是模型结论，不得计入 succeeded，也不写回 judgement',
      })
    }
    const summary = {
      total: items.length,
      succeeded: items.filter((x) => x.bucket === 'succeeded').length,
      degraded: items.filter((x) => x.bucket === 'degraded').length,
      failed: items.filter((x) => x.bucket === 'failed').length,
    }
    return {
      ok: true, version: BATCH_VERSION, batchId: id, summary, items,
      allSucceeded: summary.succeeded === summary.total,
      releaseEligible: false,
      note: 'T0 规则抽取真实执行；模型判断只在存在可用 provider 且锁定快照时才发生。未配 Key / 未锁版本时如实 E6005 / E6008，绝不把降级或 T0 事实伪装成模型判断。',
    }
  }

  function state() {
    const { events, exportedToday } = outcomeEventsForExport(store, now())
    const bounce = computeBounceRate(events)
    return {
      version: BATCH_VERSION,
      positioning: CFG.positioning, targetUser: CFG.targetUser, stage: CFG.stage,
      companies: companies().length,
      judged: companies().filter((c) => c.judgement).length,
      exportedToday,
      bounce: { ...bounce, threshold: CFG.export.bounceCircuitThreshold },
      circuitOpen: bounce.rate !== null && bounce.rate > CFG.export.bounceCircuitThreshold,
      draftExportDailyLimit: CFG.export.draftExportDailyLimit,
      dataSourceReady: '0/6 由 /health.dataSources 单独如实上报；本管道不做采集',
      userDirectedFetch: {
        version: FETCH_VERSION,
        origin: protocol.fetchPolicy.origin,
        counters: fetcher.health().counters,
        policy: {
          respectRobots: protocol.fetchPolicy.respectRobots,
          perDomainMinIntervalMs: protocol.fetchPolicy.perDomainMinIntervalMs,
          maxUrlsPerBatch: protocol.fetchPolicy.maxUrlsPerBatch,
        },
        note: '用户指定 URL 抓取单独计数，不并入商业数据源 0/6；抓取 ≠ 采集。',
      },
      releaseEligible: false,
    }
  }

  function exportDrafts(payload = {}) {
    const ctx = state()
    if (ctx.exportedToday >= ctx.draftExportDailyLimit) {
      return { ok: false, code: 'E4009', reason: `今日草稿导出已达 ${ctx.draftExportDailyLimit} 封上限` }
    }
    const items = Array.isArray(payload.items) ? payload.items : []
    const terminalDomains = []
    for (const item of items) {
      const domain = normalizeDomain(item?.domain ?? '')
      const rec = domain ? store.companyGet(domain) : null
      if (rec && CFG.outcomes.terminalStatuses.includes(rec.status)) terminalDomains.push(domain)
    }
    const gates = checkExportGates(payload.items, {
      circuitOpen: ctx.circuitOpen, bounceRate: ctx.bounce.rate,
      exportedToday: ctx.exportedToday, dailyLimit: ctx.draftExportDailyLimit,
      blacklist: Array.isArray(payload.blacklist) ? payload.blacklist : [],
      terminalDomains,
    })
    if (gates.errors?.length) return { ok: false, code: 'E4009', errors: gates.errors }
    if (!gates.allowed.length) {
      return {
        ok: false, code: ctx.circuitOpen ? 'E4010' : 'E4009',
        blocked: gates.blocked, state: ctx,
        reason: ctx.circuitOpen ? '退信熔断中，草稿导出暂停' : '全部草稿被合规闸门拒绝',
      }
    }
    const content = buildMbox(gates.allowed, { now: now() })
    const at = now()
    // B3-2：此前只在响应里写 statusAfterExport，客户库状态从未落盘。
    // 导出的草稿确实应进入 drafted（≠ sent），且不可逆终态绝不改写。
    for (const item of gates.allowed) {
      const domain = normalizeDomain(item?.domain ?? '')
      const rec = domain ? store.companyGet(domain) : null
      if (!rec || CFG.outcomes.terminalStatuses.includes(rec.status)) continue
      store.companyUpsert(domain, {
        ...rec, status: CFG.export.statusAfterExport,
        statusLog: [...(rec.statusLog ?? []), {
          from: rec.status, to: CFG.export.statusAfterExport, at: iso(at), automated: true,
          note: '草稿已导出（exported-not-sent），状态按契约落盘 drafted，绝不等于已发送',
        }],
      })
    }
    // 导出是审计事件，不是发送事件；不参与退信率分子/分母，也绝不把状态置为 sent
    store.outcomeAppend({ domain: '*', event: 'exported', at, meta: { count: gates.allowed.length, format: 'mbox' } })
    const filename = `leadpilot-drafts-${iso(at).slice(0, 10)}.mbox`
    return {
      ok: true, version: BATCH_VERSION, format: 'mbox', filename, content,
      count: gates.allowed.length, blocked: gates.blocked,
      statusAfterExport: CFG.export.statusAfterExport,
      exportedIsNotSent: true,
      note: '导出 ≠ 发送：本接口只生成 mbox 草稿文件，未调用任何邮件 API，状态不自动置 sent。请导入邮件客户端后由人逐封确认发送；OAuth / CASA Tier 2 仍是正式发布门禁。',
      disclaimer: '合规尾巴由调用方在本地注入，服务端只校验存在性，不代生成、不代存身份信息。',
    }
  }

  function importOutcomes(payload = {}) {
    const events = Array.isArray(payload.events) ? payload.events : []
    if (!events.length) return { ok: false, code: 'E4010', reason: 'events 为空' }
    if (events.length > 500) return { ok: false, code: 'E4010', reason: '单批最多 500 条结果' }
    const applied = []
    const rejected = []
    events.forEach((e, i) => {
      const domain = normalizeDomain(e?.domain)
      const event = String(e?.event ?? '')
      const reasons = []
      if (!isDomain(domain)) reasons.push('domain 非法')
      if (!CFG.outcomes.allowedEvents.includes(event)) reasons.push(`event 不在白名单：${event || '空'}`)
      if (CFG.outcomes.requiresConfirmation.includes(event) && e?.confirmed !== true) {
        reasons.push(`${event} 属不可逆终态，必须逐条人工确认（confirmed=true）`)
      }
      if (reasons.length) { rejected.push({ index: i, domain, event, code: 'E4010', reasons }); return }
      const rec = store.companyGet(domain)
      if (!rec) { rejected.push({ index: i, domain, event, code: 'E4010', reasons: ['该域名不在已导入客户库中'] }); return }
      if (CFG.outcomes.terminalStatuses.includes(rec.status)) {
        rejected.push({ index: i, domain, event, code: 'E4010', reasons: [`当前状态 ${rec.status} 为不可逆终态，任何任务与账号均不可再流转（PRD F8）`] }); return
      }
      // P2 · 结果回写必须沿业务时间线单向流转：replied→sent→bounced 这类任意回退会
      // 污染退信率/回复率统计。约束来自 shared 协议，缺失定义时一律拒绝（fail-closed）。
      const allowedFrom = CFG.outcomes.allowedFrom?.[event]
      if (!Array.isArray(allowedFrom)) {
        rejected.push({ index: i, domain, event, code: 'E4010', reasons: [`事件 ${event} 缺少 allowedFrom 流转约束，拒绝回写（fail-closed）`] }); return
      }
      if (!allowedFrom.includes('*') && !allowedFrom.includes(rec.status)) {
        rejected.push({
          index: i, domain, event, code: 'E4010',
          reasons: [`状态不可回退：${rec.status} → ${event} 不在业务时间线内（允许前驱：${allowedFrom.join(' / ')}）`],
        }); return
      }
      const at = Number.isFinite(Number(e?.at)) && Number(e?.at) > 0 ? Number(e.at) : now()
      store.outcomeAppend({ domain, event, at, meta: { operator: String(e?.operator ?? '本地用户'), note: String(e?.note ?? '') } })
      store.companyUpsert(domain, {
        ...rec, status: event,
        statusLog: [...(rec.statusLog ?? []), {
          from: rec.status, to: event, at: iso(at), automated: true,
          note: `发送结果回写 · ${event}（自动流转白名单）`,
        }],
      })
      applied.push({ domain, event, from: rec.status, to: event })
    })
    const next = state()
    return {
      ok: true, version: BATCH_VERSION, applied, rejected, state: next,
      note: '仅 drafted / sent / bounced / replied 属自动流转白名单；unsubscribed / invalid 需逐条确认且不可逆。退信率超过 3% 时熔断，后续草稿导出返回 423 E4010。',
    }
  }

  return {
    version: BATCH_VERSION,
    importCompanies, listCompanies, fetchSources, runJudgeBatch,
    exportDrafts, importOutcomes, state, health: state,
  }
}
