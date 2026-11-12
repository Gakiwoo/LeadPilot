/**
 * 发布证据通道 · v0.9.0 补遗（B4）
 *
 * 修的是什么：旧 `npm run gate` 末尾把 evaluateIntegrity([]) / evaluateOutcome([]) 写死为空数组，
 * 5 条 BLOCKED 是硬编码字符串，LEADPILOT_REQUIRE_BASELINE=1 无条件 exit 1。
 * 结果：即使运维把真实证据 POST 进 /v1/eval/*、即使所有外部条件都办妥，门禁也永远看不见。
 * 这不是「拦得严」，是「红得假」——与 B3-0 修掉的静态常量假保证同源。
 *
 * 现在把链路做成可执行的：
 *   证据目录（仓库外、.gitignore 排除）
 *     → 格式 / 逐字自洽 / 去重 / 来源声明 / 人工签署校验（不通过则整份不采信）
 *     → eval.mjs 真实计算（不再传空数组）
 *     → provider 快照锁定检查（读真实环境变量）
 *     → 外部合规清单检查（读 shared/release-compliance.json）
 *     → releaseStatus() 真实计算 → blockers 由结果生成，不再是常量。
 *
 * 纪律与边界（务必如实）：
 *  - 本模块不生成、不补全、不推断任何样本；没有证据时 NO_DATA 原样保持。
 *  - 代码能验证格式、逐字自洽、去重、来源声明与「签署齐备」；
 *    代码**不能**证明证据真实性。attestation 是签署人的责任声明，不是机器证明。
 *  - 合规清单的 completed 必须由人填写并附外部证据；脚本不代填、不自动判定完成。
 *  - releaseEligible 仍由 releaseStatus() 恒 false 锁定（当前阶段的产品决策，不是算法结论）。
 *  - 单元测试里出现的样本只是链路自检夹具，写在 .tmp/ 临时目录、用完即删，
 *    绝不入库，也绝不用于任何真实发布判定。
 */
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { protocol } from './protocol.mjs'
import {
  evaluateIntegrity, evaluateOutcome, evaluateConsistency, releaseStatus,
  integrityManifest, outcomeManifest,
} from './eval.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const COMPLIANCE_PATH = new URL('../shared/release-compliance.json', import.meta.url)

export const EVIDENCE_CONTRACT_VERSION = 'release-evidence-v1'
export const EVIDENCE_DIR_ENV = 'LEADPILOT_EVIDENCE_DIR'
export const EVIDENCE_FILES = Object.freeze({
  integrity: 'integrity.json',
  outcome: 'outcome.json',
  consistency: 'consistency.json',
})
export const OUTCOME_EVENTS = Object.freeze(['sent', 'bounced', 'replied'])

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const isIsoDate = (v) => typeof v === 'string'
  && /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?$/.test(v)
  && !Number.isNaN(Date.parse(v))
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/** 明显占位/合成标记：只查键名与真值布尔，不扫描网页正文，避免误伤真实原文 */
const SYNTHETIC_KEYS = /^(?:synthetic|generated|mock|fixture|fake|dummy|placeholder|isDemo|isSynthetic)$/i
function hasSyntheticMarker(value, depth = 0, visits = { n: 0 }) {
  if (!isObj(value) || depth > 6 || visits.n > 2000) return false
  visits.n++
  for (const [k, v] of Object.entries(value)) {
    if (SYNTHETIC_KEYS.test(k) && Boolean(v)) return true
    if (isObj(v) && hasSyntheticMarker(v, depth + 1, visits)) return true
    if (Array.isArray(v)) {
      for (const item of v.slice(0, 500)) {
        if (isObj(item) && hasSyntheticMarker(item, depth + 1, visits)) return true
      }
    }
  }
  return false
}

function isPrivateLiteral(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1'
    || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)
    || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')
}

