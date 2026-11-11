/**
 * 演示数据集 · 明确标注 DEMO，绝不伪装为真实采集结果（PRD 6.7「不能假知道」）
 *
 * 覆盖的验收场景：
 *  - 五维齐全 + A 级邮箱（AC-06 证据链）
 *  - 无海关数据市场（德国/欧盟）→ 进口可能性权重转移（AC-07）
 *  - 采购概率缺失 → 权重再归一化（PRD 6.6）
 *  - 规则/模型冲突 > 30 → 保守取规则值 + 待复议（PRD 6.7.4）
 *  - 模型引用无法核验 → E6004 整条丢弃（PRD 6.7.7）
 *  - 高匹配 + 低进口 → 疑似同行折叠（PRD 6.1）
 *  - D 级邮箱 → 禁止进入发送队列（AC-11）
 */
import type {
  Company, Contact, ContactGrade, CustomerType, DimensionKey, Evidence, ImportSignal,
  LlmJudgement, RuleFeatures, SizeTier, TradeRecord,
} from '@/types'
import { buildScoreCard } from '@/domain/scoring'

const FETCHED = '2026-11-06'
const E = (quote: string, path: string, label?: string): Evidence => ({
  quote, sourceUrl: `https://${path}`, fetchedAt: FETCHED, label,
})

interface Seed {
  name: string
  domain: string
  country: string
  flag: string
  city: string
  founded: number
  size: SizeTier
  employees: number
  types: CustomerType[]
  categories: string[]
  brands: string[]
  grade: ContactGrade
  contactEmail: string
  contactPerson?: string
  description: string
  keywords: { term: string; count: number; positionWeight: number }[]
  categoryDistance: 0 | 1 | 2 | 3
  semantic: number
  batches: number | null
  customsRecords: number | null
  customsAvailable: boolean
  importSignal: ImportSignal
  distributedBrands: number
  tradeTermHits: number
  sourceTexts: string[]
  /** 让模型引用无法在原文核验，触发 E6004 */
  fakeCitation?: boolean
  /** 让模型判断与规则分冲突，触发复议 */
  conflict?: boolean
  competitor?: boolean
  variantLabel?: string
}

const BASE_TEXTS = (s: Seed) => [
  `About ${s.name}: ${s.description}`,
  'We stock hydraulic hose fittings, JIC fittings and brass adapters for industrial distributors.',
  'Team of 23 across Rotterdam and Antwerp. FOB Rotterdam, CIF terms available.',
  'Authorized distributor for Parker and Eaton across Benelux.',
  'Products: hydraulic fittings, brass fittings, hydraulic connectors, tube assemblies.',
]

