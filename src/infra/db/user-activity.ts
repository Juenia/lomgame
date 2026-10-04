import type { Db } from './sqlite.ts';

export interface UserDailyRow {
  userId: string;
  date: string;
  commands: number;
  counters: Record<string, number>;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface DailyActivity {
  date: string;
  dau: number;
  newUsers: number;
  commands: number;
}

/**
 * user_daily：每用户每日的活跃与指令分布。
 * 留存、指令频次、新手完成率、卡触发率等封测指标都从这里算，落库可追溯。
 */
export class UserActivityRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** 记录一次指令（幂等：同一天累加）。失败不应影响游戏主流程，调用方负责 try/catch */
  touch(userId: string, date: string, command: string, now: number): void {
    const existing = this.get(userId, date);
    if (!existing) {
      this.#db
        .prepare(
          `INSERT INTO user_daily (user_id, date, commands, counters_json, first_seen_at, last_seen_at)
           VALUES (?, ?, 1, ?, ?, ?)`,
        )
        .run(userId, date, JSON.stringify({ [command]: 1 }), now, now);
      return;
    }
    const counters = { ...existing.counters, [command]: (existing.counters[command] ?? 0) + 1 };
    this.#db
      .prepare(
        `UPDATE user_daily SET commands = commands + 1, counters_json = ?, last_seen_at = ?
         WHERE user_id = ? AND date = ?`,
      )
      .run(JSON.stringify(counters), now, userId, date);
  }

  get(userId: string, date: string): UserDailyRow | null {
    const row = this.#db
      .prepare('SELECT * FROM user_daily WHERE user_id = ? AND date = ?')
      .get(userId, date) as Record<string, unknown> | undefined;
    return row ? toRow(row) : null;
  }

  /** 某天的活跃用户数 */
  dauOn(date: string): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM user_daily WHERE date = ?')
      .get(date) as { n: number };
    return row.n;
  }

  commandsOn(date: string): number {
    const row = this.#db
      .prepare('SELECT COALESCE(SUM(commands), 0) AS n FROM user_daily WHERE date = ?')
      .get(date) as { n: number };
    return row.n;
  }

  /** 某天首次出现的用户数（新用户） */
  newUsersOn(date: string): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT user_id, MIN(date) AS first_date FROM user_daily GROUP BY user_id
         ) WHERE first_date = ?`,
      )
      .get(date) as { n: number };
    return row.n;
  }

  /** 首次活跃在 cohortDate、且在 targetDate 也活跃的用户数 */
  retainedCount(cohortDate: string, targetDate: string): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT user_id, MIN(date) AS first_date FROM user_daily GROUP BY user_id
         ) cohort
         JOIN user_daily later ON later.user_id = cohort.user_id AND later.date = ?
         WHERE cohort.first_date = ?`,
      )
      .get(targetDate, cohortDate) as { n: number };
    return row.n;
  }

  cohortSize(cohortDate: string): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT user_id, MIN(date) AS first_date FROM user_daily GROUP BY user_id
         ) WHERE first_date = ?`,
      )
      .get(cohortDate) as { n: number };
    return row.n;
  }

  /** 所有出现过的日期（升序） */
  dates(): string[] {
    const rows = this.#db
      .prepare('SELECT DISTINCT date FROM user_daily ORDER BY date ASC')
      .all() as Array<{ date: string }>;
    return rows.map((row) => row.date);
  }

  /** 全服指令分布（封测期行为画像） */
  commandTotals(): Record<string, number> {
    const rows = this.#db.prepare('SELECT counters_json FROM user_daily').all() as Array<{
      counters_json: string;
    }>;
    const totals: Record<string, number> = {};
    for (const row of rows) {
      const counters = JSON.parse(row.counters_json) as Record<string, number>;
      for (const [command, count] of Object.entries(counters)) {
        totals[command] = (totals[command] ?? 0) + count;
      }
    }
    return totals;
  }

  /** 做过某条指令的用户数（新手完成率等指标用） */
  usersWhoUsed(command: string): number {
    const rows = this.#db
      .prepare('SELECT counters_json FROM user_daily')
      .all() as Array<{ counters_json: string }>;
    const users = new Set<string>();
    for (const row of rows) {
      const counters = JSON.parse(row.counters_json) as Record<string, number>;
      if ((counters[command] ?? 0) > 0) users.add(row.counters_json);
    }
    return users.size;
  }

  totalUsers(): number {
    const row = this.#db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM user_daily').get() as {
      n: number;
    };
    return row.n;
  }
}

function toRow(row: Record<string, unknown>): UserDailyRow {
  return {
    userId: String(row.user_id),
    date: String(row.date),
    commands: Number(row.commands),
    counters: JSON.parse(String(row.counters_json ?? '{}')) as Record<string, number>,
    firstSeenAt: Number(row.first_seen_at),
    lastSeenAt: Number(row.last_seen_at),
  };
}
