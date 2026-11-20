-- 直接改文字（contracts 22）：主人不经过 AI 直接改页面文字，入队渲染后存为新版本。
--
-- - render_jobs 增加 kind = 'owner-edit'：发起人是页面主人（owner_id），没有页面凭证（credential_id 为空）。
--   SQLite 不能修改 CHECK 约束，所以重建表（没有外键与触发器引用它）。
-- - revisions.source 增加 owner-edit（credential_id 为空）。

CREATE TABLE render_jobs_new (
  id                TEXT PRIMARY KEY CHECK (id GLOB 'job_*'),
  kind              TEXT NOT NULL CHECK (kind IN ('submission', 'preview', 'owner-edit')),
  status            TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  page_id           TEXT NOT NULL,
  -- 本地 Agent 的提交与预览：页面凭证；直接改文字：为空
  credential_id     TEXT,
  -- 直接改文字：页面主人；其他：为空
  owner_id          TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  lease_owner       TEXT,
  lease_expires_at  TEXT,
  outcome           TEXT CHECK (outcome IS NULL OR outcome IN ('stored', 'rendered', 'rate_limited', 'credential_invalid', 'rejected')),
  revision_id       TEXT,
  error_code        TEXT,
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT,
  CHECK ((status = 'done') = (outcome IS NOT NULL)),
  CHECK ((kind = 'owner-edit') = (owner_id IS NOT NULL)),
  CHECK ((kind = 'owner-edit') = (credential_id IS NULL))
);
INSERT INTO render_jobs_new (id, kind, status, page_id, credential_id, owner_id, attempts, max_attempts, lease_owner, lease_expires_at, outcome, revision_id, error_code, created_at, started_at, finished_at)
  SELECT id, kind, status, page_id, credential_id, NULL, attempts, max_attempts, lease_owner, lease_expires_at, outcome, revision_id, error_code, created_at, started_at, finished_at FROM render_jobs;
DROP TABLE render_jobs;
ALTER TABLE render_jobs_new RENAME TO render_jobs;
CREATE INDEX render_jobs_claim ON render_jobs (status, created_at);

DROP TRIGGER revisions_source_check_insert;
DROP TRIGGER revisions_source_check_update;
CREATE TRIGGER revisions_source_check_insert BEFORE INSERT ON revisions
WHEN NEW.source NOT IN ('local-agent', 'hosted', 'owner-edit')
BEGIN
  SELECT RAISE(ABORT, 'revisions.source must be local-agent, hosted or owner-edit');
END;
CREATE TRIGGER revisions_source_check_update BEFORE UPDATE OF source ON revisions
WHEN NEW.source NOT IN ('local-agent', 'hosted', 'owner-edit')
BEGIN
  SELECT RAISE(ABORT, 'revisions.source must be local-agent, hosted or owner-edit');
END;
