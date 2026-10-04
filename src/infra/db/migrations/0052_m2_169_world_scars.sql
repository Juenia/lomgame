-- M2.169：**世界伤痕** —— 神明级事件在地上留下的东西。
--
-- 为什么需要它：阴谋改了 `divine_throne_state`（谁坐在那儿），但那还是「神界的事」。
-- 玩家要感觉到它，就必须有**地上的痕迹**。原作里这些痕迹是明写着的：
--
--   · 「陨落真神造成的污染物100克」「陨落于背叛的真神尸液3滴」（序列 1 配方的材料）
--   · 神战遗迹里遗留「真实造物主呓语，以及黑夜、太阳、大地、空想、死神的神力」
--
-- 所以表里每条伤痕回答四件事：**哪里**（location_id）、**谁留下的**（pathway）、
-- **那地方现在什么样**（danger_bonus / corruption）、**能捡到什么**（loot_item）。
--
-- ⚠️ 它不改内容表（locations.yaml 是内容，每次 reload 会被覆盖）——
--    伤痕是**运行时的**，读取时与内容叠加（与 npc_progress / divine_throne_state 同一条口径）。
CREATE TABLE IF NOT EXISTS world_scars (
  id           TEXT PRIMARY KEY,
  -- divine_fall（某位神陨落）/ god_war（神战打过的痕迹）
  kind         TEXT NOT NULL,
  pathway      TEXT NOT NULL,
  location_id  TEXT NOT NULL,
  since        INTEGER NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  -- 这地方现在有多危险（叠加到内容的 danger 上）
  danger_bonus INTEGER NOT NULL DEFAULT 0,
  -- 这里是不是变成了堕落源（1 = 是；与地点的 corruption_source 同一条判定）
  corruption   INTEGER NOT NULL DEFAULT 0,
  -- 能捡到什么（空 = 这里不掉东西）
  loot_item    TEXT NOT NULL DEFAULT '',
  loot_chance  REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_world_scars_loc ON world_scars (location_id);
