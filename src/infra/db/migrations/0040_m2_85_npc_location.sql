-- M2.85 RPG 化：**NPC 的位置**（用户：「NPC 相当于一个有智慧的人机」——人得先站在某个地方）
--
-- 在此之前 NPC 只是图鉴里的条目（figures.yaml），没有位置，于是场景里只有怪物、没有人。
-- 有了这一列：他们会在某个街区活着（并按世界 tick 慢慢走动）。
--
-- 用 ALTER TABLE ADD COLUMN，既有列不动。
ALTER TABLE npc_progress ADD COLUMN location_id TEXT;
