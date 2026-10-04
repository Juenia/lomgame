-- M2.170：**神位争夺**（用户口径：「神位得竞争本来就是残酷的」）。
--
-- M2.169 让阴谋能把一位神从座位上推下去；这一张表管**那个空位之后的事**。
--
-- 原作的两条硬设定决定了它必须残酷：
--   · 序列 0 是**唯一**的 —— 一条途径只有一个位置，没有并列、没有共享
--   · 序列越高越受「最初」的意志影响 —— 站到那个位置上本身就是在被侵蚀
--
-- 所以「登位」不是一瞬间的事，而是一段**公开的、脆弱的**过程（默认 7 天）：
--   · 他必须待在灰雾之上（原作里神所在的层），**所有人都知道他在这儿**
--   · 期间每过一天，神性都在啃他（理智掉了就可能失控）
--   · 而其他够格的人可以直接上来**打断**他 —— 那不是抢分，那是**杀人**
--
-- ⚠️ `pathway` 是主键：一条途径同时只能有一场争夺。
CREATE TABLE IF NOT EXISTS throne_contests (
  pathway     TEXT PRIMARY KEY,
  -- rite（有人正在登位）/ settled（已定）/ lapsed（仪式断了，位置还空着）
  status      TEXT NOT NULL,
  claimant_id TEXT NOT NULL DEFAULT '',
  started_at  INTEGER NOT NULL,
  ends_at     INTEGER NOT NULL,
  -- 谁打断过（写下来 —— 这件事会被记住）
  broken_by   TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT ''
);
