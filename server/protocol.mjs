/**
 * PRD 6.7.3 / 6.7.7 / 11.4.1 / F0-6 · 服务端协议层
 *
 * 与前端 src/domain/llm-judgement.ts 共用 shared/model-protocol.json，
 * 避免「前端放行的枚举、后端却判越界」这类协议漂移。
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

export const protocol = JSON.parse(
  readFileSync(new URL('../shared/model-protocol.json', import.meta.url), 'utf8'),
)

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

export function normalizeText(text) {
  return String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

/** PRD 6.7.3 硬约束②：引用可在 <context> 原文中模糊匹配（token 覆盖率 ≥ 90%） */
export function quoteMatchesContext(quote, sources) {
  const q = normalizeText(quote)
  if (q.length < 4) return false
  const corpus = normalizeText(sources.join(' \n '))
  if (corpus.includes(q)) return true
  const tokens = q.split(' ').filter((t) => t.length > 1)
  if (!tokens.length) return false
  return tokens.filter((t) => corpus.includes(t)).length / tokens.length >= protocol.rules.evidenceMinHitRate
}

function checkEvidence(raw, label) {
  const errors = []
  if (!Array.isArray(raw) || !raw.length) return { value: [], errors: [`${label}.evidence 为空（无证据不给判断）`] }
  const value = []
  raw.forEach((item, i) => {
    if (!isObj(item)) { errors.push(`${label}.evidence[${i}] 不是对象`); return }
    const quote = item.quote
    const sourceUrl = item.source_url ?? item.sourceUrl
    const fetchedAt = item.fetched_at ?? item.fetchedAt
    if (typeof quote !== 'string' || quote.trim().length < 4) errors.push(`${label}.evidence[${i}].quote 缺失或过短`)
    if (typeof sourceUrl !== 'string' || !/^https?:\/\//.test(sourceUrl)) errors.push(`${label}.evidence[${i}].source_url 非法`)
    if (typeof fetchedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(fetchedAt)) errors.push(`${label}.evidence[${i}].fetched_at 非法`)
    value.push({ quote, source_url: sourceUrl, fetched_at: fetchedAt, label: item.label })
  })
  return { value, errors }
}

function containsForbidden(node, depth = 0) {
  if (depth > 4 || !isObj(node)) return null
  for (const [k, v] of Object.entries(node)) {
    if (protocol.forbiddenFields.includes(k.toLowerCase())) return k
    if (isObj(v)) { const n = containsForbidden(v, depth + 1); if (n) return n }
  }
  return null
}

/** 固定 schema 校验。越界值整条作废，不做自动纠正。 */
export function validateSchema(raw) {
  const errors = []
  if (!isObj(raw)) return { valid: false, errors: ['响应不是对象'], value: null }
  const forbidden = containsForbidden(raw)
  if (forbidden) errors.push(`出现禁用字段 ${forbidden}（模型不得打分）`)

  if (typeof raw.company_id !== 'string' || !raw.company_id) errors.push('company_id 缺失')
  for (const k of protocol.wireFormat.versionFields) {
    if (typeof raw[k] !== 'string' || !raw[k]) errors.push(`${k} 缺失（版本留痕强制）`)
  }
  if (protocol.rules.forbidFloatingModelPointer && typeof raw.model_version === 'string' && /latest/i.test(raw.model_version)) {
    errors.push('model_version 含 -latest 浮动指针（生产必须锁定快照版本）')
  }

  const fields = {
    customer_type: { enumKey: 'customer_type', valueKey: 'value' },
    import_signal: { enumKey: 'import_signal', valueKey: 'value' },
    size_estimate: { enumKey: 'size_estimate', valueKey: 'tier' },
  }
  const evidence = {}
  for (const [name, spec] of Object.entries(fields)) {
    const holder = raw[name]
    if (!isObj(holder)) { errors.push(`缺少 ${name}`); continue }
    const v = holder[spec.valueKey]
    if (!protocol.enums[spec.enumKey].includes(v)) errors.push(`${name}.${spec.valueKey} 越界：${String(v)}`)
    if (typeof holder.confidence !== 'number' || holder.confidence < 0 || holder.confidence > 1) {
      errors.push(`${name}.confidence 越界（应为 0–1）`)
    }
    const ev = checkEvidence(holder.evidence, name)
    errors.push(...ev.errors)
    evidence[name] = ev.value
  }

  if (!Array.isArray(raw.negative_flags)) errors.push('negative_flags 不是数组')
  else for (const f of raw.negative_flags) {
    if (!protocol.enums.negative_flags.includes(f)) errors.push(`negative_flags 含越界值：${String(f)}`)
  }

  if (errors.length) return { valid: false, errors, value: null }
  return {
    valid: true, errors: [],
    value: {
      company_id: raw.company_id,
      customer_type: { value: raw.customer_type.value, confidence: raw.customer_type.confidence, evidence: evidence.customer_type },
      import_signal: { value: raw.import_signal.value, confidence: raw.import_signal.confidence, evidence: evidence.import_signal },
      size_estimate: {
        tier: raw.size_estimate.tier,
        employee_range: Array.isArray(raw.size_estimate.employee_range) ? raw.size_estimate.employee_range : null,
        confidence: raw.size_estimate.confidence,
        evidence: evidence.size_estimate,
      },
      negative_flags: raw.negative_flags,
      notes_for_human: typeof raw.notes_for_human === 'string' ? raw.notes_for_human : undefined,
      model_id: raw.model_id, model_version: raw.model_version,
      prompt_version: raw.prompt_version, schema_version: raw.schema_version,
    },
  }
}

/** 证据校验：字段命中率 < 90% 整条丢弃；整体可溯源率 < 95% 触发 P0 告警 */
export function verifyEvidence(value, sourceTexts) {
  const fields = {}
  let matched = 0
  let total = 0
  for (const name of ['customer_type', 'import_signal', 'size_estimate']) {
    const evs = value[name].evidence
    const hits = evs.filter((e) => quoteMatchesContext(e.quote, sourceTexts)).length
    const hitRate = evs.length ? hits / evs.length : 0
    matched += hits; total += evs.length
    fields[name] = {
      accepted: hitRate >= protocol.rules.evidenceMinHitRate,
      hitRate,
      reason: hitRate >= protocol.rules.evidenceMinHitRate ? undefined : 'E6004 引用无法在原文核验，字段整条丢弃',
    }
    if (!fields[name].accepted) {
      // 丢弃后回退 no_signal / unknown，不保留模型判断
      if (name === 'customer_type') value[name].value = 'unknown'
      if (name === 'import_signal') value[name].value = 'no_signal'
      if (name === 'size_estimate') value[name].tier = 'unknown'
      value[name].confidence = 0
      value[name].evidence = []
    }
  }
  return {
    value, fields,
    provenanceRate: total ? matched / total : 0,
    passesGate: total ? matched / total >= protocol.rules.provenanceRateMin : false,
  }
}

/** PRD 11.4.1：从协议层剔除个人信息；命中即拒绝转发，不靠调用方自觉 */
export function assertNoPii(payload) {
  const violations = []
  const walk = (node, path, depth = 0) => {
    if (depth > 6 || node === null || node === undefined) return
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1)); return }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        const key = k.toLowerCase()
        const next = `${path}.${k}`
        if (protocol.piiExclusion.rejectRequestFields.some((f) => key === f || key.includes(f))) {
          violations.push(next)
        }
        walk(v, next, depth + 1)
      }
      return
    }
    if (typeof node === 'string') {
      for (const p of protocol.piiExclusion.rejectPatterns) {
        if (node.includes(p)) { violations.push(`${path}（命中 ${p}）`); break }
      }
    }
  }
  walk(payload, 'payload')
  return { ok: violations.length === 0, violations: [...new Set(violations)] }
}

