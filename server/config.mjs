/**
 * 服务端运行时配置 · 全部环境变量只在此处读取一次。
 *
 * 纪律：其它模块不得直接读 process.env（网关与抓取器的可注入 env 除外，
 * 那是为了测试确定性）。集中读取让「对外监听 + 无 token」这类组合可以在一处硬校验。
 */
import { readFileSync } from 'node:fs'

export const PKG_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version

export const PORT = Number(process.env.LEADPILOT_PORT ?? 5181)
export const HOST = process.env.LEADPILOT_HOST ?? '127.0.0.1'

/** 请求体硬上限：256 KB。批量导入请分批，不靠调大这个值解决问题 */
export const MAX_BODY = 256 * 1024

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
export const IS_LOOPBACK = LOOPBACK_HOSTS.has(HOST)

export const API_TOKEN = process.env.LEADPILOT_API_TOKEN ?? ''

export const CORS_LIST = (process.env.LEADPILOT_CORS ?? 'http://127.0.0.1:5180')
  .split(',').map((x) => x.trim()).filter(Boolean)

export const RATE_LIMIT = Math.max(1, Number(process.env.LEADPILOT_RATE_LIMIT ?? 120))

/** 限流表容量上限：长时间运行不得无限膨胀 */
export const RATE_TABLE_MAX = 4096

export const DEFAULT_SECURITY = {
  token: API_TOKEN,
  loopback: IS_LOOPBACK,
  cors: CORS_LIST,
  rateLimit: RATE_LIMIT,
}
