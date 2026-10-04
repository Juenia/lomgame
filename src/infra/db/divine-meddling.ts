/**
 * 玩家插手神明阴谋的账（M2.169）—— 表见 migrations/0054。
 *
 * 它有两个用途：
 *   ① 「那位神赢了会赏你、输了会清算你」—— 站队的记录
 *   ② **成神仪式**的判据：「在自身参与之事导致一位神灵陨落时晋升」（原作刺客途径）
 */
import type { DatabaseSync } from 'node:sqlite';
import { firstCreditOf, type MeddleSide } from '../../domain/world/divine-meddling.ts';

export interface MeddlingRow {
  characterId: string;
  schemeId: string;
  side: MeddleSide;
  success: boolean;
  exposed: boolean;
  /**
   * **他在那一局里的分量**（插手那一刻算好并冻结）。
   *
   * 冻结的理由：序列会变（他可能在这一局结束前晋升了），而「当时他是以什么身份伸的手」
   * 是既成事实。每次重算会让同一局的排名随时间漂移。
   */
  score: number;
  at: number;
}

function rowOf(row: Record<string, unknown>): MeddlingRow {
  return {
    characterId: String(row['character_id']),
    schemeId: String(row['scheme_id']),
    side: String(row['side']) as MeddleSide,
    success: Number(row['success'] ?? 0) === 1,
    exposed: Number(row['exposed'] ?? 0) === 1,
    score: Number(row['score'] ?? 0),
    at: Number(row['at'] ?? 0),
  };
}

export class DivineMeddlingRepo {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  record(input: MeddlingRow): void {
    this.#db
      .prepare(
        'INSERT INTO divine_meddling (character_id, scheme_id, side, success, exposed, score, at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.characterId, input.schemeId, input.side,
        input.success ? 1 : 0, input.exposed ? 1 : 0, input.score, input.at,
      );
  }

  ofScheme(schemeId: string): MeddlingRow[] {
    const rows = this.#db
      .prepare('SELECT * FROM divine_meddling WHERE scheme_id = ? ORDER BY at ASC')
      .all(schemeId) as Array<Record<string, unknown>>;
    return rows.map(rowOf);
  }

  ofCharacter(characterId: string): MeddlingRow[] {
    const rows = this.#db
      .prepare('SELECT * FROM divine_meddling WHERE character_id = ? ORDER BY at DESC')
      .all(characterId) as Array<Record<string, unknown>>;
    return rows.map(rowOf);
  }

  /**
   * **他这辈子把几位神推下去过** —— 只算**首功**（成神仪式读它）。
   *
   * ⚠️ 这一条被改过一次，起因是用户那一问：「但是有多位玩家参与了怎么算？」
   * 原来的实现是 `COUNT(DISTINCT scheme_id)` —— 人人有份：十个玩家在同一场阴谋上
   * 各伸一次手，那一局成了，十个人全都拿到成神资格。而序列 0 是**唯一**的。
   *
   * 现在：一场陨落只认**分量最重**的那一个（并列时先动手的优先，见 `firstCreditOf`）。
   * 其余人拿次功 —— 有赏赐、有名字，但不成神。
   */
  firstCreditCaused(characterId: string): number {
    const rows = this.#db
      .prepare(
        'SELECT m.scheme_id AS scheme_id, m.character_id AS character_id, m.score AS score, m.at AS at ' +
          'FROM divine_meddling m JOIN divine_schemes s ON s.id = m.scheme_id ' +
          "WHERE s.outcome = 'done'",
      )
      .all() as Array<{ scheme_id: string; character_id: string; score: number; at: number }>;
    const byScheme = new Map<string, Array<{ characterId: string; score: number; at: number }>>();
    for (const row of rows) {
      const list = byScheme.get(row.scheme_id) ?? [];
      list.push({ characterId: row.character_id, score: Number(row.score ?? 0), at: Number(row.at ?? 0) });
      byScheme.set(row.scheme_id, list);
    }
    let count = 0;
    for (const list of byScheme.values()) {
      if (firstCreditOf(list) === characterId) count += 1;
    }
    return count;
  }

  /** 他**参与过、而且那一局成了**的局数（显示用 —— 与「首功」是两件事） */
  meddledAndWon(characterId: string): number {
    const row = this.#db
      .prepare(
        'SELECT COUNT(DISTINCT m.scheme_id) AS n FROM divine_meddling m ' +
          'JOIN divine_schemes s ON s.id = m.scheme_id ' +
          "WHERE m.character_id = ? AND s.outcome = 'done'",
      )
      .get(characterId) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }
}
