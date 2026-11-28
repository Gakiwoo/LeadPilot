/**
 * P3-6 · store 组合根（对外契约唯一出口）
 *
 * 这个文件以前是 719 行的巨石，现在只做三件事：拼 slice、注入初始数据、挂持久化。
 * **对外形状一个字都没改**：组件仍然 `useAppStore((s) => s.xxx)`，
 * `ViewKey` 等类型仍然从这里导出，任何调用方都不需要改一行。
 *
 * 拆分边界（各自只碰自己那摊事）：
 *  - slices/ui.ts         视图 / 抽屉 / 筛选 / 选中 / Toast
 *  - slices/task.ts       任务启动与暂停继续中止（唯一会扣点的地方）
 *  - slices/company.ts    客户状态机与撤销
 *  - slices/outreach.ts   本地草稿队列（自动流转 + G2 硬拦）
 *  - slices/templates.ts  模板库（F11：保存前必过校验，内置不可删/不可覆盖）
 *  - slices/settings.ts   设置与点数镜像
 *  - slices/gateway.ts    网关探测与单家客户重新研判
 *  - slices/reset.ts      演示重置（唯一跨全字段的动作）
 *  - cloud-events.ts      SSE 事件 → 任务进度
 *  - persistence.ts       节流落盘
 *  - runtime.ts           非数据的生命周期句柄（运行器 / 定时器 / SSE 游标）
 *  - demo-bootstrap.ts    演示数据与初始 state
 *  - defaults.ts          初始常量
 */
import { create } from 'zustand'
import type { AppState } from './types'
import { createUiSlice } from './slices/ui'
import { createTaskSlice } from './slices/task'
import { createCompanySlice } from './slices/company'
import { createOutreachSlice } from './slices/outreach'
import { createTemplatesSlice } from './slices/templates'
import { createSettingsSlice } from './slices/settings'
import { createGatewaySlice } from './slices/gateway'
import { createResetSlice } from './slices/reset'
import {
  initialCompanies, initialOutreach, initialSettings, initialTasks, initialTemplates,
} from './demo-bootstrap'
import { bindPersistence } from './persistence'

// 兼容既有导入路径：组件与路由仍从这里取类型
export type { Filters, QuickFilter, SortKey, ViewKey, ToastTone } from './types'

export const useAppStore = create<AppState>()((...a) => ({
  ...createUiSlice(...a),
  ...createTaskSlice(...a),
  ...createCompanySlice(...a),
  ...createOutreachSlice(...a),
  ...createTemplatesSlice(...a),
  ...createSettingsSlice(...a),
  ...createGatewaySlice(...a),
  ...createResetSlice(...a),
  // 初始数据只由 demo-bootstrap 提供，放在最后确保不会被切片里的默认值盖掉
  companies: initialCompanies,
  tasks: initialTasks,
  outreach: initialOutreach,
  settings: initialSettings,
  templates: initialTemplates,
}))

bindPersistence(useAppStore)
