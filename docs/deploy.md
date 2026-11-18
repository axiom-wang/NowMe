# 部署与运维

面向运维。接口与安全约定见 `contracts.md` 第 10 节（加固）与第 17 节（运维）。

## 1. 进程划分

同一个镜像（`Dockerfile`），三个长期运行的服务（`docker-compose.yml`）：

| 服务 | 命令 | 端口 | 数据卷 | 说明 |
| --- | --- | --- | --- | --- |
| `web` | `node apps/web/dist/main.js` | 3000 | 读写 | 主站：登录、墙、页面发布、托管采访与生成的入口；渲染页面截图要用 Chromium |
| `pages` | `node apps/pages-host/dist/main.js` | 4000 | **只读** | 用户页面托管，独立源，不连数据库 |
| `worker` | `node apps/web/dist/worker.js` | 无 | 读写 | 后台任务进程（contracts 13） |

另有一次性的 `backup` 服务（`profiles: [tools]`），见第 6 节。

要点：

- 主站与页面托管必须是**两个不同站点**（不同的可注册域名最好）。页面托管只读挂载数据卷，所以必须显式设置 `NOWME_TICKET_SECRET`（主站、页面托管、worker 用同一个值），不能依赖自动生成的 `secret` 文件。
- 多个进程共用同一个 SQLite（WAL 模式）和同一个数据卷，所以它们必须在同一台机器上。不要把 web 横向扩到多台机器。
- 容器内数据目录固定为 `/data`（具名卷 `nowme-data`）。

## 2. 环境变量

复制 `.env.production.example` 为 `.env`（不入库）。生产环境（`NODE_ENV=production`，compose 已设置）启动前会检查配置，不完整就拒绝启动并一次列出全部问题：

- `NOWME_WEB_ORIGIN`、`NOWME_PAGES_ORIGIN`：都必须是 `https://` 源；
- `NOWME_AI_ENCRYPTION_KEY`（主站）：64 位十六进制，`openssl rand -hex 32`；
- `NOWME_MAIL_TRANSPORT=smtp` 与 `NOWME_SMTP_URL`、`NOWME_MAIL_FROM`；
- 设置了 `NOWME_PLATFORM_PROVIDER` 就必须有 `NOWME_PLATFORM_API_KEY`；
- 建议：`NOWME_TICKET_SECRET`（本编排下必填）、页面托管使用单独注册的域名、`NOWME_TRUST_PROXY` 与代理层数一致。

`NOWME_AI_ENCRYPTION_KEY` 和 `NOWME_TICKET_SECRET` 要保存在密码管理器 / 密钥服务里，**不在数据备份中**。丢失 `NOWME_AI_ENCRYPTION_KEY` 后，用户保存的模型 Key 无法解密（用户需重新填写）。

完整变量清单见 `.env.example`；备份相关：`NOWME_BACKUP_DIR`（容器内为 `/backups`）、`NOWME_BACKUP_KEEP`（默认 7）、`NOWME_BACKUP_HOST_DIR`（compose 里宿主机目录，默认 `./backups`）。

## 3. 反向代理与 HTTPS

compose 把两个端口只绑定在 `127.0.0.1`，由宿主机上的反向代理终止 HTTPS 并转发：

- 主站域名（例如 `nowme.example.com`）→ `127.0.0.1:3000`
- 页面域名（例如 `nowme-pages.example.net`，**不要**用主站的子域名）→ `127.0.0.1:4000`

Caddy 示例（自动签发证书；Nginx 同理，转发时设置 `X-Forwarded-For`，可选设置 `X-Request-Id`）：

```caddyfile
nowme.example.com {
    reverse_proxy 127.0.0.1:3000
}
nowme-pages.example.net {
    reverse_proxy 127.0.0.1:4000
}
```

