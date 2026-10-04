/**
 * 世界侧仓储（M2.2）：world_state / world_ticks / location_weather。
 *
 * 三张表各管一件事：
 *   - world_state：时钟水位线（补跑的依据）+ 世界种子 + 见过的群
 *   - world_ticks：幂等表，(tick_type, tick_key) 主键 —— 重复执行不重复结算
 *   - location_weather：每个地点一行天气（含扩散的 pending）
 */
import { NUMERIC } from '../../config/numeric.ts';
import type { WeatherId, WeatherState } from '../../domain/world/weather.ts';
import { normalizeWeather } from '../../domain/world/weather.ts';
import type { Db } from './sqlite.ts';

export interface WorldStateRow {
  seed: string;
  dayIndex: number;
  moonPhase: number;
  foggy: boolean;
  lastLightAt: number | null;
  lastHeavyAt: number | null;
  groups: string[];
  createdAt: number;
  updatedAt: number;
}

export interface TickRecord {
  tickType: 'light' | 'heavy';
  tickKey: string;
  tickAt: number;
  executedAt: number;
  summary: Record<string, unknown>;
}

export class WorldRepo {
  #db: Db;
  /** 进程内缓存：见过的群（避免每条群消息都写库） */
  #groupCache = new Set<string>();
  /**
   * 建行只做一次。
   * **这是个性能开关，不是洁癖**：`ensure` 是一条 INSERT，落在 WAL 上就是一次写事务；
   * 早先它在每条指令里被调用（路由推进 + worldViewFor 各一次），
   * 把 200×14 的实例测试拖慢了约 6 倍（实测 90ms/动作 → 660ms/动作）。
   */
  #ensured = false;
  /** world_state 的种子（建行时读一次；世界种子在生命周期内不变） */
  #seed: string | null = null;

  constructor(db: Db) {
    this.#db = db;
  }

