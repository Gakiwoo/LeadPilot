/**
 * PRD 6.7.1 / F6-1 · T0 事实抽取层（确定性规则，不调用模型）
 *
 * 职责边界（重要）：
 *  - 输入是「调用方已经拿到的原文」，本层不采集、不联网、不推断、不翻译、不做同义扩展。
 *  - 每条事实必须携带可在清洗后原文中逐字核验的 quote / source_url / fetched_at。
 *  - 未命中的维度一律进 noSignalFields，绝不补零、绝不编造「无进口」结论。
 *  - 输出 extractor='rules'，与网关的 judge（模型离散判断）严格区分，禁止混称。
 *
 * 这一层解决的是「规则分的输入从哪来」：把官网/搜索摘要文本变成可核验的结构化事实，
 * 供评分引擎、开发信个性化锚点与 integrity 评测（v0.8.0 决策：不再依赖 385 家人工标注集）复用。
 */
import { protocol, sanitizeContext, assertNoPii, normalizeText } from './protocol.mjs'

const RULES = protocol.t0Extraction
export const T0_RULES_VERSION = RULES.rulesVersion

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 输入校验：宁可 400，也不把非法来源伪装成已抽取事实 */
export function validateT0Input(raw) {
  const errors = []
  if (!isObj(raw)) return { ok: false, errors: ['请求体不是对象'], value: null }
  const companyId = String(raw.company_id ?? '').trim()
  if (!companyId) errors.push('company_id 缺失')
  if (companyId.includes('@')) errors.push('company_id 不得含邮箱地址')

  const sources = raw.sources
  if (!Array.isArray(sources) || !sources.length) errors.push('sources 为空（T0 只处理调用方已提供的原文）')
  else if (sources.length > RULES.maxSources) errors.push(`sources 超过上限 ${RULES.maxSources}`)

  const cleanSources = []
  let totalChars = 0
  if (Array.isArray(sources)) {
    sources.forEach((s, i) => {
      if (!isObj(s)) { errors.push(`sources[${i}] 不是对象`); return }
      const url = String(s.url ?? s.source_url ?? '').trim()
      const text = String(s.text ?? '')
      const fetchedAt = String(s.fetched_at ?? s.fetchedAt ?? '').trim()
      if (!/^https?:\/\//.test(url)) errors.push(`sources[${i}].url 非法（必须是 http/https 原文地址）`)
      if (!text.trim()) errors.push(`sources[${i}].text 为空`)
      if (!/^\d{4}-\d{2}-\d{2}/.test(fetchedAt)) errors.push(`sources[${i}].fetched_at 非法（需 ISO 日期）`)
      totalChars += text.length
      cleanSources.push({ url, text, fetched_at: fetchedAt })
    })
  }
  if (totalChars > RULES.maxSourceChars) errors.push(`原文总长度 ${totalChars} 超过上限 ${RULES.maxSourceChars}`)

  // 结构化字段（不含 sources 原文）整体做 PII 硬拒：调用方夹带 contact_email / api_key 一律 400
  const { sources: _ignoredSources, ...structured } = raw
  const pii = assertNoPii({ ...structured, company_id: companyId, keywords: raw.keywords ?? [], markets: raw.markets ?? [] })
  if (!pii.ok) errors.push(`结构化字段含禁止信息：${pii.violations.join('、')}`)

  if (errors.length) return { ok: false, errors, value: null }
  return {
    ok: true, errors: [],
    value: {
      company_id: companyId,
      sources: cleanSources,
      keywords: Array.isArray(raw.keywords) ? raw.keywords.map(String).filter(Boolean).slice(0, 30) : [],
      markets: Array.isArray(raw.markets) ? raw.markets.map(String).filter(Boolean).slice(0, 20) : [],
    },
  }
}

/** 按句读切分，保留原文连续子串；产出前再次用 text.includes 校验，杜绝伪造引用 */
function splitSentences(text) {
  const out = []
  const re = /[^.!?。！？;\n]{4,}[.!?。！？;\n]*/gu
  for (const m of text.matchAll(re)) {
    const s = m[0].trim()
    if (s.length >= RULES.minQuoteChars && text.includes(s)) out.push(s)
  }
  if (!out.length && text.trim().length >= RULES.minQuoteChars) {
    const whole = text.trim()
    if (text.includes(whole)) out.push(whole)
  }
  return out
}

function toQuote(sentence, originalText) {
  let q = sentence
  if (q.length > RULES.maxQuoteChars) {
    q = q.slice(0, RULES.maxQuoteChars).replace(/\s+\S*$/u, '')
  }
  if (q.length < RULES.minQuoteChars) return null
  // 硬约束：quote 必须是清洗后原文的连续子串，不允许任何改写
  return originalText.includes(q) ? q : null
}

function evidenceFor(quote, source, label) {
  return { quote, source_url: source.url, fetched_at: source.fetched_at, label }
}

/** 在清洗后的原文里逐词匹配词表，返回命中项与可核验证据 */
function matchTerms(docs, termsByKey, limit = 60) {
  const hits = []
  for (const [key, terms] of Object.entries(termsByKey)) {
    for (const term of terms) {
      const needle = normalizeText(term)
      if (needle.length < 3) continue
      for (const doc of docs) {
        const found = doc.sentences.find((s) => normalizeText(s).includes(needle))
        if (!found) continue
        const quote = toQuote(found, doc.text)
        if (!quote) continue
        hits.push({ key, term, evidence: evidenceFor(quote, doc, `${key}:${term}`) })
        break // 同一词只取第一条可核验引用，避免重复证据灌水
      }
      if (hits.length >= limit) return hits
    }
  }
  return hits
}

function pickCustomerType(hits) {
  if (!hits.length) return { value: 'unknown', evidence: [], candidates: [], noSignal: true }
  const counts = new Map()
  for (const h of hits) counts.set(h.key, (counts.get(h.key) ?? 0) + 1)
  const order = protocol.enums.customer_type
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))
  return {
    value: ranked[0][0],
    candidates: ranked.map(([k, n]) => ({ value: k, matchCount: n })),
    evidence: hits.slice(0, 3).map((h) => h.evidence),
    noSignal: false,
  }
}

