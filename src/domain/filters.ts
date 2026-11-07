/** F3-2 筛选与排序：默认「可发信优先 + 综合分降序」 */
import type { Company } from '@/types'
import type { Filters } from '@/store/useAppStore'

export function filterAndSort(companies: Company[], f: Filters): Company[] {
  const q = f.search.trim().toLowerCase()
  const list = companies.filter((c) => {
    if (f.hideCompetitors && c.scoreCard.competitorFlag) return false
    if (c.scoreCard.totalScore < f.minScore) return false
    if (f.grade !== 'ALL' && c.contacts[0]?.grade !== f.grade) return false
    if (q) {
      const hay = [c.name, c.domain, c.note, ...c.contacts.map((x) => x.value)].join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    switch (f.quick) {
      case 'high_match': return c.scoreCard.dimensions.match.score >= 80
      case 'sendable': return ['A', 'B'].includes(c.contacts[0]?.grade ?? '')
      case 'with_customs': return c.features.customsRecords !== null
      case 'uncontacted': return c.status === 'new'
      case 'replied': return ['replied', 'interested', 'quoted', 'won'].includes(c.status)
      default: return true
    }
  })

  const gradeRank: Record<string, number> = { A: 4, B: 3, C: 2, D: 1 }
  return list.sort((a, b) => {
    switch (f.sort) {
      case 'total': return b.scoreCard.totalScore - a.scoreCard.totalScore
      case 'propensity': return b.scoreCard.dimensions.propensity.score - a.scoreCard.dimensions.propensity.score
      case 'import': return b.scoreCard.dimensions.import.score - a.scoreCard.dimensions.import.score
      case 'name': return a.name.localeCompare(b.name)
      case 'discovered': return new Date(b.firstSeenAt).getTime() - new Date(a.firstSeenAt).getTime()
      default:
        // ORDER BY can_send DESC, total_score DESC（PRD 6.6）
        const send = Number(b.scoreCard.canSend) - Number(a.scoreCard.canSend)
        if (send !== 0) return send
        const grade = (gradeRank[b.contacts[0]?.grade ?? 'D'] ?? 0) - (gradeRank[a.contacts[0]?.grade ?? 'D'] ?? 0)
        if (grade !== 0) return grade
        return b.scoreCard.totalScore - a.scoreCard.totalScore
    }
  })
}

export const QUICK_FILTERS: { key: Filters['quick']; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'high_match', label: '高匹配 ≥80' },
  { key: 'sendable', label: '可直发 A·B' },
  { key: 'with_customs', label: '有进口记录' },
  { key: 'uncontacted', label: '未联系' },
  { key: 'replied', label: '已回复' },
]
