-- 0007_w6.sql —— W6 封测周：玩家反馈与行为埋点
-- 注意：任务书写的编号是 0006，但 0006 在 W5 已用于队伍任务（0006_party_w5.sql），因此顺延为 0007。
PRAGMA foreign_keys = ON;

-- 玩家反馈（.反馈 指令写入）
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  character_id TEXT,
  content     TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT '未分类',   -- 分类由运营在复盘时填
  status      TEXT NOT NULL DEFAULT 'open',     -- open | triaged | fixed | wontfix
  created_at  INTEGER NOT NULL,
  handled_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);

-- 每用户每日活跃与指令分布（留存与行为分析的基础数据）
CREATE TABLE IF NOT EXISTS user_daily (
  user_id        TEXT NOT NULL,
  date           TEXT NOT NULL,
  commands       INTEGER NOT NULL DEFAULT 0,
  counters_json  TEXT NOT NULL DEFAULT '{}',
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_user_daily_date ON user_daily(date);

-- 封测日报快照（每天采集一次，落库以便复盘对比）
CREATE TABLE IF NOT EXISTS beta_daily (
  date             TEXT PRIMARY KEY,
  dau              INTEGER NOT NULL DEFAULT 0,
  new_users        INTEGER NOT NULL DEFAULT 0,
  commands         INTEGER NOT NULL DEFAULT 0,
  retention_d1     REAL,
  retention_d7     REAL,
  feedback_count   INTEGER NOT NULL DEFAULT 0,
  deadlock_rate    REAL,
  payload_json     TEXT NOT NULL DEFAULT '{}',
  created_at       INTEGER NOT NULL
);
