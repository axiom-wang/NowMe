-- 后台任务队列（contracts 13）：主站只入队，worker 进程（或 inline 模式下主站进程内的 worker 循环）领取执行。
--
-- 两类任务，一套租约规则：
-- - AI 生成 / 修改：直接复用 generation_jobs（状态仍是 queued / running / succeeded / failed / needs_input），
--   这里只加租约与模型来源列。重启打断的任务不自动重试（避免重复计费），标记 INTERRUPTED 并退点。
-- - 提交渲染、远程预览：render_jobs。渲染幂等，租约过期后可以重试（attempts < max_attempts）。
--
-- 只存类型、状态、ID、计数与时间，不存任何页面文件、模型输出或用户内容。
-- 上传的页面文件在执行期间暂存于 <dataDir>/jobs/<id>/（只有白名单路径），任务结束即删除。
-- 不建外键：任务行按时间清理，账号注销时可以按 page_id 直接删除。

ALTER TABLE generation_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
-- 持有租约的 worker（进程内随机 ID）与租约到期时间；执行中定期续约
ALTER TABLE generation_jobs ADD COLUMN lease_owner TEXT;
ALTER TABLE generation_jobs ADD COLUMN lease_expires_at TEXT;
-- 入队时确定的模型来源（own 自己的 Key / platform 平台 AI）与用户模型配置的版本号（随机 UUID，不是 Key）：
-- worker 按它取模型；主人在排队期间删除或更换了配置时，任务以 MODEL_CONFIG 失败，不会改用新配置
ALTER TABLE generation_jobs ADD COLUMN model_source TEXT CHECK (model_source IS NULL OR model_source IN ('own', 'platform'));
ALTER TABLE generation_jobs ADD COLUMN model_version TEXT;
CREATE INDEX generation_jobs_claim ON generation_jobs (status, created_at);

CREATE TABLE render_jobs (
  id                TEXT PRIMARY KEY CHECK (id GLOB 'job_*'),
  kind              TEXT NOT NULL CHECK (kind IN ('submission', 'preview')),
  status            TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  page_id           TEXT NOT NULL,
  credential_id     TEXT NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  lease_owner       TEXT,
  lease_expires_at  TEXT,
  -- done 时的结果：stored（存了版本）、rendered（预览结果已写到暂存目录）、rate_limited、credential_invalid
  outcome           TEXT CHECK (outcome IS NULL OR outcome IN ('stored', 'rendered', 'rate_limited', 'credential_invalid')),
  revision_id       TEXT,
  -- failed 时的原因：INTERNAL（处理器出错）、INTERRUPTED（重试次数用完）、ABANDONED（等待方放弃）
  error_code        TEXT,
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT,
  CHECK ((status = 'done') = (outcome IS NOT NULL))
);
CREATE INDEX render_jobs_claim ON render_jobs (status, created_at);

-- 进度事件：阶段、序号、时间与少量数值（轮次、尝试次数），不存模型输出或用户内容。
-- job_id 是 generation_jobs.id（gen_）或 render_jobs.id（job_）。
CREATE TABLE job_events (
  job_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL CHECK (seq >= 1),
  stage       TEXT NOT NULL CHECK (stage IN ('queued', 'reading', 'designing', 'generating', 'validating', 'rendering', 'retrying', 'succeeded', 'needs_input', 'failed')),
  props_json  TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);
CREATE INDEX job_events_created ON job_events (created_at);
