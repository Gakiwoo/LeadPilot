/**
 * 用户指定 URL 抓取端点（ADR-032）。
 *
 * 抓取 ≠ 采集：只抓调用方显式给出的 URL，不发现、不爬全站、不猜地址；
 * 商业数据源仍如实 0/6，抓取单独计数。
 */
export function sourceRoutes(ctx) {
  const { json, fail, readBody } = ctx.respond
  const { fetcher, batch } = ctx

  return [
    { method: 'GET', path: '/v1/sources/health', handler: (req, res) => json(res, 200, fetcher.health()) },
    {
      method: 'POST',
      path: '/v1/sources/fetch',
      handler: async (req, res) => {
        const body = await readBody(req)
        if (!Array.isArray(body.urls) || !body.urls.length) {
          return fail(res, 400, 'E4011', '抓取请求不合法',
            'urls 必须是非空数组，且每个地址由调用方显式提供',
            '传 { urls: ["https://example.com/about"] } 后重试')
        }
        const result = await fetcher.fetchMany(body.urls)
        return json(res, result.ok ? 200 : 400, result)
      },
    },
    {
      method: 'POST',
      path: '/v1/batch/fetch-sources',
      handler: async (req, res) => {
        const body = await readBody(req)
        const result = await batch.fetchSources(body)
        return json(res, result.ok ? 200 : 400, result)
      },
    },
  ]
}
