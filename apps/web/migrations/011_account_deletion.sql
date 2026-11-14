-- 账号注销与数据导出（contracts 14）。
--
-- 1. users.deleted_at：注销时间。注销后用户行保留为墓碑（其他表的外键仍指向它），
--    但邮箱改为 `deleted:<用户 ID>`（不含原邮箱，也不是合法邮箱，登录表单永远匹配不到）、昵称改为“已注销用户”、头像清空。
--    同一个邮箱之后可以重新注册成一个新账号。
ALTER TABLE users ADD COLUMN deleted_at TEXT;

-- 2. login_codes.purpose：验证码的用途。登录只认 login；注销只认 account_delete（注销前必须新发一个，
--    登录用过 / 没用过的验证码都不能拿来注销，注销用的验证码也不能拿来登录）。
ALTER TABLE login_codes ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login' CHECK (purpose IN ('login', 'account_delete'));

-- 3. credit_entries.reason 增加 account_deleted：注销时个人余额作废，记一笔流水（S10：流水只追加，不删除）。
--    SQLite 不能修改 CHECK，只能重建表；重建保持原有的行顺序、索引与“只追加”触发器。
CREATE TABLE credit_entries_v11 (
  id             TEXT PRIMARY KEY CHECK (id GLOB 'cre_*'),
  account_kind   TEXT NOT NULL CHECK (account_kind IN ('user', 'wall')),
  account_id     TEXT NOT NULL,
  delta          INTEGER NOT NULL CHECK (delta <> 0),
  balance_after  INTEGER NOT NULL CHECK (balance_after >= 0),
  -- 009 的原因之外：account_deleted 注销账号时个人余额作废
  reason         TEXT NOT NULL CHECK (reason IN ('redeem', 'grant', 'signup', 'adjust', 'sponsor_out', 'sponsor_in', 'sponsor_return', 'job', 'job_refund', 'account_deleted')),
  ref_id         TEXT,
  actor_id       TEXT,
  created_at     TEXT NOT NULL
);
INSERT INTO credit_entries_v11 (id, account_kind, account_id, delta, balance_after, reason, ref_id, actor_id, created_at)
  SELECT id, account_kind, account_id, delta, balance_after, reason, ref_id, actor_id, created_at FROM credit_entries ORDER BY rowid;
DROP TABLE credit_entries;
ALTER TABLE credit_entries_v11 RENAME TO credit_entries;

CREATE INDEX credit_entries_account ON credit_entries (account_kind, account_id, created_at);
CREATE UNIQUE INDEX credit_entries_once ON credit_entries (reason, ref_id) WHERE reason IN ('job', 'job_refund', 'redeem');
CREATE UNIQUE INDEX credit_entries_signup ON credit_entries (account_id) WHERE reason = 'signup';
CREATE INDEX credit_entries_wall_actor ON credit_entries (account_id, actor_id) WHERE account_kind = 'wall';

CREATE TRIGGER credit_entries_no_update BEFORE UPDATE ON credit_entries
BEGIN
  SELECT RAISE(ABORT, 'credit_entries 只追加，不能修改');
END;
CREATE TRIGGER credit_entries_no_delete BEFORE DELETE ON credit_entries
BEGIN
  SELECT RAISE(ABORT, 'credit_entries 只追加，不能删除');
END;

-- 注销时按发送者清空聊天消息
CREATE INDEX chat_messages_sender ON chat_messages (sender_id);
