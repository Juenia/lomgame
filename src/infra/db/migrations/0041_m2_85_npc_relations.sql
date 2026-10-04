-- M2.85 RPG 化：**NPC 与玩家的关系** 与 **NPC 的阴谋**
--
-- 用户拍板：
--   「玩家行为可能交恶或者交好 NPC；交恶则可能被厌恶，更黑暗向的 NPC 会对玩家不利；
--     交好的 NPC 可能在某个时刻帮助玩家，可能赠送符合他自己身份的物品」
--   「强大的对立高序列者甚至可以算计玩家或者 NPC，可以布局做出一些阴谋」
--
-- 两张表的分工：
--   npc_relations  **态度**（-100 死敌 到 +100 挚友）—— 它决定对方把玩家当什么人
--   npc_schemes    **意图**（多阶段的算计）—— 只有态度坏到一定程度、且性情黑暗的人才会布局

CREATE TABLE IF NOT EXISTS npc_relations (
  npc_id       TEXT NOT NULL,
  character_id TEXT NOT NULL,
  -- -100 死敌 / 0 路人 / +100 挚友
  affinity     INTEGER NOT NULL DEFAULT 0,
  at           INTEGER NOT NULL,
  PRIMARY KEY (npc_id, character_id)
);

CREATE TABLE IF NOT EXISTS npc_schemes (
  id            TEXT PRIMARY KEY,
  npc_id        TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  kind          TEXT NOT NULL,
  -- lurk 布局 → omen 端倪（玩家可察觉）→ strike 发动
  stage         TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  due_at        INTEGER NOT NULL,
  -- 玩家什么时候察觉到的（null = 还没察觉）
  revealed_at   INTEGER,
  -- 被破解了吗
  foiled_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_npc_schemes_target ON npc_schemes (target_id, stage);
