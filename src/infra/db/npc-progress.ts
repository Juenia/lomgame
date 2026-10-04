/**
 * NPC 进度与世界演化大事记（M2.85）。
 *
 * 两张表（见 migrations/0035_m2_85_npc_progress.sql）：
 *   npc_progress  「他现在走到哪一档」—— 与世界记载分开存，因为一个是状态、一个是原著
 *   npc_deeds     「谁在什么时候做了什么」—— 晋升 / 登神 / 猎杀 / 化解灾厄
 */
import type { DatabaseSync } from 'node:sqlite';

export interface NpcProgress {
  npcId: string;
  sequence: number;
  since: number;
  ascensions: number;
  godhoodAt: number | null;
  /**
   * M2.85：**他现在站在哪**（locations.yaml 的 id）。
   *
   * null = 还没被安置（老存档 / 刚播种）—— 读取点会当「不在任何地方」处理，
   * 不猜一个位置，因为「他从哪儿来」这种事猜错比留空更糟。
   */
  locationId: string | null;
}

export interface NpcDeed {
  id?: number;
  npcId: string;
  kind: string;
  detail: string;
  /** 功绩分（化解灾厄 / 猎杀强者为正值；失败 0）—— 成神门槛读它 */
  merit?: number;
  at: number;
}

export class NpcProgressRepo {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** 全部进度（npc_id → 进度） */
  all(): NpcProgress[] {
    const rows = this.#db
      .prepare('SELECT npc_id, sequence, since, ascensions, godhood_at, location_id FROM npc_progress ORDER BY sequence ASC, npc_id ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      npcId: String(row['npc_id']),
      sequence: Number(row['sequence']),
      since: Number(row['since']),
      ascensions: Number(row['ascensions']),
      godhoodAt: row['godhood_at'] === null || row['godhood_at'] === undefined ? null : Number(row['godhood_at']),
      locationId: row['location_id'] === null || row['location_id'] === undefined ? null : String(row['location_id']),
    }));
  }

  of(npcId: string): NpcProgress | null {
    const row = this.#db
      .prepare('SELECT npc_id, sequence, since, ascensions, godhood_at, location_id FROM npc_progress WHERE npc_id = ?')
      .get(npcId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      npcId: String(row['npc_id']),
      sequence: Number(row['sequence']),
      since: Number(row['since']),
      ascensions: Number(row['ascensions']),
      godhoodAt: row['godhood_at'] === null || row['godhood_at'] === undefined ? null : Number(row['godhood_at']),
      locationId: row['location_id'] === null || row['location_id'] === undefined ? null : String(row['location_id']),
    };
  }

  /** 播种/覆盖一条进度（世界记载里的初始序列） */
  seed(progress: NpcProgress): void {
    this.#db
      .prepare(
        'INSERT INTO npc_progress (npc_id, sequence, since, ascensions, godhood_at, location_id) VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(npc_id) DO NOTHING',
      )
      .run(progress.npcId, progress.sequence, progress.since, progress.ascensions, progress.godhoodAt, progress.locationId ?? null);
  }

  /** 晋升一档（写回并返回新进度） */
  ascend(npcId: string, now: number): NpcProgress | null {
    const current = this.of(npcId);
    if (current === null || current.sequence <= 0) return null;
    const next = current.sequence - 1;
    this.#db
      .prepare('UPDATE npc_progress SET sequence = ?, since = ?, ascensions = ascensions + 1, godhood_at = ? WHERE npc_id = ?')
      .run(next, now, next === 0 ? now : null, npcId);
    return this.of(npcId);
  }

  /** 走到另一个地点（世界 tick 让 NPC 慢慢地换地方） */
  moveTo(npcId: string, locationId: string): void {
    this.#db.prepare('UPDATE npc_progress SET location_id = ? WHERE npc_id = ?').run(locationId, npcId);
  }

  /** 安置（首次给位置；已经有位置的不动） */
  place(npcId: string, locationId: string): void {
    this.#db.prepare('UPDATE npc_progress SET location_id = ? WHERE npc_id = ? AND location_id IS NULL').run(locationId, npcId);
  }

  /** **这个地点的所有人**（场景渲染用：街上站着谁） */
  atLocation(locationId: string): NpcProgress[] {
    return this.all().filter((p) => p.locationId === locationId);
  }

  /** 谁已经登神（序列 0 且记了 godhood_at） */
  gods(): NpcProgress[] {
    return this.all().filter((p) => p.sequence <= 0 && p.godhoodAt !== null);
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM npc_progress').get() as { n: number };
    return Number(row.n);
  }
}

export class NpcDeedRepo {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  record(deed: NpcDeed): void {
    this.#db
      .prepare('INSERT INTO npc_deeds (npc_id, kind, detail, merit, at) VALUES (?, ?, ?, ?, ?)')
      .run(deed.npcId, deed.kind, deed.detail, deed.merit ?? 0, deed.at);
  }

  /**
   * 这个人的**功绩总分**（用户拍板：成神不能只看时间）。
   * 化解大灾厄、猎杀强者都记正分；失败记 0 —— 于是「路人甲窜一下」拿不到分数。
   */
  meritOf(npcId: string): number {
    const row = this.#db.prepare('SELECT COALESCE(SUM(merit), 0) AS m FROM npc_deeds WHERE npc_id = ?').get(npcId) as { m: number };
    return Number(row.m);
  }

  /** 功绩榜（世界演化的大事记里，谁做过什么最多） */
  topByMerit(limit = 10): Array<{ npcId: string; merit: number; deeds: number }> {
    const rows = this.#db
      // ⚠️ 只列**有正功绩**的人：功绩榜的语义是「做过事的人」，不是「留下过记录的人」——
      // 只受过伤（0 分）的人不该上榜，否则「路人甲」看起来也像立过功。
      .prepare('SELECT npc_id, COALESCE(SUM(merit), 0) AS m, COUNT(*) AS n FROM npc_deeds GROUP BY npc_id HAVING m > 0 ORDER BY m DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ npcId: String(row['npc_id']), merit: Number(row['m']), deeds: Number(row['n']) }));
  }

  /** 最近的 N 条（世界演化的大事记，执行点用） */
  recent(limit = 10): NpcDeed[] {
    const rows = this.#db
      .prepare('SELECT id, npc_id, kind, detail, merit, at FROM npc_deeds ORDER BY at DESC, id DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row['id']),
      npcId: String(row['npc_id']),
      kind: String(row['kind']),
      detail: String(row['detail']),
      merit: Number(row['merit'] ?? 0),
      at: Number(row['at']),
    }));
  }

  ofKind(kind: string, limit = 20): NpcDeed[] {
    const rows = this.#db
      .prepare('SELECT id, npc_id, kind, detail, merit, at FROM npc_deeds WHERE kind = ? ORDER BY at DESC, id DESC LIMIT ?')
      .all(kind, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row['id']),
      npcId: String(row['npc_id']),
      kind: String(row['kind']),
      detail: String(row['detail']),
      merit: Number(row['merit'] ?? 0),
      at: Number(row['at']),
    }));
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM npc_deeds').get() as { n: number };
    return Number(row.n);
  }
}
