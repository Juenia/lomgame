-- =====================================================================
-- M2.62：边界输入的运行时状态。
--
-- 与 boundaries.yaml 的分工（与 M2.58 / M2.59 同一个分法）：
--   boundaries.yaml      —— 内容。哪条边界、对面是谁、每小时攒多少张力，静态。
--   boundary_state（本表）—— 世界状态。**上一次外来输入是什么时候**。
--
-- 为什么要记「上一次什么时候」而不是记张力值：
--   张力是**绝对时刻的函数**（now − lastEventAt 换算），不是逐 tick 累加的数。
--   这样补跑 5 格与逐小时真的跑过 5 次得到同一个结果 ——
--   与 M2.58 的生态恐慌、M2.59 的势力警觉同一条纪律。
--   存张力值的话，补跑会把它多加几次，而那种错只在重启后的第一个 tick 显形。
-- =====================================================================

CREATE TABLE IF NOT EXISTS boundary_state (
  boundary_id      TEXT PRIMARY KEY,
  -- 上一次外来输入发生的时刻（毫秒）；NULL = 从来没发生过
  last_event_at    INTEGER,
  -- 上一次是哪一类输入（trade / migrant / threat / contamination）；审计用
  last_kind        TEXT,
  -- 累计发生次数（只增不减；报告读它）
  event_count      INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
);

-- 报告与后台会问「哪条边界最活跃」
CREATE INDEX IF NOT EXISTS idx_boundary_state_events ON boundary_state(event_count);
