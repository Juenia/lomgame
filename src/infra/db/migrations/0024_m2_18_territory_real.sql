-- M2.18 任务 C+D：把 church_territory_contest.delta 从 INTEGER 改成 REAL。
--
-- 为什么要这一份：参数扫描（docs/M2.18-参数扫描.md）拍定 decayPerDay = 0.3，
-- 而非整数衰减写进 INTEGER 列会**静默取整**（SQLite 的 INTEGER 亲和），
-- 于是「每天衰减 0.3」变成「3 天衰减 1」—— 数值表与实际行为不一致，最难查的那一类。
--
-- ⚠️ **为什么不直接改 0023**：它已经在 m219 的库上应用过，schema_migrations 里那条记录
-- 不会重跑，改文件只对新库生效 —— 结果是「老库 INTEGER、新库 REAL」，本地能跑、别人拉起就错。
-- SQLite 也不支持 ALTER COLUMN TYPE，只能重建表。
CREATE TABLE church_territory_contest_new (
  id INTEGER PRIMARY KEY,
  location_id TEXT NOT NULL,
  winner_church_id TEXT NOT NULL,
  -- +1（PVP / 袭击胜利）或 -0.3（每日衰减）—— 小数是常态，所以是 REAL
  delta REAL NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO church_territory_contest_new (id, location_id, winner_church_id, delta, created_at)
  SELECT id, location_id, winner_church_id, delta, created_at FROM church_territory_contest;

DROP TABLE church_territory_contest;
ALTER TABLE church_territory_contest_new RENAME TO church_territory_contest;

CREATE INDEX idx_church_contest_location ON church_territory_contest(location_id);
