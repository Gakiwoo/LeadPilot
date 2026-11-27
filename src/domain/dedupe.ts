/**
 * AC-05 · 三重指纹去重（域名 + 公司名归一化 + 国家）
 *
 * 为什么单独成模块：去重规则同时被「服务端导入管道」和「客户端任务出库」使用，
 * 两处各写一套必然漂移（前端放行的两行、后端却判成重复，或者反过来）。
 * 因此规则本身放进 shared/dedupe-contract.json，两侧只实现归一化动作，
 * 并用 tests/frontend/dedupe.test.ts 的跨语言夹具逐条比对两侧指纹是否一致。
 *
 * 纪律：
 *  - 纯函数，无 IO、无随机、无时间依赖，同一输入永远同一指纹。
 *  - 只做判定，不删除数据：被判重的一律进 duplicates 并带 reason，由调用方决定怎么呈现。
 *  - 缺字段不猜：公司名或国家任一缺失就不参与 name_country 判重；两者都缺记 uncheckable。
 *  - 归一化不做音译、不做同义词表 —— 只会「抹掉不该影响判定的差异」（大小写/标点/法律后缀），
 *    绝不把两个不同的公司名映射成同一串。
 */
import contract from '../../shared/dedupe-contract.json'

export const DEDUPE_CONTRACT: string = contract.contract
export const DEDUPE_VERSION: string = contract.version

const MIN_NAME_KEY_LENGTH: number = contract.minNameKeyLength
const MAX_SUFFIX_STRIPS: number = contract.maxSuffixStrips
const COUNTRY_ALIASES: Record<string, string> = contract.countryAliases

const HALF_WIDTH = /[\uFF01-\uFF5E]/g
const CJK = /[\u3400-\u9fff]/

function toHalfWidth(text: string): string {
  return text.replace(HALF_WIDTH, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, ' ')
}

/** 归一化基础管线：NFC → 小写 → 全角转半角 → 标点转空格 → 折叠空白 */
function baseText(raw: unknown): string {
  return toHalfWidth(String(raw ?? '').normalize('NFC').toLowerCase())
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 后缀按字符数倒序：保证「股份有限公司」先于「有限公司」被剥离 */
const LEGAL_SUFFIXES: string[] = (contract.legalSuffixes as string[])
  .map((s) => baseText(s))
  .filter(Boolean)
  .sort((a, b) => b.length - a.length)

/**
 * 公司名归一化：剥掉尾部法律实体后缀（可多次，如「GmbH & Co. KG」）。
 * 拉丁后缀要求词边界，避免 KASSEL 之类被 "as / sa" 切掉；中文后缀直接按串尾匹配。
 * 剥完剩余长度低于 minNameKeyLength 就不剥了 —— 宁可少判重，也不把公司名清空成误合并。
 */
export function normalizeCompanyName(raw: unknown): string {
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

/** 与 server/core/dedupe.mjs 逐字一致的域名规范化：去 scheme / userinfo / 端口 / 路径 / www / 尾点 */
export function normalizeDomain(raw: unknown): string {
  let s = String(raw ?? '').trim().toLowerCase()
  if (!s) return ''
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  s = s.split(/[/?#]/)[0] ?? ''
  if (s.includes('@')) s = s.split('@').pop() ?? s
  s = s.replace(/:\d+$/, '')
  s = s.replace(/^www\./, '')
  return s.replace(/^\.+|\.+$/g, '')
}

/** 国家归一化：命中别名表就映射成 ISO-3166 alpha-2，未命中保留原文小写（不猜） */
export function normalizeCountry(raw: unknown): string {
  const text = toHalfWidth(String(raw ?? '').normalize('NFC').trim().toLowerCase()).replace(/\s+/g, ' ')
  if (!text) return ''
  return COUNTRY_ALIASES[text] ?? text
}

export interface DedupeInput {
  domain?: string
  name?: string
  country?: string
}

export type DedupeBasis = 'domain' | 'name_country'

export interface Fingerprint {
  domain: string
  nameKey: string
  countryKey: string
  /** domain = 有可用域名；name_country = 靠公司名+国家；none = 不可判重 */
  basis: DedupeBasis | 'none'
  keys: string[]
}

export function fingerprintOf(input: DedupeInput): Fingerprint {
  const domain = normalizeDomain(input.domain)
  const nameKey = normalizeCompanyName(input.name)
  const countryKey = normalizeCountry(input.country)
  const keys: string[] = []
  if (domain) keys.push(`d:${domain}`)
  if (nameKey.length >= MIN_NAME_KEY_LENGTH && countryKey) keys.push(`n:${nameKey}|c:${countryKey}`)
  const basis: DedupeBasis | 'none' = domain ? 'domain' : keys.length ? 'name_country' : 'none'
  return { domain, nameKey, countryKey, basis, keys }
}

/** 供调用方构建「已知指纹集合」，例如任务出库前先算出库内已有指纹 */
export function fingerprintKeys(input: DedupeInput): string[] {
  return fingerprintOf(input).keys
}

export interface DuplicateEntry {
  index: number
  matchedIndex: number
  basis: DedupeBasis
  key: string
  reason: string
}

export interface DedupeOutcome<T> {
  unique: T[]
  duplicates: DuplicateEntry[]
  /** 缺少全部可用指纹、无法参与判重的条目下标（如实上报，不静默当唯一） */
  uncheckable: number[]
}

/**
 * 按三重指纹去重。顺序判定：先看域名，再看「公司名+国家」。
 * matchedIndex 指首次出现的那一条下标，便于把两条记录一起呈现给用户。
 */
export function dedupeByFingerprint<T>(items: readonly T[], read: (item: T) => DedupeInput): DedupeOutcome<T> {
  const seen = new Map<string, number>()
  const unique: T[] = []
  const duplicates: DuplicateEntry[] = []
  const uncheckable: number[] = []

  items.forEach((item, index) => {
    const fp = fingerprintOf(read(item))
    if (!fp.keys.length) {
      uncheckable.push(index)
      unique.push(item)
      return
    }

    let hit: { key: string; matchedIndex: number; basis: DedupeBasis } | null = null
    for (const key of fp.keys) {
      const matchedIndex = seen.get(key)
      if (matchedIndex === undefined) continue
      hit = { key, matchedIndex, basis: key.startsWith('d:') ? 'domain' : 'name_country' }
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
