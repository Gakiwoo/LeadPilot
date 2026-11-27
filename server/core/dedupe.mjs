/**
 * AC-05 · 三重指纹去重（服务端实现）
 *
 * 与前端 src/domain/dedupe.ts 共用 shared/dedupe-contract.json，
 * 目的和 core/protocol.mjs 一样：不让「前端放行、后端判重」这类规则漂移发生。
 * 两侧实现必须逐字等价，由 tests/frontend/dedupe.test.ts 的跨语言夹具锁死。
 *
 * 纯函数，无 IO、无网络、无时间依赖；本文件唯一的外部读取是加载契约 JSON。
 */
import { readFileSync } from 'node:fs'

export const dedupeContract = JSON.parse(
  readFileSync(new URL('../../shared/dedupe-contract.json', import.meta.url), 'utf8'),
)

export const DEDUPE_CONTRACT = dedupeContract.contract
export const DEDUPE_VERSION = dedupeContract.version

const MIN_NAME_KEY_LENGTH = dedupeContract.minNameKeyLength
const MAX_SUFFIX_STRIPS = dedupeContract.maxSuffixStrips
const COUNTRY_ALIASES = dedupeContract.countryAliases

const HALF_WIDTH = /[\uFF01-\uFF5E]/g
const CJK = /[\u3400-\u9fff]/

function toHalfWidth(text) {
  return text.replace(HALF_WIDTH, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, ' ')
}

function baseText(raw) {
  return toHalfWidth(String(raw ?? '').normalize('NFC').toLowerCase())
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const LEGAL_SUFFIXES = dedupeContract.legalSuffixes
  .map((s) => baseText(s))
  .filter(Boolean)
  .sort((a, b) => b.length - a.length)

export function normalizeCompanyName(raw) {
  let key = baseText(raw)
  for (let round = 0; round < MAX_SUFFIX_STRIPS; round += 1) {
    const hit = LEGAL_SUFFIXES.find((suffix) => {
      if (!key.endsWith(suffix)) return false
      if (CJK.test(suffix)) return true
      return key.length === suffix.length || key[key.length - suffix.length - 1] === ' '
    })
    if (!hit) break
    const stripped = key.slice(0, key.length - hit.length).trim()
    if (stripped.length < MIN_NAME_KEY_LENGTH) break
    key = stripped
  }
  return key
}

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

export function normalizeCountry(raw) {
  const text = toHalfWidth(String(raw ?? '').normalize('NFC').trim().toLowerCase()).replace(/\s+/g, ' ')
  if (!text) return ''
  return Object.prototype.hasOwnProperty.call(COUNTRY_ALIASES, text) ? COUNTRY_ALIASES[text] : text
}

export function fingerprintOf(input = {}) {
  const domain = normalizeDomain(input.domain)
  const nameKey = normalizeCompanyName(input.name)
  const countryKey = normalizeCountry(input.country)
  const keys = []
  if (domain) keys.push(`d:${domain}`)
  if (nameKey.length >= MIN_NAME_KEY_LENGTH && countryKey) keys.push(`n:${nameKey}|c:${countryKey}`)
  const basis = domain ? 'domain' : keys.length ? 'name_country' : 'none'
  return { domain, nameKey, countryKey, basis, keys }
}

export function fingerprintKeys(input = {}) {
  return fingerprintOf(input).keys
}

export function dedupeByFingerprint(items, read) {
  const seen = new Map()
  const unique = []
  const duplicates = []
  const uncheckable = []

  ;(Array.isArray(items) ? items : []).forEach((item, index) => {
    const fp = fingerprintOf(read(item))
    if (!fp.keys.length) {
      uncheckable.push(index)
      unique.push(item)
      return
    }

    let hit = null
    for (const key of fp.keys) {
      if (!seen.has(key)) continue
      hit = { key, matchedIndex: seen.get(key), basis: key.startsWith('d:') ? 'domain' : 'name_country' }
      break
    }

    if (hit) {
      duplicates.push({
        index,
        matchedIndex: hit.matchedIndex,
        basis: hit.basis,
        key: hit.key,
        reason: hit.basis === 'domain'
          ? `与第 ${hit.matchedIndex + 1} 条重复：规范化域名相同（${hit.key.slice(2)}）`
          : `与第 ${hit.matchedIndex + 1} 条重复：域名不同但公司名归一化 + 国家相同（${fp.nameKey} · ${fp.countryKey}）`,
      })
      return
    }

    for (const key of fp.keys) seen.set(key, index)
    unique.push(item)
  })

  return { unique, duplicates, uncheckable }
}
