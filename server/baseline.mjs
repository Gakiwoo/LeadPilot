/**
 * PRD 9.5 · 385 家人工标注基准集导入校验器
 *
 * 纪律：本模块不生产、不补全、不推断任何标注。它只回答「这批导入数据是否
 * 满足契约」。导入校验通过 ≠ 评测通过；无真实标注时评测恒定返回 NO_DATA。
 * 校验器自身必须能被反例证明会拒绝，见 scripts/fixtures/invalid-baseline-sample.json。
 */
import { readFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'

export const contract = JSON.parse(
  readFileSync(new URL('../shared/baseline-contract.json', import.meta.url), 'utf8'),
)
export const BASELINE_CONTRACT_VERSION = contract.contractVersion

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

/** 简单 CSV 解析：支持双引号包裹与转义双引号，不做类型推断（后续由字段校验统一转换） */
function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim().length)
  if (!lines.length) return []
  const splitLine = (line) => {
    const out = []
    let cur = '', quoted = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (c === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i++ } else quoted = !quoted
      } else if (c === ',' && !quoted) { out.push(cur); cur = '' } else cur += c
    }
    out.push(cur)
    return out.map((x) => x.trim())
  }
  const header = splitLine(lines[0])
  return lines.slice(1).map((line) => {
    const cells = splitLine(line)
    const row = {}
    header.forEach((h, i) => { row[h] = cells[i] ?? '' })
    return row
  })
}

/** CSV 的值都是字符串，按契约做一次显式类型转换；JSON 保持原值由校验器判定 */
function coerceCsvRow(row) {
  const out = {}
  const numeric = new Set([
    'match_rank', 'propensity_rank', 'provenance_matched', 'provenance_total',
    'signals_true', 'signals_false', 'signals_found', 'signals_actual',
    'rules_passed', 'rules_total',
  ])
  const boolean = new Set(['customs_data_available', 'adjudicated', 'schema_pass', 'refused'])
  for (const [k, v] of Object.entries(row)) {
    if (numeric.has(k)) out[k] = v === '' ? null : Number(v)
    else if (boolean.has(k)) out[k] = v === 'true' ? true : v === 'false' ? false : v
    else out[k] = v
  }
  return out
}

/** 支持 json / jsonl / csv 文本，或已解析好的数组 / {samples|results} 对象 */
export function parseBaselineText(text, filename = 'samples.json') {
  const ext = filename.toLowerCase().split('.').pop()
  if (ext === 'csv') return parseCsv(text).map(coerceCsvRow)
  if (ext === 'jsonl' || ext === 'ndjson') {
    return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
  }
  const parsed = JSON.parse(text)
  if (Array.isArray(parsed)) return parsed
  if (isObj(parsed) && Array.isArray(parsed.samples)) return parsed.samples
  if (isObj(parsed) && Array.isArray(parsed.results)) return parsed.results
  return []
}

/** 把任意请求体归一成样本数组；不合规时返回空数组并附错误 */
function samplesFrom(payload, errors) {
  let samples = null
  if (Array.isArray(payload)) samples = payload
  else if (isObj(payload) && Array.isArray(payload.samples)) samples = payload.samples
  else if (isObj(payload) && Array.isArray(payload.results)) samples = payload.results
  else if (isObj(payload) && typeof payload.csv === 'string') {
    try { samples = parseCsv(payload.csv).map(coerceCsvRow) } catch (e) { errors.push(`CSV 解析失败：${String(e?.message ?? e)}`) }
  } else if (isObj(payload) && typeof payload.text === 'string') {
    try { samples = parseBaselineText(payload.text, String(payload.filename ?? 'samples.json')) } catch (e) { errors.push(`文本解析失败：${String(e?.message ?? e)}`) }
  } else {
    errors.push('请求体必须是样本数组，或含 samples / results / csv / text 字段')
  }
  return samples ?? []
}