  /** 建行（幂等）：world_state 只有一行；同一实例只会真的写一次 */
  ensure(now: number, seed = 'world'): void {
    if (this.#ensured) return;
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO world_state (id, seed, day_index, moon_phase, foggy, created_at, updated_at)
         VALUES (1, ?, 0, 1, 0, ?, ?)`,
      )
      .run(seed, now, now);
    this.#ensured = true;
    this.#seed = this.state()?.seed ?? seed;
  }

  state(): WorldStateRow | null {
    const row = this.#db.prepare('SELECT * FROM world_state WHERE id = 1').get() as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      seed: String(row.seed ?? 'world'),
      dayIndex: Number(row.day_index ?? 0),
      moonPhase: Number(row.moon_phase ?? 1),
      foggy: Number(row.foggy ?? 0) === 1,
      lastLightAt: row.last_light_at === null || row.last_light_at === undefined ? null : Number(row.last_light_at),
      lastHeavyAt: row.last_heavy_at === null || row.last_heavy_at === undefined ? null : Number(row.last_heavy_at),
      groups: JSON.parse(String(row.groups_json ?? '[]')) as string[],
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    };
  }

  update(patch: {
    dayIndex?: number;
    moonPhase?: number;
    foggy?: boolean;
    lastLightAt?: number;
    lastHeavyAt?: number;
    seed?: string;
  }, now: number): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.dayIndex !== undefined) { sets.push('day_index = ?'); values.push(patch.dayIndex); }
    if (patch.moonPhase !== undefined) { sets.push('moon_phase = ?'); values.push(patch.moonPhase); }
    if (patch.foggy !== undefined) { sets.push('foggy = ?'); values.push(patch.foggy ? 1 : 0); }
    if (patch.lastLightAt !== undefined) { sets.push('last_light_at = ?'); values.push(patch.lastLightAt); }
    if (patch.lastHeavyAt !== undefined) { sets.push('last_heavy_at = ?'); values.push(patch.lastHeavyAt); }
    if (patch.seed !== undefined) { sets.push('seed = ?'); values.push(patch.seed); }
    sets.push('updated_at = ?');
    values.push(now);
    this.#db.prepare(`UPDATE world_state SET ${sets.join(', ')} WHERE id = 1`).run(...(values as never[]));
  }

  /* ---------------- 幂等表 ---------------- */

  /** 抢占一个 tick；返回 true 表示本次真的执行（重复调用返回 false） */
  claimTick(record: TickRecord): boolean {
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO world_ticks (tick_type, tick_key, tick_at, executed_at, summary_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.tickType,
        record.tickKey,
        record.tickAt,
        record.executedAt,
        JSON.stringify(record.summary ?? {}),
      );
    return Number(result.changes) > 0;
  }

  hasTick(tickType: 'light' | 'heavy', tickKey: string): boolean {
    const row = this.#db
      .prepare('SELECT 1 AS ok FROM world_ticks WHERE tick_type = ? AND tick_key = ?')
      .get(tickType, tickKey);
    return Boolean(row);
  }

  /** 某类 tick 的最后一条记录（补跑的起点） */
  lastTick(tickType: 'light' | 'heavy'): TickRecord | null {
    const row = this.#db
      .prepare(
        'SELECT * FROM world_ticks WHERE tick_type = ? ORDER BY tick_key DESC LIMIT 1',
      )
      .get(tickType) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      tickType: String(row.tick_type) as 'light' | 'heavy',
      tickKey: String(row.tick_key),
      tickAt: Number(row.tick_at),
      executedAt: Number(row.executed_at),
      summary: JSON.parse(String(row.summary_json ?? '{}')) as Record<string, unknown>,
    };
  }

  countTicks(tickType?: 'light' | 'heavy'): number {
    const row = tickType
      ? (this.#db.prepare('SELECT COUNT(*) AS n FROM world_ticks WHERE tick_type = ?').get(tickType) as { n: number })
      : (this.#db.prepare('SELECT COUNT(*) AS n FROM world_ticks').get() as { n: number });
    return row.n;
  }

  /* ---------------- 天气 ---------------- */

  weatherStates(): WeatherState[] {
    const rows = this.#db.prepare('SELECT * FROM location_weather ORDER BY location_id ASC').all() as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      locationId: String(row.location_id),
      weather: normalizeWeather(row.weather === null ? null : String(row.weather)),
      since: Number(row.since),
      until: Number(row.until),
      pendingWeather:
        row.pending_weather === null || row.pending_weather === undefined
          ? null
          : normalizeWeather(String(row.pending_weather)),
      pendingAt: row.pending_at === null || row.pending_at === undefined ? null : Number(row.pending_at),
    }));
  }

  /** 写入（或初始化）一批地点天气 */
  upsertWeather(states: readonly WeatherState[], now: number): number {
    const stmt = this.#db.prepare(
      `INSERT INTO location_weather (location_id, weather, since, until, pending_weather, pending_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(location_id) DO UPDATE SET
         weather = excluded.weather, since = excluded.since, until = excluded.until,
         pending_weather = excluded.pending_weather, pending_at = excluded.pending_at,
         updated_at = excluded.updated_at`,
    );
    let count = 0;
    for (const state of states) {
      stmt.run(
        state.locationId,
        state.weather,
        state.since,
        state.until,
        state.pendingWeather,
        state.pendingAt,
        now,
      );
      count += 1;
    }
    return count;
  }

  /**
   * 读天气。**M2.76：覆盖层优先于 seed 派生。**
   *
   * 顺序写死在这里，而不是散在调用点：所有下游（菜单 / 战斗 / 仪式 / 命令 / 播报）
   * 都经过这一个函数，所以「权柄改写天气」只需要在这一个地方生效。
   *
   * ⚠️ 默认参数用 `Date.now()`：本文件是 **infra 层**（允许时钟，铁律 1 约束的是 domain）。
   * 传 `now` 是为了让用例能测「覆盖到期之后自动失效」。
   */
  weatherOf(locationId: string, now: number = Date.now()): WeatherId {
    const override = this.overrideWeatherOf(locationId, now);
    if (override !== null) return override;
    const row = this.#db
      .prepare('SELECT weather FROM location_weather WHERE location_id = ?')
      .get(locationId) as { weather: string } | undefined;
    return normalizeWeather(row?.weather ?? null);
  }

  /* ---------------- M2.76：世界状态覆盖层 ---------------- */

  /**
   * 该地点当前生效的天气覆盖；没有或已过期返回 null。
   *
   * 全服覆盖（`scope = '*'`）与地点覆盖同时存在时**地点优先** ——
   * 「某座城例外」比「全世界如何」更具体，与 cmd 层的「更具体的指令优先」同一条口径。
   */
  overrideWeatherOf(locationId: string, now: number): WeatherId | null {
    const row = this.#db
      .prepare(
        `SELECT value FROM world_overrides
          WHERE kind = 'weather' AND scope IN (?, '*') AND until > ?
          ORDER BY CASE scope WHEN ? THEN 0 ELSE 1 END, id DESC LIMIT 1`,
      )
      .get(locationId, now, locationId) as { value: string } | undefined;
    return row === undefined ? null : normalizeWeather(row.value);
  }

  /**
   * **通用覆盖读取**（M2.87）。
   *
   * `overrideWeatherOf` 是 `kind='weather'` 的专用读取点；这个函数是其余维度的入口。
   *
   * 为什么要有它：权柄本来只能改天气，因为**只有天气有读取点**。
   * 加了 `effects` 之后，如果每个新维度都要在 repo 上开一个专用方法，
   * 那「加一个改写维度」就变成了「改三处代码」—— 而漏改一处的症状是
   * 「内容写了、世界没变」，不报错。
   *
   * ⚠️ 取**最新**的一条（`ORDER BY id DESC`）：与 `setOverride` 的注释一致 ——
   * 同 kind + scope 的多条并存时，后写的那条赢。
   */
  overrideValueOf(kind: string, scope: string, now: number): string | null {
    const row = this.#db
      .prepare(
        'SELECT value FROM world_overrides WHERE kind = ? AND scope IN (?, ?) AND until > ? ORDER BY id DESC LIMIT 1',
      )
      .get(kind, scope, '*', now) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * **读同一维度的全部生效值**（M2.87）。
   *
   * ## 为什么需要复数版
   *
   * `overrideValueOf` 取最新一条 —— 对「天气」是对的（同一时刻只能有一种天气），
   * 但对**禁令**是错的：两个神明同时出手，两条禁令**都该成立**，
   * 而取最新会让先写的那条**无声失效**。
   *
   * 值是字符串数组（可能含重复），由调用方按语义合并：
   * 禁令取并集、天气取最新、倍率取乘积。
   */
  overrideValuesOf(kind: string, scope: string, now: number): string[] {
    const rows = this.#db
      .prepare(
        'SELECT value FROM world_overrides WHERE kind = ? AND scope IN (?, ?) AND until > ? ORDER BY id DESC',
      )
      .all(kind, scope, '*', now) as Array<{ value: string }>;
    return rows.map((r) => r.value);
  }

  /** 写一条覆盖（权柄或 GM）。同 kind + scope 的多条并存时取最新的一条 */
  setOverride(input: { kind: string; scope: string; value: string; until: number; source: string }, now: number): void {
    this.#db
      .prepare(
        'INSERT INTO world_overrides (kind, scope, value, until, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(input.kind, input.scope, input.value, input.until, input.source, now);
  }

  /** 当前生效的全部覆盖（后台与报告读它） */
  activeOverrides(now: number): Array<{ kind: string; scope: string; value: string; until: number; source: string }> {
    return this.#db
      .prepare('SELECT kind, scope, value, until, source FROM world_overrides WHERE until > ? ORDER BY id ASC')
      .all(now) as Array<{ kind: string; scope: string; value: string; until: number; source: string }>;
  }

  countWeather(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM location_weather').get() as { n: number };
    return row.n;
  }

  /* ---------------- 群（显著天气播报对象） ---------------- */

  /**
   * 登记一个「见过的群」。
   *
   * 返回 **true = 这一次真的写库了**（新群），false = 早就有了或空 id。
   *
   * M2.87：改成返回 boolean，是为了让**调用方**（路由层，那里有 logger）能记一行
   * 「新群登记」。排查「推送少了某个群」时最先要回答的问题是
   * 「那一刻这个群在列表里吗」—— 而在这之前只能翻库看 `groups_json` 的**当前**值，
   * 看不出它是**什么时候**进去的，于是每次都只能靠推断回答。
   *
   * 这一层不自己记日志：`WorldRepo` 没有 logger（它是纯仓库），
   * 为一行日志给它加一个依赖不划算。
   */
  touchGroup(groupId: string, now: number): boolean {
    if (!groupId || this.#groupCache.has(groupId)) return false;
    this.#groupCache.add(groupId);
    const current = this.state()?.groups ?? [];
    if (current.includes(groupId)) return false;
    const next = [...current, groupId].slice(-50);
    this.#db
      .prepare('UPDATE world_state SET groups_json = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(next), now);
    return true;
  }

  /**
   * **把一个群从播报列表里摘掉**（M2.87）。
   *
   * 用于**永久失败**：平台明确回「机器人非群成员」（code 11293）时，
   * 这个群再也不会收到任何消息 —— 留着它只会让每次播报都白试一遍、
   * 并在日志里刷满警告，把真正的问题（临时网络失败）淹掉。
   *
   * ⚠️ 只用于**永久**失败。临时失败（`fetch failed` / 超时）不该走这里 ——
   * 网络抖一下就把群摘掉，那是另一种糟糕。
   *
   * 为什么仍允许它回到列表：`touchGroup` 是「收到过这个群的消息」的判据。
   * 机器人重新被拉进群、群里有人说话，它就自动回来了 —— 不需要任何额外处理。
   */
  forgetGroup(groupId: string, now: number): boolean {
    const current = this.state()?.groups ?? [];
    if (!current.includes(groupId)) return false;
    const next = current.filter((g) => g !== groupId);
    this.#db
      .prepare('UPDATE world_state SET groups_json = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(next), now);
    this.#groupCache.delete(groupId);
    return true;
  }

  groups(): string[] {
    return this.state()?.groups ?? [];
  }

  /** 世界种子（天气序列的确定性来源）；缓存后不再查库 */
  seed(): string {
    if (this.#seed === null) {
      this.#seed = this.state()?.seed ?? 'world';
    }
    return this.#seed;
  }

  /** 天气持续时间（只读，供 CLI / 报表用） */
  weatherDurationMs(): number {
    return NUMERIC.world.weather.durationMs;
  }
}
