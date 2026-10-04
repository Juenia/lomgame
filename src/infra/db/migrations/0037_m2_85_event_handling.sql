-- M2.85 世界演化：**NPC 处理世界事件**
--
-- 世界事件原本只有 TTL（到点自己消失），没有「被谁解决了」这个概念 ——
-- 于是「NPC 相当于一个有智慧的人机，事件也可能被 NPC 解决」这条落不了地。
--
-- 这张表记「谁在什么时候处理了哪条事件」：
--   event_id 是主键 —— **一件事只会被处理一次**（先到先得，与神位同一思路）
CREATE TABLE IF NOT EXISTS world_event_handling (
  event_id  TEXT PRIMARY KEY,
  npc_id    TEXT NOT NULL,
  note      TEXT NOT NULL DEFAULT '',
  merit     INTEGER NOT NULL DEFAULT 0,
  at        INTEGER NOT NULL
);
