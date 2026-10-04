-- M2.169：**神座的运行时状态** —— 谁现在坐在那儿。
--
-- 为什么必须有这张表：`divine-thrones.yaml` 是**内容**（图鉴式的档案：黑铁纪元谁在位），
-- 而神战、暗算、陨落、夺位都是**会改变它的事**（原作：黑夜女神与大地母神联手暗算战神，
-- 战神陨落，黑夜教会彻底控制战神教会）。没有这张表，「某位神陨落」无处可写 ——
-- 于是所有神明阴谋的后果只能停在一条播报里。那正是「小打小闹」的根源。
--
-- 读取口径与 npc_progress 完全一致：**内容为底、状态覆盖**。
-- 表里只放「与内容不同的部分」——没被阴谋碰过的位置不在这张表里。
--
-- ⚠️ `seat` 在陨落时**不清空**：它是「上一任」，而那句「已陨落，疑似留有复活后手」
--    正是靠它说出来的（原作里战神那一档）。清空了就写不出这句话。
CREATE TABLE IF NOT EXISTS divine_throne_state (
  pathway    TEXT PRIMARY KEY,
  seat       TEXT NOT NULL DEFAULT '',
  seat_kind  TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL,
  since      INTEGER NOT NULL,
  -- 哪一场阴谋 / 哪一次事件改的（审计 + 编年史）
  changed_by TEXT NOT NULL DEFAULT '',
  -- 怎么变的（玩家读得到的那一句）
  fall_note  TEXT NOT NULL DEFAULT ''
);
