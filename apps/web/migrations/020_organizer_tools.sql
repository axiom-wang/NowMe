-- 组织者工具（contracts 19）：必答题与回答、一键提醒、墙的群像，以及成员关闭提醒邮件的开关。

-- 必答题：每面墙 0–3 道，组织者建墙时或在后台设置。选项是 JSON 字符串数组（2–12 个，去重）。
-- 改题目文字或单选 / 多选时，这道题已有的回答一并删除（由应用在同一事务里做）；只改选项时保留回答，
-- 读取时只认仍然存在的选项（services/wall-questions.ts 的 effectiveChoices）。
CREATE TABLE wall_questions (
  id            TEXT PRIMARY KEY CHECK (id GLOB 'wqn_*'),
  wall_id       TEXT NOT NULL REFERENCES walls (id),
  position      INTEGER NOT NULL CHECK (position BETWEEN 0 AND 2),
  prompt        TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('single', 'multi')),
  options_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX wall_questions_wall ON wall_questions (wall_id, position);

-- 成员的回答：每人每题一行，choices_json 是选中的选项文字（JSON 字符串数组）。
-- 回答在墙内可见：组织者后台看得到每个人的回答；页面上墙后，墙上的成员也看得到并能按回答筛选。
CREATE TABLE wall_answers (
  question_id   TEXT NOT NULL REFERENCES wall_questions (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users (id),
  wall_id       TEXT NOT NULL REFERENCES walls (id),
  choices_json  TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (question_id, user_id)
);
CREATE INDEX wall_answers_wall_user ON wall_answers (wall_id, user_id);
CREATE INDEX wall_answers_user ON wall_answers (user_id);

-- 一键提醒：每发一封提醒邮件一行（先记 pending 占住限额，投递后改为 sent / failed）。
-- 只用于按人限流与后台显示“提醒过几次”；不存邮件内容与邮箱。
CREATE TABLE wall_reminders (
  id            TEXT PRIMARY KEY CHECK (id GLOB 'rmd_*'),
  wall_id       TEXT NOT NULL REFERENCES walls (id),
  organizer_id  TEXT NOT NULL REFERENCES users (id),
  user_id       TEXT NOT NULL REFERENCES users (id),
  reason        TEXT NOT NULL CHECK (reason IN ('publish', 'answer', 'both')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  created_at    TEXT NOT NULL
);
CREATE INDEX wall_reminders_wall_user ON wall_reminders (wall_id, user_id, created_at);
CREATE INDEX wall_reminders_user ON wall_reminders (user_id);

-- 墙的群像：每面墙最多一份（重新生成时替换）。result_json 是 AI 归纳的主题与一句话 + 生成时按回答统计的人数；
-- sources_json 是生成时用到的发布 ID：其中任何一个因撤下、移出、注销等原因结束（被新版本替换除外）后不再展示。
CREATE TABLE wall_portraits (
  wall_id       TEXT PRIMARY KEY REFERENCES walls (id),
  result_json   TEXT NOT NULL,
  sources_json  TEXT NOT NULL,
  page_count    INTEGER NOT NULL CHECK (page_count >= 0),
  created_by    TEXT NOT NULL REFERENCES users (id),
  created_at    TEXT NOT NULL
);

-- 成员可以在“我的资料”里关闭组织者的提醒邮件（默认接收）。
ALTER TABLE users ADD COLUMN reminder_emails INTEGER NOT NULL DEFAULT 1 CHECK (reminder_emails IN (0, 1));
