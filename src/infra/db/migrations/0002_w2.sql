-- 0002_w2.sql —— W2 结构：扮演标签用量、角色 flag、事件触发记录
PRAGMA foreign_keys = ON;

-- 扮演标签每日用量：防复读刷分（同一标签计分上限 + 递减惩罚）
CREATE TABLE IF NOT EXISTS daily_tag_usage (
  character_id TEXT NOT NULL,
  date         TEXT NOT NULL,
  tag          TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (character_id, date, tag),
  FOREIGN KEY (character_id) REFERENCES characters(id)
);

CREATE INDEX IF NOT EXISTS idx_tag_usage_char_date ON daily_tag_usage(character_id, date);

-- 角色 flag：事件卡可以写入，事件条件可以读取
CREATE TABLE IF NOT EXISTS flags (
  character_id TEXT NOT NULL,
  flag         TEXT NOT NULL,
  value        TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (character_id, flag),
  FOREIGN KEY (character_id) REFERENCES characters(id)
);

-- 事件触发记录：每日去重 + cooldown_days 冷却
CREATE TABLE IF NOT EXISTS event_triggers (
  character_id TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  date         TEXT NOT NULL,
  PRIMARY KEY (character_id, event_id, date),
  FOREIGN KEY (character_id) REFERENCES characters(id)
);

CREATE INDEX IF NOT EXISTS idx_event_triggers_char_date ON event_triggers(character_id, date);