const SEEDS: Seed[] = [
  {
    name: 'Rhein Hydraulik Handel GmbH', domain: 'rhein-hydraulik.de', country: '德国', flag: '🇩🇪', city: 'Düsseldorf',
    founded: 2004, size: 'M', employees: 42, types: ['distributor', 'importer'], categories: ['五金/管件/液压接头'], brands: ['Parker', 'Eaton'],
    grade: 'A', contactEmail: 'purchasing@rhein-hydraulik.de', contactPerson: 'Mark Reynolds · Purchasing Manager',
    description: '德国液压管件分销商，代理 Parker 与 Eaton，服务 Benelux 工业客户。',
    keywords: [{ term: 'hydraulic hose fittings', count: 14, positionWeight: 1.5 }, { term: 'brass fittings', count: 6, positionWeight: 1.3 }],
    categoryDistance: 0, semantic: 0.88, batches: 9, customsRecords: null, customsAvailable: false, importSignal: 'inferred',
    distributedBrands: 2, tradeTermHits: 3, sourceTexts: [],
  },
  {
    name: 'Nordic Fluid Systems AS', domain: 'nordicfluid.no', country: '挪威', flag: '🇳🇴', city: 'Oslo',
    founded: 1998, size: 'L', employees: 130, types: ['wholesaler', 'distributor'], categories: ['五金/管件/液压接头'], brands: ['Hydac', 'Stauff'],
    grade: 'A', contactEmail: 'procurement@nordicfluid.no', contactPerson: 'Ingrid Solberg · Head of Sourcing',
    description: '北欧流体系统批发商，覆盖挪威与瑞典的工业维修市场。',
    keywords: [{ term: 'hydraulic fittings', count: 11, positionWeight: 1.5 }, { term: 'tube assemblies', count: 4, positionWeight: 1 }],
    categoryDistance: 0, semantic: 0.83, batches: 14, customsRecords: null, customsAvailable: false, importSignal: 'inferred',
    distributedBrands: 3, tradeTermHits: 4, sourceTexts: [],
  },
  {
    name: 'Pacific Hose & Fitting Inc.', domain: 'pacifichose.com', country: '美国', flag: '🇺🇸', city: 'Houston',
    founded: 1987, size: 'M', employees: 48, types: ['importer', 'distributor'], categories: ['五金/管件/液压接头'], brands: ['Parker', 'Eaton', 'Gates'],
    grade: 'A', contactEmail: 'purchasing@pacifichose.com', contactPerson: 'David Chen · Purchasing Manager',
    description: '美国海关有 9 条进口记录的液压接头进口商，代理三大品牌。',
    keywords: [{ term: 'hydraulic hose fittings', count: 18, positionWeight: 1.5 }, { term: 'JIC fittings', count: 7, positionWeight: 1.3 }],
    categoryDistance: 0, semantic: 0.91, batches: 9, customsRecords: 9, customsAvailable: true, importSignal: 'confirmed',
    distributedBrands: 3, tradeTermHits: 4, sourceTexts: [],
  },
  {
    name: 'Vietnam Industrial Supply JSC', domain: 'visupply.vn', country: '越南', flag: '🇻🇳', city: 'Ho Chi Minh',
    founded: 2012, size: 'M', employees: 36, types: ['importer', 'trader'], categories: ['五金/管件'], brands: [],
    grade: 'B', contactEmail: 'sales@visupply.vn',
    description: '越南工业耗材进口贸易商，近 24 个月 6 批次进口记录。',
    keywords: [{ term: 'hydraulic fittings', count: 7, positionWeight: 1.3 }],
    categoryDistance: 1, semantic: 0.71, batches: 6, customsRecords: 6, customsAvailable: true, importSignal: 'confirmed',
    distributedBrands: 1, tradeTermHits: 2, sourceTexts: [],
  },
  {
    name: 'Gulf Fluid Trading LLC', domain: 'gulffluid.ae', country: '阿联酋', flag: '🇦🇪', city: 'Dubai',
    founded: 2016, size: 'S', employees: 9, types: ['trader'], categories: ['五金/管件'], brands: [],
    grade: 'C', contactEmail: 'info.gulffluid@gmail.com',
    description: '迪拜小型贸易公司，仅有免费邮箱，官网未披露进口记录。',
    keywords: [{ term: 'hydraulic fittings', count: 3, positionWeight: 1 }],
    categoryDistance: 2, semantic: 0.58, batches: null, customsRecords: null, customsAvailable: false, importSignal: 'no_signal',
    distributedBrands: 0, tradeTermHits: 1, sourceTexts: [],
  },
  {
    name: 'Bavaria Präzision Werke GmbH', domain: 'bavaria-praezision.de', country: '德国', flag: '🇩🇪', city: 'Munich',
    founded: 1972, size: 'L', employees: 210, types: ['factory'], categories: ['五金/管件/液压接头'], brands: [],
    grade: 'B', contactEmail: 'einkauf@bavaria-praezision.de',
    description: '德国本土精密接头制造商，自产自销，官网明确标注 Made in Germany。',
    keywords: [{ term: 'hydraulic fittings', count: 21, positionWeight: 1.5 }, { term: 'brass fittings', count: 9, positionWeight: 1.3 }],
    categoryDistance: 0, semantic: 0.94, batches: 1, customsRecords: null, customsAvailable: false, importSignal: 'contradicted',
    distributedBrands: 0, tradeTermHits: 0, sourceTexts: [], competitor: true,
  },
  {
    name: 'Iberia Componentes SL', domain: 'iberiacomponentes.es', country: '西班牙', flag: '🇪🇸', city: 'Barcelona',
    founded: 2009, size: 'S', employees: 8, types: ['retailer'], categories: ['五金/零售'], brands: [],
    grade: 'C', contactEmail: 'contacto@iberiacomponentes.es',
    description: '西班牙本地五金零售店，面向终端客户，无批发入口。',
    keywords: [{ term: 'hydraulic fittings', count: 2, positionWeight: 1 }],
    categoryDistance: 2, semantic: 0.49, batches: null, customsRecords: null, customsAvailable: false, importSignal: 'no_signal',
    distributedBrands: 0, tradeTermHits: 0, sourceTexts: [],
  },
  {
    name: 'Anatolia Makina Sanayi', domain: 'anatoliamakina.com.tr', country: '土耳其', flag: '🇹🇷', city: 'Istanbul',
    founded: 2001, size: 'M', employees: 55, types: ['wholesaler', 'importer'], categories: ['五金/管件'], brands: ['Bosch Rexroth'],
    grade: 'B', contactEmail: 'info@anatoliamakina.com.tr',
    description: '土耳其工程机械配件批发商，代理 Bosch Rexroth，年进口 4 批次。',
    keywords: [{ term: 'hydraulic connectors', count: 8, positionWeight: 1.3 }],
    categoryDistance: 1, semantic: 0.76, batches: 4, customsRecords: null, customsAvailable: false, importSignal: 'inferred',
    distributedBrands: 1, tradeTermHits: 2, sourceTexts: [],
  },
  {
    name: 'Midwest Hydraulic Supply Co.', domain: 'midwesthydraulic.com', country: '美国', flag: '🇺🇸', city: 'Chicago',
    founded: 1994, size: 'L', employees: 168, types: ['distributor', 'wholesaler'], categories: ['五金/管件/液压接头'], brands: ['Parker', 'Gates'],
    grade: 'A', contactEmail: 'sourcing@midwesthydraulic.com', contactPerson: 'Laura Bennett · Category Manager',
    description: '美国中西部液压件分销商，海关 16 条进口记录，采购频次稳定。',
    keywords: [{ term: 'hydraulic hose fittings', count: 16, positionWeight: 1.5 }],
    categoryDistance: 0, semantic: 0.86, batches: 16, customsRecords: 16, customsAvailable: true, importSignal: 'confirmed',
    distributedBrands: 2, tradeTermHits: 3, sourceTexts: [],
  },
  {
    name: 'Siam Industrial Parts Co.', domain: 'siamindustrial.co.th', country: '泰国', flag: '🇹🇭', city: 'Bangkok',
    founded: 2018, size: 'S', employees: 12, types: ['trader'], categories: ['五金/管件'], brands: [],
    grade: 'B', contactEmail: 'sales@siamindustrial.co.th',
    description: '泰国工业配件贸易商，官网近 6 个月有新品发布与招聘信号。',
    keywords: [{ term: 'brass fittings', count: 5, positionWeight: 1.3 }],
    categoryDistance: 1, semantic: 0.67, batches: null, customsRecords: null, customsAvailable: false, importSignal: 'inferred',
    distributedBrands: 0, tradeTermHits: 2, sourceTexts: [],
  },
  {
    name: 'Baltic Marine Equipment OÜ', domain: 'balticmarine.ee', country: '爱沙尼亚', flag: '🇪🇪', city: 'Tallinn',
    founded: 2015, size: 'S', employees: 6, types: ['retailer'], categories: ['船舶配件'], brands: [],
    grade: 'D', contactEmail: 'bounce-test@balticmarine.invalid',
    description: '爱沙尼亚船用配件小店，域名 MX 记录不存在，邮箱不可达。',
    keywords: [{ term: 'hydraulic fittings', count: 1, positionWeight: 0.6 }],
    categoryDistance: 3, semantic: 0.32, batches: null, customsRecords: null, customsAvailable: false, importSignal: 'no_signal',
    distributedBrands: 0, tradeTermHits: 0, sourceTexts: [],
  },
  {
    name: 'Grupo Andino Importaciones', domain: 'grupoandino.cl', country: '智利', flag: '🇨🇱', city: 'Santiago',
    founded: 2007, size: 'M', employees: 29, types: ['importer'], categories: ['五金/管件'], brands: [],
    grade: 'A', contactEmail: 'compras@grupoandino.cl', contactPerson: 'Felipe Rojas · Import Manager',
    description: '智利工业管件进口商，近 24 个月 11 批次进口，正处备货窗口。',
    keywords: [{ term: 'hydraulic fittings', count: 10, positionWeight: 1.5 }],
    categoryDistance: 1, semantic: 0.79, batches: 11, customsRecords: null, customsAvailable: false, importSignal: 'confirmed',
    distributedBrands: 1, tradeTermHits: 3, sourceTexts: [],
  },
  {
    name: 'Kanto Kogyo Buhin KK', domain: 'kantokogyo.jp', country: '日本', flag: '🇯🇵', city: 'Osaka',
    founded: 1968, size: 'XL', employees: 620, types: ['factory', 'brand_owner'], categories: ['五金/管件'], brands: [],
    grade: 'B', contactEmail: 'overseas@kantokogyo.jp',
    description: '日本大型工业零部件制造集团，自有品牌，供应链固定。',
    keywords: [{ term: 'hydraulic connectors', count: 6, positionWeight: 1.3 }],
    categoryDistance: 1, semantic: 0.62, batches: 3, customsRecords: null, customsAvailable: false, importSignal: 'inferred',
    distributedBrands: 0, tradeTermHits: 1, sourceTexts: [],
  },
  {
    name: 'Polmos Tech Dystrybucja', domain: 'polmostech.pl', country: '波兰', flag: '🇵🇱', city: 'Poznań',
    founded: 2011, size: 'M', employees: 31, types: ['distributor'], categories: ['五金/管件/液压接头'], brands: ['Hydac'],
    grade: 'A', contactEmail: 'zakupy@polmostech.pl', contactPerson: 'Anna Kowalska · Buyer',
    description: '波兰液压件分销商，官网有 4 个招聘岗位与展会记录。',
    keywords: [{ term: 'hydraulic hose fittings', count: 12, positionWeight: 1.5 }],
    categoryDistance: 0, semantic: 0.84, batches: 5, customsRecords: null, customsAvailable: false, importSignal: 'inferred',
    distributedBrands: 1, tradeTermHits: 3, sourceTexts: [], conflict: true,
  },
  {
    name: 'Delta Fluid FZE', domain: 'deltafluidfze.ae', country: '阿联酋', flag: '🇦🇪', city: 'Sharjah',
    founded: 2020, size: 'S', employees: 4, types: ['trader'], categories: ['五金/管件'], brands: [],
    grade: 'C', contactEmail: 'delta.fluid@yahoo.com',
    description: '新注册小型贸易商，官网内容极少，模型引用无法核验。',
    keywords: [{ term: 'hydraulic fittings', count: 2, positionWeight: 1 }],
    categoryDistance: 2, semantic: 0.44, batches: null, customsRecords: null, customsAvailable: false, importSignal: 'no_signal',
    distributedBrands: 0, tradeTermHits: 0, sourceTexts: [], fakeCitation: true,
  },
  {
    name: 'Americas Bulk Components LLC', domain: 'americasbulk.com', country: '美国', flag: '🇺🇸', city: 'Dallas',
    founded: 1999, size: 'L', employees: 96, types: ['wholesaler', 'importer'], categories: ['五金/管件'], brands: ['Gates'],
    grade: 'B', contactEmail: 'sales@americasbulk.com',
    description: '美国大宗工业配件批发商，海关 7 条记录，MOQ 门槛高。',
    keywords: [{ term: 'brass fittings', count: 9, positionWeight: 1.3 }],
    categoryDistance: 1, semantic: 0.74, batches: 7, customsRecords: 7, customsAvailable: true, importSignal: 'confirmed',
    distributedBrands: 1, tradeTermHits: 2, sourceTexts: [],
  },
]

