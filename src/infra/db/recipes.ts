import type { Db } from './sqlite.ts';
import { RecipeDefSchema, type RecipeDef } from '../../domain/potion/recipe.ts';

/** recipes：魔药配方，启动时从 src/data/recipes.yaml 播种 */
export class RecipeRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  seed(defs: readonly RecipeDef[]): number {
    const stmt = this.#db.prepare(
      `INSERT INTO recipes (id, pathway, seq, main_json, aux_json, ritual, base_success, cor_on_fail, mad_on_fail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         pathway = excluded.pathway, seq = excluded.seq,
         main_json = excluded.main_json, aux_json = excluded.aux_json,
         ritual = excluded.ritual, base_success = excluded.base_success,
         cor_on_fail = excluded.cor_on_fail, mad_on_fail = excluded.mad_on_fail`,
    );
    let count = 0;
    for (const recipe of defs) {
      stmt.run(
        recipe.id,
        recipe.pathway,
        recipe.seq,
        JSON.stringify(recipe.main),
        JSON.stringify(recipe.aux),
        recipe.ritual,
        recipe.base_success,
        recipe.cor_on_fail,
        recipe.mad_on_fail,
      );
      count += 1;
    }
    return count;
  }

  get(id: string): RecipeDef | null {
    const row = this.#db.prepare('SELECT * FROM recipes WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.#toDef(row) : null;
  }

  forPathway(pathway: string): RecipeDef[] {
    const rows = this.#db
      .prepare('SELECT * FROM recipes WHERE pathway = ? ORDER BY seq DESC')
      .all(pathway) as Array<Record<string, unknown>>;
    return rows.map((row) => this.#toDef(row));
  }

  /** 按玩家输入匹配：先按 id，再按「愚者9 / 愚者·序列9」这类写法 */
  find(query: string, pathway?: string): RecipeDef | null {
    const byId = this.get(query);
    if (byId) return byId;
    const candidates = pathway ? this.forPathway(pathway) : this.all();
    const seqMatch = /(\d)/.exec(query);
    if (!seqMatch) return null;
    const seq = Number(seqMatch[1]);
    return candidates.find((recipe) => recipe.seq === seq) ?? null;
  }

  all(): RecipeDef[] {
    const rows = this.#db.prepare('SELECT * FROM recipes ORDER BY pathway ASC, seq DESC').all() as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => this.#toDef(row));
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM recipes').get() as { n: number };
    return row.n;
  }

  #toDef(row: Record<string, unknown>): RecipeDef {
    const parsed = RecipeDefSchema.safeParse({
      id: row.id,
      pathway: row.pathway,
      seq: row.seq,
      main: JSON.parse(String(row.main_json ?? '[]')),
      aux: JSON.parse(String(row.aux_json ?? '[]')),
      ritual: row.ritual ?? '',
      base_success: row.base_success,
      cor_on_fail: row.cor_on_fail,
      mad_on_fail: row.mad_on_fail,
    });
    if (!parsed.success) throw new Error(`配方数据损坏：${String(row.id)}`);
    return parsed.data;
  }
}
