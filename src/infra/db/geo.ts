import type { Db } from './sqlite.ts';
import { CitySchema, RegionSchema, RouteSchema, type City, type Region, type Route } from '../../domain/geo/types.ts';

/**
 * 地理仓储（M2.7）：区域 / 城市 / 航线 / 行程。
 *
 * 与 locations 仓储同一套路：三张内容表是 YAML 的投影（seed 时 upsert），
 * travels 是运行时状态（只增不改，除了 status 与 events_json）。
 *
 * 为什么不把「出生城市派生」也放进来：那件事是纯函数（domain/geo/birth.ts），
 * 它必须能被虚拟玩家侧直接调用（同一份 seed 要算出同一个城市），
 * 一旦它依赖数据库，测试侧就得先起库 —— 那是把可复现性押在 IO 上。
 */

export class RegionRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  seed(defs: readonly Region[]): number {
    const stmt = this.#db.prepare(
      `INSERT INTO regions (id, name, type, pathways_json, cities_json, danger)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, type = excluded.type, pathways_json = excluded.pathways_json,
         cities_json = excluded.cities_json, danger = excluded.danger`,
    );
    let count = 0;
    for (const region of defs) {
      stmt.run(
        region.id,
        region.name,
        region.type,
        JSON.stringify(region.pathways),
        JSON.stringify(region.cities),
        region.danger,
      );
      count += 1;
    }
    return count;
  }

  all(): Region[] {
    const rows = this.#db.prepare('SELECT * FROM regions ORDER BY id ASC').all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.#toDef(row));
  }

  get(id: string): Region | null {
    const row = this.#db.prepare('SELECT * FROM regions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.#toDef(row) : null;
  }

  count(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM regions').get() as { n: number }).n;
  }

  #toDef(row: Record<string, unknown>): Region {
    const parsed = RegionSchema.safeParse({
      id: row.id,
      name: row.name,
      type: row.type,
      pathways: JSON.parse(String(row.pathways_json ?? '[]')),
      cities: JSON.parse(String(row.cities_json ?? '[]')),
      danger: row.danger,
    });
    if (!parsed.success) throw new Error(`区域数据损坏：${String(row.id)}`);
    return parsed.data;
  }
}

export class CityRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  seed(defs: readonly City[]): number {
    const stmt = this.#db.prepare(
      `INSERT INTO cities (id, name, region_id, locations_json, factions_json, is_port, min_seq,
                           pathways_json, planned_json, birth_weight, center_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, region_id = excluded.region_id, locations_json = excluded.locations_json,
         factions_json = excluded.factions_json, is_port = excluded.is_port, min_seq = excluded.min_seq,
         pathways_json = excluded.pathways_json, planned_json = excluded.planned_json,
         birth_weight = excluded.birth_weight, center_id = excluded.center_id`,
    );
    let count = 0;
    for (const city of defs) {
      stmt.run(
        city.id,
        city.name,
        city.region_id,
        JSON.stringify(city.locations),
        JSON.stringify(city.factions),
        city.is_port ? 1 : 0,
        city.min_seq,
        JSON.stringify(city.pathways),
        JSON.stringify(city.planned_pathways),
        city.birth_weight,
        city.center,
      );
      count += 1;
    }
    return count;
  }

  all(): City[] {
    const rows = this.#db.prepare('SELECT * FROM cities ORDER BY id ASC').all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.#toDef(row));
  }

  get(id: string): City | null {
    const row = this.#db.prepare('SELECT * FROM cities WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.#toDef(row) : null;
  }

  /** 中文名或 id 都能查到（.移动 贝克兰德 / .移动 backlund 都认） */
  findByNameOrId(text: string): City | null {
    const byId = this.get(text);
    if (byId) return byId;
    const row = this.#db.prepare('SELECT * FROM cities WHERE name = ?').get(text) as Record<string, unknown> | undefined;
    return row ? this.#toDef(row) : null;
  }

  count(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM cities').get() as { n: number }).n;
  }

  #toDef(row: Record<string, unknown>): City {
    const parsed = CitySchema.safeParse({
      id: row.id,
      name: row.name,
      region_id: row.region_id,
      locations: JSON.parse(String(row.locations_json ?? '[]')),
      factions: JSON.parse(String(row.factions_json ?? '[]')),
      is_port: Number(row.is_port ?? 0) === 1,
      min_seq: row.min_seq,
      pathways: JSON.parse(String(row.pathways_json ?? '[]')),
      planned_pathways: JSON.parse(String(row.planned_json ?? '[]')),
      birth_weight: row.birth_weight,
      center: row.center_id,
    });
    if (!parsed.success) throw new Error(`城市数据损坏：${String(row.id)}`);
    return parsed.data;
  }
}