function featuresFor(s: Seed, variant: number): RuleFeatures {
  const texts = s.sourceTexts.length ? s.sourceTexts : BASE_TEXTS(s)
  const batches = s.batches === null ? null : Math.max(0, s.batches - variant)
  const evidences: Partial<Record<DimensionKey, Evidence[]>> = {
    match: [
      E('We stock hydraulic hose fittings, JIC fittings and brass adapters for industrial distributors.', `${s.domain}/products`, '官网产品页'),
      E('Products: hydraulic fittings, brass fittings, hydraulic connectors, tube assemblies.', `${s.domain}/catalog`, '产品目录'),
    ],
    import: s.customsRecords !== null
      ? [E(`US Customs: ${s.customsRecords} import records under HS 7307.19`, `customs.example.org/${s.domain}`, '海关记录')]
      : [E('Authorized distributor for Parker and Eaton across Benelux.', `${s.domain}/about`, '官网 About 页')],
    size: [E('Team of 23 across Rotterdam and Antwerp.', `${s.domain}/team`, '官网团队页')],
    contact: [E(`MX verified · SMTP 250 OK · ${s.contactEmail}`, `dns.example.org/${s.domain}`, '验证明细')],
  }
  if (batches !== null) {
    evidences.propensity = [E(`近 24 个月 ${batches} 批次进口，单批货值中位数 $38K`, `customs.example.org/${s.domain}`, '进口批次时间轴')]
  }
  return {
    keywordHits: s.keywords,
    categoryDistance: s.categoryDistance,
    semanticSimilarity: s.semantic,
    marketMatch: 1,
    importBatches24m: batches,
    purchaseValueRatio: batches === null ? null : 1.2,
    seasonWindow: s.country === '智利' || s.country === '德国' ? 1 : 0.4,
    supplierChangeSignal: s.types.includes('distributor') ? 0.7 : 0.3,
    activitySignals: s.size === 'S' ? 1 : s.size === 'XL' ? 2 : 4,
    employeeCount: s.employees,
    revenueUsd: s.size === 'M' ? 8_000_000 : s.size === 'L' ? 60_000_000 : 1_200_000,
    sizeTier: s.size,
    sizeEvidenceLevel: s.employees > 200 ? 'high' : 'mid',
    customsRecords: s.customsRecords,
    customsDataAvailable: s.customsAvailable,
    importWording: s.importSignal,
    distributedBrands: s.distributedBrands,
    tradeTermHits: s.tradeTermHits,
    emailGrade: s.grade,
    mxValid: s.grade !== 'D',
    smtpVerified: s.grade === 'A' || s.grade === 'B',
    domainMatch: !/gmail|yahoo|hotmail/.test(s.contactEmail),
    hasNamedContact: !!s.contactPerson,
    sourceTexts: texts,
    evidences,
  }
}

