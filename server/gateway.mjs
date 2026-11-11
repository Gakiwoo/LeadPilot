/**
 * PRD F0 / 6.7 / 9.1 · 统一 LLM 网关（服务端真实实现骨架）
 *
 * 真实部分：路由判定、降级链、超时/限流重试、熔断、schema 与证据校验、
 *          结果缓存、点数折算、调用审计、数据出境策略、PII 硬性剔除。
 * 未接部分：没有任何 API Key 时不发起任何外部请求，明确返回 E6005 降级，
 *          绝不伪造模型判断。配置 Key 后即可走真实 provider 调用。
 *
 * v0.6.0 计费闭环：注入 ledger 后，judge / write_email 在确认存在可用 provider 链
 * 之后先 reserve；只有内容通过校验的成功响应才 settle，其余一律 release 全额退还。
 * 未注入 ledger 的独立网关保持 audit-only，响应如实标 billing.scope='audit-only'。
 */
import {
  protocol, validateSchema, verifyEvidence, assertNoPii, assertNoPiiInMessages, pointCost, billingPoints,
  cacheKey, buildJudgeMessages, toClientJudgement, sanitizeContext,
  buildEmailMessages, validateEmailDraft,
} from './protocol.mjs'
import { extractFacts, reconcileWithT0 } from './t0.mjs'

const EEA_UK = new Set(['德国', '法国', '荷兰', '英国', '西班牙', '意大利', '波兰', '挪威', '瑞典', '丹麦', '比利时', '奥地利', '爱尔兰'])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** PRD F0-2：路由判定写在网关里，不让业务层决定 */
export function route(task = {}) {
  const r = protocol.routing
  if (task.t0AllFailed) return 'T1'
  if (typeof task.confidence === 'number' && task.confidence < protocol.rules.confidenceReviewThreshold) return 'T2'
  if (task.conflict) return 'T2'
  if (task.depth === 4 && task.valueTier === 'high') return 'T2'
  if (r.t0Tasks.includes(task.type)) return 'T0'
  if (r.t1Tasks.includes(task.type)) return 'T1'
  return 'T0'
}

export function regionDecision(country, tier, { policy = 'domestic_first', allowOverseas = false } = {}) {
  const isEea = EEA_UK.has(country)
  if (isEea && tier !== 'T2') return { group: 'domestic', needsConsent: false, reason: 'EU/EEA/UK 客户数据 T0/T1 强制境内组（PRD 11.4.2）' }
  if (isEea && tier === 'T2') {
    return allowOverseas
      ? { group: 'overseas', needsConsent: false, reason: '用户已显式同意境外 T2 处理' }
      : { group: 'overseas', needsConsent: true, reason: 'T2 境外模型需显式知情同意，默认拒绝' }
  }
  if (policy === 'domestic_first' && tier !== 'T2') return { group: 'domestic', needsConsent: false, reason: '默认境内组' }
  return { group: 'overseas', needsConsent: false, reason: '按质量最优路由（非 EU 客户）' }
}

