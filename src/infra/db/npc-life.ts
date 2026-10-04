/**
 * NPC 的生死与堕落（M2.164）—— 表结构见 migrations/0045_m2_164_npc_life.sql。
 *
 * ## 一条口径：**没有记录 = 活着**
 *
 * 老存档、刚播种的居民、原作里的 41 位强者，都不在这张表里 —— 而他们当然活着。
 * 所以 `isAlive` 的默认答案是 true，只有**明确死过**的人才是死的。
 * 反过来写（默认死）会让整张名册在某次迁移之后集体消失，而且不报错。
 */
import type { DatabaseSync } from 'node:sqlite';

export interface NpcLife {
  npcId: string;
  alive: boolean;
  diedAt: number | null;
  deathKind: string;
  deathNote: string;
  killer: string;
  revivedAt: number | null;
  revivals: number;
  corrupted: number;
  tempter: string;
  /** 回来的形态（ReturnForm）；空 = 没回来过 */
  returnedAs: string;
  /** 他还算不算「人」（thrall = 不算；变成怪物的也不算） */
  human: boolean;
  /** 他变成的那只生物（creatures.id）；空 = 还是人形 */
  beastId: string;
}

export interface DeathInput {
  npcId: string;
  kind: string;
  note: string;
  killer: string;
  at: number;
}

function rowOf(row: Record<string, unknown>): NpcLife {
  return {
    npcId: String(row['npc_id']),
    alive: Number(row['alive']) === 1,
    diedAt: row['died_at'] === null || row['died_at'] === undefined ? null : Number(row['died_at']),
    deathKind: String(row['death_kind'] ?? ''),
    deathNote: String(row['death_note'] ?? ''),
    killer: String(row['killer'] ?? ''),
    revivedAt: row['revived_at'] === null || row['revived_at'] === undefined ? null : Number(row['revived_at']),
    revivals: Number(row['revivals'] ?? 0),
    corrupted: Number(row['corrupted'] ?? 0),
    tempter: String(row['tempter'] ?? ''),
    returnedAs: String(row['returned_as'] ?? ''),
    human: Number(row['human'] ?? 1) === 1,
    beastId: String(row['beast_id'] ?? ''),
  };
}

const COLS = 'npc_id, alive, died_at, death_kind, death_note, killer, revived_at, revivals, corrupted, tempter, returned_as, human, beast_id';

export class NpcLifeRepo {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  all(): NpcLife[] {
    const rows = this.#db
      .prepare('SELECT ' + COLS + ' FROM npc_life ORDER BY npc_id ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowOf);
  }

  of(npcId: string): NpcLife | null {
    const row = this.#db
      .prepare('SELECT ' + COLS + ' FROM npc_life WHERE npc_id = ?')
      .get(npcId) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowOf(row);
  }

  /** 没有记录 = 活着（见文件头） */
  isAlive(npcId: string): boolean {
    return this.of(npcId)?.alive !== false;
  }

  /** 死者的 id（世界 tick 用它把死人从晋升 / 移动 / 布局里剔掉） */
  deadIds(): Set<string> {
    const rows = this.#db.prepare('SELECT npc_id FROM npc_life WHERE alive = 0').all() as Array<Record<string, unknown>>;
    return new Set(rows.map((r) => String(r['npc_id'])));
  }

  /** 死者名单（最近死的在前） */
  dead(): NpcLife[] {
    return this.all().filter((l) => !l.alive).sort((a, b) => (b.diedAt ?? 0) - (a.diedAt ?? 0));
  }

  /** 被碰过的人（堕落度 > 0，且还活着）—— 玩家能在世界动态里读到的那一层 */
  corrupted(): NpcLife[] {
    return this.all().filter((l) => l.alive && l.corrupted > 0);
  }

