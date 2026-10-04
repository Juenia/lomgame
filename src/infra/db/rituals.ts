/**
 * 仪式仓储（M2.5）：rituals + ritual_interferences 两张表。
 *
 * 三条约定：
 *   1. **preparing 每角色至多一行活的**（与 pending_menus 同思路）：玩家手里只有一份
 *      「正在攒的配置」，攒新的就覆盖旧的；终态行全部保留（仪式历史）。
 *   2. **running 是可被干扰的窗口**：started_at + interference.windowMs 之内，
 *      别人能用 .干扰 打到它。过了窗口就只剩自己 `.仪式 融合`。
 *   3. **干扰计数按「干扰者 + 时间窗」查**：每日 1 次的上限由命令层用 countInterferencesSince 判，
 *      不写在表约束里 —— 上限是运营数值，改了不该动表结构。
 */
import type { RitualConfig, RitualStatus } from '../../domain/ritual/types.ts';
import { emptyRitualConfig } from '../../domain/ritual/types.ts';
import type { Db } from './sqlite.ts';

export interface RitualRow {
  id: string;
  characterId: string;
  config: RitualConfig;
  status: RitualStatus;
  stage: number;
  startedAt: number | null;
  resolvedAt: number | null;
  result: string | null;
}

function parseConfig(raw: unknown): RitualConfig {
  try {
    const parsed = JSON.parse(String(raw ?? '{}')) as Partial<RitualConfig>;
    return {
      locationId: typeof parsed.locationId === 'string' ? parsed.locationId : null,
      timeOfDay: parsed.timeOfDay ?? null,
      witnesses: Array.isArray(parsed.witnesses) ? parsed.witnesses.map(String) : [],
      interferenceCount: Number(parsed.interferenceCount ?? 0),
    };
  } catch {
    // 一条脏 JSON 不该让玩家彻底做不了仪式：当作「配置是空的」
    return emptyRitualConfig();
  }
}

function toRow(row: Record<string, unknown>): RitualRow {
  return {
    id: String(row.id),
    characterId: String(row.character_id),
    config: parseConfig(row.config_json),
    status: String(row.status ?? 'preparing') as RitualStatus,
    stage: Number(row.stage ?? 0),
    startedAt: row.started_at === null || row.started_at === undefined ? null : Number(row.started_at),
    resolvedAt: row.resolved_at === null || row.resolved_at === undefined ? null : Number(row.resolved_at),
    result: row.result === null || row.result === undefined ? null : String(row.result),
  };
}

