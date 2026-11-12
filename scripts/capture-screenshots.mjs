/**
 * README 界面截图重生成（可复现，不依赖 Puppeteer / Playwright）
 *
 * 背景：评估报告「待验证假设 #5」指出，PNG 本身无法证明截图是真实运行渲染。
 * 现在把生成脚本纳入版本控制，任何人都能按下面两步复现 README 的 5 张图：
 *
 *   1) npm run dev                      # 或把 LEADPILOT_APP_URL 指向任意已运行实例
 *   2) npm run capture:screenshots
 *
 * 实现：Node 22 原生 WebSocket 直连 Chrome DevTools Protocol，实际操作导航后
 * Page.captureScreenshot，不引入任何第三方浏览器自动化依赖。
 *
 * 环境变量：
 *   LEADPILOT_APP_URL   前端地址，默认 http://127.0.0.1:5180/
 *   LEADPILOT_CHROME    Chrome/Chromium/Edge 可执行文件绝对路径（自动探测失败时指定）
 *   LEADPILOT_CDP_PORT  CDP 调试端口，默认 9334
 *
 * 这不是 CI 步骤，也不进发布门禁：截图只是文档证据，不参与产品能力判定。
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const OUT = join(ROOT, 'docs', 'screenshots')
const APP = process.env.LEADPILOT_APP_URL ?? 'http://127.0.0.1:5180/'
const PORT = Number(process.env.LEADPILOT_CDP_PORT ?? 9334)
const PROFILE = join(tmpdir(), `lp-chrome-capture-${process.pid}`)

const CANDIDATES = [
  process.env.LEADPILOT_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findChrome() {
  for (const candidate of CANDIDATES) {
    try { await access(candidate); return candidate } catch { /* 继续探测 */ }
  }
  throw new Error('未找到 Chrome / Chromium / Edge：请设置 LEADPILOT_CHROME 为浏览器可执行文件的绝对路径')
}

async function assertAppReady() {
  try {
    const res = await fetch(APP)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch (err) {
    throw new Error(`前端不可达（${APP}）：请先执行 npm run dev，或设置 LEADPILOT_APP_URL。原因：${String(err?.message ?? err)}`)
  }
}

const CHROME = await findChrome()
await assertAppReady()
await mkdir(OUT, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--remote-allow-origins=*',
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--window-size=1600,1000',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })

// 保留最近几行 Chrome stderr：冷启动失败时给出可诊断的原因，而不是一句「endpoint did not start」
const chromeErrors = []
chrome.stderr?.on('data', (chunk) => {
  chromeErrors.push(String(chunk).trim())
  if (chromeErrors.length > 12) chromeErrors.shift()
})
let spawnError = null
chrome.on('error', (err) => { spawnError = err })

const pending = new Map()
let seq = 0
let ws = null

function send(method, params = {}) {
  return new Promise((resolvePending, reject) => {
    const id = ++seq
    pending.set(id, { resolve: resolvePending, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }
    }, 20000)
  })
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}

async function waitFor(expression, timeoutMs = 25000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try { if (await evaluate(expression)) return } catch { /* 页面尚未就绪 */ }
    await sleep(250)
  }
  throw new Error(`waitFor failed: ${expression}`)
}

async function shot(name) {
  await sleep(800)
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
  console.log('captured:', name)
}

async function click(expression) {
  const ok = await evaluate(`(() => { const el = ${expression}; if (!el) return false; el.click(); return true })()`)
  if (!ok) throw new Error(`element not found: ${expression}`)
  await sleep(600)
}
const clickButton = (text) => click(`[...document.querySelectorAll('button')].find(b => (b.innerText || '').trim().includes(${JSON.stringify(text)}))`)

async function esc() {
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(500)
}

try {
  let list = null
  // macOS 首次冷启动 Chrome 可能超过 12s；给 30s，并在进程已退出时立即报错
  for (let i = 0; i < 100; i++) {
    if (spawnError || chrome.exitCode !== null) break
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      list = await res.json()
      if (list.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) break
    } catch { /* Chrome 启动中 */ }
    await sleep(300)
  }
  if (!list?.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) {
    throw new Error([
      `Chrome CDP endpoint 未在 ${PORT} 就绪（${CHROME}）`,
      spawnError ? `spawn: ${spawnError.message}` : null,
      chrome.exitCode !== null ? `Chrome 已退出，exitCode=${chrome.exitCode}` : null,
      chromeErrors.length ? `stderr 尾部：${chromeErrors.slice(-4).join(' | ')}` : null,
      '若端口被占用可用 LEADPILOT_CDP_PORT 换一个。',
    ].filter(Boolean).join('\n'))
  }
  const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail })
  ws.onmessage = async (ev) => {
    let raw = ev.data
    if (typeof raw !== 'string') raw = await raw.text()
    const msg = JSON.parse(raw)
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`${msg.error.code} ${msg.error.message}`))
      else p.resolve(msg.result)
    }
  }

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: APP })
  await waitFor(`!!document.querySelector('aside') && document.querySelectorAll('table tbody tr').length > 3`)

  await shot('01-overview')

  await click(`document.querySelector('table tbody tr td button')`)
  await shot('05-company-detail')
  await esc()

  await clickButton('客户管理')
  await shot('03-crm')

  await clickButton('发信中心')
  await shot('02-outreach')

  await clickButton('设置')
  await shot('04-settings')

  console.log(`完成：5 张截图已写入 ${OUT}`)
} finally {
  try { ws?.close() } catch { /* noop */ }
  chrome.kill('SIGTERM')
}
