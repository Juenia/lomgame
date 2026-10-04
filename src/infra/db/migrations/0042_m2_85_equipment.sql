-- M2.85 RPG 化 B：**角色身上的装备**
--
-- 四个槽位（weapon / armor / charm / relic），每个槽位只能有一件 ——
-- 所以主键是 (character_id, slot)，而不是给每件装备一行。
--
-- 只存装备 id：名字与数值都在 equipment.yaml（内容是数据，判定层只读）。
CREATE TABLE IF NOT EXISTS character_equipment (
  character_id TEXT NOT NULL,
  slot         TEXT NOT NULL,
  equipment_id TEXT NOT NULL,
  equipped_at  INTEGER NOT NULL,
  PRIMARY KEY (character_id, slot)
);
