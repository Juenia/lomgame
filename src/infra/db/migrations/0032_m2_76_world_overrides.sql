-- M2.76：**世界状态覆盖层** —— 让「权柄改写世界状态」这件事有一个可写的地方。
--
-- ## 为什么必须有这张表
--
-- 天气与雾日在项目里是 `(WORLD_SEED, 时间)` 的**纯函数结果**（docs/框架现状解读.md:129）：
-- `domain/world/weather.ts` 只吃 seed 与时间，没有第三个输入。
-- ⇒ 「权柄改写世界状态」在这套结构下**无处落脚** —— 这不是接线问题，是缺一层。
--
-- 现有的三条世界写入边（world_events / zone_state / power_state）都改不了天气：
-- 前两条记的是「发生过什么」，第三条记的是「势力怎么样」，而天气是**算出来的**。
--
-- ## 为什么是「覆盖」而不是「改 seed」
--
-- 改 seed 会**改写整个世界的历史**（雾日序列、事件时刻、初始播种全部跟着变），
-- 而权柄要的是「从这一刻起，这个地方是天晴」—— 是一个**有期限的例外**，不是新世界。
--
-- ## 优先级：覆盖层优先于 seed 派生
--
-- 权柄是世界级能力，它理应压过自然演化 —— 否则「神明让雨停了」会被下一小时的
-- seed 计算覆盖回去，玩家看到的是一件没有发生过的事。
-- 到期（until 过去）之后自动失效，不需要清理任务：读的时候带上 `until > now` 就够了。
CREATE TABLE IF NOT EXISTS world_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  /** 'weather' —— 目前只做天气；留出 kind 是为了权柄扩展到雾日/事件时不用改表 */
  kind TEXT NOT NULL,
  /** 作用范围：地点 id，或 '*' 表示全服 */
  scope TEXT NOT NULL,
  /** 覆盖成什么（天气 id） */
  value TEXT NOT NULL,
  /** 到期时刻（ms）。过去即失效 —— 不需要清理任务 */
  until INTEGER NOT NULL,
  /** 谁写的：'authority:<权柄 id>' / 'gm' —— 与失控事件的 source 同一口径 */
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_world_overrides_lookup ON world_overrides(kind, scope, until);
