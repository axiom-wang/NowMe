#!/usr/bin/env bash
# GitHub CI 测试成功后调用。密钥、数据库、证书始终保存在 ROOT 下。
set -euo pipefail
SHA="${1:?缺少提交号}"
STAGE="${2:?缺少构建目录}"
ROOT="${3:-/opt/nowme}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ "$STAGE" == "$ROOT/releases/$SHA."* ]] || exit 2
test -f "$ROOT/.env"
test -f "$ROOT/deploy/demo.env"
IMAGE="nowme:$SHA"
DOCKER=(sudo docker)
OLD_COMPOSE=("${DOCKER[@]}" compose --project-name nowme --project-directory "$ROOT" -f "$ROOT/docker-compose.yml" -f "$ROOT/deploy/compose.ip.yml")
PROXY="nowme-ci-download"
cleanup() { "${DOCKER[@]}" rm -f "$PROXY" >/dev/null 2>&1 || true; }
trap 'DEPLOY_STATUS=$?; cleanup; exit "$DEPLOY_STATUS"' EXIT

echo "[deploy] 构建 ${SHA}，当前线上继续提供服务"
# 腾讯云到 GitHub 的字体下载不稳定，沿用已经校验过的本地字体缓存。
cp -a "$ROOT/packages/kit/fonts/." "$STAGE/packages/kit/fonts/"
sed '/^packages\/kit\/fonts\//d' "$STAGE/.dockerignore" > "$STAGE/.dockerignore.next"
mv "$STAGE/.dockerignore.next" "$STAGE/.dockerignore"
cleanup
"${DOCKER[@]}" run -d --name "$PROXY" -p 127.0.0.1:9080:8080 \
  -v "$STAGE/deploy/browser-download-proxy.cjs:/server.cjs:ro" \
  node:22-bookworm-slim node /server.cjs >/dev/null
"${DOCKER[@]}" build --network host -t "$IMAGE" \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  --build-arg APT_MIRROR=mirrors.cloud.tencent.com \
  --build-arg PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:9080 "$STAGE"
cleanup

echo '[deploy] 检查代理配置，备份正式数据'
"${DOCKER[@]}" run --rm -v "$STAGE/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
"${OLD_COMPOSE[@]}" --profile tools run --rm --no-deps -T backup
# 不修改或打印原有密钥。
ENV_NEXT=$(mktemp "$ROOT/.env.next.XXXXXX")
chmod 600 "$ENV_NEXT"
sed '/^NOWME_IMAGE=/d' "$ROOT/.env" > "$ENV_NEXT"
printf '\nNOWME_IMAGE=%s\n' "$IMAGE" >> "$ENV_NEXT"
PREVIOUS=$("${DOCKER[@]}" inspect nowme-web-1 --format '{{.Image}}')
printf '%s\n' "$PREVIOUS" > "$ROOT/previous-image"
# 固定 compose 项目名和目录，保留原数据卷、证书与配置路径。
cp "$STAGE/docker-compose.yml" "$ROOT/docker-compose.yml"
cp "$STAGE/deploy/compose.ip.yml" "$ROOT/deploy/compose.ip.yml"
cat "$STAGE/deploy/Caddyfile" > "$ROOT/deploy/Caddyfile"
mv "$ENV_NEXT" "$ROOT/.env"
COMPOSE=("${DOCKER[@]}" compose --project-name nowme --project-directory "$ROOT" -f "$ROOT/docker-compose.yml" -f "$ROOT/deploy/compose.ip.yml")

echo '[deploy] 更新 Demo 并检查实际页面'
"${COMPOSE[@]}" up -d --no-build --wait --wait-timeout 660 demo
# healthz 不足以发现 JSX 配置错误，额外检查实际 HTML。
"${COMPOSE[@]}" exec -T demo node -e \
  "fetch('http://127.0.0.1:3000/login',{headers:{Host:new URL(process.env.NOWME_WEB_ORIGIN).host},signal:AbortSignal.timeout(15000)}).then(async r=>{if(!r.ok)throw new Error('Demo 登录页检查失败：HTTP '+r.status);if(!(await r.text()).includes('以成员身份体验'))throw new Error('Demo 登录页缺少体验入口')}).catch(e=>{console.error(e.message);process.exit(1)})"
echo '[deploy] 更新正式环境'
"${COMPOSE[@]}" up -d --no-build --wait --wait-timeout 120 web pages worker
"${COMPOSE[@]}" up -d --no-build caddy
"${COMPOSE[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
# worker 没有 HTTP 端点，观察它是否持续存活。
WORKER=$("${COMPOSE[@]}" ps -q worker)
sleep 10
[[ "$("${DOCKER[@]}" inspect "$WORKER" --format '{{.State.Running}} {{.RestartCount}}')" == 'true 0' ]]
curl --fail --silent --show-error --retry 5 --retry-delay 3 https://124.222.53.43/readyz >/dev/null
DEMO_HTML=$(curl --fail --silent --show-error --retry 5 --retry-delay 3 https://124.222.53.43:8444/login)
[[ "$DEMO_HTML" == *'以成员身份体验'* ]]
ln -sfn "$STAGE" "$ROOT/current-release"
printf '%s\n' "$SHA" > "$ROOT/deployed-sha"
"${DOCKER[@]}" tag "$IMAGE" nowme:latest
echo "[deploy] 正式环境和 Demo 已部署 $SHA"
