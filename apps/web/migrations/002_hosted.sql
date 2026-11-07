-- 平台托管路线（contracts 9 / hosted-route.md 第 4 节）：长期画像、brief、采访素材、生成任务；revisions.source 增加 hosted。
-- 这些表里的内容（画像、brief、素材、修改要求、任务结果）只属于主人：只有主人能读、能删（S7）。

-- 长期画像（按用户，跨墙）。只存“主人明确表达 / 主人确认”的条目；“模型暂定”不入库。删除为物理删除。
CREATE TABLE profile_entries (
  id            TEXT PRIMARY KEY CHECK (id GLOB 'pfe_*'),
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  category      TEXT NOT NULL CHECK (category IN ('fact', 'quote', 'preference', 'boundary')),
  text          TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 400),
  source        TEXT NOT NULL CHECK (source IN ('interview', 'owner-file')),
  confirmation  TEXT NOT NULL CHECK (confirmation IN ('owner-stated', 'owner-confirmed')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX profile_entries_user ON profile_entries (user_id, created_at);

-- 应用内采访与 brief：每页一份（重新采访时覆盖）。
-- answers_json：素材文本与点选；followups_json：抽取结果与追问；brief_json：结构化 brief；brief_md：渲染出的 brief.md。
CREATE TABLE briefs (
  id              TEXT PRIMARY KEY CHECK (id GLOB 'brf_*'),
  page_id         TEXT NOT NULL UNIQUE REFERENCES pages (id),
  owner_id        TEXT NOT NULL REFERENCES users (id),
  status          TEXT NOT NULL CHECK (status IN ('collecting', 'followups', 'review', 'confirmed')),
  answers_json    TEXT,
  followups_json  TEXT,
  brief_json      TEXT,
  brief_md        TEXT,
  confirmed_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL))
);
CREATE INDEX briefs_owner ON briefs (owner_id);

-- 采访时主人上传的图片。文件在 <dataDir>/hosted/<pageId>/assets/<file_name>；类型按文件头魔数判断，文件名由平台生成。
CREATE TABLE brief_assets (
  id          TEXT PRIMARY KEY CHECK (id GLOB 'bas_*'),
  brief_id    TEXT NOT NULL REFERENCES briefs (id) ON DELETE CASCADE,
  page_id     TEXT NOT NULL REFERENCES pages (id),
  owner_id    TEXT NOT NULL REFERENCES users (id),
  file_name   TEXT NOT NULL CHECK (file_name GLOB 'photo-[0-9]*.*'),
  mime        TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  bytes       INTEGER NOT NULL CHECK (bytes > 0),
  sha256      TEXT NOT NULL CHECK (length(sha256) = 64),
  created_at  TEXT NOT NULL,
  UNIQUE (page_id, file_name)
);
CREATE INDEX brief_assets_brief ON brief_assets (brief_id);

-- 托管生成 / 修改任务。charged = 1 表示消耗了 1 次免费额度（只有 succeeded 才会扣）。
-- request_text / result_message 是内容，只给主人看；删除页面时清空（任务行保留为墓碑，额度不恢复）。
-- usage_json 只含 token 数与轮数。
CREATE TABLE generation_jobs (
  id                TEXT PRIMARY KEY CHECK (id GLOB 'gen_*'),
  page_id           TEXT NOT NULL REFERENCES pages (id),
  owner_id          TEXT NOT NULL REFERENCES users (id),
  kind              TEXT NOT NULL CHECK (kind IN ('generate', 'edit')),
  status            TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'needs_input')),
  base_revision_id  TEXT REFERENCES revisions (id),
  target_block      TEXT,
  request_text      TEXT,
  result_message    TEXT,
  revision_id       TEXT REFERENCES revisions (id),
  error_code        TEXT,
  charged           INTEGER NOT NULL DEFAULT 0 CHECK (charged IN (0, 1)),
  usage_json        TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT,
  CHECK (charged = 0 OR status = 'succeeded')
);
CREATE INDEX generation_jobs_page ON generation_jobs (page_id, created_at);
CREATE INDEX generation_jobs_status ON generation_jobs (status);

-- 版本来源：local-agent（本地 Agent 通过页面凭证提交）/ hosted（平台托管生成，credential_id 为空）。
CREATE TRIGGER revisions_source_check_insert BEFORE INSERT ON revisions
WHEN NEW.source NOT IN ('local-agent', 'hosted')
BEGIN
  SELECT RAISE(ABORT, 'revisions.source must be local-agent or hosted');
END;
CREATE TRIGGER revisions_source_check_update BEFORE UPDATE OF source ON revisions
WHEN NEW.source NOT IN ('local-agent', 'hosted')
BEGIN
  SELECT RAISE(ABORT, 'revisions.source must be local-agent or hosted');
END;
