#!/bin/sh
set -eu
umask 077
cd "$(dirname "$0")/.."

for cmd in node npm pm2 flock timeout; do
  command -v "$cmd" >/dev/null || { echo "缺少 $cmd，请按 README 的 PM2 部署说明安装。" >&2; exit 1; }
done
node -e 'const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 18)) { console.error("需要 Node.js 22.18 或以上版本"); process.exit(1); }'

if [ ! -f .env ]; then
  cp .env.example .env
  echo "已创建 .env。请填写推送配置，再次运行 ./deploy/pm2-deploy.sh。" >&2
  exit 1
fi

if command -v pnpm >/dev/null; then
  pnpm install --prod --frozen-lockfile
else
  npm install --omit=dev --no-package-lock --no-audit --no-fund
fi
node deploy/pm2-scheduler.mjs --check
pm2 startOrRestart deploy/ecosystem.config.cjs --only ai-bot-scheduler --update-env
pm2 save
echo "查看运行日志：pm2 logs ai-bot-scheduler"
