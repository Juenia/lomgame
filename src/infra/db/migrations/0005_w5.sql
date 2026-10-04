-- 0005_w5.sql —— W5 结构：失控事件记录、审计归档、模拟报告
PRAGMA foreign_keys = ON;

-- 失控事件记录：每次进入失控写一条，用于统计与「余波」判断
CREATE TABLE IF NOT EXISTS lost_control_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL,
  date         TEXT NOT NULL,
  pathway      TEXT NOT NULL,
  text         TEXT NOT NULL,
  hp_loss      INTEGER NOT NULL DEFAULT 0,
  mad_gain     INTEGER NOT NULL DEFAULT 0,
  source       TEXT NOT NULL DEFAULT 'tick',   -- tick | potion | card
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (character_id) REFERENCES characters(id)
);

CREATE INDEX IF NOT EXISTS idx_lost_control_char_date ON lost_control_events(character_id, date);

-- 审计日志归档：audit_logs 定期搬到归档表，主表只留热数据
CREATE TABLE IF NOT EXISTS audit_logs_archive (
  id          INTEGER PRIMARY KEY,
  user_id     TEXT NOT NULL,
  command     TEXT NOT NULL,
  input       TEXT,
  output      TEXT,
  created_at  INTEGER NOT NULL,
  archived_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_archive_created ON audit_logs_archive(created_at);

-- 模拟报告留档：模拟器跑出来的结论要能追溯
CREATE TABLE IF NOT EXISTS sim_reports (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  config_json   TEXT NOT NULL,
  summary_json  TEXT NOT NULL,
  note          TEXT
);
