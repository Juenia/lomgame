-- M2.164：**回来的不是他**（用户追问：「神明复活的他还是他吗？邪神复活的他还是人吗？」）
--
-- 0045 那一版把复活写成了「原样回来 + 一个堕落度数字」—— 那等于读档：
-- 记忆、关系、性情全在，死亡就白死了。
--
-- 这一列回答的是那个追问：**从死里回来的是谁**。
--
--   same    还是他（只可能第一次、且是正神那一档拉他回来）
--   changed 是他，但缺了一块（第二次起必然；对你的好感被削、性情可能翻过来）
--   vessel  壳回来了、人没回来（天使与神那一档被强行拉回：名字还在，记忆清零）
--   thrall  **不是人**（邪神那一档：祂的东西 —— 只认祂，不认你）
--
-- human 是 returned_as 的派生列（thrall = 0），存起来是因为读取点很多：
-- 「他还算不算人」会决定他能不能被当作普通人对待，而这个判断每处都要用。
ALTER TABLE npc_life ADD COLUMN returned_as TEXT NOT NULL DEFAULT '';
ALTER TABLE npc_life ADD COLUMN human INTEGER NOT NULL DEFAULT 1;
