import { useEffect } from 'react'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import Sidebar from '@/components/Sidebar'
import TopBar from '@/components/TopBar'
import DeveloperView from '@/components/developer/DeveloperView'
import CompanyDetail from '@/components/developer/CompanyDetail'
import CrmView from '@/components/crm/CrmView'
import OutreachView from '@/components/outreach/OutreachView'
import EmailComposer from '@/components/outreach/EmailComposer'
import SettingsView from '@/components/settings/SettingsView'
import { useAppStore } from '@/store/useAppStore'

function Toast() {
  const toast = useAppStore((s) => s.toast)
  const clearToast = useAppStore((s) => s.clearToast)
  if (!toast) return null
  const styles = {
    info: { cls: 'border-brand-100 bg-white text-ink', icon: <Info size={15} className="text-brand-500" /> },
    ok: { cls: 'border-emerald-200 bg-emerald-50 text-emerald-800', icon: <CheckCircle2 size={15} className="text-emerald-600" /> },
    warn: { cls: 'border-amber-200 bg-amber-50 text-amber-800', icon: <AlertTriangle size={15} className="text-amber-600" /> },
    error: { cls: 'border-rose-200 bg-rose-50 text-rose-800', icon: <XCircle size={15} className="text-rose-600" /> },
  }[toast.tone]
  return (
    <div className={`lp-fade fixed bottom-5 right-5 z-[60] flex max-w-[440px] items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[12px] shadow-lg ${styles.cls}`}>
      <span className="mt-0.5 shrink-0">{styles.icon}</span>
      <span className="leading-5">{toast.message}</span>
      <button onClick={clearToast} className="ml-1 shrink-0 opacity-50 hover:opacity-100"><X size={13} /></button>
    </div>
  )
}

export default function App() {
  const activeView = useAppStore((s) => s.activeView)
  const companies = useAppStore((s) => s.companies)
  const drawerCompanyId = useAppStore((s) => s.drawerCompanyId)
  const composerCompanyId = useAppStore((s) => s.composerCompanyId)
  const openCompany = useAppStore((s) => s.openCompany)
  const openComposer = useAppStore((s) => s.openComposer)
  const probeGateway = useAppStore((s) => s.probeGateway)
  const undo = useAppStore((s) => s.undo)
  const gateway = useAppStore((s) => s.gateway)

  useEffect(() => {
    // 启动时探测云端网关。离线时也保留状态，界面明确显示「网关离线」，不伪造在线。
    void probeGateway()
  }, [probeGateway])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { openCompany(null); openComposer(null) }
      // PRD 8.4：状态变更支持 Ctrl+Z / Cmd+Z 撤销，保留 5 步
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        const el = e.target as HTMLElement | null
        if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
        e.preventDefault()
        undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openCompany, openComposer, undo])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-canvas text-ink">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {activeView === 'developer' && <DeveloperView />}
          {activeView === 'crm' && <CrmView />}
          {activeView === 'outreach' && <OutreachView />}
          {activeView === 'settings' && <SettingsView />}
          <div className="mt-6 border-t border-line pt-3 text-center text-[10px] leading-4 text-slate-400">
            LeadPilot 猎客 · PRD v1.1 · 评分引擎 / 状态机 / 合规校验 / 云端网关与任务编排为真实实现
            {gateway == null || gateway.mode === 'offline'
              ? ' · 云端服务不可达（offline）：请启动 npm run cloud，这不是 E6005 未配 Key'
              : gateway.mode === 'configured'
                ? ' · 模型网关已配 Key，可发起真实判断；采集数据源与 Gmail 仍为演示适配器'
                : ' · 未配置任何 API Key：模型判断明确返回 E6005 降级，不伪造结果'}
            <br />客户记录始终为演示数据；本界面不构成法律意见，正式上线前需就 PIPL 与 GDPR 取得执业律师专项意见。
          </div>
        </main>
      </div>
      <CompanyDetail company={companies.find((c) => c.id === drawerCompanyId) ?? null} onClose={() => openCompany(null)} />
      {/* P1-16：key 随开关变化强制重挂载，关闭再打开同一家公司也不会残留正文 / 标注 / 生成结果 */}
      <EmailComposer key={composerCompanyId ?? 'composer-closed'} company={companies.find((c) => c.id === composerCompanyId) ?? null} onClose={() => openComposer(null)} />
      <Toast />
    </div>
  )
}
