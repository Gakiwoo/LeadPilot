/**
 * AC-05 · 三重指纹去重（服务端实现 + 导入管道接线）
 *
 * 与 tests/frontend/dedupe.test.ts 共用 tests/fixtures/dedupe-parity.json：
 * 两侧各自对齐同一份夹具，等价性由传递性保证，不跨语言 import。
 *
 * 这里额外锁「接线」：指纹去重必须真的进了 validateRows / importCompanies，
 * 只在 core/dedupe.mjs 里写对而没接进管道，等于没做。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createMemoryStore } from '../../server/persistence/store.mjs'
import { createBatchPipeline, normalizeDomain, validateRows } from '../../server/services/batch.mjs'
import {
  DEDUPE_CONTRACT, DEDUPE_VERSION,
  dedupeByFingerprint, fingerprintKeys, fingerprintOf, normalizeCompanyName, normalizeCountry,
} from '../../server/core/dedupe.mjs'

const fixture = JSON.parse(readFileSync(new URL('../fixtures/dedupe-parity.json', import.meta.url), 'utf8'))
const sharedContract = JSON.parse(readFileSync(new URL('../../shared/dedupe-contract.json', import.meta.url), 'utf8'))

const row = (over = {}) => ({
  company_name: 'Acme Trading GmbH',
  domain: 'acme.example',
  country: 'Germany',
  ...over,
})

describe('AC-05 服务端：契约与跨语言夹具', () => {
  it('契约标识与版本取自 shared/dedupe-contract.json', () => {
    expect(DEDUPE_CONTRACT).toBe(sharedContract.contract)
    expect(DEDUPE_VERSION).toBe(sharedContract.version)
    expect(fixture.version).toBe(sharedContract.version)
  })

  it('与服务端实现逐条一致（同一份夹具，客户端另有一份对齐）', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(16)
    for (const c of fixture.cases) {
      const fp = fingerprintOf(c.input)
      expect({ id: c.id, ...fp, keys: fp.keys }).toEqual({
        id: c.id,
        domain: c.expect.domain,
        nameKey: c.expect.nameKey,
        countryKey: c.expect.countryKey,
        basis: c.expect.basis,
        keys: c.expect.keys,
      })
    }
  })

  it('batch.mjs 转出的 normalizeDomain 就是 core/dedupe.mjs 的实现，不存在第二份', () => {
    expect(normalizeDomain('https://WWW.Acme.example:443/about?x=1')).toBe('acme.example')
    expect(normalizeCompanyName('Acme GmbH & Co. KG')).toBe('acme')
    expect(normalizeCountry('Deutschland')).toBe('DE')
  })
})

describe('AC-05 服务端：validateRows 接线', () => {
  it('批内：域名不同但同名同国 → 判重，reason 写明三重指纹，不进 accepted', () => {
    const v = validateRows([
      row(),
      row({ domain: 'acme-trading.example', company_name: 'ACME TRADING GmbH' }),
    ])
    expect(v.accepted).toHaveLength(1)
    expect(v.duplicates).toHaveLength(1)
    expect(v.duplicates[0]).toMatchObject({ rowIndex: 2, basis: 'name_country' })
    expect(v.duplicates[0].reason).toContain('域名不同但公司名归一化 + 国家相同')
    expect(v.summary).toEqual({ received: 2, accepted: 1, rejected: 0, duplicates: 1 })
  })

  it('批内：同名不同国 → 两条都收（不能把德国和荷兰的同名公司合并）', () => {
    const v = validateRows([
      row({ domain: 'acme-de.example', country: '德国' }),
      row({ domain: 'acme-nl.example', country: '荷兰' }),
    ])
    expect(v.accepted).toHaveLength(2)
    expect(v.duplicates).toHaveLength(0)
  })

  it('批内：缺 country 时只按域名判重，不猜同名', () => {
    const v = validateRows([
      row({ domain: 'a.example', country: '' }),
      row({ domain: 'b.example', country: '' }),
    ])
    expect(v.accepted).toHaveLength(2)
    expect(v.duplicates).toHaveLength(0)
  })

  it('库内：existingFingerprints 命中 name_country → 判重且不覆盖既有研判', () => {
    const existingKeys = new Set(fingerprintKeys({ domain: 'rhein-hydraulik.de', name: 'Rhein Hydraulik Handel GmbH', country: '德国' }))
    const v = validateRows(
      [row({ domain: 'rhein-hydraulik-gmbh.example', company_name: 'Rhein Hydraulik Handel GmbH', country: 'DE' })],
      { existingFingerprints: existingKeys },
    )
    expect(v.accepted).toHaveLength(0)
    expect(v.duplicates).toHaveLength(1)
    expect(v.duplicates[0].reason).toContain('库内已存在同名同国公司')
  })

  it('库内：域名命中仍走原有域名判重文案（既有行为不变）', () => {
    const v = validateRows([row()], { existingDomains: new Set(['acme.example']) })
    expect(v.accepted).toHaveLength(0)
    expect(v.duplicates[0]).toMatchObject({ basis: 'domain' })
    expect(v.duplicates[0].reason).toBe('库内已存在（不覆盖既有研判与状态）')
  })
})

describe('AC-05 服务端：importCompanies 端到端', () => {
  it('两次导入同名同国不同域 → 第二次判重，客户库不产生第二条', () => {
    const store = createMemoryStore()
    const p = createBatchPipeline({ store, gateway: null })
    const first = p.importCompanies({ rows: [row()] })
    expect(first.ok).toBe(true)
    expect(first.summary.accepted).toBe(1)

    const second = p.importCompanies({ rows: [row({ domain: 'acme-gmbh.example' })] })
    expect(second.summary.duplicates).toBe(1)
    expect(second.duplicates[0]).toMatchObject({ basis: 'name_country' })
    expect(store.companyList()).toHaveLength(1)
  })

  it('不同国家的同名公司都能入库（三重指纹不是「名字相同就合并」）', () => {
    const store = createMemoryStore()
    const p = createBatchPipeline({ store, gateway: null })
    p.importCompanies({ rows: [row({ domain: 'acme-de.example', country: '德国' })] })
    const r = p.importCompanies({ rows: [row({ domain: 'acme-nl.example', country: '荷兰' })] })
    expect(r.summary.accepted).toBe(1)
    expect(store.companyList()).toHaveLength(2)
  })

  it('同一批里三家同名同国 → 只收第一条，另外两条各自带 reason 上报', () => {
    const store = createMemoryStore()
    const p = createBatchPipeline({ store, gateway: null })
    const r = p.importCompanies({
      rows: [
        row({ domain: 'acme1.example' }),
        row({ domain: 'acme2.example' }),
        row({ domain: 'acme3.example' }),
      ],
    })
    expect(r.summary).toEqual({ received: 3, accepted: 1, rejected: 0, duplicates: 2 })
    expect(r.partial).toBe(true)
    expect(r.duplicates.every((d) => d.basis === 'name_country')).toBe(true)
  })
})

describe('AC-05 去重是判定，不是删除', () => {
  it('dedupeByFingerprint 不丢弃不可判重项，并把下标如实报出', () => {
    const out = dedupeByFingerprint([{}, { domain: 'x.example' }], (c) => c)
    expect(out.unique).toHaveLength(2)
    expect(out.uncheckable).toEqual([0])
    expect(out.duplicates).toEqual([])
  })
})
