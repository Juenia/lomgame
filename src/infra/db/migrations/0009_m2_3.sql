-- 0009_m2_3.sql —— M2.3 选项驱动
-- 只新增菜单状态一张表，**不新增任何角色相关表**（任务书第八节）。
-- 菜单是「玩家上一次看到的选项快照」：每角色一行（新菜单覆盖旧菜单），
-- 5 分钟后过期（NUMERIC.menu.ttlMs）。过期后回数字一律回「菜单已过期」，
-- 由玩家发 .今日 重新开始 —— 这样系统永远不会拿旧选项去做新决定。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pending_menus (
  character_id TEXT PRIMARY KEY,
  menu_type    TEXT NOT NULL,      -- 'play' | 'explore' | 'today' | 'world' | 'result' | 'freeform' | …
  payload_json TEXT NOT NULL,      -- 选项列表快照（完整的 Menu JSON：标题/上下文/选项/自由输入开关）
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

-- 过期清理由指令入口的懒清扫驱动，这个索引让它是一次范围删除而不是全表扫
CREATE INDEX IF NOT EXISTS idx_pending_menus_expires ON pending_menus(expires_at);
