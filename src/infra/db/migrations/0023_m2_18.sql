-- M2.18 任务 B：势力层争夺（地点粒度）。
--
-- ⚠️ **只记增量，不记最终态**（铁律 5 的落地）：
--   归属 = churchTerritoryAt 的 seed 底图 + 本表的 Σ delta
--   底图仍然无状态、可复现（补跑与逐格跑必然一致）；被玩家行为改变的只有这一张表。
--
-- 为什么记 (location_id, winner_church_id) 而不是「双写胜负」：
--   归属是「谁占上风」，不需要给输家记账 —— 「输了就是没赢」。
--   若两边都记（胜者 +1、败者 -1），输家想翻身要赢 10 次，负 delta 会让翻身越来越难。
CREATE TABLE church_territory_contest (
  id INTEGER PRIMARY KEY,
  -- 必须属于 NUMERIC.church.conflict.contestedLocations（加载时校验，见 domain/church/conflict.ts）
  location_id TEXT NOT NULL,
  winner_church_id TEXT NOT NULL,
  -- 一次 PVP 胜利 +1；每日衰减 -1（同一个字段，两个来源）
  delta INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- 归属计算按地点聚合，报告按地点 + 教会聚合
CREATE INDEX idx_church_contest_location ON church_territory_contest(location_id);
