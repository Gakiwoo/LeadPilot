import { Coins, FlaskConical, MailCheck, Search, ServerCog, Wifi } from 'lucide-react'
import { useAppStore, type ViewKey } from '@/store/useAppStore'

const HEAD: Record<ViewKey, { title: string; desc: string }> = {
  developer: { title: '客户开发', desc: '配置任务 → 采集 → 五维评分 → 可发信名单' },
  crm: { title: '客户管理', desc: '表格 / 看板 / 跟进 / 导出，线索资产归集' },
  outreach: { title: '发信中心', desc: '开发信生成 · 草稿队列 · 发送闸门' },
  settings: { title: '设置', desc: '公司资料 · 模型路由 · Gmail · 额度与隐私' },
}

export default function TopBar() {
  const activeView = useAppStore((s) => s.activeView)
  const settings = useAppStore((s) => s.settings)
  const filters = useAppStore((s) => s.filters)
  const setFilters = useAppStore((s) => s.setFilters)
  const gateway = useAppStore((s) => s.gateway)
  const head = HEAD[activeView]
  const gatewayLabel = !gateway ? '网关检测中' : !gateway.online ? '网关离线' : gateway.mode === 'configured' ? `网关在线 · ${gateway.configuredCount} 家` : '网关在线 · 未配 Key'
  const gatewayTone = !gateway?.online ? 'border-line bg-white text-slate-500' : gateway.mode === 'configured' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'

  return (
    <header className="flex h-[62px] shrink-0 items-center gap-4 border-b border-line bg-white px-6">
      <div className="min-w-0">
        <h1 className="text-[16px] font-semibold leading-5 text-ink">{head.title}</h1>
        <p className="mt-0.5 truncate text-[11px] text-muted">{head.desc}</p>
      </div>

      <div className="ml-auto flex items-center gap-2.5">
        {activeView === 'developer' && (
          <div className="relative w-56">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={filters.search}
              onChange={(e) => setFilters({ search: e.target.value })}
              placeholder="搜索公司 / 域名 / 邮箱"
              className="lp-input h-8 pl-8 text-[12px]"
            />
          </div>
        )}
        <div className="flex items-center gap-1.5 rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[11px] text-slate-600">
          <Coins size={13} className="text-amber-500" />
          <span className="tabular-nums font-medium text-ink">{settings.pointsBalance.toLocaleString()}</span> 点
        </div>
        <div className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-700">
          <Wifi size={13} /> 本地评分引擎在线
        </div>
        <div title={gateway?.reason ?? '云端网关实时探测结果；未配置 API Key 时判断请求明确降级为 E6005'} className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] ${gatewayTone}`}>
          <ServerCog size={13} /> {gatewayLabel}
        </div>
        <div className="flex items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5 text-[11px] text-slate-600">
          <MailCheck size={13} className={settings.gmail.connected ? 'text-emerald-500' : 'text-slate-400'} />
          {settings.gmail.connected ? settings.gmail.email : 'Gmail 未授权'}
        </div>
        <div
          title={gateway?.mode === 'configured'
            ? '模型网关已配置 Key，可发起真实判断；采集数据源与 Gmail 仍未接入，客户记录仍为演示数据'
            : '采集、模型、Gmail 均未真实接入，客户记录为演示数据'}
          className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] font-medium text-amber-700"
        >
          <FlaskConical size={13} /> {gateway?.mode === 'configured' ? '混合模式' : 'DEMO'}
        </div>
      </div>
    </header>
  )
}
