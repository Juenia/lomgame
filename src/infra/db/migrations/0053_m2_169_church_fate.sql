-- M2.169：**教会的命运** —— 它背后的神倒下之后，它自己会怎么样。
--
-- 原作直出：
--   · 「战神陨落后**黑夜女神教会彻底控制战神教会**」（七正神.yaml:112/420）
--   · 「神战后撤出鲁恩王国的序列4以上非凡者与2级以上封印物」（:153）—— 失去庇护是有代价的
--   · 「神战后黑夜女神将红月相关权柄交给大地母神」（:63）
--
-- 为什么需要它：阴谋改了神座，但如果**教会照常运转**，那件事对玩家就还是遥远的。
-- 教会的命运是「神的死」与「信徒的日子」之间那一层 —— 也是最容易被玩家撞见的一层
-- （他所属的教会可能一夜之间换了主人）。
--
-- ⚠️ 不改内容：教会的 ranks / seats / dogma 是 churches.yaml 的（内容），
--    这里只记**运行时的那部分**：它现在归谁、还剩多少气力。
CREATE TABLE IF NOT EXISTS church_states (
  church_id     TEXT PRIMARY KEY,
  -- intact（如常）/ crippled（失了庇护）/ absorbed（被吞并）
  fate          TEXT NOT NULL,
  -- 谁在控制它（空 = 它自己那一位还在）
  controlled_by TEXT NOT NULL DEFAULT '',
  since         INTEGER NOT NULL,
  -- 哪一场阴谋改的
  by            TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT ''
);
