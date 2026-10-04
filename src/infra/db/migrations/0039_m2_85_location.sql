-- M2.85 RPG 化：**玩家的具体位置**（用户拍板「我要的 RPG 感是游戏视角上的，现在像在玩 galgame」）
--
-- 症结：在这之前玩家只有「城市」（characters.current_city_id），没有「站在哪」。
-- 于是世界没法被描述成「你在这里、周围有什么、能去哪」——只剩推事件卡。
-- 这一列把玩家的位置精确到地点（locations.yaml 的 id），场景渲染才有主语。
--
-- 用 ALTER TABLE ADD COLUMN，既有列不动。
ALTER TABLE characters ADD COLUMN current_location_id TEXT;