function pickImportSignal(confirms, infers, contradicts) {
  if (contradicts.length) return { value: 'contradicted', evidence: contradicts.slice(0, 3).map((h) => h.evidence), noSignal: false }
  if (confirms.length) return { value: 'confirmed', evidence: confirms.slice(0, 3).map((h) => h.evidence), noSignal: false }
  if (infers.length) return { value: 'inferred', evidence: infers.slice(0, 3).map((h) => h.evidence), noSignal: false }
  // no_signal = 原文没有可核验证据，不等于「确认没进口」（PRD 6.7.1）
  return { value: 'no_signal', evidence: [], noSignal: true }
}

function pickSize(docs) {
  const patterns = RULES.employeePatterns.map((p) => new RegExp(p, 'giu'))
  for (const doc of docs) {
    for (const s of doc.sentences) {
      for (const re of patterns) {
        re.lastIndex = 0
        const m = re.exec(s)
        if (!m) continue
        const n = Number(String(m[1]).replace(/,/g, ''))
        if (!Number.isFinite(n) || n <= 0) continue
        const quote = toQuote(s, doc.text)
        if (!quote) continue
        const band = ['S', 'M', 'L', 'XL'].find((k) => RULES.employeeBands[k].max === null || n <= RULES.employeeBands[k].max) ?? 'XL'
        return {
          tier: band,
          employee_range: [n, RULES.employeeBands[band].max ?? null],
          employee_count_from_text: n,
          evidence: [evidenceFor(quote, doc, `size:${n}`)],
          noSignal: false,
        }
      }
    }
  }
  return { tier: 'unknown', employee_range: null, evidence: [], noSignal: true }
}

function pickProductTerms(docs, keywords) {
  const out = []
  for (const kw of keywords) {
    const needle = normalizeText(kw)
    if (needle.length < 2 || RULES.productStopWords.includes(needle)) continue
    for (const doc of docs) {
      const found = doc.sentences.find((s) => normalizeText(s).includes(needle))
      if (!found) continue
      const quote = toQuote(found, doc.text)
      if (!quote) continue
      out.push({ term: kw, evidence: evidenceFor(quote, doc, `product:${kw}`) })
      break
    }
  }
  return out
}

