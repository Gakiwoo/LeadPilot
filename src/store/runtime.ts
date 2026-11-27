/**
 * P3-6 · store 的运行时句柄（不属于可序列化 state）
 *
 * 这些是「生命周期对象」而不是数据：定时器句柄、任务运行器、云端 SSE 关闭函数与游标。
 * 它们必须活在模块作用域（而不是 state 里），否则每次 setState 都会把它们当成数据对待：
 * React 会尝试 diff 一个 TaskRunner 实例，持久化也会试图塞进 localStorage。
 *
 * 拆 slice 时最容易搞错的一点：`cloudCursor` 同时被 task slice（续跑时回传）和
 * cloud-events（收到事件时更新）读写，所以必须抽到这里，不能各留一份。
 */
import type { TaskRunner } from '@/services/adapters'

export interface StoreRuntime {
  runner: TaskRunner | null
  toastTimer: ReturnType<typeof setTimeout> | null
  cloudClose: (() => void) | null
  cloudTaskId: string | null
  cloudCursor: unknown
}

export const runtime: StoreRuntime = {
  runner: null,
  toastTimer: null,
  cloudClose: null,
  cloudTaskId: null,
  cloudCursor: null,
}

/** 演示重置用：停掉运行器、断开云端订阅、清空会话句柄（保留 toast 定时器） */
export function resetTaskRuntime(): void {
  runtime.runner?.dispose()
  runtime.runner = null
  runtime.cloudClose?.()
  runtime.cloudClose = null
  runtime.cloudTaskId = null
  runtime.cloudCursor = null
}
