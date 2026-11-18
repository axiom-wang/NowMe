# syntax=docker/dockerfile:1
# NOWMe 镜像：主站（web）、页面托管（pages）、后台任务（worker）共用同一个镜像，用不同的启动命令区分（见 docker-compose.yml）。
# 部署说明见 docs/deploy.md。

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# base：Node 22 + pnpm（版本与根 package.json 的 packageManager 一致）
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
# 可选的下载镜像（网络访问 npm / Debian / Playwright 官方源不稳定时用，默认留空即官方源）：
#   --build-arg NPM_REGISTRY=https://registry.npmmirror.com
#   --build-arg APT_MIRROR=mirrors.cloud.tencent.com
#   --build-arg PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:9080（见 docs/deploy.md）
ARG NPM_REGISTRY=
ARG APT_MIRROR=
ENV CI=true
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set --global registry "$NPM_REGISTRY"; fi \
    && if [ -n "$APT_MIRROR" ]; then sed -i "s|deb.debian.org|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi \
    && npm install -g pnpm@12.8.1 && npm cache clean --force
WORKDIR /app

# ---------------------------------------------------------------------------
# build：安装依赖、下载 Kit 字体、编译、打 Skill 包
# ---------------------------------------------------------------------------
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
# 字体源文件不入库，构建时下载（需要联网；已存在的文件会跳过）
RUN pnpm --filter @nowme/kit fonts:fetch
RUN pnpm build
# Skill 包：主站 /skill 页面托管它的下载
RUN pnpm --filter @nowme/skill pack:skill

# ---------------------------------------------------------------------------
# runtime：构建产物 + Playwright Chromium（主站渲染页面截图用）+ 系统依赖；非 root 用户运行
# ---------------------------------------------------------------------------
FROM base AS runtime
ARG PLAYWRIGHT_DOWNLOAD_HOST=
ENV NODE_ENV=production \
    NOWME_DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build /app /app
# Chromium 及其系统库（apt）。装完清掉 apt 缓存。
RUN if [ -z "$PLAYWRIGHT_DOWNLOAD_HOST" ]; then unset PLAYWRIGHT_DOWNLOAD_HOST; fi \
    && pnpm --filter @nowme/render exec playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /backups \
    && chown -R node:node /data /backups
USER node
VOLUME ["/data"]
EXPOSE 3000 4000
# 默认启动主站；pages / worker 在 docker-compose.yml 里覆盖 command
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/web/dist/main.js"]
