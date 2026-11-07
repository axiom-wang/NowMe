-- 用户自带模型配置。Key 采用 AES-256-GCM 加密，主密钥不入库。
CREATE TABLE user_model_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('interview', 'generate')),
  endpoint_json TEXT NOT NULL,
  encrypted_key TEXT,
  version TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, role)
);
-- generation_jobs.charged 保留历史数据兼容；新任务恒为 0，不再用于额度判断。
