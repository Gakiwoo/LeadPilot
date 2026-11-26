/**
 * 构建期注入的全局常量（见 vite.config.ts 的 define）。
 *
 * 只暴露版本号这类无害信息；API Key、路径等一律不进前端。
 */
declare const __APP_VERSION__: string
