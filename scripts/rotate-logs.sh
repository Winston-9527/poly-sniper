#!/bin/sh
# poly-sniper 日志轮转：单文件超过 20MB 时归档为 .gz 并清空原文件（保持进程写入的 inode 不变），只保留最近 3 份。
# 可通过 POLY_LOG_DIR / POLY_LOG_LIMIT 覆盖，便于自测。
LOG="${POLY_LOG_DIR:-/Users/siyuan/Projects/poly-sniper/logs}"
LIMIT="${POLY_LOG_LIMIT:-20000000}"
for f in stdout.log stderr.log; do
  [ -f "$LOG/$f" ] || continue
  sz=$(stat -f%z "$LOG/$f")
  if [ "$sz" -gt "$LIMIT" ]; then
    gzip -c "$LOG/$f" > "$LOG/$f.$(date +%Y%m%d%H%M%S).gz"
    : > "$LOG/$f"
    ls -1t "$LOG/$f".*.gz 2>/dev/null | tail -n +4 | while read -r old; do rm -f "$old"; done
  fi
done
