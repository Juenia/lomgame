-- 0012_m2_5_currency.sql —— M2.5 追加：三层货币（金镑 / 苏勒 / 便士）
--
-- 这是**数据修正，不是重算**：所有既有货币数值一个都没改，改的是单位解释 ——
-- 过去的「8 金镑」现在读作「8 便士」（内部一律以最小的便士为单位存储）。
--
-- 三件事：
--   1. 库存里的货币物品 id：金镑 → 便士（值不变）
--   2. trades 增加 price_penny / tax_penny（新口径），并从旧列回填
--   3. 旧列 price / tax **保留不删**：迁移期两种字段都能读，一个版本后再清
PRAGMA foreign_keys = ON;

-- 1) 货币物品 id 改写（老存档里存的是「金镑」）
UPDATE inventory SET item_id = '便士' WHERE item_id = '金镑';

-- 2) 交易金额的两套列并存：price_penny / tax_penny 是新口径，price / tax 是旧列
ALTER TABLE trades ADD COLUMN price_penny INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trades ADD COLUMN tax_penny INTEGER NOT NULL DEFAULT 0;
UPDATE trades SET price_penny = price, tax_penny = tax;
