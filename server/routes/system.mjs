/**
 * 系统级端点：探活聚合 / 点数账本只读。
 *
 * /health 是唯一免鉴权端点，因此这里只回传「状态摘要」，不回传任何凭据、
 * 不下发证据原文，也不把 memory 持久化说成已持久化。
 */
import { PKG_VERSION } from '../config.mjs'
import { protocol } from '../core/protocol.mjs'
import { MAX_CONCURRENT } from '../services/orchestrator.mjs'
import {
  integrityManifest, outcomeManifest,
  INTEGRITY_GATE_VERSION, OUTCOME_GATE_VERSION, RELEASE_POLICY_VERSION,
} from '../core/eval.mjs'
import { contract as baselineContract, BASELINE_CONTRACT_VERSION, checkLabeledBaseline } from '../core/baseline.mjs'
import { T0_RULES_VERSION } from '../core/t0.mjs'
import { BATCH_VERSION } from '../services/batch.mjs'
import { evaluateReleaseEvidence } from '../core/release-evidence.mjs'

export function systemRoutes(ctx) {
  const { json } = ctx.respond

  return [
    {
      method: 'GET',
      path: '/health',
      handler: (req, res) => {
        const { gateway, orchestrator, store, ledger, dataSources, fetcher, batch, security } = ctx
        return json(res, 200, {
          ok: true, service: 'leadpilot-cloud', version: PKG_VERSION,
          gateway: gateway.health(),
          orchestrator: (() => {
            const list = orchestrator.listTasks()
            return {
              tasks: list.length,
              running: list.filter((t) => t.status === 'running').length,
              queued: list.filter((t) => t.status === 'queued').length,
              maxConcurrent: orchestrator.maxConcurrent ?? MAX_CONCURRENT,
              queueMode: 'fifo-auto-dequeue',
            }
          })(),
          protocol: { schemaVersion: protocol.schemaVersion, promptVersion: protocol.promptVersion },
          security: security.securityInfo(),
          persistence: {
            mode: store.mode,
            durable: store.mode !== 'memory',
            // recoveredTasks 只报「本次启动真正从活跃态降级恢复」的任务，
            // 不再把全部历史任务都算成恢复；restoredTasks 单独如实报载入总数。
            recoveredTasks: orchestrator.recoveredActiveIds?.length ?? 0,
            restoredTasks: orchestrator.recoveredIds?.length ?? 0,
          },
          points: ledger.health(),
          billing: {
            ledgerVersion: ledger.version,
            mode: 'unified-ledger-v1',
            gatewayVersion: protocol.billing.gatewayBilling.version,
            scope: protocol.billing.ledger.scope,
            ledgerConsumers: protocol.billing.ledger.ledgerConsumers,
            auditOnlyConsumers: protocol.billing.ledger.auditOnlyConsumers,
            reservePoints: protocol.billing.gatewayBilling.reservePoints,
            chargeOn: protocol.billing.gatewayBilling.chargeOn,
            releaseOn: protocol.billing.gatewayBilling.releaseOn,
            noChargeOn: protocol.billing.gatewayBilling.noChargeOn,
            note: '云端任务与网关真实调用共用一本账：有可用 provider 才预扣，内容校验通过才结算，失败/降级/缓存命中一律不扣点并全额释放。未注入账本的独立网关仍只产出审计估值。',
          },
          baseline: {
            contractVersion: BASELINE_CONTRACT_VERSION,
            contractStatus: baselineContract.status,
            importStatus: checkLabeledBaseline().status,
            requiredSize: baselineContract.baselineSize,
            diffEndpoint: protocol.evalDiff.endpoint,
            diffVersion: protocol.evalDiff.version,
            labelsRequired: false,
            accuracyClaim: false,
            releaseEligible: false,
            note: 'v0.8.0 决策：不再要求 385 家人工标注基准集，本契约降级为 legacy；当前评测口径见 evalGates。',
          },
          evalGates: (() => {
            // 发布状态读真实证据，不用 releaseStatus() 的无参默认值假装恒 false。
            const evidence = evaluateReleaseEvidence()
            const release = evidence.release
            return {
              mode: protocol.evalGates.integrity.mode,
              evidence: {
                contractVersion: evidence.contractVersion,
                filesPresent: evidence.filesPresent,
                validationOk: evidence.validation.ok,
                internalPreviewReady: release.internalPreviewReady,
                externalValidated: release.externalValidated,
                snapshotLocked: evidence.snapshot.lockedCount,
                complianceCompleted: evidence.compliance.completed,
                blockerCount: evidence.blockers.length,
                endpoint: 'GET /v1/release/status',
              },
              integrityVersion: INTEGRITY_GATE_VERSION,
              outcomeVersion: OUTCOME_GATE_VERSION,
              policyVersion: RELEASE_POLICY_VERSION,
              labelsRequired: false,
              accuracyClaim: false,
              internalPreviewReady: release.internalPreviewReady,
              externalValidated: release.externalValidated,
              releaseEligible: release.releaseEligible,
              remainingExternalBlockers: release.remainingExternalBlockers,
              droppedByDecision: release.droppedByDecision,
              endpoints: {
                integrity: integrityManifest().endpoint,
                outcome: outcomeManifest().endpoint,
                manifest: 'GET /v1/eval/gates',
              },
            }
          })(),
          t0: {
            extractor: 'rules', rulesVersion: T0_RULES_VERSION, sourceMode: 'provided-text',
            judgeFactChain: {
              enabled: protocol.judgeFactChain.enabled,
              onConflict: protocol.judgeFactChain.onConflict,
              note: '调用方提供可核验 sources 时，T0 规则事实进入 judge Prompt；冲突由代码保守裁决，未命中维度不补零。',
            },
          },
          dataSources: (() => {
            const d = dataSources.health()
            return { mode: d.mode, total: d.total, configured: d.configured, readyCount: d.readyCount }
          })(),
          fetch: fetcher.health(),
          batch: (() => {
            const b = batch.state()
            return {
              version: BATCH_VERSION, positioning: b.positioning, targetUser: b.targetUser,
              stage: b.stage, companies: b.companies, judged: b.judged,
              exportedToday: b.exportedToday, circuitOpen: b.circuitOpen,
              bounce: b.bounce, releaseEligible: false,
              generateDrafts: b.generateDrafts,
              userDirectedFetch: b.userDirectedFetch,
              note: '定位仍为自动获客；批量导入是批量 SDR 的线索投喂通道，origin=user_imported，导入≠采集；官网原文由用户指定 URL 抓取（user_directed_fetch），抓取≠采集。外部依赖重分类为发布门禁，releaseEligible 恒 false。',
            }
          })(),
          demo: gateway.health().mode === 'unconfigured-demo',
        })
      },
    },
    {
      method: 'GET',
      path: '/v1/points',
      handler: (req, res, url) => {
        const account = url.searchParams.get('account') ?? undefined
        const refId = url.searchParams.get('refId') ?? undefined
        // 纯读。peek 不为任意 account 参数开户、不写 2000 点流水，避免 GET 无限膨胀存储。
        const state = ctx.ledger.peek(account)
        const entries = refId ? ctx.ledger.entries(refId, 50) : ctx.ledger.allEntries(50)
        return json(res, 200, {
          ...state,
          entries,
          scope: protocol.billing.ledger.scope,
          ledgerConsumers: protocol.billing.ledger.ledgerConsumers,
          note: '纯读接口：不为不存在的账户开户、不写任何流水（exists:false 即零值快照）。账本覆盖云端任务与网关真实调用的预扣/结算/释放；未注入账本的独立网关才只产出审计估值。',
        })
      },
    },
  ]
}
