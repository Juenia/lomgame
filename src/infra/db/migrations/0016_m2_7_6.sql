-- =====================================================================
-- M2.7.6：普通人阶段与途径获得
--
-- 三件事：
--   1) characters 加 gender（初始性别，本版只存不算）与 pathway_status（mortal / initiated）；
--   2) pathway 与 sequence 改为**可空** —— 普通人没有途径，也没有序列；
--   3) 新增 pathway_offers（势力引导）与 recipe_clues（自己找到的配方线索）两张运行时表。
--
-- 为什么是「重建表」而不是 ALTER：
--   SQLite 不支持 DROP NOT NULL。0001 建表时 pathway TEXT NOT NULL、sequence INTEGER NOT NULL，
--   而任务书 §3 明确要求普通人这两项为空。可行的做法只有重建（官方文档
--   https://sqlite.org/lang_altertable.html#otheralter 的标准流程）。
--
-- 为什么开头是 PRAGMA defer_foreign_keys：
--   characters 被十几张表用外键引用（domain_events / inventory / trades / parties …）。
--   外键检查默认是**立即**的，DROP TABLE characters 会在那一刻就撞上引用它的行。
--   defer_foreign_keys 把检查推迟到 COMMIT —— 而那时新表已经改名就位、数据一条不少，
--   所以「重建」对引用方是完全透明的。注意 PRAGMA foreign_keys 本身在事务里是 no-op，
--   能用的只有 defer_foreign_keys（迁移是在 migrate() 的 BEGIN 里跑的）。
-- =====================================================================

PRAGMA defer_foreign_keys = ON;

CREATE TABLE characters_m27_6 (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  name           TEXT NOT NULL,
  -- 普通人 = NULL。入途径时由 .服用 写入。
  pathway        TEXT,
  -- 普通人 = NULL。入途径时写 9。
  sequence       INTEGER,
  hp             INTEGER NOT NULL DEFAULT 100,
  mp             INTEGER NOT NULL DEFAULT 100,
  mad            INTEGER NOT NULL DEFAULT 0,
  cor            INTEGER NOT NULL DEFAULT 0,
  dig            INTEGER NOT NULL DEFAULT 0,
  ap             INTEGER NOT NULL DEFAULT 5,
  dp             INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active',
  promotion_fails INTEGER NOT NULL DEFAULT 0,
  current_city_id TEXT,
  -- M2.7.6 补充 §1.2：初始性别。本版只做存储与显示，没有任何判定读它。
  gender         TEXT NOT NULL DEFAULT 'male',
  -- M2.7.6 §3：'mortal' | 'initiated'
  pathway_status TEXT NOT NULL DEFAULT 'mortal',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  CHECK (gender IN ('male', 'female')),
  CHECK (pathway_status IN ('mortal', 'initiated'))
);

-- 老库里的每一行都是 M2.7.6 之前的角色：他们创建时就带了途径，所以是 initiated。
-- 这里不能用默认值（默认是 mortal）—— 那会把所有老玩家打回普通人，
-- 而他们手上的序列、能力、消化度全都还在，会出现「有序列的普通人」这种自相矛盾的状态。
INSERT INTO characters_m27_6 (
  id, user_id, name, pathway, sequence, hp, mp, mad, cor, dig, ap, dp,
  status, promotion_fails, current_city_id, gender, pathway_status, created_at, updated_at
)
SELECT
  id, user_id, name, pathway, sequence, hp, mp, mad, cor, dig, ap, dp,
  status, promotion_fails, current_city_id, 'male',
  CASE WHEN pathway IS NOT NULL AND pathway <> '' THEN 'initiated' ELSE 'mortal' END,
  created_at, updated_at
FROM characters;

DROP TABLE characters;
ALTER TABLE characters_m27_6 RENAME TO characters;

CREATE INDEX IF NOT EXISTS idx_characters_user ON characters(user_id);
CREATE INDEX IF NOT EXISTS idx_characters_name ON characters(name);

-- ---------------------------------------------------------------------
-- 势力引导（路径 A：保底）
--
-- 一行 = 一次「有人注意到你」。stage 是它的生命周期，见 domain/initiation/types.ts。
-- task_json 是**任务快照**：内容表（factions.yaml）改了之后，
-- 已经发出去的邀约不会跟着变形 —— 玩家看到的任务与他当初接下的必须是同一件事。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pathway_offers (
  id            TEXT PRIMARY KEY,
  character_id  TEXT NOT NULL,
  faction_id    TEXT NOT NULL,
  pathway       TEXT NOT NULL,
  stage         TEXT NOT NULL DEFAULT 'contacted',
  -- 'contacted' | 'task_given' | 'task_done' | 'recipe_given' | 'completed' | 'declined'
  task_json     TEXT,
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER,
  expires_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_offers_char ON pathway_offers(character_id, stage);

-- ---------------------------------------------------------------------
-- 配方线索（路径 B：自己找到）
--
-- used_at 为 NULL = 还没用掉。线索不绑定势力 —— 这正是它比引导「自由」的地方：
-- 拿到线索的人不需要讨好任何人，只需要凑齐材料。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recipe_clues (
  id            TEXT PRIMARY KEY,
  character_id  TEXT NOT NULL,
  pathway       TEXT NOT NULL,
  clue_text     TEXT NOT NULL,
  found_at      INTEGER NOT NULL,
  used_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_clues_char ON recipe_clues(character_id, used_at);
