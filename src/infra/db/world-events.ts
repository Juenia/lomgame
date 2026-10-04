/**
 * 世界事件仓储（M2.4）：world_events 一张表。
 *
 * 三条约定：
 *   1. **写入是 INSERT OR IGNORE**：事件 id 由原因拼出来（见 domain/world/events.ts），
 *      补跑重放同一个小时时是同一个 id —— 幂等靠主键，不靠「先查再插」那套竞态写法。
 *   2. **读取只认有效期**：expires_at 过期即视为没有。数字回复能不能命中一条世界事件，
 *      判据就是这一行还在不在窗口里（router/menu.ts）。
 *   3. **只读世界侧**：不碰 characters / inventory 任何一张角色表。
 */
import type { WorldEvent, WorldEventOption, WorldEventType, WorldEventVisibility } from '../../domain/world/events.ts';
import type { Db } from './sqlite.ts';

const KNOWN_TYPES = new Set<string>(['environment', 'discovery', 'faction', 'power', 'calamity', 'rumor']);
const KNOWN_VISIBILITY = new Set<string>(['public', 'anonymous', 'faction']);

function parseOptions(raw: unknown): WorldEventOption[] {
  if (raw === null || raw === undefined) return [];
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .map((entry) => ({
        key: String(entry.key ?? ''),
        label: String(entry.label ?? ''),
        command: String(entry.command ?? ''),
      }))
      .filter((option) => option.key !== '' && option.command !== '');
  } catch {
    // 一条脏 JSON 不该把播报链路打挂：当作「这条事件没有选项」
    return [];
  }
}

function toEvent(row: Record<string, unknown>): WorldEvent {
  const type = String(row.type ?? 'rumor');
  const visibility = String(row.visibility ?? 'public');
  const event: WorldEvent = {
    id: String(row.id),
    type: (KNOWN_TYPES.has(type) ? type : 'rumor') as WorldEventType,
    text: String(row.text ?? ''),
    visibility: (KNOWN_VISIBILITY.has(visibility) ? visibility : 'public') as WorldEventVisibility,
    createdAt: Number(row.created_at ?? 0),
    ...(row.faction_id === null || row.faction_id === undefined
      ? {}
      : { factionId: String(row.faction_id) }),
    ...(row.expires_at === null || row.expires_at === undefined
      ? {}
      : { expiresAt: Number(row.expires_at) }),
    options: parseOptions(row.options_json),
  };
  return event;
}

export class WorldEventRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** 落一条事件；已存在（同 id）返回 false —— 补跑/重放看到的就是这个 false */
  insert(event: WorldEvent): boolean {
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO world_events
           (id, type, text, visibility, faction_id, options_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.type,
        event.text,
        event.visibility,
        event.factionId ?? null,
        JSON.stringify(event.options ?? []),
        event.createdAt,
        event.expiresAt ?? null,
      );
    return Number(result.changes) > 0;
  }

  /** 批量落库（世界 tick 一次可能生成多条）：返回真正新写入的条数 */
  insertMany(events: readonly WorldEvent[]): number {
    let inserted = 0;
    for (const event of events) if (this.insert(event)) inserted += 1;
    return inserted;
  }

  /** 全部事件，按 (created_at, id) 升序 —— 分片一致性比对要的就是这个稳定顺序 */
  all(): WorldEvent[] {
    const rows = this.#db
      .prepare('SELECT * FROM world_events ORDER BY created_at ASC, id ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(toEvent);
  }

  /** 最新的一份（播报与 /admin/menu 用） */
  latest(limit = 20): WorldEvent[] {
    const rows = this.#db
      .prepare('SELECT * FROM world_events ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(toEvent);
  }

  /**
   * 此刻仍然有效的事件（新→旧）。
   * 没写 expires_at 的行视为永久有效（本轮生成的事件都写 expires_at）。
   *
   * ⚠️ **`power`（势力动向）不算在内**。
   *
   * 它是一条**通知**，不是一件需要玩家回应的事：势力动向是「对某件事的响应」，
   * 玩家该回应的是触发它的那条消息。而 live 是数字回复的目标池（见 latestLive），
   * 把通知放进去的代价是一处真实踩到的坑 ——
   * 势力动向在原事件之后几毫秒落地，latestLive 于是取到它，
   * 玩家打「1」命中的是「教会加派了巡逻」，而不是那条他真正该回应的消息
   * （test/m2-4.test.ts 抓住了它）。
   *
   * 这是**读者侧**的过滤，不是写入侧的：势力动向照常落库、照常播报、照常能被查。
   * 只是它不进「能回数字」的那个池子。
   */
  live(now: number, limit = 20): WorldEvent[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM world_events
         WHERE (expires_at IS NULL OR expires_at > ?) AND type <> 'power'
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(now, limit) as Array<Record<string, unknown>>;
    return rows.map(toEvent);
  }

  /** 最新的一条仍然有效的事件（数字回复找不到个人菜单时的兜底目标） */
  latestLive(now: number): WorldEvent | null {
    return this.live(now, 1)[0] ?? null;
  }

  /** 某时刻之后生成的事件条数（频率控制与报表用） */
  countSince(since: number): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM world_events WHERE created_at >= ?')
      .get(since) as { n: number };
    return row.n;
  }

  /** 按类型计数（覆盖率报告用） */
  countByType(): Record<string, number> {
    const rows = this.#db
      .prepare('SELECT type, COUNT(*) AS n FROM world_events GROUP BY type ORDER BY type ASC')
      .all() as Array<{ type: string; n: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[String(row.type)] = Number(row.n);
    return out;
  }

  /** 按可见性计数（群播报口径核对用） */
  countByVisibility(): Record<string, number> {
    const rows = this.#db
      .prepare('SELECT visibility, COUNT(*) AS n FROM world_events GROUP BY visibility ORDER BY visibility ASC')
      .all() as Array<{ visibility: string; n: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[String(row.visibility)] = Number(row.n);
    return out;
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM world_events').get() as { n: number };
    return row.n;
  }

  /** 清空（测试与「安静一轮」用） */
  clear(): void {
    this.#db.prepare('DELETE FROM world_events').run();
  }
}