function validateAttestation(payload, label, errors) {
  const a = payload.attestation
  if (!isObj(a)) {
    errors.push(`${label}.attestation 缺失：证据必须由人签署真实性声明，不接受无主样本`)
    return
  }
  if (a.attestedReal !== true) errors.push(`${label}.attestation.attestedReal 必须为 true（真实性由签署人负责）`)
  if (typeof a.signedBy !== 'string' || a.signedBy.trim().length < 2) {
    errors.push(`${label}.attestation.signedBy 缺失或过短：必须写明签署人`)
  }
  if (!isIsoDate(a.signedAt)) errors.push(`${label}.attestation.signedAt 必须是合法日期`)
  if (typeof a.statement !== 'string' || a.statement.trim().length < 10) {
    errors.push(`${label}.attestation.statement 缺失或过短：必须写明证据来源与真实性承诺`)
  }
}

function checkRatio(obj, label, errors) {
  if (!isObj(obj) || !isNum(obj.matched) || !isNum(obj.total)
    || obj.total <= 0 || obj.matched < 0 || obj.matched > obj.total) {
    errors.push(`${label} 必须是 { matched:number, total:number>0, matched<=total }`)
  }
}

/**
 * integrity.json 契约：
 * { attestation, records: [{ sourceUrl, capturedAt, sourceOrigin?, quote, sourceText,
 *                            provenance:{matched,total}, rules:{passed,total},
 *                            schemaPass:boolean, refused:boolean }] }
 * 返回净化后的 records 只保留 evaluateIntegrity 需要的字段，不把正文带进判定结果。
 */
export function validateIntegrityEvidence(payload) {
  const errors = []
  if (!isObj(payload)) return { ok: false, errors: ['integrity.json 顶层必须是对象'], records: [], fetchedCount: 0 }
  if (hasSyntheticMarker(payload)) errors.push('integrity.json 含合成/占位标记：合成样本不得进入发布门禁')
  validateAttestation(payload, 'integrity', errors)

  const records = payload.records
  if (!Array.isArray(records) || records.length === 0) {
    errors.push('integrity.records 为空：没有真实证据时请直接不提供该文件（保持 NO_DATA），不要交空文件')
    return { ok: false, errors, records: [], fetchedCount: 0 }
  }

  const seen = new Set()
  const clean = []
  let fetchedCount = 0
  records.forEach((r, i) => {
    const at = `integrity.records[${i}]`
    if (!isObj(r)) { errors.push(`${at} 不是对象`); return }
    const sourceUrl = r.sourceUrl ?? r.source_url
    const sourceText = r.sourceText ?? r.source_text
    const quote = r.quote
    if (typeof sourceUrl !== 'string' || !/^https?:\/\//i.test(sourceUrl)) {
      errors.push(`${at}.sourceUrl 必须是 http(s) URL`)
    } else {
      try {
        const u = new URL(sourceUrl)
        if (isPrivateLiteral(u.hostname)) errors.push(`${at}.sourceUrl 指向回环/私网字面量，不是可核验的公开来源`)
      } catch { errors.push(`${at}.sourceUrl 无法解析`) }
    }
    if (!isIsoDate(r.capturedAt ?? r.captured_at)) errors.push(`${at}.capturedAt 必须是合法日期`)
    if (typeof quote !== 'string' || quote.trim().length < 4) errors.push(`${at}.quote 缺失或过短`)
    if (typeof sourceText !== 'string' || sourceText.length < 8) errors.push(`${at}.sourceText 缺失或过短`)
    if (typeof quote === 'string' && typeof sourceText === 'string' && !sourceText.includes(quote)) {
      errors.push(`${at}.quote 不在 sourceText 中：逐字核验失败，不允许伪造引用`)
    }
    checkRatio(r.provenance, `${at}.provenance`, errors)
    const rules = r.rules
    if (!isObj(rules) || !isNum(rules.passed) || !isNum(rules.total)
      || rules.total <= 0 || rules.passed < 0 || rules.passed > rules.total) {
      errors.push(`${at}.rules 必须是 { passed:number, total:number>0, passed<=total }`)
    }
    if (typeof (r.schemaPass ?? r.schema_pass) !== 'boolean') errors.push(`${at}.schemaPass 必须是布尔`)
    if (typeof r.refused !== 'boolean') errors.push(`${at}.refused 必须是布尔`)

    const digest = createHash('sha256')
      .update(`${String(sourceUrl)}\n${String(quote)}\n${String(sourceText)}`).digest('hex')
    if (seen.has(digest)) errors.push(`${at} 与已有样本完全重复：不允许复制同一条证据凑 minSamples`)
    seen.add(digest)

    if ((r.sourceOrigin ?? r.source_origin) === 'user_directed_fetch') fetchedCount++
    clean.push({
      provenance: r.provenance,
      rules,
      schemaPass: r.schemaPass ?? r.schema_pass,
      refused: r.refused,
      quote,
      sourceText,
    })
  })

  return { ok: errors.length === 0, errors, records: clean, fetchedCount }
}

