-- 生成完成通知（contracts 18）。
-- 1. users.notify_job_email：生成 / 修改完成或失败、而主人已经离开页面时，发一封提醒邮件。默认开启，可在“我的资料”里关掉。
-- 2. job_notices：每个任务只判定一次（发了 / 主人在看 / 关掉了 / 不用发 / 发送失败），重启或多个主站实例都不会重复发信。
--    只存任务 ID、判定结果与时间，不存邮箱、墙名或任何页面内容；30 天后清理。
ALTER TABLE users ADD COLUMN notify_job_email INTEGER NOT NULL DEFAULT 1 CHECK (notify_job_email IN (0, 1));

CREATE TABLE job_notices (
  job_id     TEXT PRIMARY KEY,
  outcome    TEXT NOT NULL CHECK (outcome IN ('pending', 'sent', 'present', 'off', 'skipped', 'failed')),
  created_at TEXT NOT NULL
);

CREATE INDEX job_notices_created ON job_notices (created_at);

-- 主站按结束时间扫描刚结束的任务
CREATE INDEX generation_jobs_finished ON generation_jobs (finished_at);
