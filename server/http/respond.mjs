/**
 * HTTP 响应与请求体工具：统一 JSON 形状、统一错误文案、统一请求体上限。
 *
 * PRD A.2：错误文案必须是「发生了什么 + 可能原因 + 你可以怎么做 + 错误码」。
 */
import { MAX_BODY } from '../config.mjs'

export function createResponder({ cors }) {
  function json(res, status, body) {
    cors(res)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  function fail(res, status, code, what, why, action) {
    json(res, status, {
      ok: false, code,
      what, why, action,
      message: `${what}。可能原因：${why}。你可以：${action}（${code}）`,
    })
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      let tooLarge = false
      req.on('data', (c) => {
        if (tooLarge) return
        size += c.length
        if (size > MAX_BODY) {
          // 不能用 req.destroy()，否则连接被重置，413 的结构化响应根本发不出去。
          // 丢弃已收数据、排空剩余流，让外层 catch 正常返回 413 E5002。
          tooLarge = true
          chunks.length = 0
          reject(new Error('BODY_TOO_LARGE'))
          req.resume()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        if (tooLarge) return
        if (!chunks.length) return resolve({})
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { reject(new Error('INVALID_JSON')) }
      })
      req.on('error', (err) => { if (!tooLarge) reject(err) })
    })
  }

  return { json, fail, readBody }
}
