-- M2.167：地点的**堕落源**标记。
--
-- 为什么必须进库表：判定读的是 `deps.locations.get(id)`，而它是**库**里的那一份
-- （locations 表是内容在库里的投影）。只把字段写进 locations.yaml 而不加这一列，
-- 读出来永远是 false —— 不报错，只是那条环境因子**永远是假的**。
--
-- 【原作】神弃之地的黑暗「会让生物堕落为怪物」；深渊入口「会腐蚀一切、让所有生灵堕落」。
ALTER TABLE locations ADD COLUMN corruption_source INTEGER NOT NULL DEFAULT 0;
