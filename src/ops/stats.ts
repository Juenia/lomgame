/**
 * 封测数据采集（W6）：全部指标都能从库里重算，可追溯。
 *   - 留存：user_daily 里每个用户的首个活跃日 = 注册日（cohort）
 *   - 行为：user_daily.counters_json 的指令分布
 *   - 玩法：domain_events / event_triggers / lost_control_events / trades / parties
 */
import { NUMERIC } from '../config/numeric.ts';
import type { Db } from '../infra/db/sqlite.ts';
import { UserActivityRepo } from '../infra/db/user-activity.ts';
import { FeedbackRepo } from '../infra/db/feedback.ts';

export interface RetentionPoint {
  cohort: string;
  size: number;
  d1: number | null;
  d7: number | null;
}

export interface GameplayStats {
  characters: number;
  /** 每个角色每日的卡触发次数 */
  cardTriggerRate: number;
  /** 每个角色每日的失控次数 */
  lostControlRate: number;
  /** 死循环比例（与模拟器同口径：序列 9 + DIG 达标 + MAD/COR 双越线） */
  deadlockRate: number;
  tradesCompleted: number;
  tradesPending: number;
  divinations: number;
  parties: number;
  partyTasks: number;
  purifies: number;
  promotions: number;
  promotionSuccess: number;
}

export interface BetaStats {
  dates: string[];
  dauByDate: Array<{ date: string; dau: number; newUsers: number; commands: number }>;
  retention: RetentionPoint[];
  /** 新手完成率：创建过角色且至少扮演过一次的用户占比 */
  onboardingRate: number;
  totalUsers: number;
  commandTotals: Record<string, number>;
  gameplay: GameplayStats;
  feedback: { total: number; complaints: number; complaintRate: number };
  /** 与 W5 模拟器预测的对照（激进型/稳健型区间，用于复盘） */
  simulatorReference: {
    lostControlRate: string;
    promotionSuccessRate: string;
    deadlockRate: string;
    materialRatio: string;
  };
}

export const COMPLAINT_CATEGORY = '投诉';

function dayOffset(date: string, days: number): string {
  const ts = Date.parse(`${date}T00:00:00Z`) + days * 24 * 60 * 60 * 1000;
  return new Date(ts).toISOString().slice(0, 10);
}

export function computeGameplayStats(db: Db): GameplayStats {
  const one = <T>(sql: string, ...params: Array<string | number | null>): T =>
    db.prepare(sql).get(...params) as T;

  const characters = one<{ n: number }>('SELECT COUNT(*) AS n FROM characters').n;
  const characterDays = Math.max(1, one<{ n: number }>('SELECT COUNT(*) AS n FROM user_daily').n);

  const cardTriggers = one<{ n: number }>('SELECT COUNT(*) AS n FROM event_triggers').n;
  /*
   * ⚠️ 排除 source='gm'：GM 后台的「强制失控」也往这张表留档（玩家侧「今天失控过」
   * 是按它算的），但那是运营手动造的，不是玩法跑出来的。混进来会把失控触发率打高 ——
   * 而 alerts.ts 在这项 > 0.2 时直接报 P1，等于 GM 点几下就触发一条假告警。
   */
  const lostControls = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM lost_control_events WHERE source <> 'gm'",
  ).n;
  const deadlocked = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM characters
     WHERE sequence = 9 AND dig >= ? AND mad >= ? AND cor >= ?`,
    NUMERIC.promotion.digThreshold,
    NUMERIC.lossOfControl.deadlockMadThreshold,
    NUMERIC.lossOfControl.deadlockCorThreshold,
  ).n;

  const promotionSuccess = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM domain_events WHERE type = 'promotion_success'",
  ).n;
  const promotionFail = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM domain_events WHERE type = 'promotion_fail'",
  ).n;

  const trades = one<{ completed: number; pending: number }>(
    `SELECT
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
     FROM trades`,
  );

  return {
    characters,
    cardTriggerRate: cardTriggers / characterDays,
    lostControlRate: lostControls / characterDays,
    deadlockRate: characters === 0 ? 0 : deadlocked / characters,
    tradesCompleted: trades.completed ?? 0,
    tradesPending: trades.pending ?? 0,
    divinations: 0,
    parties: one<{ n: number }>('SELECT COUNT(*) AS n FROM parties').n,
    partyTasks: one<{ n: number }>('SELECT COUNT(*) AS n FROM party_tasks').n,
    purifies: one<{ n: number }>("SELECT COUNT(*) AS n FROM domain_events WHERE reason = '净化'").n,
    promotions: promotionSuccess + promotionFail,
    promotionSuccess,
  };
}

export function computeBetaStats(db: Db): BetaStats {
  const activity = new UserActivityRepo(db);
  const feedback = new FeedbackRepo(db);
  const dates = activity.dates();

  const dauByDate = dates.map((date) => ({
    date,
    dau: activity.dauOn(date),
    newUsers: activity.newUsersOn(date),
    commands: activity.commandsOn(date),
  }));

  const retention: RetentionPoint[] = dates.map((cohort) => {
    const size = activity.cohortSize(cohort);
    const d1Date = dayOffset(cohort, 1);
    const d7Date = dayOffset(cohort, 7);
    const hasD1 = dates.includes(d1Date);
    const hasD7 = dates.includes(d7Date);
    return {
      cohort,
      size,
      d1: hasD1 && size > 0 ? activity.retainedCount(cohort, d1Date) / size : null,
      d7: hasD7 && size > 0 ? activity.retainedCount(cohort, d7Date) / size : null,
    };
  });

  const totals = activity.commandTotals();
  const totalUsers = activity.totalUsers();
  const gameplay = computeGameplayStats(db);
  const complaints = feedback.countByCategory(COMPLAINT_CATEGORY);
  const latestDate = dates[dates.length - 1] ?? '';
  const latestDau = latestDate ? activity.dauOn(latestDate) : 0;

  // 新手完成率：创建过角色 + 至少扮演过一次（用 domain_events 与 characters 交叉）
  const created = db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM characters').get() as { n: number };
  const played = db
    .prepare(
      `SELECT COUNT(DISTINCT c.user_id) AS n FROM characters c
       JOIN domain_events e ON e.character_id = c.id AND e.reason = '扮演消化'`,
    )
    .get() as { n: number };

  return {
    dates,
    dauByDate,
    retention,
    onboardingRate: created.n === 0 ? 0 : played.n / created.n,
    totalUsers,
    commandTotals: totals,
    gameplay: {
      ...gameplay,
      divinations: totals['占卜'] ?? 0,
    },
    feedback: {
      total: feedback.count(),
      complaints,
      complaintRate: latestDau === 0 ? 0 : complaints / latestDau,
    },
    simulatorReference: {
      lostControlRate: '稳健型 4.1%（30 天累计）／激进型 27.2%',
      promotionSuccessRate: '稳健型 81.0%／激进型 61.7%',
      deadlockRate: '稳健型 0.2%／激进型 4.8%',
      materialRatio: '0.81—0.87',
    },
  };
}
