-- 0001_init.sql —— W1 初始结构（S1 交付物三）
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 用户
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  qq_id         TEXT UNIQUE NOT NULL,
  nickname      TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

-- 角色
CREATE TABLE IF NOT EXISTS characters (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  pathway      TEXT NOT NULL,
  sequence     INTEGER NOT NULL DEFAULT 9,
  hp           INTEGER NOT NULL DEFAULT 100,
  mp           INTEGER NOT NULL DEFAULT 100,
  mad          INTEGER NOT NULL DEFAULT 0,
  cor          INTEGER NOT NULL DEFAULT 0,
  dig          INTEGER NOT NULL DEFAULT 0,
  dp           INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_characters_user ON characters(user_id);
CREATE INDEX IF NOT EXISTS idx_characters_name ON characters(name);

-- 幂等键
CREATE TABLE IF NOT EXISTS idempotency_keys (
  message_id  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idem_created ON idempotency_keys(created_at);

-- 领域事件日志（事件溯源核心）
CREATE TABLE IF NOT EXISTS domain_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id  TEXT NOT NULL,
  type          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  reason        TEXT NOT NULL,
  seed          TEXT,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (character_id) REFERENCES characters(id)
);

CREATE INDEX IF NOT EXISTS idx_events_char ON domain_events(character_id, created_at);

-- 每日行动
CREATE TABLE IF NOT EXISTS daily_actions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL,
  date         TEXT NOT NULL,
  ap_used      INTEGER NOT NULL DEFAULT 0,
  actions_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE(character_id, date),
  FOREIGN KEY (character_id) REFERENCES characters(id)
);

-- 冷却（优先用内存令牌桶，这里落审计）
CREATE TABLE IF NOT EXISTS cooldowns (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL,
  command      TEXT NOT NULL,
  last_used_at INTEGER NOT NULL,
  UNIQUE(character_id, command)
);

-- 审计日志
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  command     TEXT NOT NULL,
  input       TEXT,
  output      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id, created_at);

-- 每日 tick 幂等表
CREATE TABLE IF NOT EXISTS daily_ticks (
  date        TEXT PRIMARY KEY,
  executed_at INTEGER NOT NULL
);
