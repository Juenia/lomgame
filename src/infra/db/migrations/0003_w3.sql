-- 0003_w3.sql —— W3 结构：物品/背包/地点/配方/探索计数/交易
PRAGMA foreign_keys = ON;

-- 物品元数据（背包展示、可用性、绑定规则、魔药归属）
CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,                 -- material | consumable | currency | potion | trinket
  bindable    INTEGER NOT NULL DEFAULT 1,    -- 0 = 永不绑定（金镑等）
  tradeable   INTEGER NOT NULL DEFAULT 1,    -- 0 = 不可交易（身份物）
  pathway     TEXT,
  seq         INTEGER,
  effect_json TEXT NOT NULL DEFAULT '{}',    -- 消耗品效果，走 apply() 的 delta 口径
  note        TEXT
);

-- 背包（绑定/非绑定分开堆叠）
CREATE TABLE IF NOT EXISTS inventory (
  character_id TEXT NOT NULL,
  item_id      TEXT NOT NULL,
  bind_type    TEXT NOT NULL DEFAULT 'unbound',   -- bound | unbound
  quantity     INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (character_id, item_id, bind_type),
  FOREIGN KEY (character_id) REFERENCES characters(id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_char ON inventory(character_id);

-- 地点
CREATE TABLE IF NOT EXISTS locations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  min_seq     INTEGER NOT NULL DEFAULT 9,
  max_seq     INTEGER NOT NULL DEFAULT 0,
  danger      INTEGER NOT NULL DEFAULT 0,
  loot_json   TEXT NOT NULL DEFAULT '[]',
  events_json TEXT NOT NULL DEFAULT '[]'
);

-- 魔药配方
CREATE TABLE IF NOT EXISTS recipes (
  id           TEXT PRIMARY KEY,
  pathway      TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  main_json    TEXT NOT NULL,
  aux_json     TEXT NOT NULL,
  ritual       TEXT NOT NULL DEFAULT '',
  base_success REAL NOT NULL,
  cor_on_fail  INTEGER NOT NULL DEFAULT 0,
  mad_on_fail  INTEGER NOT NULL DEFAULT 0
);

-- 探索每日计数（同一地点每日上限）
CREATE TABLE IF NOT EXISTS explore_daily (
  character_id TEXT NOT NULL,
  date         TEXT NOT NULL,
  location_id  TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (character_id, date, location_id),
  FOREIGN KEY (character_id) REFERENCES characters(id)
);

-- 交易
CREATE TABLE IF NOT EXISTS trades (
  id           TEXT PRIMARY KEY,
  seller_id    TEXT NOT NULL,
  buyer_id     TEXT NOT NULL,
  item_id      TEXT NOT NULL,
  qty          INTEGER NOT NULL,
  price        INTEGER NOT NULL,
  tax          INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | completed | cancelled | expired
  created_at   INTEGER NOT NULL,
  confirmed_at INTEGER,
  FOREIGN KEY (seller_id) REFERENCES characters(id),
  FOREIGN KEY (buyer_id) REFERENCES characters(id)
);

CREATE INDEX IF NOT EXISTS idx_trades_buyer ON trades(buyer_id, status);
CREATE INDEX IF NOT EXISTS idx_trades_seller ON trades(seller_id, status);
CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at);