- 两个域名各自有证书；应用自己会下发 HSTS 与其他安全头，代理不要覆盖或去掉。
- 必须保留原始 `Host` 头（主站会校验 Host，不匹配返回 421）。
- `NOWME_TRUST_PROXY=N`：进程前面有 N 层可信代理。Caddy / Nginx 单层写 `1`；此时来源地址（限流用）取 `X-Forwarded-For` 从右数第 N 个，并接受代理传来的 `X-Request-Id`。**如果进程能被直接访问（没有代理在前），必须写 0**，否则别人可以伪造来源地址。
- 健康检查：`GET /healthz`（两个进程）、`GET /readyz`（主站，检查数据库）。

## 4. 首次启动

```bash
cp .env.production.example .env      # 填写所有必填项
docker compose build                  # 需要联网：下载 Kit 字体、Chromium
docker compose up -d
docker compose ps                     # web / pages 应为 healthy
docker compose logs -f web            # 启动日志，配置有误时会列出全部问题
```

随后配置反向代理，用浏览器访问主站域名，用邮箱验证码登录一次，确认邮件能收到。生成兑换码、发放点数：

```bash
docker compose exec web node --import tsx --conditions=source apps/web/scripts/credits.ts codes --count 20 --credits 100
```

## 5. 升级

1. 先做一次备份（第 6 节）。
2. `git pull`，查看 `docs/` 与 `.env.production.example` 有没有新增必填变量，补进 `.env`。
3. `docker compose build && docker compose up -d`。数据库迁移在主站启动时自动执行（已执行的不会重复）。
4. `docker compose ps` 确认 healthy，看日志里没有 `error` 级别的行。
5. 回滚：切回旧版本代码重新构建；如果新版本已经执行了迁移，需要用升级前的备份恢复到一个空数据卷（第 6 节），不能直接降级数据库。

## 6. 备份与恢复

备份内容：SQLite（`VACUUM INTO` 在线一致性快照，服务运行时可以执行）+ `revisions/`（页面版本文件）。不含 `secret` 文件与环境变量里的密钥。产物是 `nowme-backup-<UTC 时间戳>.tar.gz`，超过保留份数的旧备份自动删除。

```bash
mkdir -p backups && sudo chown 1000:1000 backups    # 容器内 node 用户 uid 1000 要能写
docker compose --profile tools run --rm backup       # 写到 ./backups
```

定时备份：在宿主机 crontab 里加一行，例如每天 03:30：

```cron
30 3 * * * cd /opt/nowme && docker compose --profile tools run --rm backup >> /var/log/nowme-backup.log 2>&1
```

备份文件要再复制到另一台机器 / 对象存储（本机磁盘坏了就没有备份了），并定期做恢复演练。

不用 Docker 时：`pnpm --filter @nowme/web backup [--keep 7]`（使用 `NOWME_DATA_DIR`、`NOWME_BACKUP_DIR`）。

### 恢复演练

恢复只写到**空目录**，不会覆盖现有数据；恢复后自动执行 `PRAGMA integrity_check` 与外键检查，失败会清理目标目录并报错。

演练（不影响线上）：

```bash
# 在临时容器里恢复到一个新的空目录，只看检查结果
docker compose --profile tools run --rm --no-deps backup \
  node --disable-warning=ExperimentalWarning apps/web/dist/ops/backup-cli.js \
  restore /backups/nowme-backup-<时间戳>.tar.gz --to /tmp/restore-check
```

输出“完整性检查 ok，N 张表，M 个页面版本”即通过。（`/tmp` 里的内容随容器一起丢弃。）

真正的灾难恢复：

1. `docker compose down`，把旧数据卷改名保留（`docker volume ls`），创建新的空卷 `nowme-data`；
2. 把备份文件恢复进新卷：用上面的命令，`--to /data` 并挂载 `nowme-data:/data`；
3. 确认 `.env` 里的 `NOWME_AI_ENCRYPTION_KEY` 与旧环境一致；
4. `docker compose up -d`，登录、打开几面墙与页面确认。

## 7. 日志怎么看

生产环境主站与页面托管把日志写到标准输出，每行一个 JSON：

