/**
 * 委托的存取（M2.85 RPG 化 D）。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { QuestStatus } from '../../domain/world/quest-schema.ts';

export interface TakenQuest {
  characterId: string;
  questId: string;
  npcId: string;
  status: QuestStatus;
  takenAt: number;
  doneAt: number | null;
}

export class QuestRepo {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) { this.#db = db; }

  of(characterId: string): TakenQuest[] {
    const rows = this.#db.prepare('SELECT character_id, quest_id, npc_id, status, taken_at, done_at FROM character_quests WHERE character_id = ?').all(characterId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      characterId: String(r['character_id']), questId: String(r['quest_id']), npcId: String(r['npc_id']),
      status: String(r['status']) as QuestStatus, takenAt: Number(r['taken_at']),
      doneAt: r['done_at'] === null || r['done_at'] === undefined ? null : Number(r['done_at']),
    }));
  }

  /** 进行中的（重复承接同一份委托由主键挡住 —— 幂等） */
  activeOf(characterId: string): TakenQuest[] {
    return this.of(characterId).filter((q) => q.status === 'taken');
  }

  take(characterId: string, questId: string, npcId: string, now: number): boolean {
    const r = this.#db.prepare('INSERT OR IGNORE INTO character_quests (character_id, quest_id, npc_id, status, taken_at, done_at) VALUES (?, ?, ?, ?, ?, NULL)')
      .run(characterId, questId, npcId, 'taken', now);
    return Number(r.changes) > 0;
  }

  complete(characterId: string, questId: string, npcId: string, now: number): boolean {
    const r = this.#db.prepare("UPDATE character_quests SET status = 'done', done_at = ? WHERE character_id = ? AND quest_id = ? AND npc_id = ? AND status = 'taken'")
      .run(now, characterId, questId, npcId);
    return Number(r.changes) > 0;
  }

  /** 他有没有完成过这份委托（重复给同样的委托就没意思了） */
  hasDone(characterId: string, questId: string): boolean {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM character_quests WHERE character_id = ? AND quest_id = ? AND status = 'done'").get(characterId, questId) as { n: number };
    return Number(row.n) > 0;
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM character_quests').get() as { n: number };
    return Number(row.n);
  }
}
