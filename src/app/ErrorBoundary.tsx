/**
 * 顶层错误边界。
 *
 * 本产品的核心承诺是「不假装知道」：渲染崩溃时也不允许白屏假装一切正常。
 * 这里只展示「发生了什么 / 你可以怎么做」，堆栈只进控制台，不渲染进 DOM。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'

interface Props {
  children: ReactNode
  /** 便于测试注入，生产不传 */
  onError?: (error: Error, info: ErrorInfo) => void
}

interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 只进控制台（含组件栈），绝不把堆栈渲染给终端用户
    // eslint-disable-next-line no-console
    console.error('[LeadPilot] 界面渲染失败：', error, info.componentStack)
    this.props.onError?.(error, info)
  }

  private reset = (): void => {
    this.setState({ error: null })
  }

  private reload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="flex h-screen w-screen items-center justify-center bg-canvas px-6" role="alert" aria-live="assertive">
        <div className="w-full max-w-lg rounded-xl border border-line bg-white p-6 shadow-card">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-50 text-rose-600">
              <AlertTriangle size={18} />
            </span>
            <div className="min-w-0">
              <h1 className="text-[15px] font-semibold text-ink">界面渲染失败，已停止渲染以免展示错误数据</h1>
              <p className="mt-1 text-[12px] leading-5 text-muted">
                发生了什么：某个视图在渲染时抛出异常。可能原因：本地缓存的旧数据结构与当前版本不兼容，
                或某条客户数据缺字段。堆栈只写入浏览器控制台，不上报、不展示。
              </p>
              <p className="mt-2 break-words rounded-md bg-canvas px-2 py-1.5 font-mono text-[11px] text-slate-600">
                {error.message || '未知错误'}
              </p>
            </div>
          </div>
          <div className="mt-5 flex items-center gap-2">
            <button
              onClick={this.reset}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-[12px] font-medium text-white transition hover:bg-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100"
            >
              <RotateCcw size={13} /> 重新尝试渲染
            </button>
            <button
              onClick={this.reload}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-2 text-[12px] font-medium text-slate-700 transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-brand-50"
            >
              重新加载页面
            </button>
            <span className="ml-auto text-[11px] text-muted">若反复失败，可在设置页重置演示数据</span>
          </div>
        </div>
      </div>
    )
  }
}
