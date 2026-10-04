-- M2.85 世界演化：**神位的归属**（用户拍板「神明并非是不可战胜的，玩家击败序列 0 就能晋升」）
--
-- 一个神位只能被一个人占着 —— 所以 deity_id 是主键（不是 id）。
-- 玩家夺位成功 → 这里多一行；原主被取代（历史留在 world_events 与 npc_deeds 里）。
CREATE TABLE IF NOT EXISTS godhood_claims (
  -- 被夺的那个神位（pantheon.yaml 的 id）
  deity_id     TEXT PRIMARY KEY,
  -- 现在坐在这个位置上的人
  character_id TEXT NOT NULL,
  at           INTEGER NOT NULL
);
