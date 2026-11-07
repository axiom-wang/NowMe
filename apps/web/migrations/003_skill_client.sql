-- Skill 分发（contracts 4.1、4.5）：exchange 时 CLI 自报的版本，只用于在工作区显示 “Skill 版本” 与提示更新，不参与授权。
-- 两列都可空：旧版 CLI 不报版本；源码方式运行的 CLI 不知道 Skill 版本（skill_version 为空）。
ALTER TABLE page_credentials ADD COLUMN client_cli_version TEXT CHECK (client_cli_version IS NULL OR length(client_cli_version) <= 40);
ALTER TABLE page_credentials ADD COLUMN client_skill_version TEXT CHECK (client_skill_version IS NULL OR length(client_skill_version) <= 40);
