-- 账号头像与昵称一起保存；只存重编码后的位图。
ALTER TABLE users ADD COLUMN avatar_webp BLOB;
ALTER TABLE users ADD COLUMN avatar_version TEXT;
