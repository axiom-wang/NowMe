-- 注销账号的补充（contracts 14.7、15）：举报证据转存，与同一邮箱重新注册时不再赠送点数。

-- 1. 证据转存：注销时，针对他的每一条**待处理**举报，把被举报的内容转存在这里，只给平台运营（moderation show）看。
--    page：被举报那一版的缩略卡、页面文字与整页截图；conversation：被举报私信里他发的消息（到举报时为止）。
--    举报处理完（status 不再是 open，下面的触发器）或到期（expires_at，注销后 180 天；启动时与运营命令执行时清理）后删除。
--    任何网页路由都不读这张表。
CREATE TABLE deletion_evidence (
  report_id      TEXT PRIMARY KEY REFERENCES reports (id),
  kind           TEXT NOT NULL CHECK (kind IN ('page', 'conversation')),
  card_json      TEXT,
  rendered_text  TEXT,
  screenshot     BLOB,
  -- [{ sequence, at, text }]
  messages_json  TEXT,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  CHECK ((kind = 'page' AND messages_json IS NULL) OR (kind = 'conversation' AND card_json IS NULL AND rendered_text IS NULL AND screenshot IS NULL AND messages_json IS NOT NULL))
);
CREATE INDEX deletion_evidence_expires ON deletion_evidence (expires_at);

CREATE TRIGGER deletion_evidence_cleared_on_resolve AFTER UPDATE OF status ON reports
WHEN NEW.status <> 'open'
BEGIN
  DELETE FROM deletion_evidence WHERE report_id = NEW.id;
END;

-- 2. 注销过的邮箱：只存带密钥的哈希（HMAC-SHA256，密钥由服务端票据密钥派生），不存邮箱本身。
--    只用于一件事：同一邮箱注销后重新注册时，不再发注册赠送点数。
CREATE TABLE deleted_emails (
  email_hmac  TEXT PRIMARY KEY CHECK (length(email_hmac) = 64),
  created_at  TEXT NOT NULL
);
