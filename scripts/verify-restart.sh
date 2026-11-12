#!/usr/bin/env bash
# AC-03 真实杀进程 → 重启 → 断点续跑验证
#
# 用法：bash scripts/verify-restart.sh
# 依赖：bash / curl / node 22（node:sqlite）。CI（ubuntu-latest）与本地 Git Bash 均可运行。
# 说明：本脚本只做进程编排，断言在 scripts/verify-restart.mjs，避免依赖 jq 或 node spawn。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${LEADPILOT_VERIFY_PORT:-5193}"
BASE="http://127.0.0.1:${PORT}"
# 临时目录落在项目 .tmp/（已 gitignore），用相对路径清理以避免 Windows 盘符触发安全删除拦截
mkdir -p "${ROOT}/.tmp"
TMP_REL=".tmp/restart-verify-$$"
TMP="${ROOT}/${TMP_REL}"
mkdir -p "${TMP}"
DB="${TMP}/leadpilot.db"
STATE="${TMP}/state.json"
LOG="${TMP}/server.log"
PID=""

export AC03_BASE="${BASE}"
export AC03_DB="${DB}"
export AC03_STATE="${STATE}"

cleanup() {
  if [ -n "${PID}" ]; then
    kill -9 "${PID}" 2>/dev/null || true
    wait "${PID}" 2>/dev/null || true
  fi
  (cd "${ROOT}" && rm -rf "${TMP_REL}") 2>/dev/null || true
}
trap cleanup EXIT

# 干净检出终验（2026-11-12）发现：开发机若设置了 http_proxy / HTTP_PROXY，curl 会把
# 127.0.0.1 的探活也转发给代理，代理回 502，脚本误判「服务启动失败」——CI 无代理所以一直绿。
# 这里显式绕过代理：探活目标永远是本机回环，没有任何理由走代理。
start_server() {
  LEADPILOT_PORT="${PORT}" LEADPILOT_DB_PATH="${DB}" node "${ROOT}/server/index.mjs" > "${LOG}" 2>&1 &
  PID=$!
  local i
  for i in $(seq 1 30); do
    if curl --noproxy '*' -fsS -m 1 "${BASE}/health" > /dev/null 2>&1; then
      echo "[restart-verify] 服务就绪（${i}s）"
      return 0
    fi
    sleep 1
  done
  echo "[restart-verify] 服务启动失败，日志如下："
  cat "${LOG}"
  return 1
}

stop_server() {
  # 先 SIGTERM 让服务正常收尾；若 keep-alive 连接让 server.close() 挂起，超时后强杀，
  # 避免 CI 卡住。强杀同样符合「模拟进程意外终止」的 AC-03 语义（WAL 仍在）。
  kill "${PID}" 2>/dev/null || true
  local i
  for i in $(seq 1 20); do
    if ! kill -0 "${PID}" 2>/dev/null; then break; fi
    sleep 0.2
  done
  kill -9 "${PID}" 2>/dev/null || true
  wait "${PID}" 2>/dev/null || true
  PID=""
  sleep 0.3
}

echo "=== AC-03 · 阶段 1：创建长任务并推进游标 ==="
start_server
node "${ROOT}/scripts/verify-restart.mjs" create

echo "=== AC-03 · 阶段 2：强杀进程，直读 SQLite 落盘值 ==="
stop_server
node "${ROOT}/scripts/verify-restart.mjs" persisted

echo "=== AC-03 · 阶段 3：同一 DB 重启，校验恢复与断点续跑 ==="
start_server
node "${ROOT}/scripts/verify-restart.mjs" verify

echo "=== AC-03 全链路验证通过 ==="
