-- 墙封面独立于成员页面，统一存储去除元数据的静态 WebP。
CREATE TABLE wall_covers (
  wall_id TEXT PRIMARY KEY REFERENCES walls(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  image BLOB NOT NULL,
  updated_at TEXT NOT NULL
);
