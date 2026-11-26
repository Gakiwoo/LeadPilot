/**
 * PostCSS 配置（位于 config/）。
 *
 * Tailwind 配置文件与它同目录，这里显式传绝对路径，
 * 避免 tailwindcss 插件按 cwd 找不到 config 而静默产出无样式的 CSS。
 */
import { fileURLToPath } from 'node:url'

export default {
  plugins: {
    tailwindcss: {
      config: fileURLToPath(new URL('./tailwind.config.js', import.meta.url)),
    },
    autoprefixer: {},
  },
}
