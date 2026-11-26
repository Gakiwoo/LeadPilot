/**
 * B9 / P2-5 · 前端服务层与仓储层的关键行为级反例
 *
 * 覆盖此前 0 单测的 repository（坏数据 / 配额降级 / 双重失败）与 gateway-client 边界
 * （离线不伪造在线、HTML 错误页不伪造健康）。不引入 jsdom / testing-library，
 * 用 vi.stubGlobal 注入 localStorage / fetch，保持 node 测试环境零依赖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { localRepository, type PersistedState } from '@/data/repository'
import { buildComplianceFooter, probeGateway, type GatewayHealth } from '@/services/gateway-client'

const KEY = 'leadpilot.state.v1'

afterEach(() => { vi.unstubAllGlobals() })

const state = (): PersistedState => ({
  version: 1,
  companies: [{
    id: 'c0',
    features: { sourceTexts: ['官网原文'], evidences: { a: 'b' } },
    judgement: { ok: true },
  }] as unknown as PersistedState['companies'],
  tasks: [], outreach: [], settings: {} as PersistedState['settings'],
})

function fakeStorage(initial: Record<string, string> = {}, failTimes = 0) {
  const map = new Map(Object.entries(initial))
  let writes = 0
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      writes += 1
      if (writes <= failTimes) throw new Error('QuotaExceededError')
      map.set(k, v)
    },
    removeItem: (k: string) => { map.delete(k) },
    get writes() { return writes },
  }
  return { storage, map }
}

describe('B9 / P2-5 · repository 坏数据与配额降级', () => {
  it('非法 JSON / 版本不符 / 缺 companies 一律返回 null，绝不把坏状态喂给 UI', () => {
    for (const raw of ['{bad json', '{"version":2,"companies":[]}', '{"version":1,"tasks":[]}']) {
      const { storage } = fakeStorage({ [KEY]: raw })
      vi.stubGlobal('localStorage', storage)
      expect(localRepository.load()).toBeNull()
      vi.unstubAllGlobals()
    }
  })

  it('本地无存储时 load 返回 null、save 不抛错', () => {
    expect(localRepository.load()).toBeNull()
    expect(() => localRepository.save(state())).not.toThrow()
  })

  it('合法状态往返可读，且 save 后 load 拿到同一份 companies', () => {
    const { storage } = fakeStorage()
    vi.stubGlobal('localStorage', storage)
    localRepository.save(state())
    expect(localRepository.load()?.companies[0]?.id).toBe('c0')
  })

  it('配额超限后降级落盘：剥离 sourceTexts / evidences / judgement，不阻塞交互', () => {
    const { storage, map } = fakeStorage({}, 1)
    vi.stubGlobal('localStorage', storage)
    expect(() => localRepository.save(state())).not.toThrow()
    expect(storage.writes).toBe(2)
    const saved = JSON.parse(map.get(KEY) ?? '{}') as PersistedState
    const c = saved.companies[0] as unknown as { features: { sourceTexts: string[]; evidences: Record<string, string> }; judgement: unknown }
    expect(c.features.sourceTexts).toEqual([])
    expect(c.features.evidences).toEqual({})
    expect(c.judgement).toBeNull()
  })

  it('两次都写失败时静默降级、不伪造成功，也不抛异常', () => {
    const { storage, map } = fakeStorage({}, 2)
    vi.stubGlobal('localStorage', storage)
    expect(() => localRepository.save(state())).not.toThrow()
    expect(map.has(KEY)).toBe(false)
  })

  it('clear 真正删除持久化键', () => {
    const { storage, map } = fakeStorage({ [KEY]: '{}' })
    vi.stubGlobal('localStorage', storage)
    localRepository.clear()
    expect(map.has(KEY)).toBe(false)
  })
})

describe('B9 / P2-5 · 网关边界不伪造在线 / 合规尾巴不代生成', () => {
  it('服务不可达时 probeGateway 返回 offline，绝不伪造 provider 在线', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNREFUSED') })
    const h = await probeGateway()
    expect(h.online).toBe(false)
    expect(h.mode).toBe('offline')
    expect(h.readyCount).toBe(0)
  })

  it('服务端返回 HTML 错误页时按离线降级，不把非 JSON 响应当健康结果', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => '<html>502</html>' }))
    const h = await probeGateway()
    expect(h.online).toBe(false)
    expect(h.totalProviders).toBe(0)
  })

  it('E6009 鉴权失败给出「配置 token」指引，不误导成未配 Key', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false, status: 401,
      text: async () => JSON.stringify({ ok: false, code: 'E6009' }),
    }))
    const h: GatewayHealth = await probeGateway()
    expect(h.online).toBe(false)
    expect(h.reason).toContain('VITE_LEADPILOT_TOKEN')
  })

  it('buildComplianceFooter 只拼调用方给的身份，不代生成退订文案 / 不夹带占位符', () => {
    const footer = buildComplianceFooter({
      name: 'Kou', email: 'kou@example.com', company: 'ACME Trading',
      postalAddress: 'Shenzhen, China', unsubscribe: 'Reply STOP to unsubscribe / 退订',
    })
    expect(footer.split('\n')).toHaveLength(3)
    for (const part of ['Kou', 'ACME Trading', 'Shenzhen, China', 'unsubscribe']) expect(footer).toContain(part)
    expect(footer).not.toMatch(/\[[^\]]{1,40}\]|\{\{[^}]*\}\}/)
  })
})
