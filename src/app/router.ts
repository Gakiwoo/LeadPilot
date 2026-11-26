/**
 * 哈希路由：把「当前视图」与「详情抽屉打开的是哪家客户」写进 URL。
 *
 * 为什么用 hash 而不是 history：
 *  - 构建产物 `base: './'` 可被 Tauri 2 直接复用作 frontendDist，file:// 下只有 hash 稳定；
 *  - 不需要服务端为每条前端路由配 rewrite。
 *
 * URL 形态：`#/developer`、`#/crm/company_xxx`。
 * 非法视图一律回落到 developer，不做静默猜测。
 */
import type { ViewKey } from '@/store/useAppStore'

export const ROUTE_VIEWS: readonly ViewKey[] = ['developer', 'crm', 'outreach', 'settings']

export interface Route {
  view: ViewKey
  companyId: string | null
}

const isView = (v: string): v is ViewKey => (ROUTE_VIEWS as readonly string[]).includes(v)

/** 解析 `#/crm/company_1` → { view: 'crm', companyId: 'company_1' } */
export function parseHash(hash: string): Route {
  const raw = String(hash ?? '').replace(/^#\/?/, '')
  const [viewPart, companyPart] = raw.split('/')
  const view = viewPart && isView(viewPart) ? viewPart : 'developer'
  const companyId = companyPart ? decodeURIComponent(companyPart) : null
  return { view, companyId: companyId || null }
}

/** 生成规范化的 hash（空视图回落 developer） */
export function toHash(view: ViewKey, companyId: string | null): string {
  const base = `#/${isView(view) ? view : 'developer'}`
  return companyId ? `${base}/${encodeURIComponent(companyId)}` : base
}
