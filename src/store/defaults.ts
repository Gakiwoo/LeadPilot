/**
 * P3-6 · store 的初始值常量（纯数据，无副作用）
 *
 * 从 useAppStore.ts 原样搬出，不改任何字段。`DEFAULT_FILTERS` 原来在初始 state 与
 * `resetDemo` 里各写一遍字面量，搬出来顺带消掉这份重复 —— 但取值一个字没动。
 */
import type { Settings } from '@/types'
import type { Filters } from './types'

export const DEFAULT_SETTINGS: Settings = {
  profile: {
    companyNameEn: 'Shenzhen Koude Precision Co., Ltd.',
    companyNameZh: '深圳寇德精密制品有限公司',
    address: 'Building 4, Longhua Industrial Park, Shenzhen, Guangdong, China',
    website: 'https://www.koude.example',
    mainProducts: 'hydraulic hose fittings, brass fittings, JIC adapters',
    advantages: ['15-day lead time on repeat SKUs', 'small-batch customization from 500 pcs'],
    certifications: 'ISO 9001:2015',
    moq: '500 pcs',
    leadTime: '15 days',
    caseStudies: 'Distributor in Rotterdam, 3 years, 12 containers/year',
    senderName: 'Jiaqi Wu',
    senderTitle: 'Export Manager',
    phone: '+86 138 0000 0000',
  },
  pointsBalance: 2000,
  plan: '专业版 · ¥199/月',
  llm: {
    t0: 'DeepSeek V4.1-Flash（谷时）', t1: 'DeepSeek V4-Pro（谷时）', t2: 'OpenAI GPT-5',
    byokEnabled: false, byokProvider: 'DeepSeek', regionPolicy: 'domestic_first',
  },
  gmail: { connected: false, email: '', scope: 'gmail.compose（MVP 仅草稿）', dailyLimit: 100, sentToday: 18, warmupDay: 7 },
  blacklist: ['blacklisted-company.example'],
  demoMode: true,
}

export const DEFAULT_FILTERS: Filters = {
  quick: 'all', search: '', sort: 'default', minScore: 0, hideCompetitors: true, grade: 'ALL',
}
