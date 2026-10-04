-- M2.167：**他不再是人了** —— 堕落到底的人会变成 creatures 里的一只。
--
-- 为什么不是「死」：他没死。死了的人是 npc_life.alive = 0（不可逆，只有神明能开门）；
-- 而变成怪物的人是**活着变成了别的东西** —— 他会出现在那条街上、会袭击人、
-- 会被教会清剿。两者在读取端的表现完全不同（死者不进遭遇池，怪物进）。
--
-- beast_id 指向 creatures 表的主键（beast:<npcId>）。空 = 还没变。
-- human 那一列（0046 建的）在这里复用：变成怪物之后 human = 0 ——
-- 「他还算不算人」这个问题的答案，与邪神复活成 thrall 时是同一个字段。
ALTER TABLE npc_life ADD COLUMN beast_id TEXT NOT NULL DEFAULT '';
