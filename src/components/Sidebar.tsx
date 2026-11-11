import { Compass, LayoutGrid, Mail, Settings2, RotateCcw, Radar, CircleDot } from 'lucide-react'
import { useAppStore, type ViewKey } from '@/store/useAppStore'
import { ADAPTER_STATUS } from '@/services/adapters'
import pkg from '../../package.json'

const NAV: { key: ViewKey; label: string; en: string; icon: typeof Compass }[] = [
  { key: 'developer', label: '客户开发', en: 'Developer', icon: Compass },
  { key: 'crm', label: '客户管理', en: 'CRM', icon: LayoutGrid },
  { key: 'outreach', label: '发信中心', en: 'Outreach', icon: Mail },
  { key: 'settings', label: '设置', en: 'Settings', icon: Settings2 },
]

export default function Sidebar() {
  const activeView = useAppStore((s) => s.activeView)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const companies = useAppStore((s) => s.companies)
  const resetDemo = useAppStore((s) => s.resetDemo)
  const gateway = useAppStore((s) => s.gateway)
  const probing = useAppStore((s) => s.probing)
  const probeGateway = useAppStore((s) => s.probeGateway)

  return (
    <aside className="flex h-full w-[228px] shrink-0 flex-col border-r border-line bg-white">
      <div className="flex items-center gap-2.5 px-5 py-[18px]">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 text-white shadow-sm"><Radar size={18} /></div>
        <div>
          <div className="text-[15px] font-semibold leading-4 tracking-tight text-ink">LeadPilot <span className="font-normal text-muted">猎客</span></div>
          <div className="mt-1 text-[11px] tracking-wide text-muted">B2B 客户开发工作台</div>
        </div>
      </div>

      <nav className="mt-2 space-y-0.5 px-3">
        {NAV.map(({ key, label, en, icon: Icon }) => {
          const active = key === activeView
          return (
            <button
              key={key}
              onClick={() => setActiveView(key)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition ${
                active ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <Icon size={16} className={active ? 'text-brand-600' : 'text-slate-400'} />
              <span className="text-[13px]">{label}</span>
              <span className={`ml-auto text-[11px] ${active ? 'text-brand-500' : 'text-slate-300'}`}>{en}</span>
            </button>
          )
        })}
      </nav>

      <div className="mx-3 mt-5 rounded-lg border border-line bg-canvas px-3 py-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-700">
            <CircleDot size={12} className={gateway?.online ? 'text-emerald-500' : 'text-amber-500'} /> 接入状态
          </div>
          <button onClick={() => probeGateway()} disabled={probing} className="text-[11px] text-brand-600 hover:underline disabled:opacity-50">
            {probing ? '检测中…' : '重新检测'}
          </button>
        </div>
        <ul className="space-y-1.5 text-[11px] text-muted">
          <li className="flex items-center justify-between"><span>采集数据源</span><span className="text-amber-600">{ADAPTER_STATUS.datasource.mode === 'mock' ? '编排器在线·源未接' : '未接入'}</span></li>
          <li className="flex items-center justify-between"><span>LLM 网关</span>
            <span className={gateway?.online ? (gateway.mode === 'configured' ? 'text-emerald-600' : 'text-amber-600') : 'text-slate-400'}>
              {!gateway ? '检测中' : !gateway.online ? '离线' : gateway.mode === 'configured' ? `在线 · ${gateway.configuredCount}/${gateway.totalProviders} 家已配` : '在线 · 未配 Key'}
            </span>
          </li>
          <li className="flex items-center justify-between"><span>Gmail API</span><span className="text-amber-600">未接入</span></li>
          <li className="flex items-center justify-between"><span>评分引擎</span><span className="text-emerald-600">本地运行</span></li>
        </ul>
        <p className="mt-2 border-t border-line pt-2 text-[11px] leading-4 text-slate-400">
          {gateway?.online
            ? gateway.mode === 'configured'
              ? '网关已配置 Key，可发起真实判断；未配置的 provider 仍留空位。'
              : '网关在线但未配置任何 API Key，判断请求会明确返回 E6005 降级。'
            : (gateway?.reason ?? '正在探测本地云端服务…')}
        </p>
      </div>

      <div className="mt-auto px-3 pb-4">
        <div className="mb-2 flex items-center justify-between px-1 text-[11px] text-muted">
          <span>本地客户库</span><span className="font-medium tabular-nums text-ink">{companies.length} 家</span>
        </div>
        <button
          onClick={resetDemo}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-line px-2 py-1.5 text-[11px] text-slate-500 transition hover:bg-slate-50 hover:text-ink"
        >
          <RotateCcw size={12} /> 重置演示数据
        </button>
        <p className="mt-2 text-center text-[11px] text-slate-300">v{pkg.version}·内部预览</p>
      </div>
    </aside>
  )
}