  /**
   * **杀死一个人**。
   *
   * 已经死过的不再覆盖（第一次死亡才算数 —— 否则「他死了」这句会被后来的天灾刷掉，
   * 而玩家记住的永远该是第一次）。复活过的人再死一次**会**覆盖：那是一次新的死。
   */
  kill(input: DeathInput): NpcLife {
    const current = this.of(input.npcId);
    if (current !== null && !current.alive) return current;
    this.#db
      .prepare(
        'INSERT INTO npc_life (npc_id, alive, died_at, death_kind, death_note, killer) VALUES (?, 0, ?, ?, ?, ?) ' +
          'ON CONFLICT(npc_id) DO UPDATE SET alive = 0, died_at = excluded.died_at, death_kind = excluded.death_kind, ' +
          'death_note = excluded.death_note, killer = excluded.killer',
      )
      .run(input.npcId, input.at, input.kind, input.note, input.killer);
    return this.of(input.npcId)!;
  }

  /**
   * **神明让他回来了**（唯一一条复活的路）。revivals 累加：他已经被找回来过几次。
   *
   * ⚠️ `form` 不可省（M2.164 用户追问「回来的是不是他」）：
   * 复活**不是读档** —— 回来的东西未必完整、未必是人。形态由 npc-life.ts 的
   * `returnFormOf` 决定，而它决定三件事：关系怎么变、性情算不算黑暗、还算不算人。
   */
  revive(npcId: string, at: number, form: string, human: boolean): NpcLife {
    this.#db
      .prepare(
        'INSERT INTO npc_life (npc_id, alive, revived_at, revivals, returned_as, human) VALUES (?, 1, ?, 1, ?, ?) ' +
          'ON CONFLICT(npc_id) DO UPDATE SET alive = 1, revived_at = excluded.revived_at, ' +
          'revivals = revivals + 1, returned_as = excluded.returned_as, human = excluded.human',
      )
      .run(npcId, at, form, human ? 1 : 0);
    return this.of(npcId)!;
  }

  /**
   * **他变成了怪物**（M2.167）—— 不写进「死」，因为他没死。
   *
   * 死了的人：alive = 0（不可逆，只有神明能开门）；
   * 变成怪物的人：alive = 1、human = 0、beast_id 指向 creatures 里的那一只。
   * 两者在读取端的表现完全不同（死者不进遭遇池，怪物进）。
   */
  becomeBeast(npcId: string, beastId: string): NpcLife {
    this.#db
      .prepare(
        'INSERT INTO npc_life (npc_id, alive, human, beast_id, corrupted) VALUES (?, 1, 0, ?, 100) ' +
          'ON CONFLICT(npc_id) DO UPDATE SET alive = 1, human = 0, beast_id = excluded.beast_id',
      )
      .run(npcId, beastId);
    return this.of(npcId)!;
  }

  /** 他变成的那只生物（还没变就是 null） */
  beastIdOf(npcId: string): string | null {
    const value = this.of(npcId)?.beastId ?? '';
    return value === '' ? null : value;
  }

  /** 已经变成怪物的那些人（世界 tick 与 .世界 堕落 都要读） */
  beasts(): NpcLife[] {
    return this.all().filter((l) => l.beastId !== '');
  }

  /** 他回来之后还算不算人（没有记录 = 还不算死过，当然是） */
  isHuman(npcId: string): boolean {
    return this.of(npcId)?.human !== false;
  }

  /** 「回来的不是人」的那些（.世界 死者 与神明手段都要读） */
  thralls(): NpcLife[] {
    return this.all().filter((l) => l.alive && !l.human);
  }

  /** 堕落度（0—100）。`tempter` 是那位存在的 pathway —— 用来写「他背后是谁」 */
  corrupt(npcId: string, amount: number, tempter: string): NpcLife {
    const current = this.of(npcId);
    const next = Math.max(0, Math.min(100, (current?.corrupted ?? 0) + amount));
    this.#db
      .prepare(
        'INSERT INTO npc_life (npc_id, alive, corrupted, tempter) VALUES (?, 1, ?, ?) ' +
          'ON CONFLICT(npc_id) DO UPDATE SET corrupted = ?, tempter = ?',
      )
      .run(npcId, next, tempter, next, tempter);
    return this.of(npcId)!;
  }
}
