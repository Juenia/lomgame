/**
 * 生态域的运行时状态（M2.58 阶段三）：恐慌度与目击计数。
 *
 * 与 zones.yaml 的分工：
 *   zones.yaml  —— 内容。一个地方的世界脾气（灵性 / 污染 / 承载力…），静态。
 *   zone_state  —— 世界状态。它**会因为发生了什么而改变**。
 *
 * 项目里「内容 vs 状态」一直是分开的（items/locations 是内容，creatures/characters 是状态），
 * 生态域不该是例外 —— 所以这里只有两个字段是真的会动的。
 */
import type { Db } from './sqlite.ts';

export interface ZoneState {
  zoneId: string;
  /** 恐慌度 0—1（目击累积、随小时衰减） */
  fear: number;
  /** 累计目击次数（只增不减） */
  sightingCount: number;
  lastSightingAt: number | null;
}

export class ZoneStateRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** 全部域的状态（域只有 6 个，一次读全比按需查更省事） */
  all(): Map<string, ZoneState> {
    const rows = this.#db.prepare('SELECT * FROM zone_state').all() as Array<Record<string, unknown>>;
    const out = new Map<string, ZoneState>();
    for (const row of rows) {
      const zoneId = String(row['zone_id']);
      out.set(zoneId, {
        zoneId,
        fear: clamp01(Number(row['fear'] ?? 0)),
        sightingCount: Number(row['sighting_count'] ?? 0),
        lastSightingAt: row['last_sighting_at'] === null ? null : Number(row['last_sighting_at']),
      });
    }
    return out;
  }

  /** 一次读全，键是 zoneId，值是恐慌度 —— 生态 tick 只要这一个 */
  fearByZone(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [zoneId, state] of this.all()) out.set(zoneId, state.fear);
    return out;
  }

  /**
   * 记一次目击：恐慌 +delta（clamp 到 1），计数 +1。
   *
   * 用 UPSERT 而不是「先查后写」：生态 tick 是每小时跑的，
   * 两个分片同时目击同一个域时，先查后写会丢一次更新。
   */
  recordSighting(zoneId: string, at: number, fearDelta: number): void {
    this.#db
      .prepare(
        `INSERT INTO zone_state (zone_id, fear, sighting_count, last_sighting_at, updated_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(zone_id) DO UPDATE SET
           fear = MIN(1.0, zone_state.fear + ?),
           sighting_count = zone_state.sighting_count + 1,
           last_sighting_at = ?,
           updated_at = ?`,
      )
      .run(zoneId, clamp01(fearDelta), at, at, clamp01(fearDelta), at, at);
  }

  /** 把恐慌设成某个值（衰减用）。没这一行时会插一行。 */
  setFear(zoneId: string, fear: number, at: number): void {
    this.#db
      .prepare(
        `INSERT INTO zone_state (zone_id, fear, sighting_count, last_sighting_at, updated_at)
         VALUES (?, ?, 0, NULL, ?)
         ON CONFLICT(zone_id) DO UPDATE SET fear = ?, updated_at = ?`,
      )
      .run(zoneId, clamp01(fear), at, clamp01(fear), at);
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM zone_state').get() as { n: number };
    return row.n;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
