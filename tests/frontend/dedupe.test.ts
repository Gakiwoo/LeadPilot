/**
 * AC-05 · 三重指纹去重（客户端实现 + 跨语言契约夹具）
 *
 * 这个文件锁三件事：
 *  1. 归一化边界：法律后缀、全角、标点、大小写、空白、中文后缀顺序；
 *  2. 判重语义：域名优先；域名不同但「公司名归一化 + 国家」相同也判重；缺字段绝不猜；
 *  3. 与服务端同一份夹具（tests/fixtures/dedupe-parity.json）逐条一致 —— 任一侧改规则没同步，两侧同时红。
 */
import { describe, expect, it } from 'vitest'
import fixture from '../fixtures/dedupe-parity.json'
import sharedContract from '../../shared/dedupe-contract.json'
import {
  DEDUPE_CONTRACT, DEDUPE_VERSION,
  dedupeByFingerprint, fingerprintKeys, fingerprintOf, normalizeCompanyName, normalizeCountry, normalizeDomain,
} from '@/domain/dedupe'
import { buildDemoCompanies } from '@/data/demo-data'

interface ParityCase {
  id: string
  input: { domain: string; name: string; country: string }
  expect: { domain: string; nameKey: string; countryKey: string; basis: string; keys: string[] }
}

const cases = fixture.cases as ParityCase[]

describe('AC-05 三重指纹：契约与归一化', () => {
  it('契约标识与版本与 shared/dedupe-contract.json 一致（不允许本地另立版本）', () => {
    expect(DEDUPE_CONTRACT).toBe(sharedContract.contract)
    expect(DEDUPE_VERSION).toBe(sharedContract.version)
    expect(fixture.contract).toBe(sharedContract.contract)
    expect(fixture.version).toBe(sharedContract.version)
  })

  it('跨语言夹具逐条一致：域名 / 公司名 / 国家 / 判重依据 / 指纹键', () => {
    expect(cases.length).toBeGreaterThanOrEqual(16)
    for (const c of cases) {
      const fp = fingerprintOf(c.input)
      expect({ id: c.id, domain: fp.domain }).toEqual({ id: c.id, domain: c.expect.domain })
      expect({ id: c.id, nameKey: fp.nameKey }).toEqual({ id: c.id, nameKey: c.expect.nameKey })
      expect({ id: c.id, countryKey: fp.countryKey }).toEqual({ id: c.id, countryKey: c.expect.countryKey })
      expect({ id: c.id, basis: fp.basis }).toEqual({ id: c.id, basis: c.expect.basis })
      expect({ id: c.id, keys: fp.keys }).toEqual({ id: c.id, keys: c.expect.keys })
    }
  })

  it('剥法律后缀但不越界：拉丁后缀要求词边界，中文后缀按串尾匹配', () => {
    expect(normalizeCompanyName('Rhein Hydraulik Handel GmbH')).toBe('rhein hydraulik handel')
    expect(normalizeCompanyName('Acme GmbH & Co. KG')).toBe('acme')
    expect(normalizeCompanyName('Dallas')).toBe('dallas') // 不能被 "as" 切掉
    expect(normalizeCompanyName('Midwest Hydraulic Supply Co.')).toBe('midwest hydraulic supply')
    expect(normalizeCompanyName('深圳寇德精密制品有限公司')).toBe('深圳寇德精密制品')
    // 「股份有限公司」必须整段先剥，不能先命中的「有限公司」留下「股份」残词
    expect(normalizeCompanyName('深圳寇德精密制品股份有限公司')).toBe('深圳寇德精密制品')
  })

  it('不把公司名剥空：剥完短于 minNameKeyLength 就不剥，宁可少判重', () => {
    expect(normalizeCompanyName('Co.')).toBe('co')
    expect(normalizeCompanyName('AB')).toBe('ab')
    expect(fingerprintOf({ name: 'Co.', country: 'US' }).keys).toEqual([])
  })

  it('域名规范化与服务端同规则：去 scheme / userinfo / 端口 / 路径 / www / 尾点', () => {
    expect(normalizeDomain('https://WWW.Acme.example:443/about?x=1')).toBe('acme.example')
    expect(normalizeDomain('http://user:pw@Sub.Acme.example./a/b')).toBe('sub.acme.example')
    expect(normalizeDomain('')).toBe('')
  })

  it('国家只在别名表命中时映射，未命中保留原文小写，绝不猜', () => {
    expect(normalizeCountry('德国')).toBe('DE')
    expect(normalizeCountry('Deutschland')).toBe('DE')
    expect(normalizeCountry(' DE ')).toBe('DE')
    expect(normalizeCountry('Mars')).toBe('mars')
    expect(normalizeCountry('')).toBe('')
  })
})