export function createGateway(opts = {}) {
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const nowFn = opts.now ?? (() => Date.now())
  const sleepFn = opts.sleep ?? sleep
  const store = opts.store ?? null
  const ledger = opts.ledger ?? null // 注入后才产生真实账本扣点；否则保持审计估值
  const billingCfg = protocol.billing.gatewayBilling
  const memoryCache = new Map()
  const memoryAudit = []
  // 传入持久化存储后，30 天结果缓存与调用审计跨进程可恢复；mode 在 health 中如实暴露
  const cache = store ? {
    get(key) { return store.cacheGet(key) },
    set(key, value) { store.cacheSet(key, value, protocol.rules.cacheTtlDays * 86400000) },
    get size() { return store.cacheStats().entries },
  } : memoryCache
  const audit = memoryAudit
  const failures = new Map() // providerKey -> number[] (timestamps)
  const circuit = new Map()  // providerKey -> openUntil

  /** 快照 ID 只能由环境变量注入；基线不预置任何猜测值，-latest 一律视为未锁定 */
  const versionEnvKey = (key) => `LEADPILOT_MODEL_VERSION_${key.toUpperCase().replace(/-/g, '_')}`
  const providers = protocol.providers.map((p) => {
    const raw = String(env[versionEnvKey(p.key)] ?? '').trim()
    const pinned = raw.length > 0 && !/latest/i.test(raw)
    return {
      ...p,
      configured: Boolean(env[p.envKey]),
      apiKey: env[p.envKey] ?? '',
      modelVersion: pinned ? raw : null,
      snapshotLocked: pinned,
    }
  })

  function isOpen(p) {
    const until = circuit.get(p.key) ?? 0
    if (until > nowFn()) return true
    if (until) circuit.delete(p.key)
    return false
  }

  function recordFailure(p) {
    const cfg = protocol.downgrade.circuitBreaker
    const list = [...(failures.get(p.key) ?? []).filter((t) => nowFn() - t < cfg.windowMs), nowFn()]
    failures.set(p.key, list)
    if (list.length >= cfg.failures) circuit.set(p.key, nowFn() + cfg.openMs)
    return list.length
  }

  function recordSuccess(p) { failures.delete(p.key) }

  function appendAudit(entry) {
    // 调用审计只记元数据，绝不记录 prompt / 原文 / 客户邮箱（PRD 11.4.4 / 8.3）
    const full = { at: new Date(nowFn()).toISOString(), ...entry }
    memoryAudit.push(full)
    if (memoryAudit.length > 500) memoryAudit.shift()
    if (store) {
      try { store.auditAppend(full) } catch (err) {
        // 审计落盘失败必须可见，不能静默当作成功
        // eslint-disable-next-line no-console
        console.warn(`[LeadPilot] 调用审计持久化失败：${String(err?.message ?? err)}`)
      }
    }
  }

  function readAudit() {
    return store ? store.auditList(500) : [...memoryAudit]
  }

  /* ─────────────── v0.6.0 网关调用计费（reserve → settle / release） ─────────────── */

  /** 无账本 / 命中缓存 / 校验拒绝 / 未发起 provider 调用时，明确标成「未扣点」 */
  function billingNone(reason) {
    return {
      charged: false,
      scope: ledger ? 'ledger-v2' : 'audit-only',
      reason,
      note: ledger
        ? '本次未产生账本扣点：未发起可用 provider 调用、命中缓存或被校验/降级拦截'
        : '未注入点数账本：points 仍为 token 折算审计估值，不代表已扣点',
    }
  }

  /** 仅在 chainFor 确认存在可用 provider 之后调用；预扣不成功就不发起任何外部请求 */
  function reserveBilling(taskType, tier, input = {}) {
    if (!ledger) return { active: false }
    const amount = billingCfg.reservePoints[tier] ?? billingCfg.reservePoints.T1
    const suffix = String(input.requestId ?? `${nowFn()}_${Math.random().toString(36).slice(2, 10)}`)
    const refId = `gw:${taskType}:${suffix}`
    // 同一 requestId 只允许一次计费尝试：已结算/已释放的键必须显式拒绝，
    // 否则 reserve 的幂等命中会让第二次 provider 调用继续发生，并再次宣称「已扣点」。
    const prior = ledger.entries(refId, 20)
    if (prior.some((e) => e.kind === 'settle' || e.kind === 'release')) {
      return {
        active: false, failed: true, refId, code: 'E4005',
        reason: `请求 ${refId} 已完成计费结算或释放，拒绝重复调用；重试请使用新的 requestId`,
        available: ledger.state().available,
      }
    }
    const r = ledger.reserve({ refId, amount, reason: `${taskType} 真实调用预扣（${tier}）` })
    if (!r.ok) {
      return {
        active: false, failed: true, refId,
        code: /已结算|已释放/.test(String(r.reason ?? '')) ? 'E4005' : (r.code ?? 'E4001'),
        reason: r.reason, available: r.available ?? null,
      }
    }
    // 幂等命中说明同 requestId 已有预扣（并发重复请求或上次进程崩溃遗留）：
    // 不再发起第二次外部调用；若预扣已明显超时，顺手回收，避免 held 点数永久冻结。
    if (r.idempotent) {
      const heldAt = Number(prior.find((e) => e.kind === 'reserve')?.at ?? 0)
      const stale = heldAt > 0 && nowFn() - heldAt > protocol.downgrade.timeoutMs * 20
      const recovered = stale
        ? ledger.release({ refId, reason: '清理超时未完成调用的陈旧预扣（v0.6.0 自动回收）' })
        : null
      return {
        active: false, failed: true, refId, code: 'E4005',
        reason: `请求 ${refId} 已有活跃预扣记录，拒绝并发/重复调用${recovered?.ok ? '；陈旧预扣已自动释放，请用新 requestId 重试' : ''}`,
        available: r.available ?? null,
      }
    }
    return { active: true, refId, reserve: amount }
  }

  /** 预扣被拒：不调用任何 provider，如实返回错误码，绝不假装成功 */
  function reserveFailure(taskType, tier, region, hold, extra = {}) {
    appendAudit({
      taskType, tier, providerKey: null, cached: false, input: 0, output: 0, points: 0,
      degraded: true, code: hold.code, billingRefused: true, latencyMs: 0,
    })
    return {
      ok: false, degraded: true, judgement: null, subject: null, body: null,
      tier, region, errorCodes: [hold.code], code: hold.code,
      billing: {
        charged: false, scope: 'ledger-v2', refId: hold.refId,
        reason: hold.reason, available: hold.available,
      },
      reason: hold.code === 'E4001'
        ? `点数不足，未发起任何 provider 调用：${hold.reason}`
        : `计费幂等键已结算，拒绝重复调用与重复扣点：${hold.reason}`,
      ...extra,
    }
  }

  /** 成功响应结算。estimated 为 PRD 公式折算后向上取整的整数点数，超过预扣则封顶并显式标注 */
  function settleBilling(hold, estimated) {
    if (!hold?.active) return billingNone('no-ledger-or-no-reserve')
    const capped = estimated > hold.reserve
    const amount = Math.min(estimated, hold.reserve)
    const r = ledger.settle({ refId: hold.refId, amount, reason: '网关真实调用结算（内容已通过校验）' })
    if (!r.ok) {
      return {
        charged: false, scope: 'ledger-v2', refId: hold.refId,
        error: r.code, reason: r.reason, note: `结算失败（${r.code}）：本次未扣点，预扣状态需人工核对`,
      }
    }
    return {
      charged: r.charged > 0, scope: 'ledger-v2', refId: hold.refId,
      reserved: hold.reserve, estimatedPoints: estimated, chargedPoints: r.charged,
      refunded: r.refunded, capped, idempotent: Boolean(r.idempotent),
      available: r.available,
      note: capped
        ? `本次折算 ${estimated} 点超过预扣上限 ${hold.reserve} 点，按 ${r.charged} 点封顶结算；请在 shared/model-protocol.json 调高 gatewayBilling.reservePoints`
        : `按 token 折算 ${estimated} 点实扣 ${r.charged} 点，退还 ${r.refunded} 点`,
    }
  }

  /** 失败/降级/异常一律全额释放：平台自担失败调用成本，绝不把失败伪装成已扣点 */
  function releaseBilling(hold, reason) {
    if (!hold?.active) return billingNone(reason)
    const r = ledger.release({ refId: hold.refId, reason })
    return {
      charged: false, scope: 'ledger-v2', refId: hold.refId, reserved: hold.reserve,
      refunded: r.ok ? (r.refunded ?? hold.reserve) : 0,
      released: Boolean(r.ok), code: r.ok ? null : r.code, reason,
      note: r.ok
        ? '调用失败或显式降级：预扣已全额释放，本次不计点（失败尝试仍留在调用审计里）'
        : `释放失败（${r.code}）：${r.reason}，需人工核对账本`,
    }
  }

  /** 文案必须跟随账本真实状态：没有预扣 / 释放成功 / 释放失败三种情况绝不能混说 */
  function releaseNote(hold, billing) {
    if (!hold?.active) return '本次未产生账本预扣，不计点'
    if (billing?.released === true) return '预扣点数已全额释放'
    return `预扣释放失败（${billing?.code ?? 'E4003'}），需人工核对账本`
  }

  function health() {
    const list = providers.map((p) => ({
      key: p.key, name: p.name, tier: p.tier, region: p.region, model: p.modelVersion,
      modelVersion: p.modelVersion, configured: p.configured, pinned: p.snapshotLocked,
      circuitOpen: isOpen(p),
      recentFailures: (failures.get(p.key) ?? []).length,
    }))
    const configuredCount = list.filter((p) => p.configured).length
    const pinnedCount = list.filter((p) => p.configured && p.pinned).length
    const readyCount = list.filter((p) => p.configured && p.pinned && !p.circuitOpen).length
    return {
      ok: readyCount > 0,
      mode: readyCount > 0 ? 'configured' : 'unconfigured-demo',
      configuredCount, pinnedCount, readyCount,
      totalProviders: list.length,
      cacheEntries: cache.size,
      auditEntries: readAudit().length,
      persistence: store?.mode ?? 'memory',
      billingMode: ledger ? 'ledger-v2' : 'audit-only',
      billingVersion: ledger ? billingCfg.version : null,
      billingReservePoints: ledger ? billingCfg.reservePoints : null,
      providers: list,
      note: '只配 API Key 不足以调用：还必须锁定 model_version 快照。未锁定返回 E6008，未配 Key 返回 E6005，都不伪造模型判断。',
      reason: configuredCount === 0
        ? '未配置任何 API Key：判断与写信明确返回 E6005 降级。'
        : pinnedCount === 0
          ? `已配置 ${configuredCount} 家 API Key，但未锁定任何 model_version 快照：拒绝真实调用（E6008）。请设置 LEADPILOT_MODEL_VERSION_* 环境变量。`
          : readyCount === 0
            ? '所有已锁定快照的 provider 均处于熔断中，暂时不可用。'
            : undefined,
    }
  }

  /** 无可用 provider 时区分「没 Key」「有 Key 但没锁快照」「全部熔断」，绝不笼统说成降级 */
  function noProviderReason() {
    if (!providers.some((p) => p.configured)) {
      return {
        codes: ['E6005'],
        reason: '全部 provider 不可用或未配置 API Key：本次为规则估算，未经模型校验。请把不确定性显式化（PRD F0-4）。',
      }
    }
    if (!providers.some((p) => p.configured && p.snapshotLocked)) {
      return {
        codes: ['E6008'],
        reason: '已配置 API Key 但未锁定 model_version 快照：禁止 -latest 浮动指针，网关拒绝发起真实调用。请设置 LEADPILOT_MODEL_VERSION_<PROVIDER_KEY> 为官网可查的具体版本 ID。',
      }
    }
    return {
      codes: ['E6005'],
      reason: '所有已锁定快照的 provider 均处于熔断或不可用状态：本次为规则估算，未经模型校验。',
    }
  }

  /** PRD F0-4：按 tier 顺序组降级链；T0 全失败 → 补 T1，T1 全失败 → 补 T2 */
  function chainFor(tier, region) {
    const order = tier === 'T0' ? ['T0', 'T1', 'T2'] : tier === 'T1' ? ['T1', 'T2'] : ['T2']
    return order.flatMap((t) => providers.filter((p) =>
      p.tier === t && p.configured && p.snapshotLocked && !isOpen(p)
      && (region.group !== 'domestic' || p.region === 'domestic'),
    ))
  }

  async function callOnce(p, messages) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), protocol.downgrade.timeoutMs)
    const started = nowFn()
    try {
      const isAnthropic = p.vendor === 'anthropic'
      const url = isAnthropic ? `${p.baseUrl}/messages` : `${p.baseUrl}/chat/completions`
      // chainFor 只放行已锁定快照的 provider；此处用快照 ID 调用与留痕，保证可复现
      const pinnedModel = p.modelVersion ?? p.model
      const body = isAnthropic
        ? { model: pinnedModel, max_tokens: 900, temperature: protocol.rules.temperature, system: messages[0].content, messages: messages.slice(1) }
        : {
          model: pinnedModel, messages, temperature: protocol.rules.temperature, max_tokens: 900,
          response_format: { type: 'json_object' },
        }
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: isAnthropic
          ? { 'content-type': 'application/json', 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' }
          : { 'content-type': 'application/json', authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (res.status === 429) return { kind: 'rate_limit', latencyMs: nowFn() - started }
      if (res.status >= 500) return { kind: 'server_error', status: res.status, latencyMs: nowFn() - started }
      if (!res.ok) return { kind: 'error', status: res.status, code: 'E6007', latencyMs: nowFn() - started }
      const data = await res.json()
      const content = isAnthropic ? (data.content?.[0]?.text ?? '') : (data.choices?.[0]?.message?.content ?? '')
      let raw
      try { raw = JSON.parse(content) } catch { return { kind: 'schema_error', latencyMs: nowFn() - started } }
      const usage = isAnthropic
        ? { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 }
        : { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 }
      return { kind: 'ok', raw, usage, latencyMs: nowFn() - started }
    } catch (err) {
      if (err?.name === 'AbortError') return { kind: 'timeout', latencyMs: nowFn() - started }
      return { kind: 'error', code: 'E6001', message: String(err?.message ?? err), latencyMs: nowFn() - started }
    } finally {
      clearTimeout(timer)
    }
  }

  /** PRD F0-4 降级链：超时重试 1 次 / 429 指数退避 3 次 / 5xx 立即切顺位 / schema 同 provider 重试 1 次 */
  async function callProvider(p, messages, log) {
    const d = protocol.downgrade
    let rateLimitAttempts = 0
    let timeoutRetries = 0
    let schemaRetries = 0
    for (let round = 0; round < 8; round++) {
      const result = await callOnce(p, messages)
      log.push({ providerKey: p.key, event: result.kind, latencyMs: result.latencyMs })
      if (result.kind === 'ok' || result.kind === 'schema_error') return { ...result, log }
      if (result.kind === 'rate_limit' && rateLimitAttempts < d.rateLimitRetries) {
        await sleepFn(d.rateLimitBackoffMs[Math.min(rateLimitAttempts, d.rateLimitBackoffMs.length - 1)])
        rateLimitAttempts++
        continue
      }
      if (result.kind === 'timeout' && timeoutRetries < d.timeoutRetries) {
        await sleepFn(d.timeoutBackoffMs)
        timeoutRetries++
        continue
      }
      return { ...result, log }
    }
    return { kind: 'error', code: 'E6001', message: '重试次数耗尽', log }
  }

  function jsonSchemaHintForRetry(errors) {
    return {
      role: 'user',
      content: `上次返回未通过 schema 校验：${errors.slice(0, 3).join('；')}。请严格按枚举与字段要求重新输出 JSON，不要解释。`,
    }
  }

  /**
   * 判断入口。返回：
   *  - ok=true → judgement（已通过 schema + 证据校验，wire snake_case 与内部 camelCase 双份）
   *  - degraded=true → judgement=null + E6005，客户端必须把分数显示为区间并标注未经模型校验
   *  - needsConsent=true → 境外 T2 需要用户显式同意，默认拒绝
   */
  async function judge(input = {}) {
    const started = nowFn()
    const companyId = String(input.companyId ?? 'unknown')
    const hasSources = Array.isArray(input.sources) && input.sources.length > 0

    // T0 → judge 事实链：调用方给了可核验 sources 才启用；绝不拿演示文本伪造来源
    let t0Result = null
    let t0Meta = {
      used: false, ok: false, extractor: 'rules',
      reason: '调用方未提供可核验 sources：本次判断不经过 T0 事实链，不拿演示文本伪造来源。',
    }
    let sanitized = sanitizeContext(Array.isArray(input.sourceTexts) ? input.sourceTexts : [])
    if (hasSources) {
      const extracted = extractFacts({
        company_id: companyId, sources: input.sources,
        keywords: input.keywords ?? [], markets: input.markets ?? [],
      })
      if (!extracted.ok) {
        return {
          ok: false, degraded: true, errorCodes: ['E6004'],
          t0: { used: true, ok: false, extractor: 'rules', code: extracted.code, errors: extracted.errors },
          billing: billingNone('t0_validation_error'),
          reason: `T0 事实链输入不合法：${extracted.errors.join('；')}。未向任何 provider 发送数据。`,
        }
      }
      t0Result = extracted
      t0Meta = {
        used: true, ok: true, extractor: 'rules', rulesVersion: extracted.rulesVersion,
        sourceCount: extracted.sourceCount, piiRemoved: extracted.piiRemoved,
        noSignalFields: extracted.coverage.noSignalFields,
        hitFields: extracted.coverage.hitFields,
        coverageRate: extracted.coverage.rate,
      }
      // context 必须与 T0 抽取时清洗后的原文一致，否则 quote 无法逐字核验
      sanitized = { texts: sanitizeContext(input.sources.map((s) => String(s.text ?? ''))).texts, removed: extracted.piiRemoved }
    }

    const pii = assertNoPii({ facts: input.facts ?? {}, profile: input.profile ?? {} })
    if (!pii.ok) {
      return {
        ok: false, degraded: true, errorCodes: ['E6004'], t0: t0Meta,
        billing: billingNone('pii_validation_error'),
        reason: `请求体含禁止字段（PRD 11.4.1 数据最小化）：${pii.violations.join('、')}。未向任何 provider 发送数据。`,
      }
    }

    const tier = route({ type: 'judge_import', confidence: input.confidence, conflict: input.conflict, depth: input.depth, valueTier: input.valueTier })
    const region = regionDecision(input.country ?? '', tier, {
      policy: input.regionPolicy ?? 'domestic_first',
      allowOverseas: input.allowOverseas ?? false,
    })
    if (region.needsConsent) {
      return {
        ok: false, needsConsent: true, tier, region, errorCodes: [], t0: t0Meta,
        billing: billingNone('needs_consent'), reason: region.reason,
      }
    }

    // P1-03：缓存键必须绑定完整判断上下文。此前只散列 domain + 原文，
    // 同一客户换 facts / keywords / markets / tier 后会直接命中旧结论（缓存串读）。
    const key = cacheKey(input.domain ?? companyId, sanitized.texts, {
      facts: input.facts ?? {}, keywords: input.keywords ?? [], markets: input.markets ?? [],
      confidence: input.confidence ?? null, conflict: Boolean(input.conflict),
      depth: input.depth ?? null, valueTier: input.valueTier ?? null,
      country: input.country ?? '', regionPolicy: input.regionPolicy ?? 'domestic_first',
      allowOverseas: Boolean(input.allowOverseas), tier,
      t0RulesVersion: t0Result?.rulesVersion ?? null,
    })
    const hit = cache.get(key)
    // 旧格式缓存（未标注 passesGate）一律视为陈旧失效，不把门禁状态不明的判断当成功命中
    if (hit && hit.passesGate === true && nowFn() - hit.at < protocol.rules.cacheTtlDays * 86400000) {
      appendAudit({ taskType: 'judge', tier, providerKey: hit.providerKey, cached: true, input: 0, output: 0, points: 0, t0Used: t0Meta.used, billingCharged: false, latencyMs: nowFn() - started })
      return {
        ok: true, judgement: hit.judgement, cached: true, tier, region,
        provenanceRate: hit.provenanceRate, passesGate: true,
        evidenceFields: hit.evidenceFields ?? null, errorCodes: [],
        t0: { ...t0Meta, reconciliation: hit.reconciliation ?? null },
        audit: { cached: true },
        billing: billingNone('cache_hit'),
      }
    }

    const chain = chainFor(tier, region)
    if (!chain.length) {
      const down = noProviderReason()
      appendAudit({ taskType: 'judge', tier, providerKey: null, cached: false, input: 0, output: 0, points: 0, degraded: true, code: down.codes[0], t0Used: t0Meta.used, billingCharged: false, latencyMs: nowFn() - started })
      return {
        ok: false, degraded: true, judgement: null, tier, region, t0: t0Meta,
        errorCodes: down.codes, reason: down.reason,
        billing: billingNone('no_provider'),
      }
    }

    const baseMessages = buildJudgeMessages({ companyId, sourceTexts: sanitized.texts, facts: input.facts, t0: t0Result })
    // P1-07：请求体校验查不到 companyId；这里对「真正要发出的文本」做最后一道 PII 终检。
    // 必须放在 reserveBilling 之前，否则拒绝时会在账本里留下冻结点数。
    const finalPii = assertNoPiiInMessages(baseMessages)
    if (!finalPii.ok) {
      appendAudit({ taskType: 'judge', tier, providerKey: null, cached: false, input: 0, output: 0, points: 0, degraded: true, code: 'E6004', piiBlockedAtPrompt: true, billingCharged: false, t0Used: t0Meta.used, latencyMs: nowFn() - started })
      return {
        ok: false, degraded: true, judgement: null, tier, region, errorCodes: ['E6004'], t0: t0Meta,
        billing: billingNone('pii_in_final_prompt'),
        reason: '最终 prompt 命中个人信息（邮箱/电话/凭据）：companyId 或事实字段未清洗干净，拒绝向 provider 发送数据；本次未预扣点数。',
      }
    }

    // 只有确认存在可用 provider 链才预扣；预扣失败不发起任何外部请求
    const hold = reserveBilling('judge', tier, input)
    if (hold.failed) return reserveFailure('judge', tier, region, hold, { t0: t0Meta })

    const trace = []
    let settled = null // P1-05：记录「异常前是否已结算」，决定 catch 里能否宣称点数已释放
    try {
      for (const p of chain) {
        let messages = baseMessages
        let result = await callProvider(p, messages, trace)
        let checked = result.kind === 'ok' ? validateSchema(result.raw) : { valid: false, errors: ['provider 未返回可解析 JSON'] }
        if (result.kind === 'ok' && !checked.valid && protocol.downgrade.schemaRetrySameProvider >= 1) {
          messages = [...baseMessages, jsonSchemaHintForRetry(checked.errors)]
          result = await callProvider(p, messages, trace)
          checked = result.kind === 'ok' ? validateSchema(result.raw) : { valid: false, errors: ['schema 重试失败'] }
        }
        if (result.kind !== 'ok' || !checked.valid) {
          recordFailure(p)
          continue
        }

        const verified = verifyEvidence(checked.value, sanitized.texts)
        // 证据校验之后再做规则层裁决：代码保守覆盖模型结论，全程留痕，不静默改写
        const reconciliation = t0Result ? reconcileWithT0(checked.value, t0Result) : null
        const judgement = {
          ...checked.value,
          model_id: p.model,
          model_version: p.modelVersion, // chainFor 保证非 null，禁止 -latest 浮动指针
          prompt_version: protocol.promptVersion,
          schema_version: protocol.schemaVersion,
        }
        const auditMeta = {
          taskType: 'judge', tier, providerKey: p.key, model: p.modelVersion, cached: false,
          input: result.usage.input, output: result.usage.output,
          piiRemoved: sanitized.removed, t0Used: t0Meta.used,
          t0Conflicts: reconciliation?.conflicts?.length ?? 0,
          provenanceRate: Number(verified.provenanceRate.toFixed(3)),
          latencyMs: nowFn() - started,
        }

        // P1-04：chargeOn = schema_and_content_validation_passed。证据门禁未通过属于
        // releaseOn.content_rejected，必须全额释放预扣、不结算、不写缓存、不计 provider 成功。
        if (!verified.passesGate) {
          const billing = releaseBilling(hold, '证据/内容校验未通过（E6004）：按 chargeOn 契约不结算')
          appendAudit({
            ...auditMeta, points: 0, degraded: true, code: 'E6004', passesGate: false,
            billingScope: billing.scope, billingCharged: false,
            billingRefId: billing.refId ?? null, billingPoints: 0,
          })
          return {
            ok: true, degraded: true, judgement, clientJudgement: toClientJudgement(judgement),
            provenanceRate: verified.provenanceRate, passesGate: false,
            evidenceFields: verified.fields, errorCodes: ['E6004'],
            tier, region, cached: false,
            t0: { ...t0Meta, reconciliation },
            audit: { providerKey: p.key, model: p.modelVersion, input: result.usage.input, output: result.usage.output, points: 0, latencyMs: nowFn() - started },
            billing,
            reason: `引用可溯源率 ${Number(verified.provenanceRate.toFixed(3))} 未达门禁阈值：内容校验未通过，${releaseNote(hold, billing)}，本次不计点；判断字段已回退为规则估算，未经模型有效校验。`,
          }
        }

        const points = pointCost(result.usage, tier, 0, p)
        const estimated = billingPoints(result.usage, tier, 0, p)
        const billing = settleBilling(hold, estimated)
        settled = billing
        appendAudit({
          ...auditMeta, points, passesGate: true,
          billingScope: billing.scope, billingCharged: billing.charged,
          billingRefId: billing.refId ?? null, billingPoints: estimated,
        })
        recordSuccess(p)
        const payload = {
          ok: true,
          judgement,
          clientJudgement: null,
          provenanceRate: verified.provenanceRate,
          passesGate: true,
          evidenceFields: verified.fields,
          errorCodes: [],
          tier, region, cached: false,
          t0: { ...t0Meta, reconciliation },
          audit: { providerKey: p.key, model: p.modelVersion, input: result.usage.input, output: result.usage.output, points, latencyMs: nowFn() - started },
          billing,
        }
        payload.clientJudgement = toClientJudgement(payload.judgement)
        try {
          cache.set(key, {
            at: nowFn(), judgement: payload.judgement, providerKey: p.key,
            provenanceRate: verified.provenanceRate, reconciliation,
            passesGate: true, evidenceFields: verified.fields, errorCodes: [],
          })
        } catch (cacheErr) {
          // P1-05：结果缓存是附赠能力，落盘失败不得把一次已通过校验、已结算的调用打成异常，
          // 更不能让异常分支谎称「点数已全额释放」。如实记审计并继续返回本次成功响应。
          // eslint-disable-next-line no-console
          console.warn(`[LeadPilot] 判断结果缓存写入失败（不影响本次响应与计费）：${String(cacheErr?.message ?? cacheErr)}`)
          appendAudit({ ...auditMeta, points: 0, degraded: false, code: 'E6002', cacheWriteFailed: true, billingCharged: Boolean(billing.charged) })
        }
        return payload
      }

      const billing = releaseBilling(hold, '降级链耗尽或 schema/证据校验全部失败')
      appendAudit({ taskType: 'judge', tier, providerKey: null, cached: false, input: 0, output: 0, points: 0, degraded: true, code: 'E6005', t0Used: t0Meta.used, billingCharged: false, billingRefId: billing.refId ?? null, latencyMs: nowFn() - started })
      return {
        ok: false, degraded: true, judgement: null, tier, region, errorCodes: ['E6003', 'E6005'], trace, t0: t0Meta,
        billing,
        reason: `降级链已耗尽（provider 故障或 schema/证据校验全部失败）。本次为规则估算，未经模型校验，${releaseNote(hold, billing)}。`,
      }
    } catch (err) {
      // P1-05 / P1-08：异常前若已结算，账本事实不可回滚，必须如实说明；
      // 内部错误只进服务端日志，绝不把路径 / SQLite 状态回显给调用方。
      const billing = settled ?? releaseBilling(hold, '网关调用异常')
      const moneyNote = settled
        ? `异常前已完成结算，账本${settled.charged ? `实扣 ${settled.chargedPoints} 点` : '未扣点'}，需人工核对`
        : releaseNote(hold, billing)
      // eslint-disable-next-line no-console
      console.warn(`[LeadPilot] 网关判断调用异常：${String(err?.message ?? err)}`)
      appendAudit({ taskType: 'judge', tier, providerKey: null, cached: false, input: 0, output: 0, points: 0, degraded: true, code: 'E6001', billingCharged: Boolean(settled?.charged), billingRefId: billing.refId ?? null, latencyMs: nowFn() - started })
      return {
        ok: false, degraded: true, judgement: null, tier, region, errorCodes: ['E6001'], trace, t0: t0Meta,
        billing, reason: `网关调用异常，${moneyNote}。内部错误已记录，不回显细节。`,
      }
    }
  }

  /**
   * PRD F6 · T1 写信入口。
   * 边界：只生成 subject/body，合规尾巴与发送前校验完全由客户端代码执行；
   *      未配置 Key 时明确返回 E6005，不返回任何「看起来像模型写的」模板正文。
   */
  async function writeEmail(input = {}) {
    const started = nowFn()
    const facts = {
      anchor: String(input.anchor ?? '').slice(0, 200),
      product: String(input.product ?? '').slice(0, 120),
      advantages: (Array.isArray(input.advantages) ? input.advantages : []).slice(0, 2).map((x) => String(x).slice(0, 120)),
      purpose: String(input.purpose ?? 'intro').slice(0, 40),
      tone: String(input.tone ?? 'concise').slice(0, 20),
      maxWords: Math.min(Number(input.maxWords ?? protocol.emailPolicy.wordLimits.short), protocol.emailPolicy.wordLimits.long),
      language: String(input.language ?? 'en').slice(0, 20),
      angle: String(input.angle ?? 'price_lead_time').slice(0, 40),
    }
    // T0 规则抽取增强：调用方若传入已抓取的官网原文，个性化锚点必须来自可核验引用。
    // 抽取层不调用模型、不联网；失败时如实回退调用方 anchor，绝不伪造抽取结果。
    let anchorSource = 'client'
    let t0 = null
    if (Array.isArray(input.sources) && input.sources.length) {
      const extracted = extractFacts({
        company_id: String(input.companyId ?? 'email-target').slice(0, 80),
        sources: input.sources,
        keywords: [facts.product],
      })
      if (extracted.ok) {
        const best = extracted.facts.anchors[0]
        if (best) {
          facts.anchor = String(best.quote).slice(0, 200)
          anchorSource = 't0-rules'
        }
        t0 = {
          ok: true, extractor: 'rules', rulesVersion: extracted.rulesVersion,
          sourceCount: extracted.sourceCount, piiRemoved: extracted.piiRemoved,
          coverage: extracted.coverage, anchorCount: extracted.facts.anchors.length, anchorSource,
          note: best
            ? '个性化锚点来自 T0 规则抽取的可核验原文引用'
            : '原文未命中可核验锚点，已回退调用方提供的 anchor（不编造）',
        }
      } else {
        t0 = {
          ok: false, extractor: 'rules', code: extracted.code, errors: extracted.errors,
          anchorSource: 'client', note: 'T0 输入校验未通过，如实回退调用方 anchor，不伪造抽取结果',
        }
      }
    }
    const meta = { anchorSource, anchor: facts.anchor, ...(t0 ? { t0 } : {}) }

    if (!facts.anchor || !facts.product) {
      return {
        ok: false, degraded: true, errorCodes: ['E6004'], ...meta,
        billing: billingNone('missing_anchor_or_product'),
        reason: '缺少个性化锚点或主营产品，拒绝生成无事实依据的开发信。',
      }
    }
    const pii = assertNoPii({ facts })
    if (!pii.ok) {
      return {
        ok: false, degraded: true, errorCodes: ['E6004'], ...meta,
        billing: billingNone('pii_validation_error'),
        reason: `写信请求含禁止字段（PRD 11.4.1）：${pii.violations.join('、')}。未向任何 provider 发送数据。`,
      }
    }

    const tier = route({ type: 'write_email' })
    const region = regionDecision(input.country ?? '', tier, {
      policy: input.regionPolicy ?? 'domestic_first',
      allowOverseas: input.allowOverseas ?? false,
    })
    if (region.needsConsent) {
      return {
        ok: false, needsConsent: true, tier, region, errorCodes: [], ...meta,
        billing: billingNone('needs_consent'), reason: region.reason,
      }
    }

    const chain = chainFor(tier, region)
    if (!chain.length) {
      const down = noProviderReason()
      appendAudit({ taskType: 'write_email', tier, providerKey: null, cached: false, input: 0, output: 0, points: 0, degraded: true, code: down.codes[0], billingCharged: false, latencyMs: nowFn() - started })
      return {
        ok: false, degraded: true, subject: null, body: null, tier, region, errorCodes: down.codes, ...meta,
        billing: billingNone('no_provider'),
        reason: down.reason + ' 本次不生成模型正文，客户端将回退本地确定性模板并明确标注 DEMO。',
      }
    }

    const messages = buildEmailMessages(facts)
    // P1-07：同样放在 reserveBilling 之前，PII 拒绝不产生任何预扣
    const finalPii = assertNoPiiInMessages(messages)
    if (!finalPii.ok) {
      return {
        ok: false, degraded: true, subject: null, body: null, tier, region,
        errorCodes: ['E6004'], ...meta,
        billing: billingNone('pii_in_final_prompt'),
        reason: '最终写信 prompt 命中个人信息（邮箱/电话/凭据）：个性化锚点或事实未清洗干净，拒绝向 provider 发送数据；本次未预扣点数。',
      }
    }

    // 只有确认存在可用 provider 链才预扣；预扣失败不发起任何外部请求
    const hold = reserveBilling('write_email', tier, input)
    if (hold.failed) return reserveFailure('write_email', tier, region, hold, meta)

    const trace = []
    let settled = null
    try {
      for (const p of chain) {
        const result = await callProvider(p, messages, trace)
        const checked = result.kind === 'ok' ? validateEmailDraft(result.raw, { maxWords: facts.maxWords }) : { valid: false, errors: ['provider 未返回可解析 JSON'] }
        if (result.kind !== 'ok' || !checked.valid) {
          recordFailure(p)
          trace.push({ providerKey: p.key, event: 'content_rejected', errors: checked.errors.slice(0, 3) })
          continue
        }
        const points = pointCost(result.usage, tier, 0, p)
        const estimated = billingPoints(result.usage, tier, 0, p)
        const billing = settleBilling(hold, estimated)
        settled = billing
        appendAudit({
          taskType: 'write_email', tier, providerKey: p.key, model: p.modelVersion, cached: false,
          input: result.usage.input, output: result.usage.output, points,
          billingScope: billing.scope, billingCharged: billing.charged,
          billingRefId: billing.refId ?? null, billingPoints: estimated,
          wordCount: checked.value.wordCount, latencyMs: nowFn() - started,
        })
        recordSuccess(p)
        return {
          ok: true, subject: checked.value.subject, body: checked.value.body,
          anchorUsed: checked.value.anchorUsed, wordCount: checked.value.wordCount,
          tier, region, cached: false, ...meta,
          audit: { providerKey: p.key, model: p.modelVersion, input: result.usage.input, output: result.usage.output, points, latencyMs: nowFn() - started },
          billing,
          note: '正文未经合规尾巴注入：真实身份 / 物理地址 / 退订说明由客户端代码追加，并通过发送前校验后才可入草稿队列。',
        }
      }

      const billing = releaseBilling(hold, '降级链耗尽或正文未通过 F6-2 硬约束')
      appendAudit({ taskType: 'write_email', tier, providerKey: null, cached: false, input: 0, output: 0, points: 0, degraded: true, code: 'E6005', billingCharged: false, billingRefId: billing.refId ?? null, latencyMs: nowFn() - started })
      return {
        ok: false, degraded: true, subject: null, body: null, tier, region, errorCodes: ['E6003', 'E6005'], trace, ...meta,
        billing,
        reason: `降级链已耗尽（provider 故障或正文未通过 F6-2 硬约束）。不输出未校验正文，客户端回退本地模板；${releaseNote(hold, billing)}。`,
      }
    } catch (err) {
      const billing = settled ?? releaseBilling(hold, '网关写信异常')
      const moneyNote = settled
        ? `异常前已完成结算，账本${settled.charged ? `实扣 ${settled.chargedPoints} 点` : '未扣点'}，需人工核对`
        : releaseNote(hold, billing)
      // eslint-disable-next-line no-console
      console.warn(`[LeadPilot] 网关写信调用异常：${String(err?.message ?? err)}`)
      appendAudit({ taskType: 'write_email', tier, providerKey: null, cached: false, input: 0, output: 0, points: 0, degraded: true, code: 'E6001', billingCharged: Boolean(settled?.charged), billingRefId: billing.refId ?? null, latencyMs: nowFn() - started })
      return {
        ok: false, degraded: true, subject: null, body: null, tier, region, errorCodes: ['E6001'], trace, ...meta,
        billing, reason: `网关写信异常，${moneyNote}。内部错误已记录，不回显细节。`,
      }
    }
  }

  return {
    route, regionDecision, health, judge, writeEmail,
    persistence: store?.mode ?? 'memory',
    getAudit: readAudit,
    getCacheStats: () => ({ entries: cache.size, ttlDays: protocol.rules.cacheTtlDays }),
    getCircuitState: () => [...circuit.entries()].filter(([, until]) => until > nowFn()).map(([key, until]) => ({ providerKey: key, openUntil: new Date(until).toISOString() })),
    _internals: { providers, callOnce, chainFor, cache, recordFailure, recordSuccess, isOpen },
  }
}
