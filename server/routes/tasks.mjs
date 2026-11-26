/**
 * 云端任务端点：创建 / 列出 / 快照 / SSE 订阅 / 暂停 / 继续 / 中止。
 *
 * SSE 用原生 fetch 流式读取（前端侧），服务端只做单向推送；
 * 事件带 demo:true —— 数据源适配器未接入时不得让调用方以为拿到了真实客户记录。
 */
export function taskRoutes(ctx) {
  const { json, fail, readBody } = ctx.respond
  const { orchestrator, security } = ctx

  /** SSE 订阅：hello 先发当前快照，再订阅增量事件 */
  function sse(req, res, taskId) {
    const task = orchestrator.getTask(taskId)
    if (!task) {
      fail(res, 404, 'E1003', '任务不存在', '任务 ID 有误或已被清理', '重新创建任务')
      return
    }
    security.cors(res)
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    send('hello', {
      taskId, snapshot: task, demo: true,
      note: 'SSE 为真实推送；数据源适配器未接入，事件中的候选域名为占位标识',
    })
    const unsub = orchestrator.subscribe(taskId, (evt) => send(evt.type, evt))
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000)
    req.on('close', () => { clearInterval(keepAlive); unsub() })
  }

  return [
    {
      method: 'GET',
      path: '/v1/tasks',
      handler: (req, res) => json(res, 200, { tasks: orchestrator.listTasks() }),
    },
    {
      method: 'POST',
      path: '/v1/tasks',
      handler: async (req, res) => {
        const body = await readBody(req)
        if (!body.keywords?.length || !body.markets?.length) {
          return fail(res, 400, 'E1003', '任务参数不完整', '关键词与目标市场为必填项', '补全参数后重新提交')
        }
        const created = orchestrator.createTask(body)
        if (created?.ok === false) {
          // 预扣失败：不创建任务、不扣点、不伪造 201
          return fail(res, 402, created.code ?? 'E4001',
            '点数预扣失败，任务未创建',
            created.reason ?? '账本拒绝预扣',
            created.action ?? '降低目标数量或采集深度后重试')
        }
        return json(res, 201, { ok: true, task: created, demo: true })
      },
    },
    {
      method: 'GET',
      path: /^\/v1\/tasks\/([^/]+)\/events$/,
      handler: (req, res, url, params) => sse(req, res, params[1]),
    },
    {
      method: 'GET',
      path: /^\/v1\/tasks\/([^/]+)$/,
      handler: (req, res, url, params) => {
        const task = orchestrator.getTask(params[1])
        return task
          ? json(res, 200, { ok: true, task })
          : fail(res, 404, 'E1003', '任务不存在', 'ID 有误或已清理', '重新创建任务')
      },
    },
    {
      method: 'POST',
      path: /^\/v1\/tasks\/([^/]+)\/(pause|resume|abort)$/,
      handler: async (req, res, url, params) => {
        const [, id, action] = params
        const body = await readBody(req)
        const task = action === 'pause' ? orchestrator.pause(id)
          : action === 'abort' ? orchestrator.abort(id)
            : orchestrator.resume(id, body.cursor)
        return task
          ? json(res, 200, { ok: true, task })
          : fail(res, 409, 'E1003', '任务状态不允许该操作', '任务已完成或不存在', '检查任务状态后重试')
      },
    },
  ]
}