describe('AC-05 三重指纹：判重语义', () => {
  const read = (c: { domain: string; name: string; country: string }) => c

  it('域名相同 → 判重，basis=domain，指向首次出现的那条', () => {
    const out = dedupeByFingerprint([
      { domain: 'acme.example', name: 'Acme Trading', country: 'US' },
      { domain: 'https://www.acme.example/path', name: 'Acme Trading Inc', country: 'US' },
    ], read)
    expect(out.unique).toHaveLength(1)
    expect(out.duplicates).toHaveLength(1)
    expect(out.duplicates[0]).toMatchObject({ index: 1, matchedIndex: 0, basis: 'domain' })
    expect(out.duplicates[0]?.reason).toContain('规范化域名相同')
  })

  it('域名不同但公司名归一化 + 国家相同 → 判重，且 reason 写明是三重指纹判的（不静默丢）', () => {
    const out = dedupeByFingerprint([
      { domain: 'rhein-hydraulik.de', name: 'Rhein Hydraulik Handel GmbH', country: '德国' },
      { domain: 'rhein-hydraulik-gmbh.de', name: 'RHEIN HYDRAULIK HANDEL GmbH', country: 'DE' },
    ], read)
    expect(out.unique).toHaveLength(1)
    expect(out.duplicates[0]).toMatchObject({ index: 1, matchedIndex: 0, basis: 'name_country' })
    expect(out.duplicates[0]?.reason).toContain('域名不同但公司名归一化 + 国家相同')
    expect(out.duplicates[0]?.key).toBe('n:rhein hydraulik handel|c:DE')
  })

  it('同名不同国 → 两条都保留（不同国家各有同名公司是正常情况，不能合并）', () => {
    const out = dedupeByFingerprint([
      { domain: 'acme-de.example', name: 'Acme Trading GmbH', country: '德国' },
      { domain: 'acme-nl.example', name: 'Acme Trading BV', country: '荷兰' },
    ], read)
    expect(out.unique).toHaveLength(2)
    expect(out.duplicates).toHaveLength(0)
  })

  it('缺国家或缺公司名 → 不参与 name_country 判重，绝不因为「看起来像」就合并', () => {
    const out = dedupeByFingerprint([
      { domain: 'a.example', name: 'Acme Trading', country: '' },
      { domain: 'b.example', name: 'Acme Trading', country: '' },
    ], read)
    expect(out.unique).toHaveLength(2)
    expect(out.duplicates).toHaveLength(0)
  })

  it('三条指纹全缺 → 记进 uncheckable 并保留，如实上报「不可判重」', () => {
    const out = dedupeByFingerprint([
      { domain: '', name: '', country: '' },
      { domain: 'ok.example', name: 'Real Co', country: 'US' },
    ], read)
    expect(out.uncheckable).toEqual([0])
    expect(out.unique).toHaveLength(2)
    expect(out.duplicates).toHaveLength(0)
  })

  it('unique 保持原顺序，后续行与首次出现的行比对', () => {
    const out = dedupeByFingerprint([
      { domain: 'a.example', name: 'Alpha GmbH', country: 'DE' },
      { domain: 'b.example', name: 'Beta GmbH', country: 'DE' },
      { domain: 'alpha-2.example', name: 'ALPHA', country: 'DE' },
    ], read)
    expect(out.unique.map((c) => c.domain)).toEqual(['a.example', 'b.example'])
    expect(out.duplicates[0]).toMatchObject({ index: 2, matchedIndex: 0 })
  })

  it('不做音译 / 不做同义词：名字不同就是不同公司', () => {
    const out = dedupeByFingerprint([
      { domain: 'a.example', name: 'Rhein Hydraulik', country: 'DE' },
      { domain: 'b.example', name: 'Rhein Hydraulik Handel', country: 'DE' },
    ], read)
    expect(out.unique).toHaveLength(2)
  })

  it('fingerprintKeys 给出可直接用于「已知集合」过滤的全部键', () => {
    expect(fingerprintKeys({ domain: 'acme.example', name: 'Acme GmbH', country: '德国' }))
      .toEqual(['d:acme.example', 'n:acme|c:DE'])
  })
})

describe('AC-05 三重指纹：演示数据必须能过去重而不缩水', () => {
  it('48 家演示数据自身无重复', () => {
    const out = dedupeByFingerprint(buildDemoCompanies(48), (c) => c)
    expect(out.unique).toHaveLength(48)
    expect(out.duplicates).toEqual([])
  })

  it('120 家演示数据变体名唯一，去重后数量不缩水（否则任务候选池会被正确但无意义地砍掉）', () => {
    const out = dedupeByFingerprint(buildDemoCompanies(120), (c) => c)
    expect(out.unique).toHaveLength(120)
    expect(out.duplicates).toEqual([])
  })
})