/** outcome.json 契约：{ attestation, events: [{ event, refId, occurredAt, source }] } */
export function validateOutcomeEvidence(payload) {
  const errors = []
  if (!isObj(payload)) return { ok: false, errors: ['outcome.json 顶层必须是对象'], events: [] }
  if (hasSyntheticMarker(payload)) errors.push('outcome.json 含合成/占位标记：合成发送事件不得进入发布门禁')
  validateAttestation(payload, 'outcome', errors)

  const events = payload.events
  if (!Array.isArray(events) || events.length === 0) {
    errors.push('outcome.events 为空：没有真实发送结果时请直接不提供该文件（保持 NO_DATA）')
    return { ok: false, errors, events: [] }
  }

  const seen = new Set()
  const clean = []
  events.forEach((e, i) => {
    const at = `outcome.events[${i}]`
    if (!isObj(e)) { errors.push(`${at} 不是对象`); return }
    if (!OUTCOME_EVENTS.includes(e.event)) errors.push(`${at}.event 必须是 sent/bounced/replied`)
    if (!isIsoDate(e.occurredAt ?? e.occurred_at)) errors.push(`${at}.occurredAt 必须是合法日期`)
    if (typeof e.source !== 'string' || e.source.trim().length < 3) {
      errors.push(`${at}.source 必须写明结果来源（如 SMTP 退信日志 / 邮箱回执）`)
    }
    const refId = e.refId ?? e.ref_id
    if (typeof refId !== 'string' || refId.trim().length < 3) {
      errors.push(`${at}.refId 必须写明可追溯的事件标识，便于独立审计`)
    } else if (seen.has(refId)) {
      errors.push(`${at}.refId 重复：不允许复制同一事件凑样本量`)
    }
    seen.add(refId)
    clean.push(e.event)
  })
  return { ok: errors.length === 0, errors, events: clean }
}

/** consistency.json 契约：{ attestation, prevRun: [...], currentRun: [...] } */
export function validateConsistencyEvidence(payload) {
  const errors = []
  if (!isObj(payload)) return { ok: false, errors: ['consistency.json 顶层必须是对象'], prevRun: [], currentRun: [] }
  if (hasSyntheticMarker(payload)) errors.push('consistency.json 含合成/占位标记')
  validateAttestation(payload, 'consistency', errors)
  const prevRun = payload.prevRun
  const currentRun = payload.currentRun
  if (!Array.isArray(prevRun) || !prevRun.length) errors.push('consistency.prevRun 必须是非空数组（第一次真实运行的结果序列）')
  if (!Array.isArray(currentRun) || !currentRun.length) errors.push('consistency.currentRun 必须是非空数组（第二次真实运行的结果序列）')
  if (Array.isArray(prevRun) && Array.isArray(currentRun) && prevRun.length !== currentRun.length) {
    errors.push('consistency 两次运行结果数量不同：不得用长度差掩盖不一致')
  }
  return {
    ok: errors.length === 0,
    errors,
    prevRun: Array.isArray(prevRun) ? prevRun : [],
    currentRun: Array.isArray(currentRun) ? currentRun : [],
  }
}

