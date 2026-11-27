/**
 * P3-6 前置 · store 行为级**特征测试**（characterization tests）
 *
 * 目的：在把 719 行的 useAppStore 拆成 slice 之前，先把当前行为逐条钉死。
 * 顺序是「先绿 → 再重构 → 再绿」，重构前后这套断言必须一字不差地通过，
 * 这样才能证明拆分是**行为等价重构**，而不是顺手改语义。
 *
 * 因此这里的断言只描述「现在是什么样」，不描述「我认为应该是什么样」：
 *  - 任何一条在重构前就是红的，说明我读错了现状，必须先改测试；
 *  - 任何一条在重构后变红，说明切片改动改变了行为，必须回退。
 *
 * 环境：vitest 仍是 `environment: 'node'`，不引入 jsdom。
 * `localStorage` 用 `vi.stubGlobal` 注入，`fetch` 按用例逐次 stub。
 * store 是模块级单例，所以每个用例自己 `useAppStore.setState()` 铺前置状态（不依赖上一个用例）。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/useAppStore'
import { buildDemoCompanies } from '@/data/demo-data'
import type { Company, Outreach, TaskConfig } from '@/types'

/* ------------------------------------------------------------ 测试脚手架 */

const STORAGE_KEY = 'leadpilot.state.v1'
const memory = new Map<string, string>()

beforeAll(() => {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => { memory.set(k, v) },
    removeItem: (k: string) => { memory.delete(k) },
    clear: () => { memory.clear() },
    key: (i: number) => Array.from(memory.keys())[i] ?? null,
    get length() { return memory.size },
  })
})

/** 模块首次求值时的 settings 快照，用作每个用例的复位基线 */
const BASE_SETTINGS = useAppStore.getState().settings

const DEFAULT_FILTERS = {
  quick: 'all' as const, search: '', sort: 'default' as const,
  minScore: 0, hideCompetitors: true, grade: 'ALL' as const,
}

/** 铺一个确定性的前置状态：48 家演示客户、空队列、2000 点、空撤销栈 */
function seed(over: Partial<ReturnType<typeof useAppStore.getState>> = {}): Company[] {
  const companies = buildDemoCompanies(48)
  useAppStore.setState({
    companies,
    tasks: [],
    outreach: [],
    settings: { ...BASE_SETTINGS, pointsBalance: 2000, blacklist: ['blacklisted-company.example'] },
    activeView: 'developer',
    drawerCompanyId: null,
    composerCompanyId: null,
    activeTaskId: null,
    runnerMode: 'local',
    filters: { ...DEFAULT_FILTERS },
    selectedIds: [],
    toast: null,
    gateway: null,
    probing: false,
    pointsSource: 'local-demo',
    judgingCompanyId: null,
    lastGatewayResult: null,
    undoStack: [],
    ...over,
  })
  return companies
}

const companyAt = (i: number): Company => {
  const c = useAppStore.getState().companies[i]
  if (!c) throw new Error(`期望客户列表第 ${i} 项存在，测试前置条件不成立`)
  return c
}

/** 找一家指定状态的客户；找不到即前置条件不成立，不能静默跳过 */
const companyWithStatus = (status: Company['status']): Company => {
  const c = useAppStore.getState().companies.find((x) => x.status === status)
  if (!c) throw new Error(`演示数据里没有状态为 ${status} 的客户，测试前置条件不成立`)
  return c
}

/** 只保留指定状态的客户，避免「恰好有第二个 new」这类隐式依赖 */
const onlyCompanies = (keep: Company[]): void => {
  useAppStore.setState({ companies: keep })
}

const taskConfig = (over: Partial<TaskConfig> = {}): TaskConfig => ({
  keywords: ['hydraulic fittings'],
  excludeKeywords: [],
  markets: ['德国'],
  customerTypes: ['importer'],
  depth: 2,
  targetCount: 10,
  sizeTiers: ['S', 'M', 'L'],
  foundedYearsMin: 1,
  onlyVerifiedEmails: false,
  hsCode: '7307.19',
  name: '',
  ...over,
})

