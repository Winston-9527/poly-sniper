#!/usr/bin/env bash
set -euo pipefail

PORT="${TELEGRAM_WEBHOOK_PORT:-8792}"
PATH_SUFFIX="${TELEGRAM_WEBHOOK_PATH:-/telegram/webhook}"
LOG_FILE="/tmp/cloudflared-telegram-${PORT}.log"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "[Webhook] 未找到 cloudflared，请先安装后再运行。"
  exit 1
fi

rm -f "${LOG_FILE}"
cloudflared tunnel --url "http://127.0.0.1:${PORT}" --logfile "${LOG_FILE}" --loglevel info >/dev/null 2>&1 &
TUNNEL_PID=$!

cleanup() {
  if kill -0 "${TUNNEL_PID}" >/dev/null 2>&1; then
    kill "${TUNNEL_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "[Webhook] 等待 cloudflared 分配公网地址..."
PUBLIC_URL=""
for _ in $(seq 1 30); do
  if [ -f "${LOG_FILE}" ]; then
    PUBLIC_URL=$(grep -o "https://[a-z0-9.-]*trycloudflare.com" "${LOG_FILE}" | head -n 1 || true)
  fi
  if [ -n "${PUBLIC_URL}" ]; then
    break
  fi
  sleep 1
done

if [ -z "${PUBLIC_URL}" ]; then
  echo "[Webhook] 未获取到公网地址，请检查 cloudflared 日志: ${LOG_FILE}"
  exit 1
fi

export TELEGRAM_WEBHOOK_ENABLED=true
export TELEGRAM_POLLING_ENABLED=false
export TELEGRAM_WEBHOOK_URL="${PUBLIC_URL}${PATH_SUFFIX}"

echo "[Webhook] 使用 URL: ${TELEGRAM_WEBHOOK_URL}"
echo "[Webhook] 启动服务..."
npm run dev
