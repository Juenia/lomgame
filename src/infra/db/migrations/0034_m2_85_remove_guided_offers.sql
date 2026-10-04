-- M2.85：势力引导玩法下线，pathway_offers（引导邀约）与运行时一起删除。
--
-- 为什么整表 DROP 而不是留一张死表：
--   「走上途径」从两条路（势力引导 / 自己翻线索）收成一条（翻线索）之后，
--   这张表没有任何读取方 —— repo（infra/db/initiation.ts 的 PathwayOfferRepo）
--   已在同一个里程碑里删除，留表只会让后来的人误以为它还有写入方。
--
-- 历史迁移（0016_m2_7_6.sql）是冻结快照，不回改：它在当时的世界里是对的。
-- 线索（recipe_clues）不受影响 —— 它是 M2.85 之后唯一的「获得途径」运行时表。

DROP INDEX IF EXISTS idx_offers_char;
DROP TABLE IF EXISTS pathway_offers;
