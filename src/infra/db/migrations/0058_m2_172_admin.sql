-- M2.171：管理员指令的**服务器开关**（游戏 / 主动推送 / 主动事件推送）。
--
-- 为什么单独一张表，而不是塞进 flags：
--   flags 的键是**角色**（character_id），它回答的是「这个人身上发生了什么」；
--   而这三件事的粒度是「全局」与「这个群」—— 与任何角色无关。
--   混进去的第一个后果是 .状态 的标记清单会被 scene:123456:game 这种字符串塞满。
--
-- 两个维度用同一张表表达：scene_id = '' 是全局，scene_id = <群号> 是本群覆盖。
-- 「本群没设过」与「本群设成关」是两件事，所以用行的**存在与否**区分，
-- 而不是用 value 的第三个取值 —— 后者会让「恢复跟随全局」变得没法表达。
CREATE TABLE IF NOT EXISTS server_switches (
  key        TEXT    NOT NULL,
  scene_id   TEXT    NOT NULL DEFAULT '',
  value      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key, scene_id)
);
