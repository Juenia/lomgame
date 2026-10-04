-- M2.168：**神明的记忆落库** —— 跨小时计划与出手冷却。
--
-- 在这之前这两样都是**进程内**的（`DivinePlans` 的 Map 与 `deps.divineState`），
-- 重启就丢。丢的代价不是「报错」，而是：
--   · 祂正要走完的那条计划链**从第三步回到第一步**（看起来像神在反复做同一件事）
--   · 沉寂期与手段冷却被清空 ⇒ 重启之后众神可能连着出手（那正是稀有性要防的）
--
-- RouterDeps 的注释里早就写着「真要持久化时，这里换成仓储实现即可（调用方只认这两个字段）」——
-- 这一版就是把那句话兑现。
--
-- ⚠️ `seat` 用神座的名字（throne.seat）而不是途径 id：
--    计划是「**这一位**要做什么」，而一个位置换人之后，新那位不该继承前任的计划。
CREATE TABLE IF NOT EXISTS divine_plans (
  seat        TEXT PRIMARY KEY,
  goal_id     TEXT NOT NULL,
  steps_json  TEXT NOT NULL DEFAULT '[]',
  step        INTEGER NOT NULL DEFAULT 0,
  started_at  INTEGER NOT NULL
);

-- 每一条途径上一次出手的时刻、以及各手段的冷却起点。
CREATE TABLE IF NOT EXISTS divine_state (
  pathway          TEXT PRIMARY KEY,
  last_act_at      INTEGER NOT NULL,
  method_used_json TEXT NOT NULL DEFAULT '{}'
);
