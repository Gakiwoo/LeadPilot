/**
 * 干净检出全量校验 · B3-3
 *
 * 旧做法：CI 里硬编码 31 个「关键源码」路径逐个 git ls-files --error-unmatch。
 * 问题：tracked 源码共 50+ 项，漏掉的 21 个文件在本地全绿、CI 缺模块时才会暴露，
 * 而且清单本身永远追不上新增文件（.gitignore 误排除 src/data/ 就是这么漏的）。
 *
 * 新做法：枚举 src / server / shared / scripts 下所有源码与配置，
 * 逐个确认「被 git 跟踪」+「工作区真实存在」；清单由文件系统生成，不再靠人维护。
 * 本地新增但未 git add 的源码会立刻报错，这正是干净检出要抓的情形。
 *
 * 退出码：0 全量通过；1 有未跟踪或缺失文件（CI 必须红）。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SOURCE_DIRS = ['src', 'server', 'shared', 'scripts']
const SOURCE_EXT = /\.(?:ts|tsx|mjs|js|cjs|json|sh|yml|yaml|css|html)$/
const SKIP_DIRS = new Set(['node_modules', 'dist', 'data', 'coverage', '.workbuddy'])

function walk(absDir) {
  const out = []
  for (const name of readdirSync(absDir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(absDir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else if (SOURCE_EXT.test(name)) out.push(relative(ROOT, full).split('\\').join('/'))
  }
  return out
}

const tracked = new Set(
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean),
)
const local = SOURCE_DIRS.flatMap((dir) => walk(join(ROOT, dir))).sort()
const untracked = local.filter((f) => !tracked.has(f))
const vanished = [...tracked]
  .filter((f) => SOURCE_DIRS.some((dir) => f.startsWith(`${dir}/`)) && SOURCE_EXT.test(f))
  .filter((f) => !existsSync(join(ROOT, f)))
  .sort()

if (untracked.length || vanished.length) {
  if (untracked.length) {
    // eslint-disable-next-line no-console
    console.error(`干净检出失败：${untracked.length} 个源码/配置未被 git 跟踪（或已被 .gitignore 误排除）：`)
    for (const f of untracked) console.error(`  - ${f}`)
  }
  if (vanished.length) {
    // eslint-disable-next-line no-console
    console.error(`干净检出失败：${vanished.length} 个已跟踪源码在工作区缺失：`)
    for (const f of vanished) console.error(`  - ${f}`)
  }
  process.exit(1)
}

// eslint-disable-next-line no-console
console.log(`干净检出校验通过：${local.length} 个源码/配置全部纳入版本控制，${tracked.size} 个 tracked 文件无缺失`)
