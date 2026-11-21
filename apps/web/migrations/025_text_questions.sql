-- 必答题增加填空题（contracts 19.1）：wall_questions.kind 增加 'text'（options_json 为空数组），
-- 回答仍存在 wall_answers.choices_json（填空题是只有一项的数组：成员写的那句话）。
--
-- SQLite 不能修改 CHECK 约束，所以重建 wall_questions。wall_answers 外键引用它且 ON DELETE CASCADE：
-- 迁移在事务里执行、不能关闭外键，直接 DROP 旧表会级联删掉全部回答。所以先把回答挪到不带外键的临时表，
-- 删掉 wall_answers 与旧 wall_questions，新表改名后再按原结构建回 wall_answers 并拷回回答。

CREATE TABLE wall_questions_v25 (
  id            TEXT PRIMARY KEY CHECK (id GLOB 'wqn_*'),
  wall_id       TEXT NOT NULL REFERENCES walls (id),
  position      INTEGER NOT NULL CHECK (position BETWEEN 0 AND 2),
  prompt        TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('single', 'multi', 'text')),
  options_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
INSERT INTO wall_questions_v25 (id, wall_id, position, prompt, kind, options_json, created_at, updated_at)
  SELECT id, wall_id, position, prompt, kind, options_json, created_at, updated_at FROM wall_questions;

CREATE TABLE wall_answers_v25_tmp (
  question_id   TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  wall_id       TEXT NOT NULL,
  choices_json  TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
INSERT INTO wall_answers_v25_tmp (question_id, user_id, wall_id, choices_json, updated_at)
  SELECT question_id, user_id, wall_id, choices_json, updated_at FROM wall_answers;

DROP TABLE wall_answers;
DROP TABLE wall_questions;
ALTER TABLE wall_questions_v25 RENAME TO wall_questions;
CREATE INDEX wall_questions_wall ON wall_questions (wall_id, position);

CREATE TABLE wall_answers (
  question_id   TEXT NOT NULL REFERENCES wall_questions (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users (id),
  wall_id       TEXT NOT NULL REFERENCES walls (id),
  choices_json  TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (question_id, user_id)
);
INSERT INTO wall_answers (question_id, user_id, wall_id, choices_json, updated_at)
  SELECT question_id, user_id, wall_id, choices_json, updated_at FROM wall_answers_v25_tmp;
DROP TABLE wall_answers_v25_tmp;
CREATE INDEX wall_answers_wall_user ON wall_answers (wall_id, user_id);
CREATE INDEX wall_answers_user ON wall_answers (user_id);
