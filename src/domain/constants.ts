import type {
  CompanyStatus,
  Confidence,
  ContactGrade,
  CustomerType,
  Depth,
  DimensionKey,
  SizeTier,
} from '@/types'
import protocol from '../../shared/model-protocol.json'

/** PRD 第 6 章：综合分权重 */
export const DIMENSION_WEIGHTS: Record<DimensionKey, number> = {
  match: 0.3,
  propensity: 0.25,
  size: 0.15,
  import: 0.2,
  contact: 0.1,
}

export const DIMENSION_LABELS: Record<DimensionKey, { zh: string; en: string; short: string }> = {
  match: { zh: '匹配度', en: 'Match', short: '匹配度' },
  propensity: { zh: '采购概率', en: 'Propensity', short: '采购概率' },
  size: { zh: '公司规模', en: 'Size', short: '规模' },
  import: { zh: '进口可能性', en: 'Import Likelihood', short: '进口可能' },
  contact: { zh: '联系方式质量', en: 'Contact Quality', short: '联系方式' },
}

/** PRD 6.6：分级 → 分数映射 */
export const SIZE_SCORE: Record<SizeTier, number> = { S: 55, M: 75, L: 90, XL: 80, unknown: 0 }
export const CONTACT_SCORE: Record<ContactGrade, number> = { A: 100, B: 75, C: 45, D: 10 }

/** PRD 6.7.5：各维度的「规则 / 模型」参与度，用作 α 的分维上限（共享协议单一真源） */
export const MODEL_PARTICIPATION: Record<DimensionKey, number> = protocol.modelParticipation
export const ALPHA_HARD_CAP = protocol.rules.alphaHardCap
export const CONFLICT_THRESHOLD = protocol.rules.conflictThreshold
export const PROVENANCE_RATE_MIN = protocol.rules.provenanceRateMin
export const COMPETITOR_MATCH_MIN = 92
export const COMPETITOR_IMPORT_MAX = 30

export const SIZE_LABELS: Record<SizeTier, { range: string; revenue: string; note: string }> = {
  S: { range: '1–10 人', revenue: '< $2M', note: '决策快、单量小，适合试单切入' },
  M: { range: '11–50 人', revenue: '$2M–$20M', note: '最优质区间，决策链短' },
  L: { range: '51–250 人', revenue: '$20M–$200M', note: '成熟分销商，复购稳定' },
  XL: { range: '> 250 人', revenue: '> $200M', note: '超出中小出口商服务半径' },
  unknown: { range: '未知', revenue: '未知', note: '无可用公开信息' },
}

export const GRADE_LABELS: Record<ContactGrade, { name: string; tone: string; desc: string }> = {
  A: { name: '可直发', tone: 'emerald', desc: '企业域名 + MX/SMTP 验证通过 + 关联决策人' },
  B: { name: '建议直发', tone: 'blue', desc: '企业域名验证通过，但为通用邮箱或职位不明' },
  C: { name: '需谨慎', tone: 'amber', desc: '无法验证或免费邮箱，仅单条确认后发送' },
  D: { name: '不可发', tone: 'rose', desc: 'MX 不存在 / 明确拒收 / 黑名单，禁止进入发送队列' },
}

export const CUSTOMER_TYPES: { key: CustomerType; zh: string; en: string; feature: string }[] = [
  { key: 'importer', zh: '进口商', en: 'Importer', feature: '有海关进口记录或官网明示进口业务' },
  { key: 'distributor', zh: '分销商', en: 'Distributor', feature: '代理多个品牌，有区域覆盖与经销商网络' },
  { key: 'wholesaler', zh: '批发商', en: 'Wholesaler', feature: '强调 bulk / MOQ / trade account，有仓储' },
  { key: 'brand_owner', zh: '品牌商', en: 'Brand Owner', feature: '自有商标，提供 OEM/ODM 服务页' },
  { key: 'retailer', zh: '零售商', en: 'Retailer', feature: '面向 C 端定价，无批发入口' },
  { key: 'factory', zh: '终端工厂', en: 'End User', feature: '有产线描述，采购生产耗材或配件' },
  { key: 'epc', zh: '工程商 / EPC', en: 'Contractor / EPC', feature: '按项目采购，有 tender / turnkey 表述' },
  { key: 'trader', zh: '贸易公司', en: 'Trading Company', feature: '跨品类代客采购，主营描述宽泛' },
]

export const IMPORT_SIGNAL_SCORE: Record<string, number> = {
  confirmed: 90,
  inferred: 70,
  contradicted: 20,
  // no_signal → 沿用 rule_score，不作惩罚
}

