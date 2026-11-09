/**
 * legacy 385 家基准集导入校验 CLI · PRD 9.5 / ADR-020（v0.8.0 降级为 legacy 通道）
 *
 * 用法：
 *   node scripts/validate-baseline.mjs <path-to-samples.json|jsonl|csv>
 *   node scripts/validate-baseline.mjs --self-test
 *
 * 纪律：本脚本不生成、不补全、不推断任何标注，只校验。
 * v0.8.0 决策：不做 385 人工标注集，本通道不参与当前内测/发布判定；
 * 当前评测口径为 integrity + outcome（见 server/eval.mjs、POST /v1/eval/integrity|outcome）。
 * 校验通过只代表「格式与构成符合契约」，不代表评测通过，更不代表可以发布。
 */
import { readFileSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBaselineText, validateBaselineImport } from '../server/baseline.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const args = process.argv.slice(2)

function report(result, label) {
  console.log(`\n基准集导入校验 · ${label}`)
  console.log(`  契约版本      ${result.contractVersion}`)
  console.log(`  样本数        ${result.sampleCount} / ${result.requiredSize}`)
  console.log(`  结果          ${result.status}${result.code ? ` (${result.code})` : ''}`)
  console.log(`  错误数        ${result.errorCount}`)
  console.log(`  可发布        ${result.releaseEligible ? 'YES' : 'NO'}（导入校验通过 ≠ 评测通过）`)
  if (result.warnings.length) {
    console.log('  警告：')
    for (const w of result.warnings) console.log(`    - ${w}`)
  }
  if (result.errors.length) {
    console.log(`  错误（最多展示 ${result.errors.length} 条）：`)
    for (const e of result.errors) console.log(`    - ${e}`)
  }
  for (const [id, c] of Object.entries(result.composition ?? {})) {
    console.log(`  构成 ${id}: ${c.passed ? 'PASS' : 'FAIL'}`)
  }
  console.log(`  说明          ${result.note}`)
}

function selfTest() {
  const fixture = JSON.parse(readFileSync(resolve(here, 'fixtures/invalid-baseline-sample.json'), 'utf8'))
  const invalid = validateBaselineImport(fixture)
  const empty = validateBaselineImport({ samples: [] })
  const ok = !invalid.ok && invalid.code === 'E4004' && invalid.errorCount > 0 && !empty.ok
  report(invalid, '自检反例（应当被拒绝）')
  if (!ok) {
    console.error('\nSELF-TEST FAILED：校验器没有拒绝非法反例或没有拒绝空基准集。')
    process.exitCode = 1
  } else {
    console.log('\nSELF-TEST PASSED：校验器确实会拒绝非法标注与空基准集，不编造通过。')
  }
}

if (!args.length || args[0] === '--self-test') {
  selfTest()
} else {
  const file = resolve(args[0])
  let result
  try {
    const samples = parseBaselineText(readFileSync(file, 'utf8'), file)
    result = validateBaselineImport(samples)
  } catch (err) {
    console.error(`读取或解析失败：${String(err?.message ?? err)}`)
    process.exit(1)
  }
  report(result, basename(file))
  if (!result.ok) {
    console.error('\n导入校验未通过：该文件不得用于评测。')
    process.exit(1)
  }
  console.log('\n导入格式校验通过。下一步仍需配对模型预测并调用 /v1/eval/run 做真实评测。')
}
