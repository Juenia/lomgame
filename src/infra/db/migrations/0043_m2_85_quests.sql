-- M2.85 RPG 化 D：**角色接下的委托**
--
-- 一份委托只可能由一位委托人给你（同一份模板，不同的人给），所以主键带上 npc_id。
CREATE TABLE IF NOT EXISTS character_quests (
  character_id TEXT NOT NULL,
  quest_id     TEXT NOT NULL,
  npc_id       TEXT NOT NULL,
  status       TEXT NOT NULL,
  taken_at     INTEGER NOT NULL,
  done_at      INTEGER,
  PRIMARY KEY (character_id, quest_id, npc_id)
);
