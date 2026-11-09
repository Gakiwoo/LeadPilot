import { AlertTriangle, CheckCircle2, CircleDashed, Clock, CloudCog, HardDrive, Minimize2, Pause, Play, Square, TrendingUp } from 'lucide-react'
import type { DevTask } from '@/types'
import { TASK_STAGES } from '@/domain/constants'
import { useAppStore } from '@/store/useAppStore'
import { Button, Card, ProgressLine, SectionTitle, Badge } from '@/components/ui'

export default function ExecutionView({ task }: { task: DevTask }) {
  const pauseTask = useAppStore((s) => s.pauseTask)
  const resumeTask = useAppStore((s) => s.resumeTask)
  const abortTask = useAppStore((s) => s.abortTask)
  const showToast = useAppStore((s) => s.showToast)
  const p = task.progress
  const done = task.status === 'done' || task.status === 'aborted'
  const shortfall = task.config.targetCount - p.qualified

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-[15px] font-semibold text-ink">{task.name}</h3>
              <Badge tone={task.status === 'running' ? 'blue' : task.status === 'paused' ? 'amber' : task.status === 'aborted' || task.status === 'failed' ? 'rose' : 'emerald'}>
                {{ queued: '排队中', running: '执行中', paused: '已暂停', done: '已完成', failed: '失败', aborted: '已中止' }[task.status]}
              </Badge>
              <Badge tone={task.mode === 'cloud' ? 'violet' : 'slate'}>
                {task.mode === 'cloud' ? <CloudCog size={10} /> : <HardDrive size={10} />}
                {task.mode === 'cloud' ? '云端编排 · SSE' : '本地演示运行器'}
              </Badge>
              {task.status === 'queued' && (
                <Badge tone="amber">
                  <Clock size={10} /> 队列第 {task.queuePosition || 1} 位 · 并发上限 {task.maxConcurrent ?? 3}
                </Badge>
              )}
            </div>
            <p className="mt-1 text-[11px] text-muted">任务 ID {task.id} · 创建于 {new Date(task.createdAt).toLocaleString('zh-CN', { hour12: false })} · 预扣 {task.pointsEstimated} 点</p>
          </div>
          <div className="flex gap-1.5">
            {task.status === 'running' && <Button size="sm" onClick={pauseTask}><Pause size={13} /> 暂停</Button>}
            {task.status === 'paused' && <Button size="sm" variant="primary" onClick={resumeTask}><Play size={13} /> 继续</Button>}
            {!done && <Button size="sm" variant="danger" onClick={() => { abortTask(); showToast('任务已中止，已采集结果全部保留', 'warn') }}><Square size={12} /> 中止</Button>}
            <Button size="sm" onClick={() => showToast('桌面版支持最小化到托盘，完成后弹通知（Tauri 外壳待接入）')}><Minimize2 size={13} /> 后台运行</Button>
          </div>
        </div>

        <div className="mt-5 flex items-center gap-1">
          {TASK_STAGES.map((s, i) => {
            const state = i < p.stageIndex || done ? 'done' : i === p.stageIndex ? 'active' : 'todo'
            return (
              <div key={s} className="flex flex-1 items-center gap-1">
                <div className="flex-1">
                  <div className={`flex items-center gap-1 text-[10px] ${state === 'active' ? 'font-medium text-brand-600' : state === 'done' ? 'text-emerald-600' : 'text-slate-400'}`}>
                    {state === 'done' ? <CheckCircle2 size={11} /> : state === 'active' ? <CircleDashed size={11} className="animate-spin" /> : <CircleDashed size={11} />}
                    <span className="truncate">{s}</span>
                  </div>
                  <div className="mt-1"><ProgressLine value={state === 'done' ? 100 : state === 'active' ? 55 : 0} tone={state === 'done' ? 'emerald' : 'brand'} /></div>
                </div>
              </div>
            )
          })}
        </div>

        <div className="mt-5 grid grid-cols-4 gap-3">
          {[
            { label: '候选公司', value: p.candidates.toLocaleString(), sub: '检索管道发现的原始候选' },
            { label: '已入库', value: p.stored.toLocaleString(), sub: '规范化去重后写入本地' },
            { label: '已达标', value: `${p.qualified} / ${task.config.targetCount}`, sub: `达成率 ${Math.round((p.qualified / task.config.targetCount) * 100)}%` },
            { label: '预计剩余', value: `${p.etaRange[0]}–${p.etaRange[1]} 分钟`, sub: '区间估算，不显示精确到秒的假数' },
          ].map((s) => (
            <div key={s.label} className="rounded-lg border border-line bg-canvas px-3 py-2.5">
              <p className="text-[10px] text-muted">{s.label}</p>
              <p className="mt-1 text-[19px] font-semibold tabular-nums leading-6 text-ink">{s.value}</p>
              <p className="mt-0.5 truncate text-[10px] text-slate-400">{s.sub}</p>
            </div>
          ))}
        </div>

        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted"><TrendingUp size={13} className="text-brand-500" /> 前 20 条达标客户在采集过程中即写入下方列表，可提前点开细看，无需等待全部完成（F2-1 流式结果）</p>
        {task.mode === 'cloud' && task.status === 'queued' && (
          <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
            <Clock size={13} className="mt-0.5 shrink-0" />
            <span><strong>排队中不是卡死</strong>：服务端并发上限 {task.maxConcurrent ?? 3} 已满，本任务按创建顺序（FIFO）排队；任一任务完成 / 暂停 / 中止释放槽位后会自动出队启动，无需重复点击继续。排队与暂停时长不计入硬超时预算，点数预扣在排队时已完成且不会重复扣。</span>
          </p>
        )}
        {task.mode === 'cloud' && (
          <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-[11px] leading-5 text-violet-800">
            <CloudCog size={13} className="mt-0.5 shrink-0" />
            <span><strong>真实编排 ≠ 真实采集</strong>：本任务的阶段推进、计数、单源降级、暂停/续跑/中止与 SSE 推流均由云端服务真实执行；但 6 类数据源适配器与 Playwright 集群未接入，事件中的候选域名是占位标识，<strong>不会写入任何客户记录</strong>。需要带客户的完整链路请切回本地演示运行器。</span>
          </p>
        )}
      </Card>

      {shortfall > 0 && done && (
        <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <AlertTriangle size={16} className="text-amber-600" />
          <div className="text-[12px] text-amber-800">
            <strong>结果不足：</strong>目标 {task.config.targetCount}，已找到 {p.qualified}（{Math.round((p.qualified / task.config.targetCount) * 100)}%）。不静默截断，可放宽条件续采。
          </div>
          <div className="ml-auto flex gap-1.5">
            {['评分门槛 70→60', '扩展相邻国家', '扩展同义关键词'].map((x) => (
              <button key={x} className="lp-chip" onClick={() => showToast(`已记录放宽项「${x}」：真实续采需云端任务编排器支持`, 'warn')}>{x}</button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <Card className="p-4">
          <SectionTitle title="分源统计" desc="单源失败不影响整体，且必须显式告知（不允许静默降级）" />
          <div className="space-y-1.5">
            {p.sources.map((s) => (
              <div key={s.key ?? s.name} className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] ${s.status === 'warn' ? 'border-amber-200 bg-amber-50' : 'border-line'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${s.status === 'warn' ? 'bg-amber-500' : s.status === 'fail' ? 'bg-rose-500' : 'bg-emerald-500'}`} />
                <span className="font-medium text-ink">{s.name}</span>
                {s.mode === 'unconfigured' && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">未接入</span>}
                {s.mode === 'not_implemented' && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">接口未实现</span>}
                {s.mode === 'ready' && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">已就绪</span>}
                <span className="ml-auto tabular-nums text-muted">命中 {s.hits}</span>
                {s.failures > 0 && <span className="tabular-nums text-amber-700">失败 {s.failures}</span>}
              </div>
            ))}
          </div>
          <p className="mt-2 text-[10px] leading-4 text-amber-700">
            {p.sources.find((s) => s.status === 'warn')?.reason ?? '某数据源不可用时会在此标注原因，并给出完整性百分比'}
          </p>
        </Card>

        <Card className="p-4">
          <SectionTitle title="执行日志" desc={task.mode === 'cloud' ? '事件来自云端 SSE 单向推送，游标由编排器持久化，控制指令走独立 POST' : '断点续跑游标与阶段状态持久化在客户端（演示用 localStorage）'} extra={<span className="lp-chip"><Clock size={11} /> 最近 {p.log.length} 条</span>} />
          <div className="h-[186px] space-y-1 overflow-y-auto rounded-lg bg-slate-900 p-2.5 font-mono text-[10px] leading-4">
            {[...p.log].reverse().map((l, i) => (
              <div key={i} className={l.level === 'warn' ? 'text-amber-300' : l.level === 'error' ? 'text-rose-300' : 'text-slate-300'}>
                <span className="mr-2 text-slate-500">{l.at}</span>{l.text}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
