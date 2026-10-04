-- =====================================================================
-- M2.10：PVP 战斗
--
-- M2.9 交付了 PVE 的战斗状态机，M2.10 让**对手可以是另一个玩家**。
-- 状态机本身一个字都不用改 —— 「一边一个 HP、一边一串状态」这个形状
-- 对 PVE 与 PVP 本来就是同一件事（这正是 0018 末尾那句「为 M2.10 留的口子」）。
--
-- 本次迁移做两件事：
--   1. creature_id 从 NOT NULL 改为**可空**（PVP 的对手是玩家，没有生物实例）；
--   2. 新增四列（PVP 的对手身份、轮次、暂存动作）与一列被吞行动的计数。
--
-- SQLite 不支持 DROP NOT NULL，只能重建表（与 M2.7.6 给 characters 加列同一手法）。
--
-- ⚠️ 口径：本文件**不新增任何角色相关表**，也不改动 M2.9 之外的任何既有表结构。
--    battle_rounds 完全不动 —— 「每一回合一条带 seed 的记录」这条对 PVP 同样成立，
--    而且 PVP 更需要它（两个真人对同一回合的记忆可以完全不同）。
-- =====================================================================

-- 重建期间先把外键检查推到提交时：
-- battle_rounds.battle_id 引用 battles(id)，DROP + RENAME 会在这中间短暂地「指向不存在的表」。
PRAGMA defer_foreign_keys = ON;

CREATE TABLE IF NOT EXISTS battles_new (
  id                    TEXT PRIMARY KEY,
  character_id          TEXT NOT NULL,
  -- M2.10：可空（PVP 时为 NULL）
  creature_id           TEXT,
  species_id            TEXT NOT NULL,
  species_name          TEXT NOT NULL,
  location_id           TEXT NOT NULL,
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

  -- ------------------------------------------------------------------
  -- M2.10 新增
  -- ------------------------------------------------------------------
  -- 这一场是不是 PVP。有了它，creature_* 那一串的语义就明确了：
  --   0 → 「那只生物」    1 → 「对手玩家」（血量 / 序列 / 状态）
  -- 不改名（不改 creature_* → opponent_*）的理由写在 domain/battle/types.ts 里：
  -- 判定层对两边完全对称、它从不关心对面是人还是生物，改名要动 0018 的全部列与全部测试。
  is_pvp                INTEGER NOT NULL DEFAULT 0,
  -- PVP 对手的角色 id（PVE 为 NULL）
  opponent_character_id TEXT,
  -- 现在轮到谁出招：'challenger' = character_id 那一方；'opponent' = opponent_character_id 那一方。
  -- PVE 恒为 'challenger'（生物永远在线，不存在「等它出招」）。
  turn_of               TEXT NOT NULL DEFAULT 'challenger',
  -- 对方已经出招、在等自己时暂存的那个动作（异步 PVP = 两人各选一个动作再一起结算）
  pending_action_json   TEXT,
  -- 自己被对手的「幻觉干扰」吞掉了几次行动（PVP 专用；PVE 恒为 0）
  negate_player_actions INTEGER NOT NULL DEFAULT 0,

  CHECK (status IN ('active','player_win','player_lose','stalemate','fled','creature_fled')),
  CHECK (turn_of IN ('challenger','opponent')),
  CHECK (is_pvp IN (0,1))
);

-- 搬数据：旧表的每一行都是 PVE（is_pvp=0 / turn_of='challenger' / 其余为 NULL）
INSERT INTO battles_new (
  id, character_id, creature_id, species_id, species_name, location_id, round, status,
  player_hp, player_mp, player_status_json, player_defense_penalty,
  creature_hp, creature_max_hp, creature_sequence, creature_dying, creature_status_json,
  creature_berserk, creature_evolved, creature_shield, creature_playing_dead,
  ally_called, ally_arrives_at_round, ally_count, negate_creature_actions,
  last_player_damage, foresight_json, world_json, started_at, last_round_at, resolved_at,
  is_pvp, opponent_character_id, turn_of, pending_action_json, negate_player_actions
)
SELECT
  id, character_id, creature_id, species_id, species_name, location_id, round, status,
  player_hp, player_mp, player_status_json, player_defense_penalty,
  creature_hp, creature_max_hp, creature_sequence, creature_dying, creature_status_json,
  creature_berserk, creature_evolved, creature_shield, creature_playing_dead,
  ally_called, ally_arrives_at_round, ally_count, negate_creature_actions,
  last_player_damage, foresight_json, world_json, started_at, last_round_at, resolved_at,
  0, NULL, 'challenger', NULL, 0
FROM battles;

DROP TABLE battles;
ALTER TABLE battles_new RENAME TO battles;

-- 重建索引（旧索引随旧表一起没了）
CREATE INDEX IF NOT EXISTS idx_battles_char ON battles(character_id, status);
CREATE INDEX IF NOT EXISTS idx_battles_status ON battles(status);
-- M2.10：PVP 的热路径是「这个**对手**此刻有没有在打」（发起挑战前的校验要走它）
CREATE INDEX IF NOT EXISTS idx_battles_opponent ON battles(opponent_character_id, status);
-- M2.10：轮次查询（超时补齐要按 turn_of 判断该补谁）
CREATE INDEX IF NOT EXISTS idx_battles_turn ON battles(is_pvp, turn_of, status);