export function defaultEvidenceDir() {
  return join(ROOT, '.evidence')
}

/** 只读：文件不存在是正常状态（NO_DATA），解析失败才是错误 */
export function readEvidenceBundle(dir = defaultEvidenceDir()) {
  const abs = resolve(dir)
  const bundle = { dir: abs, present: [], missing: [], errors: [], files: {} }
  for (const [key, name] of Object.entries(EVIDENCE_FILES)) {
    const path = join(abs, name)
    if (!existsSync(path)) { bundle.missing.push(name); continue }
    bundle.present.push(name)
    try {
      bundle.files[key] = JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) {
      bundle.errors.push(`${name} 解析失败：${String(err?.message ?? err)}`)
    }
  }
  return bundle
}

export function readCompliance() {
  return JSON.parse(readFileSync(COMPLIANCE_PATH, 'utf8'))
}

export function isComplianceComplete(item) {
  return isObj(item) && item.status === 'completed'
    && typeof item.evidence === 'string' && item.evidence.trim().length >= 8
    && typeof item.verifiedBy === 'string' && item.verifiedBy.trim().length >= 2
    && isIsoDate(item.verifiedAt)
}

export function complianceStatus(compliance) {
  const items = Array.isArray(compliance?.items) ? compliance.items : []
  const complete = items.filter(isComplianceComplete)
  return {
    contractVersion: compliance?.contractVersion ?? 'unknown',
    total: items.length,
    completed: complete.length,
    pending: items.filter((i) => !isComplianceComplete(i))
      .map((i) => `${String(i?.id ?? 'unknown')}:${String(i?.status ?? 'unknown')}`),
    ok: items.length > 0 && complete.length === items.length,
  }
}

/** 快照锁定：读真实环境变量；含 -latest 一律不算锁定，且不要求 guessing 任何版本号 */
export function snapshotStatus(env = process.env) {
  const rows = protocol.providers.map((p) => {
    const envKey = `LEADPILOT_MODEL_VERSION_${p.key.toUpperCase().replace(/-/g, '_')}`
    const raw = String(env[envKey] ?? '').trim()
    const pinned = raw.length > 0 && !/latest/i.test(raw)
    return {
      provider: p.key, envKey,
      configured: Boolean(env[p.envKey]),
      pinned,
      version: pinned ? raw : null,
    }
  })
  return {
    rows,
    configuredCount: rows.filter((r) => r.configured).length,
    lockedCount: rows.filter((r) => r.pinned && r.configured).length,
    ok: rows.some((r) => r.pinned && r.configured),
  }
}

/**
 * 主入口：真实证据 → 真实判定 → 真实 blockers。
 * dir / compliance 可由调用方指定，仅用于自检；生产门禁不传这两个参数。
 * 注意：不接受「内存注入样本」——样本只能来自磁盘证据文件，避免任何绕过路径。
 */
