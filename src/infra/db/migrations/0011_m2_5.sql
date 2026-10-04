-- 0011_m2_5.sql —— M2.5 晋升仪式 + 干扰
-- 只新增两张仪式侧的表，**不新增任何角色相关表**（任务书 §6）。
--
-- rituals 一行 = 一次仪式：
--   preparing   玩家在 .仪式 准备/布置 里攒的配置（每角色至多一行活的）
--   running     已 .仪式 开始：阶段 1/2 过了，等 .仪式 融合 做阶段 3
--              —— 这一段「等着融合」的窗口正是别人能来干扰的时候（M2.5 §4）
--   success / failed / interrupted  终态，resolved_at + result 记结局
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rituals (
  id            TEXT PRIMARY KEY,
  character_id  TEXT NOT NULL,
  config_json   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'preparing',
  stage         INTEGER NOT NULL DEFAULT 0,
  started_at    INTEGER,
  resolved_at   INTEGER,
  result        TEXT
);

CREATE INDEX IF NOT EXISTS idx_rituals_character ON rituals(character_id, status);

-- 每次干扰一行。id 与 created_at 都要落库：前者是幂等键，后者是「每日 1 次」的依据
CREATE TABLE IF NOT EXISTS ritual_interferences (
  id            TEXT PRIMARY KEY,
  ritual_id     TEXT NOT NULL,
  interferer_id TEXT NOT NULL,
  success       INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ritual_interferences_interferer ON ritual_interferences(interferer_id, created_at);
