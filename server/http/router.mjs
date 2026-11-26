/**
 * 极简表驱动路由。
 *
 * 替代 index.mjs 里 400+ 行的 if/else 链：静态路径走 O(1) 精确匹配，
 * 仅 /v1/tasks/:id 这类动态段走正则。新增端点只需在 routes/ 下注册一行，
 * 不必再在入口函数里插一段 if。
 */
export function createRouter(routeGroups) {
  const exact = new Map()
  const patterns = []

  for (const route of routeGroups.flat()) {
    if (typeof route.path === 'string') {
      exact.set(`${route.method} ${route.path}`, route)
    } else {
      patterns.push(route)
    }
  }

  return {
    /** 返回 { route, params } 或 null */
    match(method, path) {
      const hit = exact.get(`${method} ${path}`)
      if (hit) return { route: hit, params: [] }
      for (const route of patterns) {
        if (route.method !== method) continue
        const m = route.path.exec(path)
        if (m) return { route, params: m }
      }
      return null
    },
    get size() { return exact.size + patterns.length },
  }
}
