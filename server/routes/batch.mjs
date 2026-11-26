/**
 * 批量 SDR 管道端点：导入 / 批量研判 / 批量出信 / mbox 导出 / 结果回写 / 抑制名单。
 *
 * 定位纪律：导入 = 用户投喂（origin=user_imported），导出 = 只产 mbox 草稿（导出 ≠ 发送）。
 * 熔断态（退信率 > 3%）导出返回 423。
 */
export function batchRoutes(ctx) {
  const { json, readBody } = ctx.respond
  const { batch } = ctx

  return [
    { method: 'GET', path: '/v1/batch/health', handler: (req, res) => json(res, 200, batch.state()) },
    { method: 'GET', path: '/v1/import/companies', handler: (req, res) => json(res, 200, batch.listCompanies()) },
    {
      method: 'POST',
      path: '/v1/import/companies',
      handler: async (req, res) => {
        const body = await readBody(req)
        const result = batch.importCompanies(body)
        return json(res, result.ok ? 200 : 400, result)
      },
    },
    {
      method: 'POST',
      path: '/v1/batch/judge',
      handler: async (req, res) => {
        const body = await readBody(req)
        const result = await batch.runJudgeBatch(body)
        return json(res, result.ok ? 200 : 400, result)
      },
    },
    {
      // 批量出信与导入 / 研判共用服务端客户库；降级项 body=null，不伪造正文
      method: 'POST',
      path: '/v1/batch/generate-drafts',
      handler: async (req, res) => {
        const body = await readBody(req)
        const result = await batch.generateDrafts(body)
        return json(res, result.ok ? 200 : 400, result)
      },
    },
    {
      method: 'POST',
      path: '/v1/export/eml',
      handler: async (req, res) => {
        const body = await readBody(req)
        const result = batch.exportDrafts(body)
        const status = result.ok ? 200 : result.code === 'E4010' ? 423 : 400
        return json(res, status, result)
      },
    },
    {
      method: 'POST',
      path: '/v1/import/outcomes',
      handler: async (req, res) => {
        const body = await readBody(req)
        const result = batch.importOutcomes(body)
        return json(res, result.ok ? 200 : 400, result)
      },
    },
    // G2 抑制名单由服务端登记与持久化；导出闸门不依赖调用方传参
    { method: 'GET', path: '/v1/suppressions', handler: (req, res) => json(res, 200, batch.listSuppressions()) },
    {
      method: 'POST',
      path: '/v1/import/suppressions',
      handler: async (req, res) => {
        const body = await readBody(req)
        const result = batch.importSuppressions(body)
        return json(res, result.ok ? 200 : 400, result)
      },
    },
  ]
}
