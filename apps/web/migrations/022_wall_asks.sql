-- 问墙：用一句话找人（contracts 21）。成员问一句（“谁会剪视频？”），AI 读墙上对他可见的已发布页面，
-- 找出写到这件事的人，每一位附上 TA 页面上的原话（服务端核对）。
-- 结果只属于提问的人：所有读取都带 viewer_id；被找到的人、组织者、其他成员都看不到提问与结果，也不产生任何通知。
-- 每位查看者在每面墙只留最近一次提问（再问一次就替换）；只保存成功的结果（含“没找到”），
-- 每次调用（含失败）另记 ask_generate 事件，事件里没有问题原文。
CREATE TABLE wall_asks (
  id          TEXT PRIMARY KEY CHECK (id GLOB 'ask_*'),
  wall_id     TEXT NOT NULL REFERENCES walls (id),
  viewer_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- 提问原文（查看者自己写的，只给他自己看）
  question    TEXT NOT NULL,
  -- 当时交给模型的候选人数
  candidates  INTEGER NOT NULL CHECK (candidates >= 0),
  -- 当时找到几位（0 = AI 明确回答“没找到”）；用来区分“没找到”和“找到的人后来都更新或离开了”
  found       INTEGER NOT NULL CHECK (found BETWEEN 0 AND 10),
  created_at  TEXT NOT NULL,
  UNIQUE (viewer_id, wall_id)
);
CREATE INDEX wall_asks_wall ON wall_asks (wall_id);

-- 找到的每一位一行：绑定对方当时的发布（publication_id），对方更新、撤下或任一方失去访问后不再展示。
-- 单独成行是为了在某一页被删除时按 page_id 删掉引用了那一页原话的那一条。
CREATE TABLE wall_ask_matches (
  ask_id          TEXT NOT NULL REFERENCES wall_asks (id) ON DELETE CASCADE,
  position        INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9),
  page_id         TEXT NOT NULL REFERENCES pages (id),
  publication_id  TEXT NOT NULL,
  reason          TEXT NOT NULL,
  quote           TEXT NOT NULL,
  PRIMARY KEY (ask_id, position)
);
CREATE INDEX wall_ask_matches_page ON wall_ask_matches (page_id);
