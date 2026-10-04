-- =====================================================================
-- M2.9：PVE 回合制战斗
--
-- 战斗**不是一次判定**。M2.6.1 的 .袭击 是「打一下、结算、结束」，
-- 那是它该有的样子；战斗是**状态机**：遭遇 → 多回合博弈 → 结算 → 落库。
-- 「玩家可以关掉 QQ，5 分钟后回来接着打」这条异步性质，就是这两张表存在的理由 ——
-- 一次判定没有「回来接着打」这回事，也就没有任何东西需要落库。
--
-- 两张表各管一件事：
--   battles        未决战斗的状态机（一行 = 一场还没打完 / 已经打完的战斗）
--   battle_rounds  每一回合的记录（审计 + **复现**：带 seed 的判定输入输出）
--
-- 口径：本文件**不新增任何角色相关表**（任务书 §4.4），
--       也不改动 M2.1 / M2.2 / M2.5 / M2.6 / M2.6.1 / M2.7 / M2.7.6 / M2.7.7 / M2.8 的任何既有表结构。
--
-- ⚠️ 为 M2.10 留的口子：creature_id 现在是 NOT NULL，因为 M2.9 只有 PVE。
--    M2.10 做 PVP 时它要变成可空（对手可以是另一个玩家），另加 opponent_character_id。
--    状态机本身（battles 的全部其它列 + battle_rounds）**一个字都不用改** ——
--    因为「一边一个 HP、一边一串状态」这个形状对 PVE 与 PVP 是同一件事。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 战斗状态（未决战斗）
--
-- 相对任务书 §4.4 给的表结构，这里多了若干列，全都是**判定真的需要**的，
-- 不是「顺手多存一点」（与 M2.8 的 creatures 多两列同一手法）：
--
--   species_id / species_name  报告与文案不必再回查内容表；内容改了之后审计还能复述当时是什么
--   creature_sequence          战斗里「进化」会把序列 -1，结束后要写回 creatures 表
--   creature_max_hp            暴走/进化/援军都会抬它，没有基线就算不出 HP 比例（AI 全靠这个比例）
--   creature_dying             生物没有 MAD 字段，「长期没进食（濒死）」是它触发暴走的等价条件
--   creature_berserk/evolved/shield/playing_dead
--                              四种**跨回合**的行为标记。少存一个，玩家中途关掉 QQ 再回来，
--                              那只生物就会忘记自己在暴走 / 已经蜕过壳 / 正躺在地上装死
--   ally_called/ally_arrives_at_round/ally_count
--                              「求援」是唯一一个**延迟生效**的行为，不落库就跨不过回合边界
--   negate_creature_actions    「幻觉干扰」还剩几次能吞掉对手的行动
--   player_defense_penalty     「强攻」的代价要延后一回合支付，不落库就付不出来
--   last_player_damage         「模仿」要用玩家上一击的伤害
--   foresight_json             「占卜预判」看到的东西 —— 它必须活到玩家下一次做选择
--   world_json                 这一场战斗所处的世界（夜晚 / 雾 / 危险度），**开局定下、整场不变**
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS battles (
  id                    TEXT PRIMARY KEY,
  character_id          TEXT NOT NULL,
  creature_id           TEXT NOT NULL,
  species_id            TEXT NOT NULL,
  species_name          TEXT NOT NULL,
  location_id           TEXT NOT NULL,
  -- 当前回合号（1 起）。战斗结束后它等于「打完的回合数 + 1」
  round                 INTEGER NOT NULL DEFAULT 1,
  status                TEXT NOT NULL DEFAULT 'active',
  player_hp             INTEGER NOT NULL,
  player_mp             INTEGER NOT NULL,
  player_status_json    TEXT NOT NULL DEFAULT '[]',
  player_defense_penalty REAL NOT NULL DEFAULT 0,
  creature_hp           INTEGER NOT NULL,
  creature_max_hp       INTEGER NOT NULL,
  creature_sequence     INTEGER NOT NULL,
  creature_dying        INTEGER NOT NULL DEFAULT 0,
  creature_status_json  TEXT NOT NULL DEFAULT '[]',
  creature_berserk      INTEGER NOT NULL DEFAULT 0,
  creature_evolved      INTEGER NOT NULL DEFAULT 0,
  creature_shield       INTEGER NOT NULL DEFAULT 0,
  creature_playing_dead INTEGER NOT NULL DEFAULT 0,
  ally_called           INTEGER NOT NULL DEFAULT 0,
  ally_arrives_at_round INTEGER,
  ally_count            INTEGER NOT NULL DEFAULT 0,
  negate_creature_actions INTEGER NOT NULL DEFAULT 0,
  last_player_damage    INTEGER NOT NULL DEFAULT 0,
  foresight_json        TEXT,
  world_json            TEXT NOT NULL DEFAULT '{}',
  started_at            INTEGER NOT NULL,
  last_round_at         INTEGER NOT NULL,
  resolved_at           INTEGER,
  CHECK (status IN ('active','player_win','player_lose','stalemate','fled','creature_fled'))
);

-- 热路径两条：
--   「这个人此刻有没有在打」——每条指令都要问一次（超时自动防御靠它）
--   「这一场打完了没有」——报告与结算靠它
CREATE INDEX IF NOT EXISTS idx_battles_char ON battles(character_id, status);
CREATE INDEX IF NOT EXISTS idx_battles_status ON battles(status);

-- ---------------------------------------------------------------------
-- 回合记录（审计 + 复现）
--
-- 一行 = 一个回合。seed 落库的理由与其它判定一致：
-- 玩家投诉「我明明比它强却一直打不中」时，能用 seed 精确复现那一个回合。
--
-- result_json 里存的是判定层原样吐出来的 RoundResult 摘要：
-- 事件列表 / 双方伤害 / flags（暴击 / 流血 / 援军到达 / 超时自动防御 / 预知）。
-- 报告里的「生物行为分布 / 玩家动作分布 / 状态触发分布」**直接读这一张表**，
-- 不从最终状态反推 —— 状态反推不出「发生过什么」。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS battle_rounds (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  battle_id       TEXT NOT NULL,
  round           INTEGER NOT NULL,
  player_action   TEXT NOT NULL,
  creature_action TEXT NOT NULL,
  result_json     TEXT NOT NULL,
  seed            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (battle_id) REFERENCES battles(id)
);

CREATE INDEX IF NOT EXISTS idx_rounds_battle ON battle_rounds(battle_id, round);
