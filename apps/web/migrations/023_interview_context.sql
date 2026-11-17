ALTER TABLE profile_entries ADD COLUMN scope TEXT NOT NULL DEFAULT 'all';
ALTER TABLE profile_entries ADD COLUMN source_wall_id TEXT REFERENCES walls(id) ON DELETE SET NULL;
ALTER TABLE profile_entries ADD COLUMN question_key TEXT;
ALTER TABLE generation_jobs ADD COLUMN remember_facts INTEGER NOT NULL DEFAULT 0 CHECK (remember_facts IN (0, 1));