function judgementFor(s: Seed, id: string): LlmJudgement {
  const ctQuote = E('Authorized distributor for Parker and Eaton across Benelux.', `${s.domain}/about`)
  const imQuote = E('We stock hydraulic hose fittings, JIC fittings and brass adapters for industrial distributors.', `${s.domain}/products`)
  const szQuote = E('Team of 23 across Rotterdam and Antwerp.', `${s.domain}/team`)
  const fake = E('ISO 9001 certified since 1998 with 40 engineers and 12 warehouses', `${s.domain}/certificates`)
  const type: CustomerType | 'unknown' = s.types[0] ?? 'unknown'
  const conflict = s.conflict
  return {
    company_id: id,
    customer_type: {
      value: conflict ? 'retailer' : type,
      confidence: conflict ? 0.86 : 0.82,
      evidence: [s.fakeCitation ? fake : ctQuote],
    },
    import_signal: {
      value: conflict ? 'contradicted' : s.competitor ? 'contradicted' : s.importSignal,
      confidence: conflict ? 0.9 : 0.9,
      evidence: [s.fakeCitation ? fake : imQuote],
    },
    size_estimate: {
      tier: s.size === 'XL' ? 'L' : s.size,
      employee_range: [Math.max(1, s.employees - 8), s.employees + 8],
      confidence: 0.61,
      evidence: [szQuote],
    },
    negative_flags: s.competitor ? ['competitor_suspected'] : s.fakeCitation ? ['stale_page'] : [],
    notes_for_human: s.competitor ? '官网同时提供 OEM 代工，可能是同行' : undefined,
    model_id: 'deepseek-v4.1-flash',
    model_version: '2026-10-15',
    prompt_version: 'judge-v1.1.0',
    schema_version: 'schema-v1',
  }
}

