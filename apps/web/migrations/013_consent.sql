-- 用户协议与隐私政策的同意记录（contracts 16.3）：记下用户确认“已年满 18 岁，并同意用户协议和隐私政策”时的文档版本与时间。
-- 只有最近一次确认；版本与当前 LEGAL_VERSION 不同（或为空，即这条迁移之前的老用户）时，下次登录需要重新确认。
ALTER TABLE users ADD COLUMN terms_version TEXT;
ALTER TABLE users ADD COLUMN terms_accepted_at TEXT;
