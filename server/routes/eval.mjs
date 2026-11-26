/**
 * 评测与发布门禁端点。
 *
 * 全部为确定性计算：不联网、不调模型、无真实样本一律 NO_DATA。
 * 调用方只能**抬高**门槛（minSamples ↑、windowSize ↓），不能下调来把 1 条样本判成 PASSED。
 */
import {
  baselineManifest, diffEvalRuns, evaluateBaseline, evaluateIntegrity, evaluateOutcome,
  integrityManifest, outcomeManifest,
} from '../core/eval.mjs'
import {
  BASELINE_CONTRACT_VERSION, contract as baselineContract, validateBaselineImport,
} from '../core/baseline.mjs'
import { evaluateReleaseEvidence } from '../core/release-evidence.mjs'

export function evalRoutes(ctx) {
  const { json, readBody } = ctx.respond

  return [
    { method: 'GET', path: '/v1/eval/gates', handler: (req, res) => json(res, 200, baselineManifest()) },
    {
      method: 'GET',
      path: '/v1/eval/baseline/contract',
      handler: (req, res) => json(res, 200, {
        contractVersion: BASELINE_CONTRACT_VERSION,
        ...baselineContract,
        note: '本接口只返回契约，不返回任何标注样本。',
      }),
    },
    {
      method: 'POST',
      path: '/v1/eval/baseline/validate',
      handler: async (req, res) => {
        const body = await readBody(req)
        const result = validateBaselineImport(body)
        return json(res, result.ok ? 200 : 400, result)
      },
    },
    {
      method: 'POST',
      path: '/v1/eval/run',
      handler: async (req, res) => {
        const body = await readBody(req)
        return json(res, 200, evaluateBaseline(body.results ?? [], body.baselineVersion ?? 'unversioned'))
      },
    },
    {
      method: 'POST',
      path: '/v1/eval/diff',
      handler: async (req, res) => {
        const body = await readBody(req)
        const result = diffEvalRuns(body.prev, body.current)
        return json(res, result.status === 'INVALID_INPUT' ? 400 : 200, result)
      },
    },
    {
      method: 'GET',
      path: '/v1/eval/integrity/gates',
      handler: (req, res) => json(res, 200, integrityManifest()),
    },
    {
      method: 'GET',
      path: '/v1/eval/outcome/gates',
      handler: (req, res) => json(res, 200, outcomeManifest()),
    },
    {
      method: 'POST',
      path: '/v1/eval/integrity',
      handler: async (req, res) => {
        const body = await readBody(req)
        // 调用方只能抬高门槛，不能下调 minSamples 把 1 条样本判成 PASSED。
        const floor = integrityManifest().minSamples
        const requested = Number.isInteger(body.minSamples) ? body.minSamples : floor
        const result = evaluateIntegrity(body.records ?? body.evidence ?? [], {
          consistency: body.consistency,
          minSamples: Math.max(requested, floor),
        })
        return json(res, 200, result)
      },
    },
    {
      method: 'POST',
      path: '/v1/eval/outcome',
      handler: async (req, res) => {
        const body = await readBody(req)
        // minSamples 不得下调；windowSize 不得放大（把历史 sent 拉进来稀释退信率也是一种绕过）。
        const manifest = outcomeManifest()
        const requestedMin = Number.isInteger(body.minSamples) ? body.minSamples : manifest.minSamples
        const requestedWindow = Number.isInteger(body.windowSize) ? body.windowSize : manifest.windowSize
        const result = evaluateOutcome(body.events ?? [], {
          windowSize: Math.min(requestedWindow, manifest.windowSize),
          minSamples: Math.max(requestedMin, manifest.minSamples),
        })
        return json(res, 200, result)
      },
    },
    {
      // 只读发布状态。证据原文不回传，只给摘要与由真实判定生成的阻断项。
      method: 'GET',
      path: '/v1/release/status',
      handler: (req, res) => {
        const e = evaluateReleaseEvidence()
        return json(res, 200, {
          ok: true,
          contractVersion: e.contractVersion,
          releaseBlocked: e.releaseBlocked,
          releaseEligible: e.release.releaseEligible,
          internalPreviewReady: e.release.internalPreviewReady,
          externalValidated: e.release.externalValidated,
          evidenceReady: e.evidenceReady,
          accuracyClaim: false,
          integrity: { status: e.integrity.status, sampleSize: e.integrity.sampleSize, minSamples: e.integrity.minSamples },
          outcome: { status: e.outcome.status, sampleSize: e.outcome.sampleSize, minSamples: e.outcome.minSamples },
          consistency: e.consistency
            ? { status: e.consistency.status, rate: e.consistency.rate }
            : { status: 'NO_DATA', rate: null },
          snapshot: {
            configuredCount: e.snapshot.configuredCount,
            lockedCount: e.snapshot.lockedCount,
            ok: e.snapshot.ok,
          },
          compliance: {
            completed: e.compliance.completed, total: e.compliance.total,
            pending: e.compliance.pending,
          },
          filesPresent: e.filesPresent,
          validation: { ok: e.validation.ok, errorCount: e.validation.errors.length },
          blockers: e.blockers,
          note: '只回传摘要，不回传证据原文；代码无法证明证据真实性，真实性由 attestation 签署人负责。',
        })
      },
    },
  ]
}
