/**
 * 入途径的运行时状态（M2.7.6；M2.85 修订）：配方线索（recipe_clues）。
 *
 * M2.85：势力引导的运行时表（pathway_offers）随引导玩法一并删除
 * （迁移 0034 DROP），「走上途径」只剩探索翻线索这一条路。
 * 这张表是**运行时状态**，不是内容：内容（线索正文、途径落点权重）
 * 在 domain/initiation/clue.ts 与 src/data/factions.yaml。
 * 这里只负责「谁手上有什么、用掉没有」。
 */
import type { Db } from './sqlite.ts';
import type { RecipeClue } from '../../domain/initiation/types.ts';
import type { PathwayId } from '../../domain/character/types.ts';

interface ClueRow {
  id: string;
  character_id: string;
  pathway: string;
  clue_text: string;
  found_at: number;
  used_at: number | null;
}

function toClue(row: ClueRow): RecipeClue {
  return {
    id: row.id,
    characterId: row.character_id,
    pathway: row.pathway as PathwayId,
    clueText: row.clue_text,
    foundAt: row.found_at,
    usedAt: row.used_at,
  };
}

export class RecipeClueRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  insert(clue: RecipeClue): void {
    this.#db
      .prepare(
        `INSERT INTO recipe_clues (id, character_id, pathway, clue_text, found_at, used_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(clue.id, clue.characterId, clue.pathway, clue.clueText, clue.foundAt, clue.usedAt);
  }

  /** 还没用掉的线索（.线索 与调制校验都读它） */
  unusedOf(characterId: string): RecipeClue[] {
    const rows = this.#db
      .prepare(
        'SELECT * FROM recipe_clues WHERE character_id = ? AND used_at IS NULL ORDER BY found_at ASC',
      )
      .all(characterId) as unknown as ClueRow[];
    return rows.map(toClue);
  }

  /** 是否持有某条途径的未用线索（决定 .魔药 能不能调这一瓶） */
  hasUnused(characterId: string, pathway: PathwayId): boolean {
    return this.byPathway(characterId, pathway) !== null;
  }

  byPathway(characterId: string, pathway: PathwayId): RecipeClue | null {
    const row = this.#db
      .prepare(
        'SELECT * FROM recipe_clues WHERE character_id = ? AND pathway = ? AND used_at IS NULL ORDER BY found_at ASC LIMIT 1',
      )
      .get(characterId, pathway) as ClueRow | undefined;
    return row ? toClue(row) : null;
  }

  markUsed(id: string, now: number): void {
    this.#db.prepare('UPDATE recipe_clues SET used_at = ? WHERE id = ?').run(now, id);
  }

  all(): RecipeClue[] {
    const rows = this.#db
      .prepare('SELECT * FROM recipe_clues ORDER BY found_at ASC')
      .all() as unknown as ClueRow[];
    return rows.map(toClue);
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM recipe_clues').get() as { n: number };
    return row.n;
  }
}
