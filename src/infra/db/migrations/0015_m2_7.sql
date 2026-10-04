-- =====================================================================
-- M2.7：世界地理（区域 / 城市 / 航线）+ 跨区域移动（travels）
--
-- 三张地理表和 locations 一样是**内容的投影**：启动时由 src/data/*.yaml 播种，
-- 表本身不是真相（改数据要改 YAML，改完重启即生效 —— 见 README 的内容管线一节）。
--
-- travels 是**运行时状态**，不属于内容：它记录「某人在某条路线上、几点到」。
-- 为什么单独一张表而不是复用 flags：一次移动有 5 个字段（路线、出发、到达、状态、事件），
-- 塞进 flag 的 value 文本列就得自己解析 JSON，还要额外处理「进行中的行程只有一条」这条约束。
-- =====================================================================

CREATE TABLE IF NOT EXISTS regions (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,
  pathways_json TEXT NOT NULL DEFAULT '[]',
  cities_json   TEXT NOT NULL DEFAULT '[]',
  danger        REAL NOT NULL DEFAULT 0.5
);

CREATE TABLE IF NOT EXISTS cities (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  region_id      TEXT NOT NULL,
  locations_json TEXT NOT NULL DEFAULT '[]',
  factions_json  TEXT NOT NULL DEFAULT '[]',
  is_port        INTEGER NOT NULL DEFAULT 0,
  min_seq        INTEGER NOT NULL DEFAULT 9,
  pathways_json  TEXT NOT NULL DEFAULT '[]',
  planned_json   TEXT NOT NULL DEFAULT '[]',
  birth_weight   REAL NOT NULL DEFAULT 0,
  center_id      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS routes (
  id             TEXT PRIMARY KEY,
  from_city      TEXT NOT NULL,
  to_city        TEXT NOT NULL,
  type           TEXT NOT NULL,
  duration_hours INTEGER NOT NULL,
  cost_penny     INTEGER NOT NULL,
  danger         REAL NOT NULL,
  events_json    TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS travels (
  id            TEXT PRIMARY KEY,
  character_id  TEXT NOT NULL,
  route_id      TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  arrives_at    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'traveling',
  events_json   TEXT
);

CREATE INDEX IF NOT EXISTS idx_travels_char ON travels(character_id, status);
CREATE INDEX IF NOT EXISTS idx_routes_from ON routes(from_city);

-- 玩家此刻在哪座城市。
-- 为什么不复用 flags.loc（那是个地点）：城市与地点是两个粒度。
-- 通缉系统问的是「你在谁的势力范围内」（地点级），
-- 地理系统问的是「你属于哪个圈子、能走哪条途径、能去哪」（城市级）。
-- 混用会让「到达一座城市」必须先选一个具体地点，而那件事本来就该由 center 决定。
ALTER TABLE characters ADD COLUMN current_city_id TEXT;
