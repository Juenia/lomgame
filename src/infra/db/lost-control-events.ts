import type { Db } from './sqlite.ts';

export interface LostControlEvent {
  characterId: string;
  date: string;
  pathway: string;
  text: string;
  hpLoss: number;
  madGain: number;
  /** M2.76：堕落形态 id；null = 该途径没写形态 / 序列够不着 ⇒ 走全局缺省后果 */
  form: string | null;
  source: string;
  createdAt: number;
}

/** lost_control_events：每次进入失控都留档，用于统计与内容调优 */
export class LostControlRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  record(event: LostControlEvent): void {
    this.#db
      .prepare(
        `INSERT INTO lost_control_events
           (character_id, date, pathway, text, hp_loss, mad_gain, form, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.characterId,
        event.date,
        event.pathway,
        event.text,
        event.hpLoss,
        event.madGain,
        event.form,
        event.source,
        event.createdAt,
      );
  }

  countOf(characterId: string): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM lost_control_events WHERE character_id = ?')
      .get(characterId) as { n: number };
    return row.n;
  }

  /**
   * 这个角色**今天**失控过吗（M2.1 方案 E 的判据）。
   *
   * 为什么不用 status：失控是结算时点上的状态，玩家当天的第一条指令往往就是 .净化/.休息，
   * 一解除 status 就回到 active —— 实测 80 个失控日里 80/80 都是这样，于是
   * 「探索时人还在失控里」这个条件几乎永远不成立。而 lost_control_events 是按天留档的，
   * 「今天失控过」这个事实不会被解除动作抹掉。走 idx_lost_control_char_date，每条探索一次查询。
   */
  hasOn(characterId: string, date: string): boolean {
    const row = this.#db
      .prepare(
        'SELECT 1 AS ok FROM lost_control_events WHERE character_id = ? AND date = ? LIMIT 1',
      )
      .get(characterId, date);
    return Boolean(row);
  }

  countOn(date: string): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM lost_control_events WHERE date = ?')
      .get(date) as { n: number };
    return row.n;
  }

  lastOf(characterId: string): LostControlEvent | null {
    const row = this.#db
      .prepare(
        'SELECT * FROM lost_control_events WHERE character_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(characterId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      characterId: String(row.character_id),
      date: String(row.date),
      pathway: String(row.pathway),
      text: String(row.text),
      hpLoss: Number(row.hp_loss),
      madGain: Number(row.mad_gain),
      // M2.76 之前的行没有这一列（迁移加的是可空列）⇒ null 表示「走的是全局缺省后果」
      form: row.form === null || row.form === undefined ? null : String(row.form),
      source: String(row.source),
      createdAt: Number(row.created_at),
    };
  }

  total(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM lost_control_events').get() as { n: number };
    return row.n;
  }
}