export class RouteRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  seed(defs: readonly Route[]): number {
    const stmt = this.#db.prepare(
      `INSERT INTO routes (id, from_city, to_city, type, duration_hours, cost_penny, danger, events_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         from_city = excluded.from_city, to_city = excluded.to_city, type = excluded.type,
         duration_hours = excluded.duration_hours, cost_penny = excluded.cost_penny,
         danger = excluded.danger, events_json = excluded.events_json`,
    );
    let count = 0;
    for (const route of defs) {
      stmt.run(
        route.id,
        route.from,
        route.to,
        route.type,
        route.duration_hours,
        route.cost_penny,
        route.danger,
        JSON.stringify(route.events),
      );
      count += 1;
    }
    return count;
  }

  all(): Route[] {
    const rows = this.#db.prepare('SELECT * FROM routes ORDER BY id ASC').all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.#toDef(row));
  }

  get(id: string): Route | null {
    const row = this.#db.prepare('SELECT * FROM routes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.#toDef(row) : null;
  }

  /** 从某座城市出发的所有路线（.移动 无参时的目的地菜单） */
  from(cityId: string): Route[] {
    const rows = this.#db
      .prepare('SELECT * FROM routes WHERE from_city = ? ORDER BY duration_hours ASC, id ASC')
      .all(cityId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.#toDef(row));
  }

  find(from: string, to: string): Route | null {
    const row = this.#db
      .prepare('SELECT * FROM routes WHERE from_city = ? AND to_city = ? LIMIT 1')
      .get(from, to) as Record<string, unknown> | undefined;
    return row ? this.#toDef(row) : null;
  }

  count(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM routes').get() as { n: number }).n;
  }

  #toDef(row: Record<string, unknown>): Route {
    const parsed = RouteSchema.safeParse({
      id: row.id,
      from: row.from_city,
      to: row.to_city,
      type: row.type,
      duration_hours: row.duration_hours,
      cost_penny: row.cost_penny,
      danger: row.danger,
      events: JSON.parse(String(row.events_json ?? '[]')),
    });
    if (!parsed.success) throw new Error(`路线数据损坏：${String(row.id)}`);
    return parsed.data;
  }
}

export type TravelStatus = 'traveling' | 'arrived' | 'aborted';

/** 路途中已经触发（或即将触发）的一个事件 */
export interface TravelEventRecord {
  /** 事件 id（storm / bandit / ghost_ship …，见 domain/geo/events.ts） */
  id: string;
  /** 触发的游戏时刻（毫秒） */
  at: number;
  /** 玩家是否已经做过选择 */
  resolved: boolean;
  /** 玩家选了什么：fight / flee / observe / interact */
  choice?: string;
  /** 结算结果的一句话（报告与复现用） */
  outcome?: string;
}

export interface TravelRecord {
  id: string;
  characterId: string;
  routeId: string;
  startedAt: number;
  arrivesAt: number;
  status: TravelStatus;
  events: TravelEventRecord[];
}

export class TravelRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  create(record: TravelRecord): void {
    this.#db
      .prepare(
        `INSERT INTO travels (id, character_id, route_id, started_at, arrives_at, status, events_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.characterId,
        record.routeId,
        record.startedAt,
        record.arrivesAt,
        record.status,
        JSON.stringify(record.events),
      );
  }

  update(record: TravelRecord): void {
    this.#db
      .prepare('UPDATE travels SET status = ?, events_json = ? WHERE id = ?')
      .run(record.status, JSON.stringify(record.events), record.id);
  }

  get(id: string): TravelRecord | null {
    const row = this.#db.prepare('SELECT * FROM travels WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.#toRecord(row) : null;
  }

  /**
   * 此刻在路上的那一条（按定义最多一条：同一个角色不能同时走两条路）。
   * 取最新的一条而不是 LIMIT 1 —— 老数据里可能留下已到达但没清干净的行。
   */
  activeOf(characterId: string): TravelRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM travels WHERE character_id = ? AND status = 'traveling' ORDER BY started_at DESC LIMIT 1")
      .get(characterId) as Record<string, unknown> | undefined;
    return row ? this.#toRecord(row) : null;
  }

  /** 全部在路上的行程（世界 tick 与报告用） */
  allActive(): TravelRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM travels WHERE status = 'traveling' ORDER BY started_at ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.#toRecord(row));
  }

  /** 已到达的行程（报告里的「移动次数」按它统计，不把失败/中断算进去） */
  arrivedCount(): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM travels WHERE status = 'arrived'").get() as { n: number }).n;
  }

  count(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM travels').get() as { n: number }).n;
  }

  #toRecord(row: Record<string, unknown>): TravelRecord {
    let events: TravelEventRecord[] = [];
    try {
      events = JSON.parse(String(row.events_json ?? '[]')) as TravelEventRecord[];
    } catch {
      events = [];
    }
    return {
      id: String(row.id),
      characterId: String(row.character_id),
      routeId: String(row.route_id),
      startedAt: Number(row.started_at),
      arrivesAt: Number(row.arrives_at),
      status: String(row.status) as TravelStatus,
      events,
    };
  }
}