export class RitualRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** 该角色手上那份「正在攒的配置」（没有就 null） */
  preparingOf(characterId: string): RitualRow | null {
    const row = this.#db
      .prepare("SELECT * FROM rituals WHERE character_id = ? AND status = 'preparing' ORDER BY rowid DESC LIMIT 1")
      .get(characterId) as Record<string, unknown> | undefined;
    return row ? toRow(row) : null;
  }

  /** 该角色此刻正在举行的仪式（阶段 1/2 已过、等融合） */
  runningOf(characterId: string): RitualRow | null {
    const row = this.#db
      .prepare("SELECT * FROM rituals WHERE character_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1")
      .get(characterId) as Record<string, unknown> | undefined;
    return row ? toRow(row) : null;
  }

  /** 写入/覆盖准备态；返回那一行 */
  savePreparing(characterId: string, config: RitualConfig, now: number): RitualRow {
    const existing = this.preparingOf(characterId);
    if (existing) {
      this.#db
        .prepare('UPDATE rituals SET config_json = ? WHERE id = ?')
        .run(JSON.stringify(config), existing.id);
      return { ...existing, config };
    }
    /**
     * id 里必须带一个**序号**，不能只用 characterId + now。
     *
     * 踩过的坑：同一虚拟时刻（now 不变）连着办两次仪式 —— 第一次中断、第二次重新挑地点 ——
     * 两次算出来的 id 完全一样，第二次 INSERT 直接撞主键抛异常，
     * 命令层的 catch 把它变成「系统繁忙」，玩家看到的是「还没有在准备仪式」。
     * 序号取「该角色已有的仪式行数」，所以它仍然是确定性的（同 seed 同结果）。
     */
    const id = 'ritual:' + characterId + ':' + now + ':' + this.#countOf(characterId);
    this.#db
      .prepare(
        'INSERT INTO rituals (id, character_id, config_json, status, stage, started_at, resolved_at, result) ' +
          'VALUES (?, ?, ?, \'preparing\', 0, NULL, NULL, NULL)',
      )
      .run(id, characterId, JSON.stringify(config));
    return { id, characterId, config, status: 'preparing', stage: 0, startedAt: null, resolvedAt: null, result: null };
  }

  /** 准备态 → running（阶段 1/2 已过，stage 记到 2） */
  markRunning(ritualId: string, stage: number, now: number): void {
    this.#db
      .prepare("UPDATE rituals SET status = 'running', stage = ?, started_at = ? WHERE id = ?")
      .run(stage, now, ritualId);
  }

  /** 结算：写终态与结果摘要 */
  resolve(ritualId: string, status: RitualStatus, result: string, now: number): void {
    this.#db
      .prepare('UPDATE rituals SET status = ?, resolved_at = ?, result = ?, stage = 3 WHERE id = ?')
      .run(status, now, result, ritualId);
  }

  /** 覆盖整份配置（干扰计数、M2.76 的累积惩罚都走它） */
  updateConfig(ritualId: string, config: RitualConfig): void {
    this.#db.prepare('UPDATE rituals SET config_json = ? WHERE id = ?').run(JSON.stringify(config), ritualId);
  }

  /** 更新配置里的「已被干扰次数」（干扰成功时调用） */
  bumpInterference(ritualId: string, config: RitualConfig): void {
    this.updateConfig(ritualId, config);
  }

  /** 清掉准备态（取消 / 用完之后） */
  clearPreparing(characterId: string): void {
    this.#db.prepare("DELETE FROM rituals WHERE character_id = ? AND status = 'preparing'").run(characterId);
  }

  /**
   * 此刻还能被干扰的仪式（别人办着的）。
   * 只要 running 且 started_at 落在窗口内 —— 不看地点，地点由命令层传进来过滤
   * （纯函数不读库，反过来仓储也不该认识玩家的位置）。
   */
  runningInWindow(now: number, windowMs: number): RitualRow[] {
    const rows = this.#db
      .prepare("SELECT * FROM rituals WHERE status = 'running' AND started_at IS NOT NULL AND started_at + ? > ? ORDER BY started_at DESC")
      .all(windowMs, now) as Array<Record<string, unknown>>;
    return rows.map(toRow);
  }

  /** 某仪式收到的干扰记录 */
  interferencesOf(ritualId: string): Array<{ id: string; interfererId: string; success: boolean; createdAt: number }> {
    const rows = this.#db
      .prepare('SELECT * FROM ritual_interferences WHERE ritual_id = ? ORDER BY created_at ASC')
      .all(ritualId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      interfererId: String(row.interferer_id),
      success: Number(row.success) === 1,
      createdAt: Number(row.created_at),
    }));
  }

  /** 干扰者自 since 起干扰过几次（每日上限的依据） */
  countInterferencesSince(interfererId: string, since: number): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM ritual_interferences WHERE interferer_id = ? AND created_at >= ?')
      .get(interfererId, since) as { n: number };
    return Number(row.n);
  }

  /** 记一次干扰；幂等靠 id（同一条指令重放不会记两次） */
  addInterference(input: {
    id: string;
    ritualId: string;
    interfererId: string;
    success: boolean;
    createdAt: number;
  }): boolean {
    const result = this.#db
      .prepare(
        'INSERT OR IGNORE INTO ritual_interferences (id, ritual_id, interferer_id, success, created_at) ' +
          'VALUES (?, ?, ?, ?, ?)',
      )
      .run(input.id, input.ritualId, input.interfererId, input.success ? 1 : 0, input.createdAt);
    return Number(result.changes) > 0;
  }

  /** 该角色一共有多少条仪式记录（id 序号的来源） */
  #countOf(characterId: string): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM rituals WHERE character_id = ?')
      .get(characterId) as { n: number };
    return Number(row.n);
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM rituals').get() as { n: number };
    return Number(row.n);
  }

  /** 按状态计数（覆盖率报告用） */
  countByStatus(): Record<string, number> {
    const rows = this.#db.prepare('SELECT status, COUNT(*) AS n FROM rituals GROUP BY status').all() as Array<{
      status: string;
      n: number;
    }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[String(row.status)] = Number(row.n);
    return out;
  }

  countInterferences(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM ritual_interferences').get() as { n: number };
    return Number(row.n);
  }

  countInterferenceSuccess(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM ritual_interferences WHERE success = 1').get() as { n: number };
    return Number(row.n);
  }
}