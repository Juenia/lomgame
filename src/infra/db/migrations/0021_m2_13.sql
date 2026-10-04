-- =====================================================================
-- M2.13：封印物
--
-- 任务书 §5.7 的硬约束是「**不新增表**」—— 封印物本质是「有 type 与效果字段的 items」，
-- 沿用 M2.5 的 items 表。所以这一份迁移只加列。
--
-- ## 四处与任务书 §5.7 的差异（都在这里写清楚）
--
-- 1. **任务书列了 `effect_json`，但那一列早就有了**（0003_w3.sql 建的）。
--    重复 ALTER 会直接报 "duplicate column name"。
--    封印物的效果就写进那一列 —— 它的 schema（domain/item/item.ts 的 ItemEffectSchema）
--    在本轮扩展了机制字段，所以「无视序列差 / 重抽 / 伤害翻倍」这些也住在里面。
--
-- 2. **`type` 的默认值是 'material'**，所以已有的 38 件物品**一个字节都没变**
--    （它们的 type 全是 material）。这一列与既有的 `kind` 是两个维度：
--      kind —— 背包分类（material / consumable / currency / potion / trinket），M2.5 定的；
--      type —— 非凡物类型（material / wonder / sealed / charm），M2.13 定的。
--
-- 3. **`seal_level` 可空**（只有封印物有）：NULL = 不是封印物。
--    不用 0 当「没有」，因为 0 是一个合法的封印等级（理论上）。
--
-- 4. **`rarity` 默认 1**（1 = 常见，5 = 极稀有）：已有物品全是 1，
--    它们的稀有度一直由**掉落表的权重**表达（rarityLabel），那是另一件事。
--    这一列说的是「这一件东西本身有多难见」—— 封印物的来源不在掉落表里。
--
-- ## 为什么不是「新增一张 extraordinary 表」
--
-- 封印物的全部字段都是「每一件物品各一份」的属性（类型 / 效果 / 代价 / 等级 / 稀有度），
-- 没有一行是「一次使用」「一次掉落」那样的事件 —— 后者才需要自己的表
-- （掉落与使用都以 domain_events 留档，不需要新表）。
-- 新开一张表会让「这件东西是什么」有两个出处，而 items 表本来就回答这个问题。
-- =====================================================================

PRAGMA foreign_keys = ON;

-- 非凡物类型：material（普通物，默认）| wonder（神奇物品）| sealed（封印物）| charm（符咒）
ALTER TABLE items ADD COLUMN type TEXT NOT NULL DEFAULT 'material';

-- 使用代价（封印物的「第二张脸」）：{ mad?, cor?, apRecoveryHalvedDays? }
-- 与 effect_json 分开存，因为两者问的是不同的问题：
--   effect_json      —— 用了之后**我要办的那件事**成不成
--   side_effect_json —— 用了之后**我自己**要付什么
ALTER TABLE items ADD COLUMN side_effect_json TEXT;

-- 封印等级 0—5：越高越危险。**不参与任何判定**，只进回执文案与报告。
ALTER TABLE items ADD COLUMN seal_level INTEGER;

-- 稀有度 1—5（1 = 常见，5 = 极稀有）。与掉落表权重分档是两件事，见文件头第 4 条。
ALTER TABLE items ADD COLUMN rarity INTEGER NOT NULL DEFAULT 1;

-- 不新增表。不新增索引（items 表只有 50 行，全表扫；加索引只会让写入多一步）。
