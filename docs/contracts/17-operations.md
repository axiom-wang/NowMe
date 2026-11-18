# 17. 运维：容器、备份与日志

细节与操作步骤见 [deploy.md](../deploy.md)。

**镜像与编排。** 根目录 `Dockerfile` 多阶段构建（安装依赖、下载 Kit 字体、`pnpm build`、打 Skill 包；运行阶段装 Playwright Chromium 与系统库，以非 root 的 `node` 用户运行）。`docker-compose.yml` 用同一个镜像起三个服务：`web`（主站）、`pages`（页面托管，数据卷只读）、`worker`（`start:worker`，13 节），共享数据卷 `/data`（`NOWME_DATA_DIR`）；端口只绑定本机回环地址，由反向代理对外。环境变量来自 `.env`（模板 `.env.production.example`）。页面托管只读挂载数据卷，所以生产必须显式设置 `NOWME_TICKET_SECRET`。

**备份与恢复。** `pnpm --filter @nowme/web backup` 把数据库（`VACUUM INTO` 在线一致性快照，主站运行时可执行）与 `revisions/` 打成 `NOWME_BACKUP_DIR/nowme-backup-<UTC 时间戳>.tar.gz`，保留最近 `NOWME_BACKUP_KEEP`（默认 7）份；先写 `.partial` 再改名，归档文件权限 0600（不依赖备份目录的权限）。备份不含 `secret` 文件与 `NOWME_AI_ENCRYPTION_KEY`（后者必须单独保管）。`restore <文件> --to <目录>` 只写到不存在或为空的目录，校验归档内只有 `db.sqlite` 与 `revisions/`，恢复后执行 `PRAGMA integrity_check` 与 `foreign_key_check`，失败则清理目标。

**日志与请求 ID。** `NODE_ENV=production` 时主站与页面托管输出 JSON 行：`time`（ISO 8601）、`level`（`debug|info|warn|error`）、`service`（`web|pages`）、`msg`、`reqId`（请求内的日志才有），访问日志另有 `method`、`route`、`status`、`ms`；开发环境保持可读文本。JSON 日志里（`msg` 与各字段的字符串值）的邮箱与令牌（`nmt_` / `nmc_` / `nms_`、邀请码 `inv_`、公开链接 `pub_`）会被打码。每个响应带 `X-Request-Id`；只有声明了 `NOWME_TRUST_PROXY` 才接受上游传来的（须匹配 `^[A-Za-z0-9._-]{8,64}$`），否则自己生成。访问日志只记方法、路由模板（没有命中路由时只留前两段路径）、状态码、耗时，**不记录查询串、cookie、表单内容、邮箱**；页面托管路径里的票据一律写成 `/v/:ticket/...`。访问日志默认只在生产环境写。

**CI。** `.github/workflows/ci.yml`：push 与 pull_request 触发；Node 版本读 `.nvmrc`，pnpm 缓存；`test` 任务依次执行安装（`--frozen-lockfile`）、Playwright Chromium、Kit 字体、Skill 打包、`typecheck`、`test`、`build`；`e2e` 任务单独运行 `pnpm test:e2e`。