function pickAnchors(candidates, limit = 3) {
  const seen = new Set()
  const out = []
  for (const item of candidates) {
    const key = item.evidence.quote
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      quote: item.evidence.quote,
      source_url: item.evidence.source_url,
      fetched_at: item.evidence.fetched_at,
      tags: Array.isArray(item.tags) ? item.tags : [item.key],
    })
    if (out.length >= limit) break
  }
  return out
}

/**
 * 主入口。返回纯数据结构，不写库、不联网、不发起任何模型调用。
 * @param {object} raw { company_id, sources:[{url,text,fetched_at}], keywords?, markets? }
 */
export function extractFacts(raw) {
  const input = validateT0Input(raw)
  if (!input.ok) return { ok: false, errors: input.errors, code: 'E6004' }

  const { company_id, sources, keywords } = input.value
  const cleaned = sanitizeContext(sources.map((s) => s.text))
  const docs = sources.map((s, i) => ({
    url: s.url, fetched_at: s.fetched_at, text: cleaned.texts[i], sentences: splitSentences(cleaned.texts[i]),
  })).filter((d) => d.sentences.length)

  const typeHits = matchTerms(docs, RULES.customerTypeTerms)
  const importConfirms = matchTerms(docs, { confirmed: RULES.importSignalTerms.confirmed })
  const importInfers = matchTerms(docs, { inferred: RULES.importSignalTerms.inferred })
  const importContradicts = matchTerms(docs, { contradicted: RULES.importSignalTerms.contradicted })
  const negativeHits = matchTerms(docs, RULES.negativeFlagTerms)

  const customerType = pickCustomerType(typeHits)
  const importSignal = pickImportSignal(importConfirms, importInfers, importContradicts)
  const sizeEstimate = pickSize(docs)
  const productTerms = pickProductTerms(docs, keywords)
  const negativeFlags = [...new Set(negativeHits.map((h) => h.key))]

  // 锚点优先级：产品共现 > 进口信号 > 客户类型，全部来自可核验原文
  const anchorCandidates = [
    ...productTerms.map((p) => ({ key: 'product', tags: ['product', p.term], evidence: p.evidence })),
    ...importConfirms.map((h) => ({ key: 'import', tags: ['import', h.term], evidence: h.evidence })),
    ...typeHits.map((h) => ({ key: 'customer_type', tags: ['customer_type', h.key], evidence: h.evidence })),
  ]

  const dimensionNames = ['customer_type', 'import_signal', 'size_estimate']
  const noSignalFields = [
    customerType.noSignal && 'customer_type',
    importSignal.noSignal && 'import_signal',
    sizeEstimate.noSignal && 'size_estimate',
  ].filter(Boolean)
  const hitCount = dimensionNames.length - noSignalFields.length

  const facts = {
    company_id,
    customer_type: {
      value: customerType.value,
      candidates: customerType.candidates,
      evidence: customerType.evidence,
      no_signal: customerType.noSignal,
    },
    import_signal: {
      value: importSignal.value,
      evidence: importSignal.evidence,
      no_signal: importSignal.noSignal,
      note: importSignal.noSignal ? '原文无可核验进口证据；无记录 ≠ 没进口，禁止按 0 分处理' : undefined,
    },
    size_estimate: {
      tier: sizeEstimate.tier,
      employee_range: sizeEstimate.employee_range,
      employee_count_from_text: sizeEstimate.employee_count_from_text ?? null,
      evidence: sizeEstimate.evidence,
      no_signal: sizeEstimate.noSignal,
    },
    product_terms: productTerms,
    negative_flags: negativeFlags,
    negative_evidence: negativeHits.slice(0, 3).map((h) => h.evidence),
    anchors: pickAnchors(anchorCandidates),
  }

  const evidence = [
    ...customerType.evidence, ...importSignal.evidence, ...sizeEstimate.evidence,
    ...productTerms.map((p) => p.evidence), ...negativeHits.slice(0, 3).map((h) => h.evidence),
  ]
  // 去重后逐条复核：任何一条不在原文里的引用都丢弃，宁可少给也不伪造
  const seen = new Set()
  const verifiedEvidence = evidence.filter((e) => {
    const k = `${e.source_url}|${e.quote}`
    if (seen.has(k)) return false
    seen.add(k)
    return docs.some((d) => d.url === e.source_url && d.text.includes(e.quote))
  })

  return {
    ok: true,
    extractor: 'rules',
    rulesVersion: T0_RULES_VERSION,
    sourceMode: 'provided-text',
    sourceCount: docs.length,
    piiRemoved: cleaned.removed,
    facts,
    evidence: verifiedEvidence,
    coverage: {
      dimensions: dimensionNames,
      noSignalFields,
      hitFields: dimensionNames.filter((d) => !noSignalFields.includes(d)),
      rate: Number((hitCount / dimensionNames.length).toFixed(3)),
    },
    note: 'T0 规则抽取：不调用模型、不联网、不推断；未命中维度明确标 no_signal，绝不补零。',
  }
}

