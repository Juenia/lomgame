-- M2.85 世界演化：NPC 进度（让 NPC 参与世界演化 —— 晋升 / 登神）
--
-- 为什么要单独一张表：figures.yaml 与 npc-tracks.yaml 是**原作记载**（静态，不能改）；
-- 而「他现在走到哪一档」是**世界状态**（会随时间变）。两者必须分开 ——
-- 否则世界一演化就把原著数据写花了。
--
-- 这张表只存**与世界记载不同的部分**：
--   sequence     当前序列（初始值来自 npc-tracks.yaml 的 currentSequence）
--   since        当前这一档是什么时候到的（毫秒）—— 晋升判定用「停留了多久」
--   ascensions   已经晋升过几次（用于展示与统计）
--   godhood_at   登神时刻（毫秒）；null = 还没登神
CREATE TABLE IF NOT EXISTS npc_progress (
  npc_id     TEXT PRIMARY KEY,
  sequence   INTEGER NOT NULL,
  since      INTEGER NOT NULL,
  ascensions INTEGER NOT NULL DEFAULT 0,
  godhood_at INTEGER
);

-- 谁在什么时候做了什么（世界演化的大事记：晋升 / 登神 / 猎杀 / 化解灾厄）
CREATE TABLE IF NOT EXISTS npc_deeds (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  npc_id  TEXT NOT NULL,
  kind    TEXT NOT NULL,
  detail  TEXT NOT NULL DEFAULT '',
  -- 功绩分（用户拍板：「不要随便来个路人甲就窜一下子解决了大灾厄，然后还成神了」）。
  -- 化解大灾厄给得多、猎杀强者给得多、失败给 0 甚至负分；成神要求分数过线，见 npc-advance.ts。
  merit   INTEGER NOT NULL DEFAULT 0,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_npc_deeds_at ON npc_deeds (at DESC);
