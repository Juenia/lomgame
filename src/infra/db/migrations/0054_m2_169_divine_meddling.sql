-- M2.169：**玩家插手的账** —— 谁在一场神明阴谋里做过什么。
--
-- 用户口径：「要刺激感」。刺激感来自三件事，这张表是第三件的载体：
--   ① 看得见    阴谋有阶段、有倒计时（.神战 看得到）
--   ② 有代价    插手可能被发现 —— 被发现就是**报复**（邪神降罚 / 教会通缉）
--   ③ **不可逆** 做过的事记在案上：那位神赢了会赏你，输了会清算你
--
-- ⚠️ 它还是**成神仪式**的判据来源：刺客途径序列 1 → 0 的仪式之一就是
--    「在自身参与之事导致一位神灵陨落时晋升」——那句话要读的就是这张表。
CREATE TABLE IF NOT EXISTS divine_meddling (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL,
  scheme_id   TEXT NOT NULL,
  -- inform（向目标告密）/ aid（替发起者办事）
  side        TEXT NOT NULL,
  -- 做成了没有、有没有被发现是你
  success     INTEGER NOT NULL DEFAULT 0,
  exposed     INTEGER NOT NULL DEFAULT 0,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_divine_meddling_char ON divine_meddling (character_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_divine_meddling_scheme ON divine_meddling (scheme_id);
