/**
 * 神位归属（M2.85 世界演化）—— 「神明并非是不可战胜的」的落点。
 *
 * `deity_id` 是主键：**一个神位只有一个主人**。玩家击杀序列 0 之后在这里登记，
 * 世界从此按「这个位置归谁」回答 `.图鉴 途径` 与战报。
 */
import type { DatabaseSync } from 'node:sqlite';

export interface GodhoodClaim {
  deityId: string;
  characterId: string;
  at: number;
}

export class GodhoodRepo {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** 夺位（同一神位重复夺位时**覆盖**：新的赢了就是新的主） */
  claim(input: GodhoodClaim): void {
    this.#db
      .prepare(
        'INSERT INTO godhood_claims (deity_id, character_id, at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(deity_id) DO UPDATE SET character_id = excluded.character_id, at = excluded.at',
      )
      .run(input.deityId, input.characterId, input.at);
  }

  /** 这个神位现在归谁（没人夺过则 null —— 即「还在原主手里」） */
  holderOf(deityId: string): GodhoodClaim | null {
    const row = this.#db
      .prepare('SELECT deity_id, character_id, at FROM godhood_claims WHERE deity_id = ?')
      .get(deityId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return { deityId: String(row['deity_id']), characterId: String(row['character_id']), at: Number(row['at']) };
  }

  /** 这个人占了哪些神位 */
  ofCharacter(characterId: string): GodhoodClaim[] {
    const rows = this.#db
      .prepare('SELECT deity_id, character_id, at FROM godhood_claims WHERE character_id = ? ORDER BY at DESC')
      .all(characterId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ deityId: String(row['deity_id']), characterId: String(row['character_id']), at: Number(row['at']) }));
  }

  all(): GodhoodClaim[] {
    const rows = this.#db
      .prepare('SELECT deity_id, character_id, at FROM godhood_claims ORDER BY at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({ deityId: String(row['deity_id']), characterId: String(row['character_id']), at: Number(row['at']) }));
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM godhood_claims').get() as { n: number };
    return Number(row.n);
  }
}
