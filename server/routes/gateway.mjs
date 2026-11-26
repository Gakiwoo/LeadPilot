/**
 * LLM 网关端点：健康 / 审计诊断 / 研判 / T0 规则抽取 / 写信。
 *
 * 计费拒绝（E4001 / E4005）用 402 / 409 表达，避免前端误判为可重试的模型故障；
 * 需要显式同意（EU T2）用 403；其余失败一律 503 显式降级。
 */
import { protocol, assertNoPii } from '../core/protocol.mjs'
import { extractFacts, T0_RULES_VERSION } from '../core/t0.mjs'
import { BASELINE_CONTRACT_VERSION, contract as baselineContract, checkLabeledBaseline } from '../core/baseline.mjs'

/** 统一的失败状态码映射：识别「计费拒绝 / 需同意」与「服务降级」 */
function failureStatus(result) {
  if (result.ok) return 200
  if (result.needsConsent) return 403
  if (result.code === 'E4001') return 402
  if (result.code === 'E4005') return 409
  return 503
}

export function gatewayRoutes(ctx) {
  const { json, fail, readBody } = ctx.respond

  return [
    {
      method: 'GET',
      path: '/v1/gateway/health',
      handler: (req, res) => {
        const { gateway, ledger, dataSources, fetcher, security } = ctx
        return json(res, 200, {
          ...gateway.health(), security: security.securityInfo(),
          points: ledger.health(),
          billing: {
            mode: 'unified-ledger-v1',
            version: protocol.billing.gatewayBilling.version,
            scope: protocol.billing.ledger.scope,
            ledgerConsumers: protocol.billing.ledger.ledgerConsumers,
            auditOnlyConsumers: protocol.billing.ledger.auditOnlyConsumers,
            reservePoints: protocol.billing.gatewayBilling.reservePoints,
            releaseOn: protocol.billing.gatewayBilling.releaseOn,
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
          t0: {
            extractor: 'rules', rulesVersion: T0_RULES_VERSION, sourceMode: 'provided-text',
            judgeFactChain: { enabled: protocol.judgeFactChain.enabled, onConflict: protocol.judgeFactChain.onConflict },
          },
          dataSources: (() => {
            const d = dataSources.health()
            return { mode: d.mode, total: d.total, configured: d.configured, readyCount: d.readyCount }
          })(),
          fetch: fetcher.health(),
        })
      },
    },
    {
      method: 'GET',
      path: '/v1/gateway/audit',
      handler: (req, res) => json(res, 200, {
        entries: ctx.gateway.getAudit(),
        circuit: ctx.gateway.getCircuitState(),
        cache: ctx.gateway.getCacheStats(),
      }),
    },
    {
      method: 'POST',
      path: '/v1/judge',
      handler: async (req, res) => {
        const body = await readBody(req)
        const pii = assertNoPii({ facts: body.facts ?? {}, profile: body.profile ?? {} })
        if (!pii.ok) {
          return fail(res, 400, 'E6004', '请求体含禁止字段',
            `数据最小化要求剔除个人信息，命中：${pii.violations.join('、')}`,
            '移除邮箱/电话/联系人姓名/邮件正文后重试')
        }
        const result = await ctx.gateway.judge(body)
        return json(res, failureStatus(result), { ok: !!result.ok, ...result })
      },
    },
    {
      method: 'POST',
      path: '/v1/t0/extract',
      handler: async (req, res) => {
        const body = await readBody(req)
        const result = extractFacts(body)
        if (!result.ok) {
          return fail(res, 400, 'E6004', 'T0 抽取输入不合法', result.errors.join('；'),
            '补全 sources / url / fetched_at，并剔除个人信息后重试')
        }
        return json(res, 200, result)
      },
    },
    {
      method: 'POST',
      path: '/v1/email/generate',
      handler: async (req, res) => {
        const body = await readBody(req)
        const pii = assertNoPii({
          facts: {
            anchor: body.anchor, product: body.product, advantages: body.advantages,
            purpose: body.purpose, tone: body.tone, language: body.language,
          },
        })
        if (!pii.ok) {
          return fail(res, 400, 'E6004', '写信请求体含禁止字段',
            `数据最小化要求剔除个人信息，命中：${pii.violations.join('、')}`,
            '移除收件人邮箱/联系人姓名/邮件正文后重试')
        }
        const result = await ctx.gateway.writeEmail(body)
        return json(res, failureStatus(result), { ok: !!result.ok, ...result })
      },
    },
  ]
}
