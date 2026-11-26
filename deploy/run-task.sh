#!/bin/sh
# Linux cron entry point. All notification logic lives in the existing Node tasks.
set -eu
umask 077
cd "$(dirname "$0")/.."

usage() {
  echo "Usage: $0 {github-trending|telegram-email|binance-copy|ai-news|stocks} [--dry-run]" >&2
  exit 2
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || usage
task=$1
shift
daily=true
case "$task" in
  github-trending) limit=10m; entry="dist/github-trending/main.js" ;;
  telegram-email) daily=false; limit=10m; entry="dist/telegram-relay/main.js" ;;
  binance-copy) daily=false; limit=2m; entry="dist/binance-copy/main.js" ;;
  ai-news) limit=15m; entry="dist/ai-news/main.js" ;;
  stocks) limit=90m; entry="dist/stocks/main.js" ;;
  *) usage ;;
esac
if [ "$#" -eq 1 ] && [ "$1" != "--dry-run" ]; then usage; fi

[ -f "$entry" ] || { echo "缺少 $entry，请先运行 npm run build。" >&2; exit 1; }
node_bin=${NODE_BIN:-node}
if [ "$#" -eq 1 ]; then
  exec timeout --kill-after=30s "$limit" "$node_bin" --env-file=.env "$entry" --dry-run
fi

mkdir -p .cron
exec 9>".cron/$task.lock"
flock -n -E 75 9 || {
  status=$?
  if [ "$status" -eq 75 ]; then exit 0; fi
  exit "$status"
}

# Daily jobs can be retried after a failure. Polling tasks keep delivery progress in SQLite.
if [ "$daily" = true ]; then
  day=$(TZ=Asia/Shanghai date +%F)
  stamp=".cron/$task.last-success"
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$day" ]; then exit 0; fi
fi

timeout --kill-after=30s "$limit" "$node_bin" --env-file=.env "$entry"
if [ "$daily" = true ]; then
  echo "$day" > "$stamp.tmp"
  mv -f "$stamp.tmp" "$stamp"
fi
