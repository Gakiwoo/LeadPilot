/**
 * 发布证据通道自检 / 查看 CLI · v0.9.0 补遗（B4）
 *
 *   npm run evidence:check                     查看当前证据目录的真实判定
 *   npm run evidence:check -- --dir <path>    指定证据目录
 *   npm run evidence:check -- --self-test     跑反例，证明校验器真的会拒绝伪造证据
 *   npm run evidence:check -- --strict        要求内测资格证据达标，否则退出码 1
 *
 * 纪律：本脚本不生成、不补全、不推断任何证据样本；自检只构造「应当被拒绝」的反例
 * 与空目录，绝不构造一份能通过门禁的假样本并把它留在磁盘上。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import {
  evaluateReleaseEvidence, validateIntegrityEvidence, validateOutcomeEvidence,
  validateConsistencyEvidence, snapshotStatus, complianceStatus, readCompliance,
  defaultEvidenceDir, EVIDENCE_CONTRACT_VERSION,
} from '../server/release-evidence.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const argOf = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function selfTest() {
  const ok = (name, fn) => {
    try { fn(); console.log(`PASS  ${name}`); return true } catch (err) {
      console.error(`FAIL  ${name}\n      ${String(err?.message ?? err)}`)
      return false
    }
  }
  let passed = 0, total = 0
  const t = (name, fn) => { total++; if (ok(name, fn)) passed++ }

  const attestation = {
    attestedReal: true, signedBy: '自检夹具', signedAt: '2026-11-12T00:00:00.000Z',
    statement: '本人确认本文件内证据来自真实运行与真实发送结果，非合成、非推测。',
  }
  const record = (i = 0) => ({
    sourceUrl: `https://evidence.example.com/about/${i}`,
    capturedAt: '2026-11-12',
    sourceOrigin: 'user_directed_fetch',
    quote: `we import fittings ${i}`,
    sourceText: `about: we import fittings ${i} from asia`,
    provenance: { matched: 1, total: 1 },
    rules: { passed: 2, total: 2 },
    schemaPass: true,
    refused: false,
  })
  const integrity = (over = {}) => ({ attestation, records: [record(0)], ...over })
  const outcome = (over = {}) => ({
    attestation,
    events: [{ event: 'sent', refId: 'evt-1', occurredAt: '2026-11-12', source: 'smtp-log' }],
    ...over,
  })
  const consistency = (over = {}) => ({
    attestation, prevRun: [{ a: 1 }], currentRun: [{ a: 1 }], ...over,
  })

  t('缺人工签署的证据被拒（不接受无主样本）', () => {
    const r = validateIntegrityEvidence({ records: [record(0)] })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => e.includes('attestation')))
  })
  t('带 synthetic 标记的证据被拒', () => {
    const r = validateIntegrityEvidence(integrity({ synthetic: true }))
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => e.includes('合成')))
  })
  t('quote 不在 sourceText 的伪造引用被拒', () => {
    const r = validateIntegrityEvidence(integrity({ records: [{ ...record(0), quote: 'not in source' }] }))
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => e.includes('逐字核验')))
  })
  t('复制同一条证据凑 minSamples 被拒（去重）', () => {
    const r = validateIntegrityEvidence(integrity({ records: [record(0), record(0)] }))
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => e.includes('重复')))
  })
  t('空 records 被拒（应保持 NO_DATA，而不是交空文件）', () => {
    assert.equal(validateIntegrityEvidence(integrity({ records: [] })).ok, false)
  })
  t('outcome 重复 refId 被拒', () => {
    const e = outcome().events[0]
    const r = validateOutcomeEvidence(outcome({ events: [e, e] }))
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((x) => x.includes('refId 重复')))
  })
  t('outcome 非法事件类型被拒', () => {
    const r = validateOutcomeEvidence(outcome({ events: [{ ...outcome().events[0], event: 'opened' }] }))
    assert.equal(r.ok, false)
  })
  t('consistency 两次运行长度不等被拒', () => {
    const r = validateConsistencyEvidence(consistency({ currentRun: [{ a: 1 }, { b: 2 }] }))
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => e.includes('数量不同')))
  })
  t('形状合法 + 签署齐备的证据能被校验器接受（链路可通）', () => {
    assert.equal(validateIntegrityEvidence(integrity()).ok, true)
    assert.equal(validateOutcomeEvidence(outcome()).ok, true)
    assert.equal(validateConsistencyEvidence(consistency()).ok, true)
  })

  // 空目录：必须真实走到 NO_DATA，而不是把硬编码常量打印出来
  const tmpRoot = join(ROOT, '.tmp')
  mkdirSync(tmpRoot, { recursive: true })
  const emptyDir = mkdtempSync(join(tmpRoot, 'evidence-empty-'))
  try {
    const env = {}
    const r = evaluateReleaseEvidence({ dir: emptyDir, env })
    t('空证据目录 → integrity / outcome 均为 NO_DATA，且 blockers 由真实判定生成', () => {
      assert.equal(r.integrity.status, 'NO_DATA')
      assert.equal(r.outcome.status, 'NO_DATA')
      assert.equal(r.release.internalPreviewReady, false)
      assert.equal(r.release.externalValidated, false)
      assert.ok(r.blockers.length >= 5)
      assert.ok(r.blockers.some((b) => b.includes('NO_DATA')))
    })
    t('空证据目录 → releaseEligible 恒 false，accuracyClaim 恒 false，证据未就绪', () => {
      assert.equal(r.release.releaseEligible, false)
      assert.equal(r.release.accuracyClaim, false)
      assert.equal(r.accuracyClaim, false)
      assert.equal(r.evidenceReady, false)
      assert.equal(r.releaseBlocked, true)
    })
  } finally {
    rmSync(emptyDir, { recursive: true, force: true })
  }

  t('provider 快照：未注入 / -latest 都不算锁定，具体版本才算', () => {
    const none = snapshotStatus({})
    const latest = snapshotStatus({ DEEPSEEK_API_KEY: 'k', LEADPILOT_MODEL_VERSION_DEEPSEEK_PRO: 'deepseek-latest' })
    const pinned = snapshotStatus({ DEEPSEEK_API_KEY: 'k', LEADPILOT_MODEL_VERSION_DEEPSEEK_PRO: 'deepseek-chat-2026-10-15' })
    assert.equal(none.ok, false)
    assert.equal(latest.ok, false)
    assert.equal(pinned.ok, true)
    assert.equal(pinned.lockedCount, 1)
  })
  t('合规清单：只改 status 不填证据/签署人/日期，仍不算完成', () => {
    const base = readCompliance()
    assert.equal(complianceStatus(base).ok, false)
    const forged = {
      ...base,
      items: base.items.map((i) => ({ ...i, status: 'completed' })),
    }
    assert.equal(complianceStatus(forged).ok, false)
  })

  console.log(`\n${passed}/${total} evidence self-checks passed · ${EVIDENCE_CONTRACT_VERSION}`)
  if (passed !== total) {
    console.error('\nSELF-TEST FAILED：证据校验器没有拦住伪造样本。')
    process.exit(1)
  }
  console.log('SELF-TEST PASSED：伪造证据会被拒绝；门禁无法证明证据真实性，只保证「无签署/无来源/不自洽/凑数样本进不来」。')
}

function report(dir, strict) {
  const r = evaluateReleaseEvidence(dir ? { dir } : {})
  console.log(`\n发布证据判定 · ${r.contractVersion}`)
  console.log(`  证据目录      ${r.evidenceDir}`)
  console.log(`  已提供文件    ${r.filesPresent.length ? r.filesPresent.join(', ') : '（无）'}`)
  console.log(`  缺失文件      ${r.filesMissing.join(', ')}`)
  console.log(`  校验结果      ${r.validation.ok ? 'PASS' : `FAIL（${r.validation.errors.length} 条）`}`)
  for (const e of r.validation.errors.slice(0, 12)) console.log(`    - ${e}`)
  console.log(`  样本数量      integrity=${r.sampleCounts.integrityRecords} · outcome=${r.sampleCounts.outcomeEvents} · 抓取来源=${r.sampleCounts.fetchedRecords}`)
  console.log(`  integrity     ${r.integrity.status}（${r.integrity.sampleSize}/${r.integrity.minSamples}）`)
  console.log(`  outcome       ${r.outcome.status}（${r.outcome.sampleSize}/${r.outcome.minSamples}）`)
  console.log(`  consistency   ${r.consistency ? `${r.consistency.status}（${r.consistency.rate ?? '未测量'}）` : 'NO_DATA（缺两次真实运行结果）'}`)
  console.log(`  provider 快照 已配置 ${r.snapshot.configuredCount} 家 Key / 锁定 ${r.snapshot.lockedCount} 家`)
  console.log(`  外部合规      ${r.compliance.completed}/${r.compliance.total} 完成${r.compliance.pending.length ? `（待办：${r.compliance.pending.join('、')}）` : ''}`)
  console.log(`  发布状态      releaseBlocked=${r.releaseBlocked} · releaseEligible=${r.release.releaseEligible} · accuracyClaim=${r.release.accuracyClaim}`)
  console.log(`                internalPreviewReady=${r.release.internalPreviewReady} · externalValidated=${r.release.externalValidated} · evidenceReady=${r.evidenceReady}`)
  console.log('\n  阻断项（由真实判定生成，不是硬编码）：')
  for (const b of r.blockers) console.log(`    BLOCKED  ${b}`)
  console.log(`\n  说明          ${r.note}`)
  if (strict && !r.evidenceReady) {
    console.error('\nEVIDENCE FAILED：--strict 要求内测资格证据达标，当前未达标。')
    process.exit(1)
  }
  console.log(r.evidenceReady
    ? '\nEVIDENCE OK：内测资格证据达标；正式发布仍被 releaseEligible=false 与外部合规项卡住。'
    : '\nEVIDENCE PENDING：证据未就绪；这是「尚未达标」，不是自检失败。')
}

if (args.includes('--self-test')) selfTest()
else report(argOf('--dir'), args.includes('--strict'))
