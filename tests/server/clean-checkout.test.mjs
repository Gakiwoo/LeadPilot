/**
 * B6 · P1-2 行为级反例：干净检出对账不得再出现「跳过 src/data/ 却报全部纳入」的假保证。
 *
 * 这里测纯函数，不依赖 git 元数据（真实仓库跟踪状态由 CLI 在 CI 里查 git ls-files）；
 * 反例用「故意漏跟踪 / 故意让文件不存在」注入，改坏实现必须变红。
 */
import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectLocalSources, auditCleanCheckout, SOURCE_DIRS, SOURCE_EXT,
} from '../../scripts/check-clean-checkout.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const local = collectLocalSources(ROOT)
const allTracked = [...local]

describe('B6 · 干净检出全量对账', () => {
  it('src/data/ 必须被枚举：按 basename 跳过就会漏（ADR-008 同款假保证）', () => {
    expect(local).toContain('src/data/demo-data.ts')
    expect(local).toContain('src/data/repository.ts')
  })

  it('根级配置与 .github/workflows 也纳入对账，不再只查四个子目录', () => {
    expect(local).toContain('package.json')
    expect(local).toContain('config/vite.config.ts')
    expect(local).toContain('.github/workflows/ci.yml')
    expect(SOURCE_DIRS).toContain('.github')
    expect(SOURCE_DIRS).toContain('config')
  })

  it('全量跟踪时通过，统计数量与真实枚举一致', () => {
    const r = auditCleanCheckout({ trackedList: allTracked, localList: local })
    expect(r.ok).toBe(true)
    expect(r.localCount).toBe(local.length)
    expect(r.untracked).toEqual([])
    expect(r.vanished).toEqual([])
  })

  it('反例：故意漏跟踪 src/data/repository.ts 必须报红', () => {
    const r = auditCleanCheckout({
      trackedList: allTracked.filter((f) => f !== 'src/data/repository.ts'),
      localList: local,
    })
    expect(r.ok).toBe(false)
    expect(r.untracked).toContain('src/data/repository.ts')
  })

  it('反例：干净检出缺根配置 package.json 必须报红（vanished 覆盖根级）', () => {
    const r = auditCleanCheckout({
      trackedList: allTracked,
      localList: local,
      fileExists: (f) => f !== 'package.json',
    })
    expect(r.ok).toBe(false)
    expect(r.vanished).toContain('package.json')
  })

  it('根级 data/ 仍被跳过，本地持久库不进源码清单', () => {
    expect(local.some((f) => f.startsWith('data/'))).toBe(false)
    expect(SOURCE_EXT.test('data/leadpilot.db')).toBe(false)
  })
})
