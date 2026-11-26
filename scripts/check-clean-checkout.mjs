/**
 * 干净检出全量校验 · B3-3 / B6
 *
 * 旧做法：CI 里硬编码 31 个「关键源码」路径逐个 git ls-files --error-unmatch。
 * 问题：tracked 源码共 50+ 项，漏掉的 21 个文件在本地全绿、CI 缺模块时才会暴露，
 * 而且清单本身永远追不上新增文件（.gitignore 误排除 src/data/ 就是这么漏的）。
 *
 * 新做法：枚举 src / server / shared / scripts / .github 下所有源码与配置，
 * 加上仓库根级配置，逐个确认「被 git 跟踪」+「工作区真实存在」；清单由文件系统生成。
 *
 * B6 · P1-2：跳过目录必须按「仓库根相对路径」判定，不能按 basename —— 旧写法
 * `SKIP_DIRS.has(name)` 会连 src/data/ 一起排除，导致脚本报「全部纳入」却漏了 2 个源文件，
 * 与 ADR-008 的 .gitignore 假保证同款。根级配置也必须纳入 vanished 对账。
 *
 * 退出码：0 全量通过；1 有未跟踪或缺失文件（CI 必须红）。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const SOURCE_DIRS = ['src', 'server', 'shared', 'scripts', 'tests', '.github']
export const SOURCE_EXT = /\.(?:ts|tsx|mjs|js|cjs|json|sh|yml|yaml|css|html)$/
/** 只跳过「仓库根下」的这些路径；src/data/ 之类同名子目录必须照常枚举 */
const SKIP_ROOTS = new Set(['node_modules', 'dist', 'data', 'coverage', '.workbuddy'])
const isSkipped = (rel) => SKIP_ROOTS.has(String(rel).split('/')[0])

function walk(absDir, relDir) {
  const out = []
  for (const name of readdirSync(absDir)) {
    const rel = `${relDir}/${name}`
    if (isSkipped(rel)) continue
    const full = join(absDir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full, rel))
    else if (SOURCE_EXT.test(name)) out.push(rel)
  }
  return out
}

/** 枚举源码目录 + 根级配置；返回仓库根相对路径（已排序去重） */
export function collectLocalSources(root = ROOT) {
  const out = []
  for (const dir of SOURCE_DIRS) {
    const abs = join(root, dir)
    if (existsSync(abs)) out.push(...walk(abs, dir))
  }
  for (const name of readdirSync(root)) {
    if (SKIP_ROOTS.has(name)) continue
    const full = join(root, name)
    if (statSync(full).isFile() && SOURCE_EXT.test(name)) out.push(name)
  }
  return [...new Set(out)].sort()
}

/**
 * 纯函数对账：既查「本地有但未被跟踪」，也查「已跟踪但干净检出里不存在」。
 * fileExists 可注入，便于行为级反例模拟「干净检出缺根配置」而不真的删文件。
 */
export function auditCleanCheckout({
  trackedList = [],
  localList = [],
  fileExists = (f) => existsSync(join(ROOT, f)),
} = {}) {
  const tracked = new Set(trackedList)
  const local = [...new Set(localList)].sort()
  const untracked = local.filter((f) => !tracked.has(f))
  const vanished = [...tracked]
    .filter((f) => SOURCE_EXT.test(f) && !isSkipped(f))
    .filter((f) => !fileExists(f))
    .sort()
  return {
    ok: untracked.length === 0 && vanished.length === 0,
    untracked,
    vanished,
    localCount: local.length,
    trackedCount: tracked.size,
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  const trackedList = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean)
  const result = auditCleanCheckout({ trackedList, localList: collectLocalSources(ROOT) })
  if (!result.ok) {
    if (result.untracked.length) {
      // eslint-disable-next-line no-console
      console.error(`干净检出失败：${result.untracked.length} 个源码/配置未被 git 跟踪（或已被 .gitignore 误排除）：`)
      for (const f of result.untracked) console.error(`  - ${f}`)
    }
    if (result.vanished.length) {
      // eslint-disable-next-line no-console
      console.error(`干净检出失败：${result.vanished.length} 个已跟踪源码在工作区缺失：`)
      for (const f of result.vanished) console.error(`  - ${f}`)
    }
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log(`干净检出校验通过：${result.localCount} 个源码/配置全部纳入版本控制，${result.trackedCount} 个 tracked 文件无缺失`)
}