export function evaluateReleaseEvidence({ dir, env = process.env, compliance } = {}) {
  const evidenceDir = resolve(dir ?? env[EVIDENCE_DIR_ENV] ?? defaultEvidenceDir())
  const bundle = readEvidenceBundle(evidenceDir)
  const comp = complianceStatus(compliance ?? readCompliance())
  const snapshot = snapshotStatus(env)

  const vi = bundle.files.integrity ? validateIntegrityEvidence(bundle.files.integrity) : null
  const vo = bundle.files.outcome ? validateOutcomeEvidence(bundle.files.outcome) : null
  const vc = bundle.files.consistency ? validateConsistencyEvidence(bundle.files.consistency) : null
  const errors = [...bundle.errors]
  for (const v of [vi, vo, vc]) if (v && !v.ok) errors.push(...v.errors)
  const validation = {
    ok: errors.length === 0,
    errors,
    integrity: vi ? vi.ok : null,
    outcome: vo ? vo.ok : null,
    consistency: vc ? vc.ok : null,
  }

  // 关键：非法文件整份不采信，绝不让坏样本影响判定结果，也绝不因此伪造 PASSED。
  const records = vi?.ok ? vi.records : []
  const events = vo?.ok ? vo.events : []
  const consistency = vc?.ok ? evaluateConsistency(vc.prevRun, vc.currentRun) : null
  const consistencyOk = consistency?.ok === true && consistency.status === 'PASSED'

  const integrity = evaluateIntegrity(records, consistencyOk ? { consistency } : {})
  const outcome = evaluateOutcome(events)
  const release = releaseStatus({ integrity, outcome })
  const fetchedCount = vi?.ok ? vi.fetchedCount : 0

  const ig = integrityManifest()
  const og = outcomeManifest()
  const blockers = []
  if (!validation.ok) {
    blockers.push(`发布证据校验失败：${errors.length} 条（非法文件整份不采信，不伪造判定；详见 npm run evidence:check）`)
  }
  if (integrity.status === 'NO_DATA') {
    blockers.push(`integrity 门禁：NO_DATA（${bundle.missing.includes(EVIDENCE_FILES.integrity) ? '证据目录无 integrity.json' : '证据文件不可用'}；内部预览资格未验证，需 ≥ ${ig.minSamples} 条真实原文样本）`)
  } else if (integrity.ok !== true) {
    blockers.push(`integrity 门禁：${integrity.status}（样本 ${integrity.sampleSize}/${integrity.minSamples}，P0：${integrity.p0Failures.join('；') || '样本不足'}）`)
  } else if (!consistencyOk) {
    blockers.push(`integrity 门禁：${integrity.status}，但两次运行一致性证据缺失或未达标（可复现性未验证，不得据此宣称可内测）`)
  }
  if (outcome.status === 'NO_DATA') {
    blockers.push(`业务结果门禁：NO_DATA（无真实发送样本；不得宣称准确率 / 回复率，需 ≥ ${og.minSamples} 条真实结果）`)
  } else if (outcome.ok !== true) {
    blockers.push(`业务结果门禁：${outcome.status}（样本 ${outcome.sampleSize}/${outcome.minSamples}，退信率 ${outcome.metrics.bounce_rate ?? '未测量'}）`)
  }
  if (fetchedCount === 0) {
    blockers.push(`用户指定抓取器已就绪（robots / 限速 / SSRF），但 integrity 证据中 0 条带 user_directed_fetch 来源声明`)
  }
  if (!snapshot.ok) {
    blockers.push(`provider 模型快照：已配置 ${snapshot.configuredCount} 家 Key / 锁定 ${snapshot.lockedCount} 家；需运行时注入 LEADPILOT_MODEL_VERSION_*（未锁即 E6008）`)
  }
  if (!comp.ok) {
    blockers.push(`外部合规 ${comp.completed}/${comp.total} 完成：Google OAuth / CASA Tier 2 / EV 代码签名 / PIPL·GDPR 法律意见（${comp.pending.join('、')}）`)
  }

  return {
    contractVersion: EVIDENCE_CONTRACT_VERSION,
    evidenceDir,
    filesPresent: bundle.present,
    filesMissing: bundle.missing,
    validation,
    sampleCounts: {
      integrityRecords: records.length,
      outcomeEvents: events.length,
      fetchedRecords: fetchedCount,
    },
    // 完整评测结果只在进程内/CLI 使用；HTTP 端点只暴露下面的精简摘要，不回传原文。
    integrity,
    outcome,
    consistency,
    snapshot,
    compliance: comp,
    release,
    blockers,
    evidenceReady: validation.ok && integrity.ok === true && consistencyOk && outcome.ok === true,
    releaseBlocked: blockers.length > 0 || release.releaseEligible !== true,
    accuracyClaim: false,
    note: '代码只能验证格式 / 逐字自洽 / 去重 / 来源声明 / 签署齐备，不能证明证据真实性；真实性由 attestation 签署人负责，发布前须独立审计。releaseEligible 恒 false 是当前阶段的产品决策。',
  }
}
