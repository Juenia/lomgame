-- M2.85 RPG 化 A：**历练**（用户拍板「不需要天赋树，因为技能都是序列自带的」）
--
-- 这条修正决定了本迁移的形状：**经验不换技能**，所以没有技能点、没有天赋表。
-- 经验只影响「历练档」，历练档影响属性上限与抗性 —— 而技能仍然由**序列**自带。
--
-- 用 ALTER TABLE ADD COLUMN：既有列一个都不动（用户选的尺度是「加一层」）。
ALTER TABLE characters ADD COLUMN exp INTEGER NOT NULL DEFAULT 0;