export const STATUS_DEFS: {
  key: CompanyStatus
  zh: string
  en: string
  tone: string
  automated?: boolean
  terminal?: boolean
}[] = [
  { key: 'new', zh: '新建', en: 'New', tone: 'slate' },
  { key: 'drafted', zh: '已生成草稿', en: 'Drafted', tone: 'indigo', automated: true },
  { key: 'sent', zh: '已发送', en: 'Sent', tone: 'blue', automated: true },
  { key: 'delivered', zh: '已送达', en: 'Delivered', tone: 'cyan' },
  { key: 'opened', zh: '已打开', en: 'Opened', tone: 'cyan' },
  { key: 'replied', zh: '已回复', en: 'Replied', tone: 'violet', automated: true },
  { key: 'interested', zh: '有意向', en: 'Interested', tone: 'emerald' },
  { key: 'quoted', zh: '报价中', en: 'Quoted', tone: 'amber' },
  { key: 'won', zh: '已成交', en: 'Won', tone: 'emerald' },
  { key: 'not_interested', zh: '无意向', en: 'Not Interested', tone: 'slate' },
  { key: 'bounced', zh: '退信', en: 'Bounced', tone: 'rose', automated: true },
  { key: 'unsubscribed', zh: '退订/无效', en: 'Unsubscribed · Invalid', tone: 'rose', terminal: true },
]

export const AUTOMATIC_TRANSITIONS: CompanyStatus[] = ['drafted', 'sent', 'bounced', 'replied']

export const DEPTH_CONFIG: Record<Depth, {
  label: string
  duration: string
  sources: number
  pointsPerCompany: number
  hardTimeoutMin: number
  desc: string
}> = {
  1: { label: 'L1 快速', duration: '3–5 分钟', sources: 3, pointsPerCompany: 1, hardTimeoutMin: 10, desc: '仅搜索摘要 + 企业库基础字段，只做 MX 验证' },
  2: { label: 'L2 标准', duration: '8–12 分钟', sources: 5, pointsPerCompany: 2, hardTimeoutMin: 25, desc: '搜索 + 企业库 + 官网首页/联系页，MX + SMTP 验证' },
  3: { label: 'L3 深度', duration: '20–30 分钟', sources: 6, pointsPerCompany: 4, hardTimeoutMin: 50, desc: '官网 4 页深抓 + 海关关联 + 决策人识别' },
  4: { label: 'L4 极致', duration: '45–60 分钟', sources: 8, pointsPerCompany: 8, hardTimeoutMin: 90, desc: '官网 8 页 + 社媒 + 供应链关联 + 二次交叉核验' },
}

export const MARKET_PRESETS: { name: string; countries: string[] }[] = [
  { name: '欧美五国', countries: ['德国', '美国', '英国', '法国', '荷兰'] },
  { name: '东盟六国', countries: ['越南', '泰国', '印尼', '马来西亚', '菲律宾', '新加坡'] },
  { name: '中东 GCC', countries: ['阿联酋', '沙特', '卡塔尔', '科威特', '阿曼', '巴林'] },
  { name: '拉美三国', countries: ['巴西', '墨西哥', '智利'] },
  { name: '一带一路', countries: ['波兰', '土耳其', '埃及', '巴基斯坦'] },
]

/** 海关数据可得性 → 影响「进口可能性」预期管理（PRD F1-2、6.4） */
export const CUSTOMS_AVAILABILITY: Record<string, 'high' | 'mid' | 'low'> = {
  美国: 'high', 印度: 'high', 越南: 'high', 印尼: 'high', 巴西: 'high', 墨西哥: 'high', 俄罗斯: 'high',
  德国: 'mid', 荷兰: 'mid', 英国: 'mid', 法国: 'mid', 日本: 'mid', 韩国: 'mid', 意大利: 'mid', 西班牙: 'mid', 波兰: 'mid',
  阿联酋: 'low', 沙特: 'low', 埃及: 'low', 土耳其: 'low', 智利: 'low', 泰国: 'low', 马来西亚: 'low',
}

/** PRD F6-2 禁词表与字数硬限：与服务端网关共用共享协议，防止两边口径漂移 */
export const BANNED_WORDS: string[] = protocol.emailPolicy.bannedWords
export const EMAIL_LENGTH_LIMIT: Record<'short' | 'medium' | 'long', number> = protocol.emailPolicy.wordLimits

export const EMAIL_PURPOSES = [
  { key: 'intro', zh: '建立联系' },
  { key: 'quote', zh: '报价' },
  { key: 'sample', zh: '寄样' },
  { key: 'meeting', zh: '约会议' },
  { key: 'new_product', zh: '推新品' },
  { key: 'followup', zh: '二次跟进' },
]

export const TASK_STAGES = ['检索候选', '规范化', '去重', '抓取详情', '验证邮箱', '模型判断与评分']

export const ERROR_CODES = {
  E1001: '数据源配额耗尽', E1002: '目标站反爬拦截', E1003: '任务超时',
  E2001: 'Gmail 授权已过期', E2002: 'scope 不足', E2003: '账号被限制',
  E3001: '命中黑名单', E3002: '超出发送额度', E3003: '触发熔断', E3004: '邮箱等级不足',
  E4001: '点数不足', E4002: '订阅已过期',
  E5001: '数据库损坏', E5002: '网络不可用', E5003: '版本不兼容',
  E6001: 'provider 超时', E6002: '限流', E6003: 'schema 校验失败',
  E6004: '证据校验不通过', E6005: '全部 provider 不可用（降级模式）',
  E6006: 'BYOK Key 无效', E6007: '内容触发 provider 安全策略拒答',
} as const

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: '高', mid: '中', low: '低',
}