/** PRD F0-6 点数折算；折算率外置在协议文件，模型涨价不用改代码 */
export function pointCost(usage, tier, searchCalls = 0, provider = null) {
  const rate = provider ?? { inUsdPerM: 0.3, outUsdPerM: 1.2 }
  const usd =
    (usage.input / 1_000_000) * rate.inUsdPerM +
    (usage.output / 1_000_000) * rate.outUsdPerM +
    searchCalls * protocol.billing.searchRateUsdPerCall
  const multiplier = protocol.billing.modelTierMultiplier[tier] ?? 1
  return Math.ceil(usd / protocol.billing.pointValueUsd) * multiplier
}

/**
 * 账本计费点数：PRD 公式乘层级系数后可能是小数（T1 = 1.6 倍），
 * 而账本只接受非负整数。统一向上取整；响应必须同时给出原始折算估值，
 * 绝不把 1.6 点悄悄说成 1 点或 2 点而不留痕。
 */
export function billingPoints(usage, tier, searchCalls = 0, provider = null) {
  return Math.ceil(pointCost(usage, tier, searchCalls, provider))
}

/** 结果缓存键：同域名 + 同 prompt 版本 + 同一份原文（30 天 TTL 由网关控制） */
export function cacheKey(domain, sourceTexts) {
  const hash = createHash('sha256').update(sourceTexts.join('\n')).digest('hex').slice(0, 16)
  return `${domain}:${protocol.promptVersion}:${protocol.schemaVersion}:${hash}`
}

