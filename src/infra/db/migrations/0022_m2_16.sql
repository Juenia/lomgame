-- M2.16：正神教会（入教 + 教内贡献）
--
-- 两列，**不加索引**：30 天 × 200 人的规模，全表扫够用
-- （与 M2.13「只给 items 加四列」同一个判断）。
--
-- church_id 可空：NULL = 未入教。一人一家（硬互斥），本版不做出退 ——
-- 这条不是靠约束守的，是靠 `canJoin` 的第 2 条判据守的（见 domain/church/membership.ts）。
--
-- church_contribution 是**累计贡献点**（捐献换算而来）。
-- ⚠️ 这里**没有 rank 列**：档位由「贡献 + 序列」双门槛**算出来**
-- （domain/church/membership.ts 的 currentRank），存下来反而会与序列脱节。

ALTER TABLE characters ADD COLUMN church_id TEXT;
ALTER TABLE characters ADD COLUMN church_contribution INTEGER NOT NULL DEFAULT 0;
