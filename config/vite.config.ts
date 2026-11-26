/**
 * Vite / Vitest 配置（位于 config/，由 package.json 脚本用 --config 指定）。
 *
 * 关键：`root` 显式指回项目根，所以 index.html、public/、dist/ 的位置与搬迁前完全一致，
 * 只有配置文件本身换了目录。别名与缓存目录都用绝对路径，避免相对路径随配置位置漂移。
 */
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import pkg from '../package.json'

// 本文件在 <root>/config/ 下，上一级即项目根
const projectRoot = path.resolve(__dirname, '..')

export default defineConfig({
  plugins: [react()],
  root: projectRoot,
  // 版本号在构建期注入，避免把整个 package.json（含 scripts / devDependencies）打进前端包
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // 相对路径：便于后续作为 Tauri 2 的 frontendDist 直接复用
  base: './',
  resolve: {
    alias: { '@': path.join(projectRoot, 'src') },
  },
  // PostCSS 配置也在 config/ 下，显式指过去，不依赖默认的「从 root 向上查找」
  css: {
    postcss: __dirname,
  },
  // 安全：dev server 只绑定回环。Vite 5 / esbuild 的已知开发服务器漏洞
  // （任意站点可发请求读响应、optimized deps .map 路径穿越）影响范围是「可被访问到的 dev server」，
  // 绑定 127.0.0.1 后外部站点无法直连；生产构建产物 dist/ 不包含 dev server（见 ADR-017）。
  server: { host: '127.0.0.1', port: 5180, strictPort: false },
  preview: { host: '127.0.0.1', port: 5180, strictPort: false },
  // 把构建/测试缓存留在项目内，避免写入系统临时目录时被沙箱拒绝
  cacheDir: path.join(projectRoot, 'node_modules/.vite-cache'),
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.mjs'],
    // 当前环境的 fs 代理不允许多个 worker 同时写 SSR 转换缓存，改为顺序执行
    fileParallelism: false,
  },
})