function contactsFor(s: Seed, id: string): Contact[] {
  const main: Contact = {
    id: `${id}_c1`, type: 'email', value: s.contactEmail, ownerName: s.contactPerson?.split(' · ')[0],
    title: s.contactPerson?.split(' · ')[1], grade: s.grade,
    verified: s.grade === 'A' || s.grade === 'B',
    verifyCode: s.grade === 'A' ? '250 OK' : s.grade === 'D' ? '550 user unknown' : 'catch-all',
    source: s.grade === 'C' ? 'WHOIS / 官网' : '官网联系页',
    isBlacklisted: false,
  }
  return [main]
}

function tradeRecordsFor(s: Seed, id: string, features: RuleFeatures): TradeRecord[] {
  const n = Math.min(3, s.customsRecords ?? (features.importBatches24m ?? 0))
  return Array.from({ length: n }, (_, i) => ({
    id: `${id}_t${i}`,
    hsCode: '7307.19',
    productDesc: 'Hydraulic hose fittings / tube assemblies',
    originCountry: '中国',
    valueUsd: 32_000 + i * 6_500,
    tradeDate: `2026-${String(3 + i * 3).padStart(2, '0')}-12`,
    dataSource: s.customsRecords !== null ? '授权海关数据商' : '官网信号推断',
  }))
}

