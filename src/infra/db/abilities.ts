import type { Db } from './sqlite.ts';
import { AbilityDefSchema, abilityFlag, mergeAbilityEffects, type AbilityDef, type AbilityEffect } from '../../domain/ability/ability.ts';
import type { PathwayId } from '../../domain/character/types.ts';

/** abilities：能力表，启动时从 src/data/abilities.yaml 播种；判定时查表 */
export class AbilityRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  seed(defs: readonly AbilityDef[]): number {
    const stmt = this.#db.prepare(
      `INSERT INTO abilities (id, pathway, seq, name, effect_json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         pathway = excluded.pathway, seq = excluded.seq,
         name = excluded.name, effect_json = excluded.effect_json`,
    );
    let count = 0;
    for (const def of defs) {
      stmt.run(def.id, def.pathway, def.seq, def.name, JSON.stringify(def.effect));
      count += 1;
    }
    return count;
  }

  get(id: string): AbilityDef | null {
    const row = this.#db.prepare('SELECT * FROM abilities WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toDef(row) : null;
  }

  forPathway(pathway: PathwayId): AbilityDef[] {
    const rows = this.#db
      .prepare('SELECT * FROM abilities WHERE pathway = ? ORDER BY seq DESC')
      .all(pathway) as Array<Record<string, unknown>>;
    return rows.map(toDef);
  }

  /** 已解锁的能力：靠 flags 表里的 ability_<pathway>_<seq> 标记判定 */
  unlockedFor(characterId: string, pathway: PathwayId): AbilityDef[] {
    const flags = new Set(
      (
        this.#db
          .prepare("SELECT flag FROM flags WHERE character_id = ? AND flag LIKE 'ability_%'")
          .all(characterId) as Array<{ flag: string }>
      ).map((row) => row.flag),
    );
    return this.forPathway(pathway).filter((def) => flags.has(abilityFlag(def.pathway, def.seq)));
  }

  /** 已解锁能力的合并效果 */
  effectsOf(characterId: string, pathway: PathwayId): AbilityEffect {
    return mergeAbilityEffects(this.unlockedFor(characterId, pathway));
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM abilities').get() as { n: number };
    return row.n;
  }
}

function toDef(row: Record<string, unknown>): AbilityDef {
  const parsed = AbilityDefSchema.safeParse({
    id: row.id,
    pathway: row.pathway,
    seq: row.seq,
    name: row.name,
    effect: JSON.parse(String(row.effect_json ?? '{}')),
  });
  if (!parsed.success) throw new Error(`能力数据损坏：${String(row.id)}`);
  return parsed.data;
}
