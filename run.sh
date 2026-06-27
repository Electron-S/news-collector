#!/usr/bin/env bash
# 뉴스 수집 + Telegram 알림 (cron용). 수집을 코드로 수행하므로 Claude 실행이 필요 없다.
set -euo pipefail
cd "$(dirname "$0")"

if REPORT=$(node collect.js); then
  if ! node notify.js "$REPORT"; then
    echo "전송 실패"
    node alert.js "텔레그램 전송 실패 ($REPORT)" || true
    exit 1
  fi
else
  code=$?
  if [ "$code" -eq 3 ]; then
    echo "오늘 리포트가 이미 존재하여 건너뜁니다."
    exit 0
  fi
  echo "수집 실패 (exit $code)"
  node alert.js "수집 실패 (exit $code) — cron.log 확인" || true
  exit "$code"
fi
