-- 举报、拉黑与处理（contracts 15、S12）。

-- 举报：对象是墙上已发布的页面，或一段一对一私信。同一个人对同一页面 / 同一段私信只有一条（重复举报只更新）。
-- note 只给平台运营看；组织者只能看到页面、原因类别与次数（S12）。
-- publication_id：举报时页面的当前发布（处理后页面重新发布、内容换了，再次举报会重新打开）。
-- last_sequence：举报私信时这段对话最后一条消息的序号（平台运营只看到这条为止的内容）。
CREATE TABLE reports (
  id                TEXT PRIMARY KEY CHECK (id GLOB 'rpt_*'),
  reporter_id       TEXT NOT NULL REFERENCES users (id),
  target_kind       TEXT NOT NULL CHECK (target_kind IN ('page', 'conversation')),
  wall_id           TEXT NOT NULL REFERENCES walls (id),
  reported_user_id  TEXT NOT NULL REFERENCES users (id),
  page_id           TEXT REFERENCES pages (id),
  publication_id    TEXT REFERENCES publications (id),
  conversation_id   TEXT REFERENCES conversations (id),
  last_sequence     INTEGER CHECK (last_sequence IS NULL OR last_sequence >= 0),
  reason            TEXT NOT NULL CHECK (reason IN ('harassment', 'inappropriate', 'impersonation', 'spam', 'other')),
  note              TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'actioned')),
  resolved_by       TEXT CHECK (resolved_by IN ('organizer', 'platform')),
  resolved_at       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (reporter_id <> reported_user_id),
  CHECK ((status = 'open') = (resolved_at IS NULL) AND (resolved_at IS NULL) = (resolved_by IS NULL)),
  CHECK ((target_kind = 'page' AND page_id IS NOT NULL AND publication_id IS NOT NULL AND conversation_id IS NULL AND last_sequence IS NULL)
      OR (target_kind = 'conversation' AND conversation_id IS NOT NULL AND last_sequence IS NOT NULL AND page_id IS NULL AND publication_id IS NULL))
);
CREATE UNIQUE INDEX reports_page_once ON reports (reporter_id, page_id) WHERE target_kind = 'page';
CREATE UNIQUE INDEX reports_conversation_once ON reports (reporter_id, conversation_id) WHERE target_kind = 'conversation';
CREATE INDEX reports_wall_open ON reports (wall_id, status, target_kind);
CREATE INDEX reports_status ON reports (status, updated_at);

-- 处理记录：只追加。actor = organizer 时 actor_user_id 是组织者；platform 是命令行操作，没有账号。
CREATE TABLE moderation_actions (
  id              TEXT PRIMARY KEY CHECK (id GLOB 'mda_*'),
  actor           TEXT NOT NULL CHECK (actor IN ('organizer', 'platform')),
  actor_user_id   TEXT REFERENCES users (id),
  action          TEXT NOT NULL CHECK (action IN ('takedown', 'dismiss', 'resolve', 'suspend', 'unsuspend')),
  wall_id         TEXT REFERENCES walls (id),
  page_id         TEXT REFERENCES pages (id),
  publication_id  TEXT REFERENCES publications (id),
  report_id       TEXT REFERENCES reports (id),
  user_id         TEXT REFERENCES users (id),
  note            TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_at      TEXT NOT NULL,
  CHECK ((actor = 'organizer') = (actor_user_id IS NOT NULL))
);
CREATE INDEX moderation_actions_publication ON moderation_actions (publication_id) WHERE publication_id IS NOT NULL;

-- 拉黑：账号之间，对所有共同的墙生效；双向效果由查询负责（任一方向存在即生效）。
CREATE TABLE blocks (
  blocker_id  TEXT NOT NULL REFERENCES users (id),
  blocked_id  TEXT NOT NULL REFERENCES users (id),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_blocked ON blocks (blocked_id);

-- 停用账号：有记录即停用（不能登录、会话失效、页面下墙）；解除时删除记录，处理记录里留痕。
CREATE TABLE user_suspensions (
  user_id       TEXT PRIMARY KEY REFERENCES users (id),
  reason        TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  suspended_at  TEXT NOT NULL
);