/**
 * PRD 11.4.1：官网自由文本里可能夹带邮箱/电话，从协议层剔除后再发给模型。
 * 结构化字段命中 PII 直接拒绝请求；自由文本则清洗，不因含联系方式就丢掉整页事实。
 */
export function sanitizeContext(texts) {
  let removed = 0
  const clean = (Array.isArray(texts) ? texts : []).map((raw) => {
    let s = String(raw ?? '')
    s = s.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, () => { removed++; return '[email removed]' })
    s = s.replace(/\+?\d[\d\s().-]{7,}\d/g, () => { removed++; return '[phone removed]' })
    s = s.replace(/\b(?:sk-|Bearer\s+)[A-Za-z0-9_-]{8,}/g, () => { removed++; return '[credential removed]' })
    return s
  })
  return { texts: clean, removed }
}

/**
 * T0 → judge 事实链（ADR-016 / PRD 6.7.1）：把规则层抽取的可核验事实注入 system prompt。
 * T0 是规则、不是模型；这里只提供 quote 与命中状态，不让模型「参考另一个模型的结论」。
 */
function t0FactLines(t0) {
  if (!t0?.ok) return []
  const lines = [
    '',
    `<t0_facts extractor="rules" rules_version="${t0.rulesVersion}">`,
    '以下事实由确定性词表从 <context> 抽取，每条 quote 均可在 <context> 中逐字核验。',
    '硬约束：不得与这些事实矛盾；标为 no_signal 的维度，除非 <context> 有直接原文证据，否则必须输出 no_signal / unknown。',
  ]
  for (const name of ['customer_type', 'import_signal', 'size_estimate']) {
    const f = t0.facts?.[name]
    if (!f) continue
    const value = name === 'size_estimate' ? f.tier : f.value
    const quotes = (f.evidence ?? []).slice(0, 3).map((e) => `"${e.quote}"`).join(' | ')
    lines.push(`${name}: ${value}${f.no_signal ? ' (no_signal)' : ''} · quotes: ${quotes || 'none'}`)
  }
  lines.push(`no_signal_fields: ${(t0.coverage?.noSignalFields ?? []).join(',') || 'none'}`)
  lines.push('</t0_facts>')
  return lines
}

/** PRD 6.7.7 Prompt 层硬隔离：模型只能使用 <context> 内的内容 */
export function buildJudgeMessages(input) {
  const context = (input.sourceTexts ?? []).map((t, i) => `[${i + 1}] ${t}`).join('\n')
  const hasT0 = Boolean(input.t0?.ok)
  return [
    {
      role: 'system',
      content: [
        protocol.rules.systemPromptGuard,
        `你只输出 JSON，不解释、不寒暄。字段取值必须落在以下枚举白名单内：`,
        `customer_type.value: ${protocol.enums.customer_type.join('|')}`,
        `import_signal.value: ${protocol.enums.import_signal.join('|')}`,
        `size_estimate.tier: ${protocol.enums.size_estimate.join('|')}`,
        `negative_flags: ${protocol.enums.negative_flags.join('|')}`,
        `禁止输出 ${protocol.forbiddenFields.join(' / ')} 字段。每条 evidence 必须包含 quote / source_url / fetched_at，quote 必须是 <context> 中的原文片段。`,
        `版本留痕固定为：model_id=<由网关注入> model_version=<由网关注入> prompt_version=${protocol.promptVersion} schema_version=${protocol.schemaVersion}`,
        ...t0FactLines(input.t0),
      ].join('\n'),
    },
    {
      role: 'user',
      content: `<context>\n${context}\n</context>\n\n<facts>\n${JSON.stringify(input.facts ?? {})}\n</facts>\n\ncompany_id: ${input.companyId}\n`
        + (hasT0 ? '优先引用 <t0_facts> 中已核验的 quote 作为 evidence，并与规则事实保持一致。\n' : '')
        + '请判断这家公司的客户类型、进口信号与规模档。',
    },
  ]
}

