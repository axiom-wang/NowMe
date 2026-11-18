#!/usr/bin/env bash
# 把当前工作区部署到单台服务器（IP 直连：正式环境 + 演示环境 + Caddy），见 docs/deploy.md 第 9 节。
#
#   deploy/deploy.sh            # 同步代码与配置 → 在服务器上构建镜像 → 启动 / 更新全部服务
#   deploy/deploy.sh --no-build # 只同步配置并重启（改了 env / Caddyfile 时）
#
# 需要：本机能用 SSH 密钥登录服务器；deploy/prod.env 与 deploy/demo.env 已填好（含密钥，不入库）。
set -euo pipefail

HOST="${NOWME_DEPLOY_HOST:-ubuntu@124.222.53.43}"
KEY="${NOWME_DEPLOY_KEY:-$HOME/.ssh/nowme_deploy_ed25519}"
DIR="${NOWME_DEPLOY_DIR:-/opt/nowme}"
BUILD=1
[ "${1:-}" = "--no-build" ] && BUILD=0

cd "$(dirname "$0")/.."
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o ServerAliveInterval=30 "$HOST")
COMPOSE="docker compose -f docker-compose.yml -f deploy/compose.ip.yml"

for file in deploy/prod.env deploy/demo.env; do
  [ -f "$file" ] || { echo "缺少 $file" >&2; exit 1; }
done
for name in NOWME_SMTP_URL NOWME_MAIL_FROM; do
  grep -Eq "^$name=.+" deploy/prod.env || { echo "deploy/prod.env 里的 $name 还没填：正式环境没有它发不出登录验证码，会拒绝启动" >&2; exit 1; }
done

echo "==> 同步代码到 $HOST:$DIR"
"${SSH[@]}" "sudo mkdir -p $DIR && sudo chown \$(id -u):\$(id -g) $DIR"
# 字体源文件（约 150 MB）随代码一起传：服务器上从 GitHub 下载不稳定，构建时已存在的文件会跳过下载
rsync -az --delete -e "ssh -i $KEY -o IdentitiesOnly=yes" \
  --exclude .git --exclude node_modules --exclude dist --exclude '*.tsbuildinfo' \
  --exclude .data --exclude backups \
  --include '/.env.example' --include '/.env.production.example' --exclude '/.env' --exclude '/.env.*' \
  --exclude test-results --exclude playwright-report --exclude .nowme-test-home --exclude .nowme-preview \
  --exclude marketing --exclude .history --exclude .vscode --exclude .claude --exclude .DS_Store --exclude skill/dist-package \
  ./ "$HOST:$DIR/"

echo "==> 写入服务器上的环境文件"
"${SSH[@]}" "cd $DIR && install -m 600 deploy/prod.env .env && chmod 600 deploy/*.env \
  && sed -i -e '/^packages\/kit\/fonts\//d' .dockerignore \
  && mkdir -p backups && sudo chown 1000:1000 backups"

if [ "$BUILD" = 1 ]; then
  echo "==> 构建镜像（第一次要十几分钟）"
  "${SSH[@]}" "cd $DIR && sudo docker build -t nowme:latest \
    --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
    --build-arg APT_MIRROR=mirrors.cloud.tencent.com \
    --build-arg PLAYWRIGHT_DOWNLOAD_HOST='${NOWME_PLAYWRIGHT_DOWNLOAD_HOST:-}' ."
fi

echo "==> 启动 / 更新服务"
"${SSH[@]}" "cd $DIR \
  && sudo $COMPOSE run --rm --no-deps --user root --entrypoint chown demo -R node:node /app/.data/demo \
  && sudo $COMPOSE up -d --no-build --remove-orphans \
  && sleep 5 && sudo $COMPOSE ps"