```json
{"method":"GET","route":"/w/:wallId","status":200,"ms":12,"time":"2026-11-15T03:04:05.123Z","level":"info","service":"web","msg":"GET /w/:wallId 200 12ms","reqId":"7c0b..."}
```

- 字段：`time`、`level`（`debug|info|warn|error`）、`service`（`web|pages`）、`msg`，请求内的日志有 `reqId`；访问日志还有 `method`、`route`（路由模板，不含具体标识）、`status`、`ms`。5xx 为 `error` 级别。
- 访问日志**不记录**查询串、cookie、表单内容与邮箱；页面托管路径里的票据写成 `/v/:ticket/...`。JSON 日志里的邮箱与 `nmt_` token 会被打码。
- 每个响应带 `X-Request-Id`。用户反馈出错时让他提供这个 ID（浏览器开发者工具里能看到），再按它查日志。

常用命令：

```bash
docker compose logs -f --tail=200 web
docker compose logs web pages worker --since 1h | grep '"level":"error"'
docker compose logs web --since 1h | grep '7c0b...'          # 某个请求的全部日志
docker compose logs web --since 1h | jq -c 'select(.status >= 500)'
```

Docker 默认的 json-file 日志驱动不限大小；在 `/etc/docker/daemon.json` 里配置 `"log-opts": {"max-size": "20m", "max-file": "5"}` 防止磁盘被写满。

## 8. CI

`.github/workflows/ci.yml`：每次 push 与 pull request 运行 `test` 任务（安装、Chromium、Kit 字体、Skill 打包、`typecheck`、`test`、`build`）与独立的 `e2e` 任务（`pnpm test:e2e`）。固定使用 Ubuntu 24.04，避免 `ubuntu-latest` 升级到 Playwright 1.58 不支持的系统。本地想复现，按同样顺序执行这些命令即可。

### GitHub 与腾讯云自动同步

GitHub 是代码的唯一发布入口。本地提交并推送到开发分支、通过 PR 合并到 `main` 后，CI 的 `test` 和 `e2e` 都通过，才运行 `deploy`，同时更新 Demo 与正式环境。开发分支推送只检查，不影响线上；保存本地文件也不会直接上线。

```bash
git switch -c codex/my-change
# 修改代码后
git add <本次修改的文件>
git commit -m "feat: describe the change"
git push -u origin codex/my-change
gh pr create --base main
# 在 GitHub 合并 PR；到 Actions → CI 查看 deploy 结果
```

部署流程：

1. GitHub 将**通过测试的准确提交**打成 `git archive`，通过专用 SSH 密钥发送到 `/opt/nowme/releases/<提交号>.<随机值>`。只传受 Git 管理的文件，不同步本地数据和环境文件。
2. `deploy/server-release.sh` 使用服务器上的字体缓存构建 `nowme:<提交号>`；构建期间旧服务继续运行。
3. 校验 Caddy 配置、备份正式数据，先更新 Demo 并检查实际登录页，再更新正式主站、页面托管与 worker。
4. 检查 HTTPS、正式数据库就绪状态与 worker 是否持续存活；全部通过才更新 `/opt/nowme/deployed-sha` 和 `current-release`。

GitHub 仓库 Actions secrets：`TENCENT_DEPLOY_KEY`（专用私钥）、`TENCENT_KNOWN_HOSTS`（已核实的服务器 SSH 主机公钥）。可选 repository variable：`TENCENT_DEPLOY_HOST`，默认 `ubuntu@124.222.53.43`。服务器 `authorized_keys` 中该密钥使用 `restrict,command="/home/ubuntu/.local/bin/nowme-github-deploy"`；该脚本由 `deploy/github-receive.sh` 安装，只接受 `deploy <40 位提交号>`，不提供终端或端口转发。

`.env`、`deploy/demo.env`、数据库、页面文件和 HTTPS 证书保留在服务器上。线上用户数据不会同步回本地或进入 GitHub。若其他电脑或 Agent 改了仓库，本地用 `git pull --ff-only` 获取。不要直接修改服务器上的应用代码；修复也应从本地走 PR。

