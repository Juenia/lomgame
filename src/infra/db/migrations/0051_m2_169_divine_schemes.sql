-- M2.169：**神明的阴谋**（用户口径：「应该是世界级规模的，不要小打小闹，
-- 例如邪神是针对正神实施的阴谋，目的是为了（扳倒）正神」）。
--
-- 与 NPC 的阴谋（npc_schemes）是两件事：
--   npc_schemes   一个人算计另一个人 —— 街面上的事
--   divine_schemes 一位神算计另一位神 —— **会改变神座**
--
-- 原作里的先例（七正神.yaml）：黑夜女神与大地母神长期结盟，神战中联手暗算战神，
-- 战神陨落，黑夜教会彻底控制战神教会。那是一条**跨数年、有对手、改变格局**的链。
--
-- ⚠️ 阶段是**累积**的：结盟 → 渗透 → 削弱 → 神战 → 陨落。跳步不存在 ——
--    一位神没法在没有任何铺垫的情况下把另一位从座位上拉下来。
CREATE TABLE IF NOT EXISTS divine_schemes (
  id          TEXT PRIMARY KEY,
  -- 发起者与目标的**途径 id**（与 divine_throne_state.pathway 同一口径）
  schemer     TEXT NOT NULL,
  target      TEXT NOT NULL,
  -- 目的：usurp（取而代之）/ fall（让祂陨落）/ weaken（削弱）/ corrupt（腐化其教会）
  goal        TEXT NOT NULL,
  stage       TEXT NOT NULL,
  progress    INTEGER NOT NULL DEFAULT 0,
  -- 暴露度 0—100：做得越急越高，越高越可能被目标或其盟友察觉并反击
  exposed     INTEGER NOT NULL DEFAULT 0,
  -- 同谋（结盟阶段拉到的其他途径）
  allies_json TEXT NOT NULL DEFAULT '[]',
  started_at  INTEGER NOT NULL,
  -- 这一阶段什么时候能推进到下一阶段（世界级阴谋是慢的）
  due_at      INTEGER NOT NULL,
  -- 结局（空 = 还在进行；被打断或成了都要留痕）
  outcome     TEXT NOT NULL DEFAULT '',
  closed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_divine_schemes_open ON divine_schemes (outcome, due_at);