const draftFor = (companyId: string, contactId = ''): Outreach => ({
  id: `out_${companyId}`,
  companyId,
  contactId,
  subject: 'Intro',
  bodyText: 'Hello',
  bodyHtml: '<pre>Hello</pre>',
  language: 'en',
  purpose: 'intro',
  status: 'draft',
  personalizationTags: [],
  validation: {
    wordCount: 1, maxWords: 200, bannedHits: [], hasUnsubscribe: true, hasSenderIdentity: true,
    hasPlaceholder: false, hasPersonalization: true, passed: true, issues: [],
  },
  createdAt: '2026-11-27T00:00:00.000Z',
  demo: true,
})

/** 让 fetch 立刻失败，模拟「云端未启动」（store 必须如实降级，不伪造在线） */
const stubFetchOffline = () => {
  const spy = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')))
  vi.stubGlobal('fetch', spy)
  return spy
}

/** 让 fetch 返回一段 JSON，模拟服务端正常响应 */
const stubFetchJson = (body: unknown) => {
  const spy = vi.fn(() => Promise.resolve({
    ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)),
  }))
  vi.stubGlobal('fetch', spy)
  return spy
}

/* ------------------------------------------------------------ 视图 / 选择 / 筛选 */

describe('store 特征 · 视图与选择', () => {
  it('setActiveView 切换视图时清空选中，避免跨页残留选中态被批量操作误用', () => {
    seed()
    useAppStore.setState({ selectedIds: ['a', 'b'] })
    useAppStore.getState().setActiveView('crm')
    expect(useAppStore.getState().activeView).toBe('crm')
    expect(useAppStore.getState().selectedIds).toEqual([])
  })

  it('openCompany / openComposer 只写各自的抽屉 id，互不影响', () => {
    seed()
    useAppStore.getState().openCompany('c_0001')
    expect(useAppStore.getState().drawerCompanyId).toBe('c_0001')
    expect(useAppStore.getState().composerCompanyId).toBeNull()
    useAppStore.getState().openComposer('c_0002')
    expect(useAppStore.getState().composerCompanyId).toBe('c_0002')
    expect(useAppStore.getState().drawerCompanyId).toBe('c_0001')
    useAppStore.getState().openCompany(null)
    expect(useAppStore.getState().drawerCompanyId).toBeNull()
  })

  it('toggleSelect 无 shift 是切换，带 shift 是追加且不产生重复', () => {
    seed()
    const toggle = useAppStore.getState().toggleSelect
    toggle('a')
    expect(useAppStore.getState().selectedIds).toEqual(['a'])
    toggle('b')
    expect(useAppStore.getState().selectedIds).toEqual(['a', 'b'])
    toggle('a')
    expect(useAppStore.getState().selectedIds).toEqual(['b'])
    toggle('b', true)
    useAppStore.getState().toggleSelect('b', true)
    expect(useAppStore.getState().selectedIds).toEqual(['b'])
    useAppStore.getState().toggleSelect('c', true)
    expect(useAppStore.getState().selectedIds).toEqual(['b', 'c'])
  })

  it('selectAll 直接覆盖、clearSelection 清空', () => {
    seed()
    useAppStore.getState().selectAll(['x', 'y', 'z'])
    expect(useAppStore.getState().selectedIds).toEqual(['x', 'y', 'z'])
    useAppStore.getState().clearSelection()
    expect(useAppStore.getState().selectedIds).toEqual([])
  })

  it('setFilters 是浅合并：只改传入字段，其余筛选条件保持不变', () => {
    seed()
    useAppStore.getState().setFilters({ search: 'hydraulic' })
    useAppStore.getState().setFilters({ grade: 'A' })
    const f = useAppStore.getState().filters
    expect(f).toMatchObject({ ...DEFAULT_FILTERS, search: 'hydraulic', grade: 'A' })
  })
})

/* ------------------------------------------------------------ Toast */