发布失败到 Actions 查看日志。构建或备份失败时尚未更新应用；开始更新容器后失败，可能留下部分更新，需要修复并重新发布。升级前备份在 `/opt/nowme/backups`，旧镜像 ID 在 `/opt/nowme/previous-image`。数据库迁移不做自动降级，回滚按第 5–6 节操作。

## 9. 没有域名时：单台服务器、IP 直连

域名备案完成之前的临时做法（`deploy/`）。一台服务器上同时跑正式环境、演示环境和 Caddy：

| 地址 | 内容 |
| --- | --- |
| `https://<IP>` | 正式环境主站（`web`） |
| `https://<IP>:8443` | 正式环境页面托管（`pages`） |
| `https://<IP>:8444` | 演示环境主站（`demo`，`pnpm demo`：一键体验登录、独立数据卷 `nowme-demo-data`） |
| `https://<IP>:8445` | 演示环境页面托管（与演示主站同一进程） |

- 云防火墙放行 TCP 80、443、8443、8444、8445（80 只用于证书验证与跳转）。
- 证书：Caddy 向 Let's Encrypt 申请 IP 证书（`shortlived` 配置，约 6 天有效，自动续期）。
- 两个源在同一个 IP 上，必须设置 `NOWME_ALLOW_SAME_IP_ORIGINS=1`（contracts 10.1）。这放宽了“主站与页面托管是不同站点”的约定：会话 cookie 会随请求到达页面托管端口。有了两个域名后去掉这个变量，按第 3 节部署。
- 同一 IP 上运行正式站与 Demo 时，非默认端口的主站使用 `nowme_session_<端口>` Cookie，两个环境登录与退出互不覆盖；数据库、票据密钥与加密密钥仍各自独立。
- 演示环境任何人都能一键登录并使用维护者预置的模型 Key，注意模型费用；不需要时 `docker compose ... stop demo`。
- 环境文件：`deploy/prod.env`（上传后是服务器上的 `.env`）与 `deploy/demo.env`，含密钥，不入库。
- 日常更新走第 8 节的 GitHub 自动发布。首次部署或手动修复可用 `deploy/deploy.sh`（rsync 当前工作区 → 服务器上构建镜像 → 启动服务）；仅改配置时加 `--no-build`。手动部署会使用本机环境文件，应先核实它们与服务器一致。
- 服务器上的日常命令要带上两个 compose 文件，例如 `cd /opt/nowme && sudo docker compose -f docker-compose.yml -f deploy/compose.ip.yml logs -f web`。

### 腾讯云构建时的浏览器下载备用路径

Playwright 1.58 的 Chromium 使用 Chrome for Testing 下载布局。旧的 `https://npmmirror.com/mirrors/playwright` 不包含 `builds/cft/`，不能再作为统一下载源。默认使用 Playwright 官方源；官方源连接不稳定时，可在服务器上临时运行路径转换器（只绑定回环地址，不对公网开放）：

```bash
cd /opt/nowme
sudo docker run -d --name nowme-browser-download -p 127.0.0.1:9080:8080 \
  -v "$PWD/deploy/browser-download-proxy.cjs:/server.cjs:ro" \
  node:22-bookworm-slim node /server.cjs
sudo docker build --network host -t nowme:latest \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  --build-arg APT_MIRROR=mirrors.cloud.tencent.com \
  --build-arg PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:9080 .
sudo docker rm -f nowme-browser-download
```

转换器只将构建依赖下载重定向到 npmmirror 的 HTTPS 地址，不代理用户请求，不进入应用镜像。复用本机字体时需在服务器构建上下文中保留 `packages/kit/fonts/`，并移除服务器 `.dockerignore` 中对应的字体排除条目。

容器运行时直接调用 Node（Demo 通过 `--import tsx --conditions=source` 运行），避免 pnpm 在 `NODE_ENV=production` 下启动脚本时自动重装依赖。生产容器里的运营脚本同样用 `node --import tsx --conditions=source apps/web/scripts/<脚本>.ts` 调用。
