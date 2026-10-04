/**
 * NPC 与玩家的关系 + NPC 的阴谋（M2.85 RPG 化）。
 *
 * 两张表（见 migrations/0041_m2_85_npc_relations.sql）：
 *   npc_relations  **态度**（-100 死敌 … +100 挚友）
 *   npc_schemes    **意图**（lurk 布局 → omen 端倪 → strike 发动）
 *
 * 分工的理由：态度是**别人怎么看你**，意图是**他打算做什么** —— 前者持续存在，
 * 后者有始有终（会被察觉、会被破解、会发动）。混在一张表里会让「他现在到底在干什么」
 * 变成一个查不清的问题。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { SchemeKind, SchemeStage } from '../../domain/world/npc-scheme.ts';

export interface NpcRelation {
  npcId: string;
  characterId: string;
  affinity: number;
  at: number;
}

export interface NpcScheme {
  id: string;
  npcId: string;
  targetId: string;
  kind: SchemeKind;
  stage: SchemeStage;
  startedAt: number;
  dueAt: number;
  revealedAt: number | null;
  foiledAt: number | null;
}

const REL_COLS = 'npc_id, character_id, affinity, at';
const SCH_COLS = 'id, npc_id, target_id, kind, stage, started_at, due_at, revealed_at, foiled_at';

function toRelation(row: Record<string, unknown>): NpcRelation {
  return {
    npcId: String(row['npc_id']),
    characterId: String(row['character_id']),
    affinity: Number(row['affinity']),
    at: Number(row['at']),
  };
}

function toScheme(row: Record<string, unknown>): NpcScheme {
  return {
    id: String(row['id']),
    npcId: String(row['npc_id']),
    targetId: String(row['target_id']),
    kind: String(row['kind']) as SchemeKind,
    stage: String(row['stage']) as SchemeStage,
    startedAt: Number(row['started_at']),
    dueAt: Number(row['due_at']),
    revealedAt: row['revealed_at'] === null || row['revealed_at'] === undefined ? null : Number(row['revealed_at']),
    foiledAt: row['foiled_at'] === null || row['foiled_at'] === undefined ? null : Number(row['foiled_at']),
  };
}

export class NpcRelationRepo {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) { this.#db = db; }

  of(npcId: string, characterId: string): NpcRelation | null {
    const row = this.#db.prepare(`SELECT ${REL_COLS} FROM npc_relations WHERE npc_id = ? AND character_id = ?`).get(npcId, characterId) as Record<string, unknown> | undefined;
    return row === undefined ? null : toRelation(row);
  }

  /** 加减好感（没有记录就以 0 起步）—— 返回**结算后**的关系 */
  bump(npcId: string, characterId: string, delta: number, now: number): NpcRelation {
    const current = this.of(npcId, characterId)?.affinity ?? 0;
    const next = Math.max(-100, Math.min(100, Math.round(current + delta)));
    this.#db.prepare(`INSERT INTO npc_relations (${REL_COLS}) VALUES (?, ?, ?, ?) ` +
      'ON CONFLICT(npc_id, character_id) DO UPDATE SET affinity = excluded.affinity, at = excluded.at')
      .run(npcId, characterId, next, now);
    return { npcId, characterId, affinity: next, at: now };
  }

  /** 这个玩家与所有 NPC 的关系 */
  ofCharacter(characterId: string): NpcRelation[] {
    const rows = this.#db.prepare(`SELECT ${REL_COLS} FROM npc_relations WHERE character_id = ?`).all(characterId) as Array<Record<string, unknown>>;
    return rows.map(toRelation);
  }

  all(): NpcRelation[] {
    const rows = this.#db.prepare(`SELECT ${REL_COLS} FROM npc_relations`).all() as Array<Record<string, unknown>>;
    return rows.map(toRelation);
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM npc_relations').get() as { n: number };
    return Number(row.n);
  }
}

export class NpcSchemeRepo {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) { this.#db = db; }

  create(scheme: NpcScheme): boolean {
    const r = this.#db.prepare(`INSERT OR IGNORE INTO npc_schemes (${SCH_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(scheme.id, scheme.npcId, scheme.targetId, scheme.kind, scheme.stage, scheme.startedAt, scheme.dueAt, scheme.revealedAt, scheme.foiledAt);
    return Number(r.changes) > 0;
  }

  byId(id: string): NpcScheme | null {
    const row = this.#db.prepare(`SELECT ${SCH_COLS} FROM npc_schemes WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row === undefined ? null : toScheme(row);
  }

  /** 针对某个人的、**还没结束**的阴谋 */
  activeOf(targetId: string): NpcScheme[] {
    const rows = this.#db.prepare(`SELECT ${SCH_COLS} FROM npc_schemes WHERE target_id = ? AND foiled_at IS NULL AND stage != 'strike'`).all(targetId) as Array<Record<string, unknown>>;
    return rows.map(toScheme);
  }

  all(): NpcScheme[] {
    const rows = this.#db.prepare(`SELECT ${SCH_COLS} FROM npc_schemes`).all() as Array<Record<string, unknown>>;
    return rows.map(toScheme);
  }

  setStage(id: string, stage: SchemeStage, now: number): void {
    this.#db.prepare('UPDATE npc_schemes SET stage = ? WHERE id = ?').run(stage, id);
    void now;
  }

  /** 玩家察觉到了（omen 阶段的读取点） */
  reveal(id: string, now: number): void {
    this.#db.prepare('UPDATE npc_schemes SET revealed_at = ? WHERE id = ? AND revealed_at IS NULL').run(now, id);
  }

  /** 被破解（玩家在端倪阶段反制成功） */
  foil(id: string, now: number): void {
    this.#db.prepare('UPDATE npc_schemes SET foiled_at = ? WHERE id = ?').run(now, id);
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM npc_schemes').get() as { n: number };
    return Number(row.n);
  }
}
