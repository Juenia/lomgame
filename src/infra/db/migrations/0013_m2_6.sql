-- 0013_m2_6.sql —— M2.6 通缉系统 + 势力范围
-- 只新增三张表（factions / wanted_states / bounty_claims），**不新增任何角色相关表**（任务书 §三）。
--
-- 为什么 factions 要落库而不是只留在 numeric.ts：
--   势力范围是**内容**，会随剧情扩城而变（贝克兰德→廷根→海上）；落库之后
--   「谁控制哪个地点」可以被查询、被播报引用、被后续的运营工具改，
--   而不必每次都改代码再重启。本版的行由 numeric.ts 播种（seedFactions），
--   所以「数值唯一入口」这条硬约束仍然成立 —— 表是投影，不是第二份真相。
--
-- wanted_states 一行 = 一个角色被**一个势力**通缉的一次记录。
--   同一个角色可以同时被多个势力通缉（例如又在警察厅打了人、又在教会的地头闹事），
--   判定时取"当前地点归属的势力所发的那一条"；4 级（全境通缉）不看这条限制。
--   expires_at 到期即自动失效 —— 查询一律带 `expires_at > now`，不做后台清扫。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS factions (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,
  territory_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wanted_states (
  id            TEXT PRIMARY KEY,
  character_id  TEXT NOT NULL,
  faction_id    TEXT NOT NULL,
  level         INTEGER NOT NULL DEFAULT 1,
  reason        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wanted_char ON wanted_states(character_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_wanted_faction ON wanted_states(faction_id, level);

-- 举报领赏的流水。它同时是「同一条通缉只能被领一次」的幂等键来源：
--   id = seedFrom(['bounty', wanted_id])，重复举报同一条通缉会撞主键。
CREATE TABLE IF NOT EXISTS bounty_claims (
  id            TEXT PRIMARY KEY,
  wanted_id     TEXT NOT NULL,
  claimer_id    TEXT NOT NULL,
  reward_penny  INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bounty_claimer ON bounty_claims(claimer_id, created_at);
