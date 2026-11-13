-- “和 TA 聊什么”（contracts 11）：查看者请 AI 读「我自己的资料 + 对方已发布的页面」，得到共同点与开场建议。
-- 结果只属于查看者：只有 viewer_id 本人能读、能清除。绑定对方当时的发布（publication_id）：
-- 对方更新、撤下页面或任一方失去墙的访问后不再展示（由读取时的授权检查保证，见 services/icebreaker.ts）。
-- 只保存成功的结果；每次调用（含失败）另记一条 icebreaker_generate 事件用于限流。
CREATE TABLE icebreakers (
  id              TEXT PRIMARY KEY CHECK (id GLOB 'ice_*'),
  wall_id         TEXT NOT NULL REFERENCES walls (id),
  viewer_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  page_id         TEXT NOT NULL REFERENCES pages (id),
  publication_id  TEXT NOT NULL,
  -- { links: [{ kind, title, mine, theirs }], openers: [{ text, about }], sources: { page, brief } }
  result_json     TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX icebreakers_viewer_page ON icebreakers (viewer_id, page_id, created_at);
CREATE INDEX icebreakers_page ON icebreakers (page_id);
CREATE INDEX icebreakers_viewer_wall ON icebreakers (viewer_id, wall_id);

-- 按“谁、哪类事件、最近多久”计数（按人的运行限制）。
CREATE INDEX events_actor_type ON events (actor_id, type, created_at);