/**
 * PRD F6 · T1 写信 Prompt。合规尾巴（真实身份 / 物理地址 / 退订）由客户端代码注入，
 * 服务端与模型都不接触发件人手机号与地址，模型输出里也不允许出现这些字段。
 */
export function buildEmailMessages(facts) {
  const limits = protocol.emailPolicy
  return [
    {
      role: 'system',
      content: [
        'You write short B2B cold emails for an exporter. Use ONLY the facts inside <context>.',
        `Hard limits: at most ${facts.maxWords} words in the body; never use these phrases: ${limits.bannedWords.join(' / ')}.`,
        'Do NOT invent numbers, certifications, customer names, case studies, prices or delivery claims.',
        'The first sentence MUST reference the anchor fact from <context> (a verifiable public fact, not flattery).',
        'Do NOT write a signature, sender name, postal address, or unsubscribe line; the client injects those by code.',
        'Do NOT leave placeholders such as [name] or {{company}}.',
        'Never output a score, rating, points, or any numeric evaluation of the recipient.',
        'Output ONLY one JSON object: {"subject": string, "body": string, "anchor_used": string}. No markdown, no explanation.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `<context>\n${JSON.stringify(facts)}\n</context>\n\nWrite one cold email in ${facts.language}.`,
    },
  ]
}

/** F6-2 服务端硬约束校验：不通过就换顺位，绝不把未校验正文交给用户 */
export function validateEmailDraft(raw, opts = {}) {
  const errors = []
  if (!isObj(raw)) return { valid: false, errors: ['响应不是对象'], value: null }
  const subject = typeof raw.subject === 'string' ? raw.subject.trim() : ''
  const body = typeof raw.body === 'string' ? raw.body.trim() : ''
  const anchorUsed = typeof raw.anchor_used === 'string' ? raw.anchor_used.trim() : ''
  if (subject.length < 4 || subject.length > 120) errors.push('subject 缺失或长度越界')
  if (body.length < 40) errors.push('body 过短，不构成可发送的开发信')
  const maxWords = Number(opts.maxWords ?? protocol.emailPolicy.wordLimits.short)
  const wordCount = (body.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) ?? []).length
    + (body.match(/[\u4e00-\u9fff]/g) ?? []).length
  if (wordCount > maxWords) errors.push(`正文 ${wordCount} 词，超过 ${maxWords} 词硬限`)
  const lower = body.toLowerCase()
  const bannedHits = protocol.emailPolicy.bannedWords.filter((w) => lower.includes(w.toLowerCase()))
  if (bannedHits.length) errors.push(`命中禁词：${bannedHits.join('、')}`)
  if (/\[[^\]]{1,40}\]|\{\{[^}]*\}\}/.test(body)) errors.push('存在未填充占位符')
  if (/reply\s+stop|unsubscribe|退订/i.test(body)) errors.push('模型不得输出退订尾巴（必须由代码注入）')
  if (errors.length) return { valid: false, errors, value: null }
  return { valid: true, errors: [], value: { subject, body, anchorUsed, wordCount } }
}

/** 把网关 wire 格式（snake_case）转成前端内部表示（camelCase） */
export function toClientEvidence(list) {
  return (list ?? []).map((e) => ({
    quote: e.quote,
    sourceUrl: e.source_url ?? e.sourceUrl,
    fetchedAt: e.fetched_at ?? e.fetchedAt,
    label: e.label,
  }))
}

export function toClientJudgement(j) {
  return {
    company_id: j.company_id,
    customer_type: { ...j.customer_type, evidence: toClientEvidence(j.customer_type.evidence) },
    import_signal: { ...j.import_signal, evidence: toClientEvidence(j.import_signal.evidence) },
    size_estimate: { ...j.size_estimate, evidence: toClientEvidence(j.size_estimate.evidence) },
    negative_flags: j.negative_flags,
    notes_for_human: j.notes_for_human,
    model_id: j.model_id, model_version: j.model_version,
    prompt_version: j.prompt_version, schema_version: j.schema_version,
  }
}

export const hasOwn = has
