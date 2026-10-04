-- 0006_party_w5.sql —— W5 次级项：队伍任务的执行记录
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS party_tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  party_id     TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  leader_id    TEXT NOT NULL,
  date         TEXT NOT NULL,
  members      INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (party_id) REFERENCES parties(id)
);

CREATE INDEX IF NOT EXISTS idx_party_tasks_party_date ON party_tasks(party_id, date);
