#!/bin/sh
# Linux cron entry point. All notification logic lives in the existing Node tasks.
set -eu
umask 077
cd "$(dirname "$0")/.."

usage() {
  echo "Usage: $0 {github-trending|telegram-email|ai-news|stocks} [--dry-run]" >&2
  exit 2
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || usage
task=$1
shift
case "$task" in
  github-trending|telegram-email) limit=10m ;;
  ai-news) limit=15m ;;
  stocks) limit=90m ;;
  *) usage ;;
esac
if [ "$#" -eq 1 ] && [ "$1" != "--dry-run" ]; then usage; fi

entry="dist/$task/main.js"
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

# Daily jobs can be retried after a failure. The channel tracks individual posts in SQLite.
day=$(TZ=Asia/Shanghai date +%F)
stamp=".cron/$task.last-success"
if [ "$task" != telegram-email ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$day" ]; then
  exit 0
fi

timeout --kill-after=30s "$limit" "$node_bin" --env-file=.env "$entry"
if [ "$task" != telegram-email ]; then
  echo "$day" > "$stamp.tmp"
  mv -f "$stamp.tmp" "$stamp"
fi
