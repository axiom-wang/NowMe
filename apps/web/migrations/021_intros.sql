-- AI 介绍值得认识的人（contracts 20）：AI 读「查看者自己在这面墙的资料 + 墙上对他可见的已发布页面」，
-- 介绍几位适合他认识的人，并说明为什么（依据是两边资料里的原文，服务端核对）。
-- 结果只属于查看者：所有读取都带 viewer_id；被介绍的人、组织者、其他成员都看不到，也不产生任何通知。
-- 每位查看者在每面墙只留最新一份（“换一批”替换）；只保存成功的结果，每次调用（含失败）另记 intro_generate 事件。
CREATE TABLE intros (
  id            TEXT PRIMARY KEY CHECK (id GLOB 'itr_*'),
  wall_id       TEXT NOT NULL REFERENCES walls (id),
  viewer_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- 这次用了查看者的哪些资料：{ page: boolean, brief: boolean }
  sources_json  TEXT NOT NULL,
  -- 当时交给模型的候选页面 ID（JSON 字符串数组），用来提示“墙上新来了几位”
  seen_json     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (viewer_id, wall_id)
);
CREATE INDEX intros_wall ON intros (wall_id);

-- 每一位被介绍的人一行：绑定对方当时的发布（publication_id），对方更新、撤下或任一方失去访问后不再展示。
-- 单独成行是为了在某一页被删除时按 page_id 删掉引用了那一页文字的介绍。
CREATE TABLE intro_picks (
  intro_id        TEXT NOT NULL REFERENCES intros (id) ON DELETE CASCADE,
  position        INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9),
  page_id         TEXT NOT NULL REFERENCES pages (id),
  publication_id  TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('learn', 'interest', 'collab')),
  title           TEXT NOT NULL,
  reason          TEXT NOT NULL,
  mine            TEXT NOT NULL,
  theirs          TEXT NOT NULL,
  PRIMARY KEY (intro_id, position)
);
CREATE INDEX intro_picks_page ON intro_picks (page_id);
