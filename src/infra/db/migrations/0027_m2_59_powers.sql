-- =====================================================================
-- M2.59：文明势力的**运行时状态**与**势力之间的关系**。
--
-- 与 powers.yaml 的分工（与 M2.58 的 zones.yaml vs zone_state 完全一致）：
--   powers.yaml        —— 内容。势力是什么（目标 / 资源 / 默认态度 / 默认关系），静态。
--   power_state（本表）—— 世界状态。它**因为发生了什么而改变**：警觉会涨会落。
--   power_relations    —— 势力之间的关系，可以被运行时改写（谁跟谁翻脸了、谁欠谁）。
--
-- ⚠️ 为什么不改 0013_m2_6.sql 的 factions 表：
--   那张表是**领地**（谁管哪块地），是通缉系统的地基，wanted_states.faction_id 外键指向它。
--   给领地加状态列会让「领地」与「势力状态」两件事混在一张表里，
--   而它们的变化频率差着两个数量级（领地几乎不变，警觉每小时都在动）。
--   所以状态另外两张表，用 power_id 关联 —— 沿用 M2.58 分表的同一条理由。
--
-- ⚠️ 领地仍然是 factions 表的事：powers.yaml 里那 11 家的 id 与 factions 表**部分重叠**
--   （police / church / gang 三家的 id 完全一致），所以「警察厅管哪些地点」
--   仍然只有一处定义（numeric.factionTerritory）。这一层不复制那份名单。
-- =====================================================================

CREATE TABLE IF NOT EXISTS power_state (
  power_id          TEXT PRIMARY KEY,
  -- 警觉度 0—1：出了事就涨，没事就落。它是「这次会不会反应」的主输入
  alert             REAL NOT NULL DEFAULT 0,
  -- 影响力 0—1：它能压住多少地方（本版只落数据，判定暂不读）
  influence         REAL NOT NULL DEFAULT 0.5,
  -- 累计反应次数（只增不减；报告读它）
  reaction_count    INTEGER NOT NULL DEFAULT 0,
  last_reaction_at  INTEGER,
  updated_at        INTEGER NOT NULL
);

-- 势力之间的关系。默认关系写在 powers.yaml 的 relations 段里（内容），
-- 这张表记**运行时被改写过的那些**（谁跟谁翻脸了、谁欠谁一份人情）。
-- kind: ally / hostile / debt —— 与 powers.yaml 同一个枚举。
CREATE TABLE IF NOT EXISTS power_relations (
  from_power_id  TEXT NOT NULL,
  to_power_id    TEXT NOT NULL,
  kind           TEXT NOT NULL,
  -- 这条关系有多强 0—1（默认关系写 0.5；运行时翻脸会更高）
  weight         REAL NOT NULL DEFAULT 0.5,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (from_power_id, to_power_id, kind),
  CHECK (kind IN ('ally', 'hostile', 'debt'))
);

-- 反应次数是报告的热路径（「这一轮哪几家势力真的动过」）
CREATE INDEX IF NOT EXISTS idx_power_state_reactions ON power_state(reaction_count);