export function buildDemoCompanies(count = 48): Company[] {
  const out: Company[] = []
  for (let i = 0; i < count; i++) {
    const base = SEEDS[i % SEEDS.length]
    // SEEDS 为空是编程错误：宁可少造数据，也不对 undefined 取属性
    if (!base) break
    const variant = Math.floor(i / SEEDS.length)
    const suffix = variant === 0 ? '' : ` ${['North', 'Industrial', 'Global', 'Regional'][variant - 1] ?? ''}`.trim()
    const name = variant === 0 ? base.name : `${base.name}${suffix ? ` · ${suffix}` : ''}`
    const domain = variant === 0 ? base.domain : `${base.domain.split('.')[0]}${variant}.${base.domain.split('.').slice(1).join('.')}`
    const id = `c_${(i + 1).toString().padStart(4, '0')}`
    const s: Seed = { ...base, name, domain, variantLabel: suffix }
    const features = featuresFor(s, variant)
    const raw = judgementFor(s, id)
    // P1-10：演示数据是本地合成的规则事实，不是模型判断。评分卡一律按 E6005 降级口径：
    // 不把合成 judgement 喂给 buildScoreCard（α 归零）、分数显示区间、置信度标低、明确标注 DEMO。
    // raw 仅作为「本地演示证据链」保留在 company.judgement，不参与打分，也不声称来自模型。
    const scoreCard = buildScoreCard(features, null, { modelAvailable: false })
    scoreCard.warnings.push('DEMO · 评分卡为本地规则估算，未经模型校验（E6005 降级口径），不显示模型判断')
    if (s.fakeCitation) {
      scoreCard.warnings.push('E6004 演示引用无法在原文核验，相关判断已整条丢弃并回退规则分')
    }
    const status = ((['new', 'new', 'drafted', 'sent', 'replied', 'interested', 'quoted', 'won', 'bounced', 'unsubscribed'] as const)[i % 10]) ?? 'new'
    const firstSeen = new Date(Date.UTC(2026, 10, 6 - (i % 6), 8 + (i % 8), 12)).toISOString()
    out.push({
      id, domain, name, nameLocal: undefined, country: s.country, flag: s.flag, city: s.city,
      website: `https://${domain}`, foundedYear: s.founded,
      employeeRange: `${Math.max(1, s.employees - 8)}–${s.employees + 8} 人`,
      revenueRange: s.size === 'M' ? '$5M–$15M' : s.size === 'L' ? '$20M–$80M' : undefined,
      sizeTier: s.size, categories: s.categories, description: s.description,
      brands: s.brands, customerTypes: s.types, features, judgement: raw, scoreCard,
      contacts: contactsFor(s, id), tradeRecords: tradeRecordsFor(s, id, features),
      status, sourceTaskId: 'task_demo_001', firstSeenAt: firstSeen,
      lastContactAt: ['sent', 'replied', 'interested', 'quoted', 'won', 'bounced'].includes(status) ? firstSeen : null,
      nextFollowAt: status === 'quoted' ? '2026-11-12' : null,
      note: '', demo: true,
      statusLog: [{
        id: `sl_init_${id}`, from: null, to: 'new', operator: '系统', automated: false,
        note: '演示数据入库', createdAt: firstSeen,
      }],
      followups: status === 'quoted' ? [{ id: `fu_${id}`, dueDate: '2026-11-12', content: '报价后跟进', channel: '邮件', done: false }] : [],
    })
    const c = out[out.length - 1]
    if (status !== 'new' && c) {
      c.statusLog.push({
        id: `sl_${id}_s`, from: 'new', to: status, operator: '本地用户', automated: false,
        note: '演示状态', createdAt: firstSeen,
      })
    }
  }
  return out
}

export const DEMO_TASK_ID = 'task_demo_001'
export const DEMO_COMPANY_COUNT = 48