const RECONCILE_DIMS = [
  { name: 'customer_type', key: 'value', fallback: 'unknown' },
  { name: 'import_signal', key: 'value', fallback: 'no_signal' },
  { name: 'size_estimate', key: 'tier', fallback: 'unknown' },
]

/**
 * PRD 6.7.4 / ADR-016：T0 规则事实与 T1 模型判断冲突时的代码级裁决。
 *
 *  - 规则命中、模型不同 → 保守取规则值，置信度归零，证据换成 T0 可逐字核验的引用，
 *    并显式记 conflicts；绝不取平均、绝不静默覆盖、绝不把规则结论说成模型结论。
 *  - 规则 no_signal、模型却给出确定结论 → 回退 no_signal / unknown，置信度归零。
 *  - 一致时保持模型输出，只记录 t0 一致标记。
 *
 * 输入 judgement 来自已通过 validateSchema + verifyEvidence 的结构；本函数原地修改，
 * 并把裁决明细返回给调用方放进响应体与审计，保证「谁改了什么」完全可追溯。
 */
export function reconcileWithT0(judgement, t0Result) {
  const conflicts = []
  const overrides = []
  const consistent = []
  const t0Evidence = {
    customer_type: t0Result.facts?.customer_type?.evidence ?? [],
    import_signal: t0Result.facts?.import_signal?.evidence ?? [],
    size_estimate: t0Result.facts?.size_estimate?.evidence ?? [],
  }
  const noSignal = new Set(t0Result.coverage?.noSignalFields ?? [])

  for (const dim of RECONCILE_DIMS) {
    const holder = judgement[dim.name]
    if (!holder) continue
    const modelValue = holder[dim.key]
    const f = t0Result.facts?.[dim.name]
    const rawRuleValue = dim.key === 'tier' ? f?.tier : f?.value
    const ruleValue = noSignal.has(dim.name) || !rawRuleValue || ['unknown', 'no_signal'].includes(rawRuleValue)
      ? null
      : rawRuleValue

    if (!ruleValue) {
      // 规则层无信号：模型不得凭训练记忆把它变成确定结论
      if (modelValue && ![dim.fallback, 'no_signal', 'unknown'].includes(modelValue)) {
        conflicts.push({
          field: dim.name, kind: 'no_signal_overridden', t0Value: 'no_signal',
          modelValue, resolution: dim.fallback,
        })
        holder[dim.key] = dim.fallback
        holder.confidence = 0
        overrides.push(dim.name)
      }
      continue
    }
    if (modelValue !== ruleValue) {
      conflicts.push({
        field: dim.name, kind: 'value_conflict', t0Value: ruleValue,
        modelValue, resolution: 'rules-win-zero-confidence',
      })
      holder[dim.key] = ruleValue
      holder.confidence = 0
      if (t0Evidence[dim.name].length) holder.evidence = t0Evidence[dim.name]
      overrides.push(dim.name)
    } else {
      consistent.push(dim.name)
    }
  }

  if (conflicts.length) {
    const note = `T0 规则事实与模型判断冲突，代码已保守取规则值并归零置信度：${conflicts.map((c) => c.field).join('、')}。待人工复议，不得据此直接发信。`
    judgement.notes_for_human = [judgement.notes_for_human, note].filter(Boolean).join(' ')
  }
  return {
    applied: true,
    extractor: 'rules',
    rulesVersion: t0Result.rulesVersion,
    policy: protocol.judgeFactChain.onConflict,
    noSignalFields: [...noSignal],
    consistent,
    conflicts,
    overrides,
    note: conflicts.length
      ? '规则层与模型冲突：代码裁决已生效，模型结论未被采纳为最终结论。'
      : '规则层与模型结论一致或规则层无信号，未发生覆盖。',
  }
}
