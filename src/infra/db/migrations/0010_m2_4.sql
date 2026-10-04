-- 0010_m2_4.sql —— M2.4 公共事件流
-- 只新增世界侧的一张表，**不新增任何角色相关表**（任务书 §6）。
-- 事件是「世界说过的话」：同 seed 同输出，id 由原因拼出来（env:地点:天气:起始时刻…），
-- 所以补跑重放同一个小时时 INSERT OR IGNORE 天然幂等，不会重复播报。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS world_events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  text         TEXT NOT NULL,
  visibility   TEXT NOT NULL DEFAULT 'public',
  faction_id   TEXT,
  options_json TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_world_events_created ON world_events(created_at);
CREATE INDEX IF NOT EXISTS idx_world_events_type ON world_events(type, created_at);
