import { useEffect, useState } from 'react'
import { ListFilter, Plus, Radio, SlidersHorizontal } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { Badge } from '@/components/ui'
import TaskConfigPanel from './TaskConfig'
import ExecutionView from './ExecutionView'
import CompanyList from './CompanyList'

type Tab = 'config' | 'execution' | 'list'

export default function DeveloperView() {
  const [tab, setTab] = useState<Tab>('list')
  const tasks = useAppStore((s) => s.tasks)
  const activeTaskId = useAppStore((s) => s.activeTaskId)
  const activeTask = tasks.find((t) => t.id === activeTaskId) ?? tasks.find((t) => t.status === 'running' || t.status === 'paused')
  const lastTask = tasks[0]
  // 显式收窄：`activeTask || lastTask` 的判断无法让 TS 推断 `a ?? b` 非空
  const shownTask = activeTask ?? lastTask ?? null

  useEffect(() => {
    if (activeTask) setTab('execution')
  }, [activeTaskId]) // eslint-disable-line react-hooks/exhaustive-deps

  const tabs: { key: Tab; label: string; icon: typeof ListFilter; extra?: string }[] = [
    { key: 'list', label: '客户名单', icon: ListFilter },
    { key: 'config', label: '新建任务', icon: Plus },
    { key: 'execution', label: '执行进度', icon: Radio, extra: activeTask ? '运行中' : undefined },
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        {tabs.map(({ key, label, icon: Icon, extra }) => (
          <button key={key} onClick={() => setTab(key)} className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-medium transition ${tab === key ? 'bg-white text-brand-700 shadow-card ring-1 ring-line' : 'text-slate-600 hover:bg-white/70'}`}>
            <Icon size={13} /> {label}
            {extra && <Badge tone="blue">{extra}</Badge>}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted"><SlidersHorizontal size={12} /> 采集 → 评分 → 写信 → 发信 → 归集</span>
      </div>

      {tab === 'config' && <TaskConfigPanel />}
      {tab === 'execution' && (shownTask ? <ExecutionView task={shownTask} /> : null)}
      {tab === 'list' && <CompanyList />}
    </div>
  )
}
