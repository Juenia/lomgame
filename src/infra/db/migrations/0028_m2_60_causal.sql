-- =====================================================================
-- M2.60：因果日志 —— 把「发生过什么」变成「谁导致了谁」。
--
-- ## 为什么需要它
--
-- 项目里已经有一张 domain_events（0001_init.sql），但它记的是**角色级操作流水**：
--
--   character_id / type / payload / reason / seed
--   类型长这样：ap_delta / item_gain / mad_delta / character_created
--
-- 它回答的是「这个角色的行动点为什么少了 1」，**读不出**：
--
--   谁导致了谁（目击 → 势力反应 是一条因果边，不是两条孤立记录）
--   哪个势力记得（M2.59 的势力会反应，但它们互相之间不记事）
--   一件事的后果是什么（事件链：前兆 → 发展 → 高潮 → 余波）
--
-- ## 这一层建什么
--
--   causal_nodes  —— 事件节点。所有**值得回溯**的事都进这里。
--   causal_edges  —— 因果边。from 导致 to，关系是 caused / responded / mutated。
--
-- ## 节点 id 的来源（幂等的基础）
--
-- 节点 id 一律由「事的来源」拼出，与 world_events 的做法一致：
--
--   sighting:<sightingId>                一次目击
--   worldevent:<worldEventId>            一条世界事件
--   reaction:<sourceId>:<powerId>        一次势力反应（与 M2.59 的 reaction.id 同源）
--
-- 于是**重放同一个事件得到同一个节点**，INSERT OR IGNORE 天然幂等 ——
-- 补跑与逐小时真的跑过，得到的是同一张因果图，而不是两倍那么多条边。
-- =====================================================================

CREATE TABLE IF NOT EXISTS causal_nodes (
  id          TEXT PRIMARY KEY,
  -- 节点类型：sighting / worldevent / reaction
  kind        TEXT NOT NULL,
  -- 这件事发生在哪（locations.id）；全境事件是 NULL
  location_id TEXT,
  -- 涉及的角色（目击者是玩家；世界事件是 NULL）
  character_id TEXT,
  -- 涉及的势力（势力反应节点有；其它通常没有）
  power_id    TEXT,
  -- 一句话摘要（报告与审计读它，不做渲染）
  summary     TEXT NOT NULL,
  -- 事件强度 0—1（目击按感知层次、灾厄按等级；用来给因果图排序）
  intensity   REAL NOT NULL DEFAULT 0.5,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_causal_nodes_time ON causal_nodes(created_at, id);
CREATE INDEX IF NOT EXISTS idx_causal_nodes_kind ON causal_nodes(kind, created_at);
CREATE INDEX IF NOT EXISTS idx_causal_nodes_char ON causal_nodes(character_id, created_at);

-- 因果边：from 导致 to。
--
-- relation 三值，刻意只留三种 —— 多了会变成一张「什么都能连」的图，
-- 而那种图在报告里看不出任何东西：
--   caused    A 导致了 B（目击 → 世界事件）
--   responded B 是对 A 的响应（目击 → 势力反应）
--   mutated    A 改变了 B 的属性（污染扩散 → 生物变异，本轮未接）
CREATE TABLE IF NOT EXISTS causal_edges (
  id          TEXT PRIMARY KEY,
  from_node   TEXT NOT NULL,
  to_node     TEXT NOT NULL,
  relation    TEXT NOT NULL,
  -- 这条边是关于谁的：势力 id 或角色 id（复盘「哪个势力记得」时按它筛）
  subject     TEXT,
  created_at  INTEGER NOT NULL,
  CHECK (relation IN ('caused', 'responded', 'mutated'))
);

CREATE INDEX IF NOT EXISTS idx_causal_edges_from ON causal_edges(from_node);
CREATE INDEX IF NOT EXISTS idx_causal_edges_to ON causal_edges(to_node);
CREATE INDEX IF NOT EXISTS idx_causal_edges_subject ON causal_edges(subject, created_at);
