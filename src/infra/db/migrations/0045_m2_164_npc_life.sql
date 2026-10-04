-- M2.164：NPC 的**生死与堕落**（用户拍板：「NPC 死亡是真的死亡，永久，不刷新」）
--
-- 为什么单独一张表，而不是在 npc_progress 上加两列：
--
--   npc_progress 回答「他现在走到哪一档」—— 会晋升、会换地方；
--   npc_life     回答「他还在不在」—— 死了的人不再晋升、不再移动、不再布局。
--
-- 两者的读取点完全不同。合在一张表里的话，每次问「谁在这条街上」都要顺手判断死没死 ——
-- 漏掉一处就是**街上有死人**，而且不报错。
--
-- ⚠️ 「永久」是这张表存在的理由：死了就是死了，不刷新。
--    生物生态会自己补回来（那是生态），但人不补 —— 要让人回来只有一条路：
--    **神明复活**（revive），见 src/domain/world/npc-life.ts 与 world-tick.ts 的复活段。
CREATE TABLE IF NOT EXISTS npc_life (
  npc_id     TEXT PRIMARY KEY,
  -- 1 = 活着；0 = 死了（**没有记录** = 活着 —— 老存档与刚播种的人都不在这张表里）
  alive      INTEGER NOT NULL DEFAULT 1,
  died_at    INTEGER,
  -- 怎么死的（murder / scheme / calamity / creature / age）—— 文案与判据都读它
  death_kind TEXT NOT NULL DEFAULT '',
  -- 玩家看到的那一句（写在死亡那一刻：事后世界变了，那句话不该跟着变）
  death_note TEXT NOT NULL DEFAULT '',
  -- 谁干的：npcId，或 player:<角色 id>，或 ''（天灾）
  killer     TEXT NOT NULL DEFAULT '',
  revived_at INTEGER,
  revivals   INTEGER NOT NULL DEFAULT 0,
  -- 堕落度 0—100（邪神蛊惑的下场）；0 = 没被碰过
  corrupted  INTEGER NOT NULL DEFAULT 0,
  -- 谁在蛊惑他（神座的 pathway）—— 用来写「他背后是谁」
  tempter    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_npc_life_alive ON npc_life (alive, died_at DESC);
