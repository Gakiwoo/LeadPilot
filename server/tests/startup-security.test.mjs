/**
 * B3-3 · 启动前置安全校验的自动化反例
 *
 * 此前 README/PM-REVIEW 写着「安全活体验证 ✅」，实际只有一次性人工验证，
 * 改坏 server/index.mjs 的 isDirectRun 分支 CI 仍会全绿。
 * 这里用真实子进程启动入口，断言不安全的组合必须 exit(1) 且给出明确原因。
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const ENTRY = fileURLToPath(new URL('../index.mjs', import.meta.url))

function boot(extra = {}) {
  return spawnSync(process.execPath, [ENTRY], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 8000,
    env: {
      ...process.env,
      LEADPILOT_HOST: '0.0.0.0',
      LEADPILOT_PORT: '0',
      LEADPILOT_STORE: 'memory',
      LEADPILOT_API_TOKEN: '',
      LEADPILOT_CORS: 'http://127.0.0.1:5180',
      ...extra,
    },
  })
}

describe('启动前置安全（真实子进程反例）', () => {
  it('对外监听 + 无令牌：拒绝启动，明确要求 LEADPILOT_API_TOKEN', () => {
    const r = boot()
    expect(r.error).toBeUndefined()
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/SECURITY_CONFIG/)
    expect(r.stderr).toMatch(/LEADPILOT_API_TOKEN/)
  })

  it('对外监听 + CORS 通配：即使已配令牌也拒绝启动', () => {
    const r = boot({ LEADPILOT_API_TOKEN: 'test-token', LEADPILOT_CORS: '*' })
    expect(r.error).toBeUndefined()
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/SECURITY_CONFIG/)
    expect(r.stderr).toMatch(/CORS 通配/)
  })
})
