-- =====================================================================
-- M2.8：非凡生物（世界实体层）
--
-- 生物**不是事件卡**。事件卡是「抽一张、看一眼、结束」；
-- 生物有自己的位置、HP、状态、年龄，跑在每小时一次的生态 tick 上 ——
-- 玩家遇到的是「此时此刻的它」，不是配置好的它。
--
-- 三张表各管一件事：
--   creature_species  物种模板（启动时从 src/data/creatures.yaml 播种）—— **内容**
--   creatures         生物实例（世界状态，跑在 tick 上）—— **状态**
--   sightings         遭遇记录（审计：谁在什么时候遇到了谁、看到哪一层、做了什么）
-- 外加一张 creature_ticks 幂等表（见文件末尾）。
--
-- 口径：本文件**不新增任何角色相关表**（任务书 §4.6），
--       也不改动 M2.1 / M2.2 / M2.5 / M2.6 / M2.7 / M2.7.6 / M2.7.7 的任何既有表结构。
--
-- ⚠️ 这套结构是**为 M2.9 留好的**：creatures 里的 hp / status / sequence 就是战斗的对手来源，
--    M2.9 只需要接一个「进入战斗」的动作。所以这里存的是**完整战斗所需的最小集**，
--    不是一个只够渲染遭遇文案的投影。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 物种模板（内容侧的运行时副本，启动时覆盖式播种）
--
-- 为什么要落库而不是每次读 YAML：生物实例要外键引用它，
-- 而且报告/审计要能回答「这只当时是什么物种」—— 即使内容表后来改了。
-- 与 items / locations 不同（那两张是纯内容，判定层直接读内存表），
-- 物种表被**世界状态**引用，所以它必须在库里。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS creature_species (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  base_sequence         INTEGER NOT NULL,
  habitat_json          TEXT NOT NULL,
  pathway_affinity_json TEXT NOT NULL,
  drops_json            TEXT NOT NULL,
  behaviors_json        TEXT NOT NULL,
  habits_json           TEXT NOT NULL,
  tick_rate             TEXT NOT NULL,
  base_hp               INTEGER NOT NULL,
  flavor                TEXT NOT NULL DEFAULT '',
  -- 五层感知文本（blur / silhouette / full / advantage / essence）。
  -- 落库是为了审计「当时给他看的是哪一句」—— 内容改了之后报告还能复现。
  perception_json       TEXT NOT NULL,
  updated_at            INTEGER NOT NULL,
  CHECK (tick_rate IN ('hourly', 'daily'))
);

-- ---------------------------------------------------------------------
-- 生物实例（世界状态，跑在生态 tick 上）
--
-- 与物种模板的分别：模板是「低语者是什么」，实例是「老码头那只饿了两天的低语者」。
-- 玩家遇到的一律是实例。
--
-- 相对任务书 §4.6 的表结构，这里多了两列，都是**判定/战斗真的需要**的：
--   max_hp     —— 没有它，「HP 40/40」和「HP 40/100」分不出来；进化要抬上限，也需要基线
--   feed_count —— 进化条件是「存活 240 小时 **且** 捕食 3 次」，次数必须记着
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS creatures (
  id            TEXT PRIMARY KEY,
  species_id    TEXT NOT NULL,
  location_id   TEXT NOT NULL,
  -- 个体序列：从物种基线开始，进化时 -1（数字越小越强）
  sequence      INTEGER NOT NULL,
  hp            INTEGER NOT NULL,
  max_hp        INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'healthy',
  age_hours     INTEGER NOT NULL DEFAULT 0,
  feed_count    INTEGER NOT NULL DEFAULT 0,
  last_fed_at   INTEGER,
  spawned_at    INTEGER NOT NULL,
  migrated_from TEXT,
  FOREIGN KEY (species_id) REFERENCES creature_species(id),
  CHECK (status IN ('healthy', 'hungry', 'evolving', 'dying')),
  CHECK (hp > 0)
);

-- 遭遇的取生物路径就是「这个地点此刻有哪些活的」—— 这条索引是热路径
CREATE INDEX IF NOT EXISTS idx_creatures_location ON creatures(location_id, status);
CREATE INDEX IF NOT EXISTS idx_creatures_species ON creatures(species_id);

-- ---------------------------------------------------------------------
-- 遭遇记录（审计）
--
-- 一行 = 一次「你遇到了它」。seed 落库的理由与其它判定一致：
-- 玩家投诉「我明明比它强却只看到一团雾」时，能用日志里的 seed 精确复现。
--
-- action 为 NULL = 遭遇已发生但玩家还没选动作（他可能直接关了对话）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sightings (
  id            TEXT PRIMARY KEY,
  character_id  TEXT NOT NULL,
  creature_id   TEXT NOT NULL,
  species_id    TEXT NOT NULL,
  -- 感知层次：blur / silhouette / full / advantage / essence
  layer         TEXT NOT NULL,
  action        TEXT,
  seed          TEXT NOT NULL,
  -- 观察本质时采到的东西（JSON 数组）；没采集是 NULL
  harvest_json  TEXT,
  resolved_at   INTEGER NOT NULL,
  CHECK (layer IN ('blur', 'silhouette', 'full', 'advantage', 'essence')),
  CHECK (action IS NULL OR action IN ('observe', 'confront', 'retreat', 'interact', 'hold'))
);

CREATE INDEX IF NOT EXISTS idx_sightings_char ON sightings(character_id, resolved_at);
CREATE INDEX IF NOT EXISTS idx_sightings_creature ON sightings(creature_id);

-- ---------------------------------------------------------------------
-- 生态 tick 幂等表
--
-- 与 M2.2 的 world_ticks **同一手法、不同的一张表**：
--   同一 (tick_key) 只结算一次，重复执行不重复结算；补跑按水位线逐格补齐。
--
-- 为什么不复用 world_ticks：那是 M2.2 世界时钟（天气 / 月相 / 雾日）的幂等表，
-- 它的水位线语义（last_light_at / last_heavy_at）属于世界时钟。
-- 生态 tick 是**另一条时间线**（生物自己的节拍），共表会让两边的补跑互相干扰 ——
-- 而任务书的硬约束是「不改 M2.2 已定的东西」。分表是代价最小的做法。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS creature_ticks (
  tick_key     TEXT PRIMARY KEY,
  tick_at      INTEGER NOT NULL,
  executed_at  INTEGER NOT NULL,
  -- 这一小时世界做了什么（迁移 / 捕食 / 进化 / 繁衍 / 衰亡各几次），报告直接读它
  summary_json TEXT NOT NULL DEFAULT '{}'
);
