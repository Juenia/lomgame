-- 0008_m2_2.sql —— M2.2 世界时钟 + 地区天气
-- 只新增世界侧的表，不动任何角色相关表（任务书第四节第 7 条）。
PRAGMA foreign_keys = ON;

-- 世界状态：单行（id 恒为 1），存时钟水位线与世界种子
-- 水位线是「补跑」的依据：last_light_at 之后的每个整点、last_heavy_at 之后的每一天都要补
CREATE TABLE IF NOT EXISTS world_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  seed          TEXT    NOT NULL DEFAULT 'world',
  day_index     INTEGER NOT NULL DEFAULT 0,      -- 东八区天序号（1970-01-01 起算）
  moon_phase    INTEGER NOT NULL DEFAULT 1,      -- 1—30，15 = 月圆
  foggy         INTEGER NOT NULL DEFAULT 0,      -- 今天是不是雾日
  last_light_at INTEGER,                         -- 最近一次轻 tick 的时刻（每小时一次）
  last_heavy_at INTEGER,                         -- 最近一次重 tick 的时刻（每天 0 点一次）
  groups_json   TEXT    NOT NULL DEFAULT '[]',   -- 见过面的群（显著天气要全群播报）
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 世界 tick 幂等表：同一 (tick_type, tick_key) 只结算一次，重复执行不重复结算
--   light → tick_key 是小时键（2026-01-01T13），heavy → tick_key 是日期（2026-01-01）
CREATE TABLE IF NOT EXISTS world_ticks (
  tick_type    TEXT    NOT NULL,
  tick_key     TEXT    NOT NULL,
  tick_at      INTEGER NOT NULL,                 -- 这个 tick 本该发生的时刻（补跑按它推算上下文）
  executed_at  INTEGER NOT NULL,
  summary_json TEXT    NOT NULL DEFAULT '{}',
  PRIMARY KEY (tick_type, tick_key)
);

CREATE INDEX IF NOT EXISTS idx_world_ticks_at ON world_ticks(tick_at);

-- 地区天气：每个地点一行，天气彼此独立
CREATE TABLE IF NOT EXISTS location_weather (
  location_id     TEXT PRIMARY KEY,
  weather         TEXT    NOT NULL DEFAULT 'clear',
  since           INTEGER NOT NULL,
  until           INTEGER NOT NULL,
  pending_weather TEXT,                          -- 邻居扩散过来的天气
  pending_at      INTEGER,                       -- 落地时刻（= 源地点换天气时刻 + 2 小时）
  updated_at      INTEGER NOT NULL
);

-- 天气扩散图：地点之间的相邻关系（locations.yaml 的 adjacent）
ALTER TABLE locations ADD COLUMN adjacent_json TEXT NOT NULL DEFAULT '[]';
