/**
 * slice · 网关探测与单家客户重新研判
 *
 * 降级必须显式：网关不可达时不是「悄悄少个结果」，而是评分卡改成区间显示、
 * 置信度标低、`lastGatewayResult.degraded=true`，界面据此标注「未经模型校验」。
 * 同时遵守 11.4 数据最小化：只传判断所需事实，绝不传邮箱 / 电话 / 联系人姓名。
 */
import type { StateCreator } from 'zustand'
import { probeGateway as probeGatewayHealth, judgeCompany } from '@/services/adapters'
import { acceptModelJudgement } from '@/domain/llm-judgement'
import { buildScoreCard } from '@/domain/scoring'
import type { AppState } from '../types'

export type GatewaySlice = Pick<AppState,
  | 'gateway' | 'probing' | 'judgingCompanyId' | 'lastGatewayResult'
  | 'probeGateway' | 'judgeWithGateway'>

export const createGatewaySlice: StateCreator<AppState, [], [], GatewaySlice> = (set, get) => ({
  gateway: null,
  probing: false,
  judgingCompanyId: null,
  lastGatewayResult: null,

  probeGateway: async () => {
    if (get().probing) return
    set({ probing: true })
    const health = await probeGatewayHealth()
    set({ gateway: health, probing: false })
  },

  /** 用云端网关重新判断一家客户：结果无论成功或降级都要显式落到评分卡上 */
  judgeWithGateway: async (companyId: string) => {
    const company = get().companies.find((c) => c.id === companyId)
    if (!company) return
    set({ judgingCompanyId: companyId })
    const f = company.features
    // 与服务端 11.4 数据最小化一致：只传判断所需的事实，绝不传邮箱/电话/联系人
    const facts = {
      keywordHits: f.keywordHits,
      categoryDistance: f.categoryDistance,
      semanticSimilarity: f.semanticSimilarity,
      importBatches24m: f.importBatches24m,
      customsRecords: f.customsRecords,
      customsDataAvailable: f.customsDataAvailable,
      distributedBrands: f.distributedBrands,
      tradeTermHits: f.tradeTermHits,
      employeeCount: f.employeeCount,
      marketMatch: f.marketMatch,
      importWording: f.importWording,
    }
    const result = await judgeCompany({
      companyId, domain: company.domain, country: company.country,
      sourceTexts: f.sourceTexts, facts,
      depth: 2,
      regionPolicy: get().settings.llm.regionPolicy,
    })
    const at = new Date().toISOString()

    if (result.ok && result.clientJudgement) {
      // 客户端不信任服务端结论，再跑一次 schema + 证据校验
      const accepted = acceptModelJudgement(result.clientJudgement, f.sourceTexts)
      const card = buildScoreCard(f, accepted.judgement, { modelAvailable: Boolean(accepted.judgement) })
      set((s) => ({
        companies: s.companies.map((c) => c.id === companyId ? { ...c, scoreCard: card } : c),
        judgingCompanyId: null,
        lastGatewayResult: {
          companyId, at, provider: result.audit?.providerKey, model: result.audit?.model,
          cached: Boolean(result.cached), provenance: result.provenanceRate ?? 0,
          points: result.audit?.points, degraded: !accepted.judgement,
          reason: accepted.errorCodes.length ? accepted.reason : undefined,
        },
      }))
      get().showToast(
        accepted.judgement
          ? `云端判断完成：${result.audit?.model ?? '网关'} · 可溯源率 ${((result.provenanceRate ?? 0) * 100).toFixed(0)}%${result.cached ? ' · 命中 30 天缓存' : ` · 消耗 ${result.audit?.points ?? 0} 点`}`
          : '云端返回未通过客户端二次校验，已回退规则估算并降低置信度',
        accepted.judgement ? 'ok' : 'warn',
      )
    } else {
      // E6005：不静默回退，分数变区间、置信度标低、界面标注未经模型校验
      const card = buildScoreCard(f, null, { modelAvailable: false })
      set((s) => ({
        companies: s.companies.map((c) => c.id === companyId ? { ...c, scoreCard: card } : c),
        judgingCompanyId: null,
        lastGatewayResult: {
          companyId, at, cached: false, provenance: 0, degraded: true,
          reason: result.reason ?? '网关不可用',
        },
      }))
      get().showToast(`${result.reason ?? '网关不可用'} · 该客户分数已改为区间显示`, 'warn')
    }
  },
})
