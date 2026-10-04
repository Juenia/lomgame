-- M2.85 RPG 化 B：**角色拥有的非凡物品**
--
-- 为什么和 character_equipment 分开：那张表存的是「**穿在身上的**」（每槽一件），
-- 而这一张存的是「**手里有的**」—— 一个人可以有两件同槽位的封印物，只是不能同时穿。
-- 不做这一步的话，「获得一件装备」就没有地方落 —— 只能凭空装备，那不叫来源。
CREATE TABLE IF NOT EXISTS character_equipment_owned (
  character_id TEXT NOT NULL,
  equipment_id TEXT NOT NULL,
  obtained_at  INTEGER NOT NULL,
  /** 怎么来的：battle 掉落 / shop 购买 / quest 报酬 / gm 直接给 */
  source       TEXT NOT NULL,
  PRIMARY KEY (character_id, equipment_id)
);
