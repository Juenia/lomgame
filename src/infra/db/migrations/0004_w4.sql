-- 0004_w4.sql —— W4 结构：能力表 / 队伍 / 每日计数 / 晋升失败计数 / 交易设备指纹
PRAGMA foreign_keys = ON;

-- 注意：daily_ticks 表在 0001_init.sql 里已经建好（date 主键即幂等键），这里不重复创建。

-- 晋升连续失败计数（防卡死加成用）
ALTER TABLE characters ADD COLUMN promotion_fails INTEGER NOT NULL DEFAULT 0;

-- 交易设备指纹（W4 只留钩子；OneBot 上报没有设备信息，字段先备好）
ALTER TABLE trades ADD COLUMN device_key TEXT;

-- 能力表：判定时查表，不硬编码
CREATE TABLE IF NOT EXISTS abilities (
  id          TEXT PRIMARY KEY,
  pathway     TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  effect_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_abilities_pathway_seq ON abilities(pathway, seq);

-- 每日计数：休息/净化/占卜这类「每日 N 次」的业务限制
CREATE TABLE IF NOT EXISTS daily_counters (
  character_id TEXT NOT NULL,
  date         TEXT NOT NULL,
  key          TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (character_id, date, key),
  FOREIGN KEY (character_id) REFERENCES characters(id)
);

-- 队伍（最小实现：上限 4 人，队长离开即解散）
CREATE TABLE IF NOT EXISTS parties (
  id         TEXT PRIMARY KEY,
  leader_id  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',   -- active | disbanded
  created_at INTEGER NOT NULL,
  FOREIGN KEY (leader_id) REFERENCES characters(id)
);

CREATE TABLE IF NOT EXISTS party_members (
  party_id     TEXT NOT NULL,
  character_id TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member', -- leader | member
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY (party_id, character_id),
  FOREIGN KEY (party_id) REFERENCES parties(id),
  FOREIGN KEY (character_id) REFERENCES characters(id)
);

CREATE INDEX IF NOT EXISTS idx_party_members_char ON party_members(character_id);
CREATE INDEX IF NOT EXISTS idx_parties_leader ON parties(leader_id, status);
