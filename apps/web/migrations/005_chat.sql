CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  wall_id TEXT NOT NULL REFERENCES walls(id),
  kind TEXT NOT NULL CHECK (kind IN ('group', 'direct')),
  user_a TEXT REFERENCES users(id),
  user_b TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  CHECK ((kind = 'group' AND user_a IS NULL AND user_b IS NULL)
    OR (kind = 'direct' AND user_a IS NOT NULL AND user_b IS NOT NULL AND user_a < user_b))
);
CREATE UNIQUE INDEX conversations_wall_group ON conversations(wall_id) WHERE kind = 'group';
CREATE UNIQUE INDEX conversations_wall_pair ON conversations(wall_id, user_a, user_b) WHERE kind = 'direct';

-- 旧墙自动拥有一个群；沿用墙 ID 的随机后缀，便于新墙使用相同的幂等创建规则。
INSERT INTO conversations(id, wall_id, kind, created_at)
  SELECT 'cnv_' || substr(id, 5), id, 'group', created_at FROM walls;

CREATE TABLE chat_messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  sender_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, sender_id, client_id)
);
CREATE INDEX chat_messages_history ON chat_messages(conversation_id, sequence);
CREATE TABLE chat_reads (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  PRIMARY KEY (conversation_id, user_id)
);
