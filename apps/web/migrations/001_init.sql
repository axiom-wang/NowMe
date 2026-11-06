-- NOWMe 主站数据库（contracts 第 3 节）：全部表、约束与索引。
-- 时间一律为 ISO 8601 UTC 字符串（`Date#toISOString()`，可按字符串比较大小）。
-- 一次性 token、页面凭证、会话令牌、登录验证码只存 SHA-256 哈希（hex，64 个字符）；
-- 邀请码与公开链接令牌是可分享的链接，明文保存，可随时轮换。
-- M3（墙、邀请、发布、事件）直接使用这里的表，不再修改表结构；需要新表时另加迁移文件。

-- 用户。首次登录时 nickname 为空，填写昵称后才能使用其他页面。
CREATE TABLE users (
  id          TEXT PRIMARY KEY CHECK (id GLOB 'usr_*'),
  email       TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  nickname    TEXT,
  created_at  TEXT NOT NULL
);

-- 登录验证码：6 位数字，10 分钟，最多 5 次尝试。code_hash = SHA-256("<id>.<code>")。
-- 新验证码签发时，同一邮箱未使用的旧验证码被作废（used_at 置为签发时间）。
CREATE TABLE login_codes (
  id          TEXT PRIMARY KEY CHECK (id GLOB 'lgc_*'),
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL CHECK (length(code_hash) = 64),
  attempts    INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX login_codes_email_created ON login_codes (email, created_at);

-- 会话：id 是会话令牌（nms_...）的 SHA-256；30 天。csrf_token 随表单下发，不是秘密凭据。
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY CHECK (length(id) = 64),
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  csrf_token  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- 墙。status = closed 时 closed_at 必填；关闭的墙对所有人不可见。
CREATE TABLE walls (
  id              TEXT PRIMARY KEY CHECK (id GLOB 'wal_*'),
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  scene_type      TEXT NOT NULL CHECK (scene_type IN ('hackathon', 'interest', 'club', 'general')),
  organizer_note  TEXT,
  organizer_id    TEXT NOT NULL REFERENCES users (id),
  invite_code     TEXT NOT NULL UNIQUE CHECK (invite_code GLOB 'inv_*'),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at      TEXT NOT NULL,
  closed_at       TEXT,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX walls_organizer ON walls (organizer_id);

-- 成员关系。(wall_id, user_id) 唯一：退出后再加入复用同一行（status 回到 active、ended_at 清空）；
-- removed 的成员不能再加入（由应用检查）。组织者建墙时自动成为 role = organizer 的成员。
CREATE TABLE memberships (
  id         TEXT PRIMARY KEY CHECK (id GLOB 'mem_*'),
  wall_id    TEXT NOT NULL REFERENCES walls (id),
  user_id    TEXT NOT NULL REFERENCES users (id),
  role       TEXT NOT NULL CHECK (role IN ('organizer', 'member')),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left', 'removed')),
  joined_at  TEXT NOT NULL,
  ended_at   TEXT,
  UNIQUE (wall_id, user_id),
  CHECK ((status = 'active') = (ended_at IS NULL))
);
CREATE INDEX memberships_user ON memberships (user_id, status);
CREATE INDEX memberships_wall ON memberships (wall_id, status);

-- 页面：加入墙时创建，一个成员关系一页。public_token 为空表示未开启公开链接。
-- contact_public：0 / 1。联系方式只在发布时快照进 publications.contact_json。
CREATE TABLE pages (
  id               TEXT PRIMARY KEY CHECK (id GLOB 'pg_*'),
  membership_id    TEXT NOT NULL UNIQUE REFERENCES memberships (id),
  wall_id          TEXT NOT NULL REFERENCES walls (id),
  owner_id         TEXT NOT NULL REFERENCES users (id),
  contact_channel  TEXT,
  contact_value    TEXT,
  contact_public   INTEGER NOT NULL DEFAULT 0 CHECK (contact_public IN (0, 1)),
  public_token     TEXT UNIQUE CHECK (public_token IS NULL OR public_token GLOB 'pub_*'),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX pages_wall ON pages (wall_id);
CREATE INDEX pages_owner ON pages (owner_id);

-- 一次性 token（nmt_...）：只存哈希；换取成功时 used_at 置为当前时间。
-- 重新生成指令、断开本地 Agent 时，该页未使用的 token 直接删除（作废）。
CREATE TABLE agent_tokens (
  id          TEXT PRIMARY KEY CHECK (id GLOB 'agt_*'),
  page_id     TEXT NOT NULL REFERENCES pages (id),
  token_hash  TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX agent_tokens_page ON agent_tokens (page_id);

-- 页面凭证（nmc_...）：只存哈希。每页同时最多一个有效凭证（revoked_at IS NULL）。
CREATE TABLE page_credentials (
  id               TEXT PRIMARY KEY CHECK (id GLOB 'crd_*'),
  page_id          TEXT NOT NULL REFERENCES pages (id),
  credential_hash  TEXT NOT NULL UNIQUE CHECK (length(credential_hash) = 64),
  created_at       TEXT NOT NULL,
  last_used_at     TEXT,
  revoked_at       TEXT
);
CREATE UNIQUE INDEX page_credentials_one_active ON page_credentials (page_id) WHERE revoked_at IS NULL;
CREATE INDEX page_credentials_page ON page_credentials (page_id);

-- 版本：number 页内递增（accepted 与 rejected 共用一个序列）。
-- 文件存 <dataDir>/revisions/<id>/（original/、served/、cover.png、render/full.png）；
-- rejected 版本只存报告（report_json），不写文件，card_json / manifest_json / rendered_text / render_json 为空。
CREATE TABLE revisions (
  id             TEXT PRIMARY KEY CHECK (id GLOB 'rev_*'),
  page_id        TEXT NOT NULL REFERENCES pages (id),
  number         INTEGER NOT NULL CHECK (number >= 1),
  source         TEXT NOT NULL DEFAULT 'local-agent',
  credential_id  TEXT REFERENCES page_credentials (id),
  status         TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
  report_json    TEXT NOT NULL,
  card_json      TEXT,
  manifest_json  TEXT,
  rendered_text  TEXT,
  render_json    TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (page_id, number)
);
CREATE INDEX revisions_page_created ON revisions (page_id, created_at);

-- 发布：不可变快照。每页至多一个 ended_at IS NULL 的发布（部分唯一索引）。
-- 结束时 ended_at 与 end_reason 同时填写。contact_json 可以为空（发布时不公开联系方式）。
CREATE TABLE publications (
  id            TEXT PRIMARY KEY CHECK (id GLOB 'pbl_*'),
  page_id       TEXT NOT NULL REFERENCES pages (id),
  revision_id   TEXT NOT NULL REFERENCES revisions (id),
  card_json     TEXT NOT NULL,
  contact_json  TEXT,
  published_at  TEXT NOT NULL,
  ended_at      TEXT,
  end_reason    TEXT CHECK (end_reason IN ('superseded', 'withdrawn', 'removed', 'closed', 'deleted')),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
CREATE UNIQUE INDEX publications_one_active ON publications (page_id) WHERE ended_at IS NULL;
CREATE INDEX publications_page ON publications (page_id, published_at);
CREATE INDEX publications_revision ON publications (revision_id);

-- 事件（contracts 6）：只存类型、ID、数值 / 布尔属性，不存内容。
-- 不设外键：事件是统计日志，不应阻止删除页面或版本；类型由应用按 EVENT_TYPES 检查。
CREATE TABLE events (
  id          TEXT PRIMARY KEY CHECK (id GLOB 'evt_*'),
  type        TEXT NOT NULL,
  wall_id     TEXT,
  page_id     TEXT,
  actor_id    TEXT,
  props_json  TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX events_wall_type ON events (wall_id, type, created_at);
CREATE INDEX events_page ON events (page_id, created_at);