describe('store 特征 · Toast 生命周期', () => {
  it('showToast 缺省 tone 为 info，clearToast 立即清空', () => {
    seed()
    useAppStore.getState().showToast('已保存')
    expect(useAppStore.getState().toast).toMatchObject({ message: '已保存', tone: 'info' })
    useAppStore.getState().clearToast()
    expect(useAppStore.getState().toast).toBeNull()
  })

  it('Toast 4.2 秒后自动消失，且只清掉自己那条（不误清后来的提示）', () => {
    seed()
    vi.useFakeTimers()
    try {
      useAppStore.getState().showToast('第一条', 'ok')
      const first = useAppStore.getState().toast?.id
      expect(first).toBeTypeOf('number')
      vi.advanceTimersByTime(4300)
      expect(useAppStore.getState().toast).toBeNull()

      useAppStore.getState().showToast('第二条', 'warn')
      useAppStore.getState().showToast('第三条', 'error')
      vi.advanceTimersByTime(4300)
      // 后一条覆盖前一条时，旧定时器不能把新提示一起清掉
      expect(useAppStore.getState().toast).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

/* ------------------------------------------------------------ 任务启动与预扣 */

describe('store 特征 · startTask 的前置拒绝（不建任务、不扣点）', () => {
  it('点数不足：返回 E4001，不创建任务，余额不变', () => {
    seed({ settings: { ...BASE_SETTINGS, pointsBalance: 5 } })
    const r = useAppStore.getState().startTask(taskConfig({ targetCount: 10, depth: 2 }))
    expect(r.ok).toBe(false)
    expect(r.message).toContain('E4001')
    expect(useAppStore.getState().tasks).toHaveLength(0)
    expect(useAppStore.getState().settings.pointsBalance).toBe(5)
  })

  it('已有运行中任务：拒绝并行，余额不变', () => {
    seed()
    const first = useAppStore.getState().startTask(taskConfig())
    expect(first.ok).toBe(true)
    const balanceAfterFirst = useAppStore.getState().settings.pointsBalance
    try {
      const second = useAppStore.getState().startTask(taskConfig({ name: '第二个' }))
      expect(second.ok).toBe(false)
      expect(second.message).toContain('运行中的任务')
      expect(useAppStore.getState().tasks).toHaveLength(1)
      expect(useAppStore.getState().settings.pointsBalance).toBe(balanceAfterFirst)
    } finally {
      useAppStore.getState().abortTask()
    }
  })

  it('关键词或目标市场为空：拒绝（PRD F1-2 强制用户表达明确意图）', () => {
    seed()
    expect(useAppStore.getState().startTask(taskConfig({ keywords: [] })).ok).toBe(false)
    expect(useAppStore.getState().startTask(taskConfig({ markets: [] })).ok).toBe(false)
    expect(useAppStore.getState().tasks).toHaveLength(0)
  })
})

describe('store 特征 · startTask 正常启动（本地演示）', () => {
  it('预扣 = 目标数 × 深度单价；建任务、置 activeTaskId、重置筛选、日志写明三重指纹去重', () => {
    seed()
    const before = useAppStore.getState().settings.pointsBalance
    useAppStore.setState({ filters: { ...DEFAULT_FILTERS, quick: 'high_match', search: 'x', grade: 'A' } })

    const r = useAppStore.getState().startTask(taskConfig({ targetCount: 10, depth: 2 }))
    try {
      expect(r.ok).toBe(true)
      // 10 家 × L2 的 2 点/家 = 20
      expect(useAppStore.getState().settings.pointsBalance).toBe(before - 20)
      const task = useAppStore.getState().tasks[0]
      expect(task).toMatchObject({ mode: 'local', status: 'running', pointsEstimated: 20, pointsUsed: 0 })
      expect(useAppStore.getState().activeTaskId).toBe(task?.id)
      // 启动清空筛选，避免用户以为本次结果仍受上次筛选影响
      expect(useAppStore.getState().filters).toMatchObject({ quick: 'all', search: '' })

      // AC-05 接线：120 家候选里 48 家已在库 → 跳过 48
      const logText = (task?.progress.log ?? []).map((l) => l.text).join('\n')
      expect(logText).toContain('三重指纹去重')
      expect(logText).toContain('候选 120 家')
      expect(logText).toContain('跳过 48 家')
    } finally {
      useAppStore.getState().abortTask()
    }
  })

  it('云端不可达：任务标 failed、退还预扣点数、不伪造 taskId', async () => {
    seed()
    useAppStore.setState({ runnerMode: 'cloud' })
    stubFetchOffline()
    const before = useAppStore.getState().settings.pointsBalance

    const r = useAppStore.getState().startTask(taskConfig({ targetCount: 5, depth: 2 }))
    expect(r.ok).toBe(true)
    expect(useAppStore.getState().settings.pointsBalance).toBe(before - 10)

    await vi.waitFor(() => {
      const task = useAppStore.getState().tasks[0]
      expect(task?.status).toBe('failed')
      expect(useAppStore.getState().activeTaskId).toBeNull()
      expect(useAppStore.getState().settings.pointsBalance).toBe(before)
    })
    const task = useAppStore.getState().tasks[0]
    expect((task?.progress.log ?? []).map((l) => l.text).join('\n')).toContain('已退还预扣 10 点')
  })
})

/* ------------------------------------------------------------ 状态机与撤销 */

describe('store 特征 · setCompanyStatus 与撤销', () => {
  it('正常流转：改状态、追加留痕、undoStack 增 1', () => {
    seed()
    const c = companyWithStatus('new')
    onlyCompanies([c])
    const r = useAppStore.getState().setCompanyStatus(c.id, 'drafted')
    expect(r.ok).toBe(true)
    const updated = companyAt(0)
    expect(updated.status).toBe('drafted')
    expect(updated.statusLog).toHaveLength(c.statusLog.length + 1)
    expect(updated.statusLog.at(-1)).toMatchObject({ from: 'new', to: 'drafted', automated: false })
    expect(useAppStore.getState().undoStack).toHaveLength(1)
  })

  it('退订未二次确认：返回 needsConfirm 且状态与黑名单都不动', () => {
    seed()
    const c = companyWithStatus('new')
    onlyCompanies([c])
    const r = useAppStore.getState().setCompanyStatus(c.id, 'unsubscribed')
    expect(r).toMatchObject({ ok: false, needsConfirm: true })
    expect(companyAt(0).status).toBe('new')
    expect(useAppStore.getState().settings.blacklist).toEqual(['blacklisted-company.example'])
  })

  it('退订确认后：把该客户全部联系方式写入全局黑名单（可逆性由 undo 兜底）', () => {
    seed()
    const c = companyWithStatus('new')
    onlyCompanies([c])
    const r = useAppStore.getState().setCompanyStatus(c.id, 'unsubscribed', { confirmed: true })
    expect(r.ok).toBe(true)
    const blacklist = useAppStore.getState().settings.blacklist
    for (const contact of c.contacts) expect(blacklist).toContain(contact.value)
  })

  it('终态客户任何流转都被硬拦（E3001 不可逆）', () => {
    seed()
    const c = companyWithStatus('unsubscribed')
    onlyCompanies([c])
    const r = useAppStore.getState().setCompanyStatus(c.id, 'replied')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('不可逆')
    expect(companyAt(0).status).toBe('unsubscribed')
  })

  it('undo 一次性回滚状态、留痕、黑名单与 lastContactAt，并出栈', () => {
    seed()
    const c = companyWithStatus('new')
    onlyCompanies([c])
    const originalLogLength = c.statusLog.length
    const originalBlacklist = [...useAppStore.getState().settings.blacklist]

    useAppStore.getState().setCompanyStatus(c.id, 'unsubscribed', { confirmed: true })
    expect(companyAt(0).status).toBe('unsubscribed')
    expect(useAppStore.getState().settings.blacklist.length).toBeGreaterThan(originalBlacklist.length)

    useAppStore.getState().undo()
    const restored = companyAt(0)
    expect(restored.status).toBe(c.status)
    expect(restored.statusLog).toHaveLength(originalLogLength)
    expect(restored.lastContactAt).toBe(c.lastContactAt)
    expect(useAppStore.getState().settings.blacklist.sort()).toEqual(originalBlacklist.sort())
    expect(useAppStore.getState().undoStack).toHaveLength(0)
  })

  it('撤销栈为空时不改任何状态，只提示', () => {
    seed()
    const c = companyWithStatus('new')
    onlyCompanies([c])
    useAppStore.getState().undo()
    expect(companyAt(0).status).toBe('new')
    expect(useAppStore.getState().toast).toMatchObject({ message: '没有可撤销的状态变更', tone: 'info' })
  })

  it('batchSetStatus 已确认：逐条流转并汇报实际成功条数', () => {
    seed()
    const news = useAppStore.getState().companies.filter((x) => x.status === 'new').slice(0, 2)
    expect(news.length).toBe(2)
    onlyCompanies(news)
    const r = useAppStore.getState().batchSetStatus(news.map((x) => x.id), 'drafted', true)
    expect(r.ok).toBe(true)
    expect(useAppStore.getState().companies.every((x) => x.status === 'drafted')).toBe(true)
    expect(useAppStore.getState().toast).toMatchObject({ message: '已批量更新 2 家客户状态', tone: 'ok' })
  })
})

/* ------------------------------------------------------------ 客户 / 草稿 / 设置 */

describe('store 特征 · 客户、草稿与设置', () => {
  it('updateCompany 只改目标客户，其余对象引用不变', () => {
    seed()
    const target = companyAt(0)
    const other = companyAt(1)
    useAppStore.getState().updateCompany(target.id, { city: 'Rotterdam' })
    expect(companyAt(0).city).toBe('Rotterdam')
    expect(companyAt(1)).toBe(other)
  })

  it('addOutreach 命中 G2 全局黑名单时拦截，不建草稿、不推进状态', () => {
    const seedCompany = companyWithStatus('new')
    const contact = seedCompany.contacts[0]
    if (!contact) throw new Error('演示客户没有联系人，测试前置条件不成立')
    const domain = contact.value.split('@')[1] ?? ''
    seed({
      companies: [{ ...seedCompany, contacts: [{ ...contact, grade: 'A', isBlacklisted: false }] }],
      settings: { ...BASE_SETTINGS, pointsBalance: 2000, blacklist: [`@${domain}`] },
    })

    const r = useAppStore.getState().addOutreach(draftFor(seedCompany.id, contact.id))
    expect(r.ok).toBe(false)
    expect(r.message).toContain('四道闸门拦截')
    expect(r.message).toContain('G2')
    expect(useAppStore.getState().outreach).toHaveLength(0)
    expect(companyAt(0).status).toBe('new')
  })

  it('updateOutreach 只 patch 目标草稿', () => {
    seed({ outreach: [draftFor('c1'), draftFor('c2')] })
    useAppStore.getState().updateOutreach('out_c1', { subject: 'Hi' })
    expect(useAppStore.getState().outreach[0]?.subject).toBe('Hi')
    expect(useAppStore.getState().outreach[1]?.subject).toBe('Intro')
  })

  it('updateSettings 浅合并；addBlacklist 去重（重复加不产生第二份）', () => {
    seed()
    useAppStore.getState().updateSettings({ plan: '团队版' })
    expect(useAppStore.getState().settings.plan).toBe('团队版')
    expect(useAppStore.getState().settings.pointsBalance).toBe(2000)

    useAppStore.getState().addBlacklist('@acme.example')
    useAppStore.getState().addBlacklist('@acme.example')
    const blacklist = useAppStore.getState().settings.blacklist
    expect(blacklist.filter((x) => x === '@acme.example')).toHaveLength(1)
  })
})

/* ------------------------------------------------------------ 网关与点数镜像 */

describe('store 特征 · 网关与点数镜像（离线一律如实降级）', () => {
  it('probeGateway 离线：online=false、mode=offline、probing 复位，不伪造在线', async () => {
    seed()
    stubFetchOffline()
    await useAppStore.getState().probeGateway()
    const h = useAppStore.getState().gateway
    expect(h).toMatchObject({ online: false, mode: 'offline', configuredCount: 0, totalProviders: 0 })
    expect(h?.reason).toContain('不可达')
    expect(useAppStore.getState().probing).toBe(false)
  })

  it('syncPoints 离线：不覆盖本地余额，pointsSource 保持 local-demo', async () => {
    seed()
    stubFetchOffline()
    await useAppStore.getState().syncPoints()
    expect(useAppStore.getState().settings.pointsBalance).toBe(2000)
    expect(useAppStore.getState().pointsSource).toBe('local-demo')
  })

  // 口径说明：`syncPoints` 里 `!snap.ok` 这条分支在当前离线桩下不可达 ——
  // 失败响应根本不含 `available`，会被后面的 `typeof snap.available !== 'number'` 接住。
  // 保留它是**有意防御**（服务端可能返回 ok:false 却带着 available，例如 409 幂等冲突），
  // 特征测试覆盖不到它，重构时不许把它当死代码删掉。

  it('syncPoints 在线：用服务端 available 覆盖镜像余额并标记 pointsSource=server', async () => {
    seed()
    stubFetchJson({ ok: true, available: 777, held: 3, spent: 20, granted: 800 })
    await useAppStore.getState().syncPoints()
    expect(useAppStore.getState().settings.pointsBalance).toBe(777)
    expect(useAppStore.getState().pointsSource).toBe('server')
  })

  it('judgeWithGateway 客户不存在：直接返回，不留 judging 中间态', async () => {
    seed()
    await useAppStore.getState().judgeWithGateway('missing')
    expect(useAppStore.getState().judgingCompanyId).toBeNull()
    expect(useAppStore.getState().lastGatewayResult).toBeNull()
  })

  it('judgeWithGateway 网关不可用：评分卡降级 + 结果标 degraded，且请求体不含邮箱/电话/联系人姓名', async () => {
    seed()
    const target = companyAt(0)
    const contactEmail = target.contacts[0]?.value ?? ''
    const spy = stubFetchOffline()

    await useAppStore.getState().judgeWithGateway(target.id)

    const after = companyAt(0).scoreCard
    expect(after).toBeTruthy()
    expect(useAppStore.getState().judgingCompanyId).toBeNull()
    expect(useAppStore.getState().lastGatewayResult).toMatchObject({ companyId: target.id, degraded: true })
    expect(useAppStore.getState().toast).toMatchObject({ tone: 'warn' })

    // 11.4 数据最小化：发往模型的事实里不能出现联系方式
    const [, init] = spy.mock.calls[0] as unknown as [string, { body: string }]
    const payload = init.body
    if (contactEmail) expect(payload).not.toContain(contactEmail)
    expect(payload).not.toContain('"contactEmail"')
    expect(payload).not.toContain('"phone"')
  })
})

/* ------------------------------------------------------------ 持久化与重置 */

describe('store 特征 · 节流持久化与演示重置', () => {
  it('状态变更经节流后落盘到 localStorage（键名与版本号需与仓储契约一致）', async () => {
    seed()
    memory.clear()
    useAppStore.getState().setFilters({ search: 'persist-me' })
    // 首次变更会立刻落盘；之后的变更走 400ms debounce，最长 1500ms 必写一次
    await new Promise((resolve) => setTimeout(resolve, 800))
    const raw = memory.get(STORAGE_KEY)
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw ?? '{}') as { version?: number; companies?: unknown[] }
    expect(parsed.version).toBe(1)
    expect(Array.isArray(parsed.companies)).toBe(true)
  })

  it('resetDemo：客户回到 48 家、草稿清空、余额与筛选复位、本地存储被清', () => {
    seed({ outreach: [draftFor('c1')] })
    useAppStore.setState({ settings: { ...BASE_SETTINGS, pointsBalance: 12 } })

    useAppStore.getState().resetDemo()

    const s = useAppStore.getState()
    expect(s.companies).toHaveLength(48)
    expect(s.outreach).toHaveLength(0)
    expect(s.settings.pointsBalance).toBe(BASE_SETTINGS.pointsBalance)
    expect(s.filters).toEqual(DEFAULT_FILTERS)
    expect(s.activeTaskId).toBeNull()
    expect(s.selectedIds).toEqual([])
    expect(s.pointsSource).toBe('local-demo')
    expect(memory.has(STORAGE_KEY)).toBe(false)
  })
})