function validateField(name, spec, value, where, errors) {
  if (value === undefined || value === null || value === '') {
    if (spec.required) errors.push(`${where}.${name} 缺失`)
    return
  }
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') { errors.push(`${where}.${name} 应为字符串`); break }
      if (spec.minLength && value.trim().length < spec.minLength) errors.push(`${where}.${name} 长度不足 ${spec.minLength}`)
      break
    case 'enum':
      if (!spec.values.includes(value)) errors.push(`${where}.${name} 越界：${String(value)}（允许 ${spec.values.join('|')}）`)
      break
    case 'integer':
      if (!Number.isInteger(value)) { errors.push(`${where}.${name} 应为整数`); break }
      if (spec.min !== undefined && value < spec.min) errors.push(`${where}.${name} 小于 ${spec.min}`)
      if (spec.max !== undefined && value > spec.max) errors.push(`${where}.${name} 大于 ${spec.max}`)
      break
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) { errors.push(`${where}.${name} 应为有限数值`); break }
      if (spec.min !== undefined && value < spec.min) errors.push(`${where}.${name} 小于 ${spec.min}`)
      break
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${where}.${name} 应为布尔值`)
      break
    case 'url':
      if (typeof value !== 'string' || !/^https?:\/\//.test(value)) errors.push(`${where}.${name} 必须是 http/https 原文地址`)
      break
    case 'date':
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) errors.push(`${where}.${name} 必须是 ISO 日期`)
      break
    default: break
  }
}

function checkComposition(samples, errors) {
  const out = {}
  for (const rule of contract.compositionRules) {
    const counts = {}
    for (const s of samples) {
      const k = String(s[rule.field])
      counts[k] = (counts[k] ?? 0) + 1
    }
    out[rule.id] = { field: rule.field, counts, passed: true }
    const n = samples.length || 1
    if (rule.require === 'allEnumValues') {
      const missing = rule.values.filter((v) => (counts[v] ?? 0) < rule.minPerValue)
      out[rule.id].missing = missing
      out[rule.id].passed = missing.length === 0
      if (missing.length) errors.push(`构成不达标 [${rule.id}]：缺少 ${missing.join('、')}`)
    } else if (rule.require === 'balanced') {
      const ratio = (counts.true ?? 0) / n
      out[rule.id].trueRatio = Number(ratio.toFixed(3))
      out[rule.id].passed = ratio >= rule.trueMinRatio && ratio <= rule.trueMaxRatio
      if (!out[rule.id].passed) errors.push(`构成不达标 [${rule.id}]：有海关数据占比 ${(ratio * 100).toFixed(1)}%，要求 ${rule.trueMinRatio * 100}–${rule.trueMaxRatio * 100}%`)
    } else if (rule.require === 'minRatio') {
      const ratio = (counts[rule.value] ?? 0) / n
      out[rule.id].ratio = Number(ratio.toFixed(3))
      out[rule.id].passed = ratio >= rule.minRatio
      if (!out[rule.id].passed) errors.push(`构成不达标 [${rule.id}]：${rule.value} 占比 ${(ratio * 100).toFixed(1)}%，要求 ≥ ${rule.minRatio * 100}%`)
    }
  }
  return out
}

/**
 * 导入校验主入口。
 * @returns {{ok, status, code?, contractVersion, sampleCount, requiredSize, errors, warnings, composition, annotators, releaseEligible, note}}
 */
export function validateBaselineImport(payload) {
  const errors = []
  const warnings = []
  const samples = samplesFrom(payload, errors)
  const sampleCount = samples.length

  if (sampleCount !== contract.baselineSize) {
    errors.push(`基准集样本数 ${sampleCount}，契约要求恰好 ${contract.baselineSize} 家。不得用重复样本或合成数据凑数。`)
  }

  const ids = new Set()
  let annotatorConflicts = 0
  let syntheticMarkers = 0
  samples.forEach((s, i) => {
    const where = `samples[${i}]`
    if (!isObj(s)) { errors.push(`${where} 不是对象`); return }

    for (const key of Object.keys(s)) {
      const lower = key.toLowerCase()
      if (contract.forbiddenFields.some((f) => lower === f || lower.includes(f))) {
        errors.push(`${where} 含禁止字段 ${key}（标注集不得夹带评分字段或个人信息）`)
      }
    }
    for (const [key, value] of Object.entries(s)) {
      if (typeof value !== 'string') continue
      for (const p of contract.forbiddenValuePatterns) {
        if (value.includes(p)) { errors.push(`${where}.${key} 命中禁止内容 ${p}`); break }
      }
      if (/FAKE|SYNTHETIC|GENERATED|MOCK/i.test(value)) {
        // 反例夹具必须被明确拒绝，绝不让它冒充人工标注
        if (!/INVALID-FIXTURE/.test(value)) syntheticMarkers++
      }
    }

    const id = String(s.sample_id ?? '')
    if (id) {
      if (ids.has(id)) errors.push(`${where}.sample_id 重复：${id}`)
      ids.add(id)
    }

    for (const [name, spec] of Object.entries(contract.fields)) validateField(name, spec, s[name], where, errors)

    const a = String(s.annotator_a ?? ''), b = String(s.annotator_b ?? ''), c = String(s.adjudicated_by ?? '')
    if (a && b && a === b) { annotatorConflicts++; errors.push(`${where} 两名标注员相同（${a}），违反独立双标`) }
    if (c && (c === a || c === b)) { annotatorConflicts++; errors.push(`${where} 裁决人不得兼任标注员`) }
    for (const who of [a, b, c]) {
      if (/dev|engineer|研发|developer/i.test(who)) { annotatorConflicts++; errors.push(`${where} 研发不得兼任标注/裁决：${who}`) }
    }
    if (Number(s.provenance_matched) > Number(s.provenance_total)) errors.push(`${where} provenance_matched > provenance_total`)
    if (Number(s.signals_found) > Number(s.signals_actual)) errors.push(`${where} signals_found > signals_actual`)
    if (Number(s.rules_passed) > Number(s.rules_total)) errors.push(`${where} rules_passed > rules_total`)
    if (!(Number(s.signals_true) + Number(s.signals_false) > 0)) errors.push(`${where} signals_true + signals_false 必须 > 0`)
  })
  if (syntheticMarkers) warnings.push(`发现 ${syntheticMarkers} 处疑似合成标记，需人工复核标注来源`)

  const composition = sampleCount ? checkComposition(samples, errors) : {}
  const ok = errors.length === 0
  return {
    ok,
    status: ok ? 'VALID' : 'INVALID',
    code: ok ? null : 'E4004',
    contractVersion: BASELINE_CONTRACT_VERSION,
    sampleCount,
    requiredSize: contract.baselineSize,
    errors: [...new Set(errors)].slice(0, 80),
    errorCount: new Set(errors).size,
    warnings,
    composition,
    annotators: { independentPairsChecked: sampleCount, conflicts: annotatorConflicts, policy: contract.annotatorPolicy },
    releaseEligible: false,
    note: '导入校验通过 ≠ 评测通过。真实发布必须把模型预测与这 385 家人工标注配对后调用 /v1/eval/run；当前仓库不含任何标注样本。',
  }
}

/** 只在显式配置 LEADPILOT_BASELINE_FILE 时读取真实标注文件；绝不扫描目录「找」标注集 */
export function checkLabeledBaseline() {
  const file = process.env.LEADPILOT_BASELINE_FILE ?? ''
  if (!file) {
    return { status: 'NOT_IMPORTED', baselineSize: 0, requiredSize: contract.baselineSize, contractVersion: BASELINE_CONTRACT_VERSION }
  }
  if (!existsSync(file)) {
    return { status: 'FILE_NOT_FOUND', file: basename(file), baselineSize: 0, requiredSize: contract.baselineSize, contractVersion: BASELINE_CONTRACT_VERSION }
  }
  let validation
  try {
    validation = validateBaselineImport(parseBaselineText(readFileSync(file, 'utf8'), file))
  } catch (err) {
    return { status: 'PARSE_ERROR', file: basename(file), reason: String(err?.message ?? err), contractVersion: BASELINE_CONTRACT_VERSION }
  }
  return {
    status: validation.ok ? 'IMPORTED_VALID' : 'IMPORTED_INVALID',
    file: basename(file), baselineSize: validation.sampleCount,
    requiredSize: contract.baselineSize, contractVersion: BASELINE_CONTRACT_VERSION,
    errors: validation.errors.slice(0, 10),
    releaseEligible: false,
  }
}
