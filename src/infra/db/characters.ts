import type { Db } from './sqlite.ts';
import type {
  CharacterState,
  CharacterStatus,
  DomainEvent,
  Gender,
  PathwayId,
  PathwayStatus,
} from '../../domain/character/types.ts';

interface CharacterRow {
  id: string;
  user_id: string;
  name: string;
  /** M2.7.6：普通人没有途径，库里是 NULL */
  pathway: string | null;
  /** M2.7.6：普通人没有序列，库里是 NULL */
  sequence: number | null;
  hp: number;
  mp: number;
  mad: number;
  cor: number;
  dig: number;
  /** M2.85 A：历练累计经验（不换技能 —— 技能由序列自带） */
  exp: number;
  current_location_id: string | null;
  dp: number;
  status: string;
  promotion_fails: number;
  /** M2.7：城市 id（0015 迁移新增；老库里的行是 NULL） */
  current_city_id?: string | null;
  /** M2.7.6：初始性别（0016 新增；老库里的行补 'male'） */
  gender?: string | null;
  /** M2.7.6：mortal / initiated（0016 新增；老库里的行按 pathway 推断） */
  pathway_status?: string | null;
  /** M2.16：所属教会 id（0022 新增；老库里的行是 NULL = 未入教） */
  church_id?: string | null;
  /** M2.16：累计贡献点（0022 新增；老库里的行是 0） */
  church_contribution?: number;
  created_at: number;
  updated_at: number;
}

function toState(row: CharacterRow): CharacterState {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    pathway: (row.pathway as PathwayId | null) ?? null,
    sequence: row.sequence ?? null,
    /*
     * M2.7.6：老库（0016 之前）没有 pathway_status 列，迁移已经把它补齐了；
     * 这里的兜底是给「手工建表 / 测试里直接 insert」的场景 —— 有途径就是 initiated。
     * 反过来（有途径却判成 mortal）会让一个老玩家突然不能扮演，那是最坏的一种读法。
     */
    pathwayStatus:
      (row.pathway_status as PathwayStatus | null) ??
      (row.pathway ? 'initiated' : 'mortal'),
    gender: (row.gender as Gender | null) ?? 'male',
    hp: row.hp,
    mp: row.mp,
    mad: row.mad,
    cor: row.cor,
    dig: row.dig,
    exp: Number(row.exp ?? 0),
    currentLocationId: row.current_location_id === null || row.current_location_id === undefined ? null : String(row.current_location_id),
    dp: row.dp,
    status: row.status as CharacterStatus,
    promotionFails: row.promotion_fails ?? 0,
    currentCityId: row.current_city_id ?? null,
    /*
     * M2.16：老库（0022 之前）没有这两列，迁移把 church_contribution 补成 0、
     * church_id 留 NULL。这里的兜底是给「手工建表 / 测试里直接 insert」的场景 ——
     * 缺了它，一个还没跑迁移的库会读出 undefined 流进判定层（金额算成 NaN）。
     */
    churchId: row.church_id ?? null,
    churchContribution: row.church_contribution ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CharacterRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** W1：users.id 与 qq_id 同值，避免过早引入账号体系 */
  ensureUser(userId: string, nickname: string, now: number): void {
    this.#db
      .prepare(
        `INSERT INTO users (id, qq_id, nickname, status, created_at, last_login_at)
         VALUES (?, ?, ?, 'active', ?, ?)
         ON CONFLICT(qq_id) DO UPDATE SET
           nickname = excluded.nickname,
           last_login_at = excluded.last_login_at`,
      )
      .run(userId, userId, nickname, now, now);
  }

  insert(state: CharacterState): void {
    this.#db
      .prepare(
        `INSERT INTO characters (
           id, user_id, name, pathway, sequence, hp, mp, mad, cor, dig, dp, exp, current_location_id,
           status, promotion_fails, current_city_id, gender, pathway_status,
           church_id, church_contribution,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        state.id,
        state.userId,
        state.name,
        // M2.7.6：普通人的 pathway / sequence 落 NULL（不是空串，也不是 -1）
        state.pathway,
        state.sequence,
        state.hp,
        state.mp,
        state.mad,
        state.cor,
        state.dig,
        state.dp,
        // M2.85 A：历练经验落库（漏了它，经验会在重启后归零，而读库看不出来）
        state.exp ?? 0,
        state.currentLocationId ?? null,
        state.status,
        state.promotionFails ?? 0,
        state.currentCityId ?? null,
        state.gender,
        state.pathwayStatus,
        // M2.16：新角色一律未入教（church_id NULL、贡献 0）
        state.churchId ?? null,
        state.churchContribution ?? 0,
        state.createdAt,
        state.updatedAt,
      );
  }

  update(state: CharacterState): void {
    this.#db
      .prepare(
        `UPDATE characters SET
           name = ?, pathway = ?, sequence = ?, hp = ?, mp = ?, mad = ?, cor = ?,
           dig = ?, dp = ?, exp = ?, current_location_id = ?, status = ?, promotion_fails = ?, current_city_id = ?,
           gender = ?, pathway_status = ?, church_id = ?, church_contribution = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        state.name,
        state.pathway,
        state.sequence,
        state.hp,
        state.mp,
        state.mad,
        state.cor,
        state.dig,
        state.dp,
        state.exp ?? 0,
        state.currentLocationId ?? null,
        state.status,
        state.promotionFails ?? 0,
        // M2.7：移动会改城市。**必须在这里写**——移动的落库路径就是 characters.update()，
        // 漏了这一列的话，到达之后重启一次城市就弹回出生地，而且读库完全看不出来。
        state.currentCityId ?? null,
        // M2.7.6：入途径就是在这条路径上落库的（pathway / sequence / pathway_status 三联）
        state.gender,
        state.pathwayStatus,
        // M2.16：入教与捐献都走这条路径落库。漏了这两列的话，
        // 买完东西重启一次「教会归属」就没了 —— 而读库完全看不出来。
        state.churchId ?? null,
        state.churchContribution ?? 0,
        state.updatedAt,
        state.id,
      );
  }

  findByUserId(userId: string): CharacterState | null {
    const row = this.#db
      .prepare('SELECT * FROM characters WHERE user_id = ? LIMIT 1')
      .get(userId) as CharacterRow | undefined;
    return row ? toState(row) : null;
  }

  findById(id: string): CharacterState | null {
    const row = this.#db.prepare('SELECT * FROM characters WHERE id = ? LIMIT 1').get(id) as
      | CharacterRow
      | undefined;
    return row ? toState(row) : null;
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM characters').get() as { n: number };
    return row.n;
  }

  /** 全量角色（每日 tick 用） */
  all(): CharacterState[] {
    const rows = this.#db
      .prepare('SELECT * FROM characters ORDER BY created_at ASC')
      .all() as unknown as CharacterRow[];
    return rows.map(toState);
  }

  /** 状态筛选（每日 tick 的失控恢复用） */
  byStatus(status: CharacterStatus): CharacterState[] {
    const rows = this.#db
      .prepare('SELECT * FROM characters WHERE status = ? ORDER BY created_at ASC')
      .all(status) as unknown as CharacterRow[];
    return rows.map(toState);
  }

  appendEvents(events: readonly DomainEvent[]): void {
    if (events.length === 0) return;
    const stmt = this.#db.prepare(
      `INSERT INTO domain_events (character_id, type, payload, reason, seed, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const event of events) {
      stmt.run(
        event.characterId,
        event.type,
        JSON.stringify(event.payload),
        event.reason,
        event.seed ?? null,
        event.createdAt,
      );
    }
  }

  /**
   * M2.16：最近一条指定类型事件的 payload（没有则 null）。
   *
   * 用途是**教内档位**：档位是算出来的（没有 rank 列），所以「变了没有」只能跟
   * 「上一次记到第几档」比，而那个值住在 `church_rank_up` 事件的 payload 里。
   * 用一条 SQL 取最后一条，而不是把整个事件史读进内存再过滤 ——
   * 后者在 200 人 × 每天一次的量级上是纯浪费。
   */
  lastEventPayloadOf(characterId: string, type: string): Record<string, unknown> | null {
    const row = this.#db
      .prepare(
        'SELECT payload FROM domain_events WHERE character_id = ? AND type = ? ORDER BY id DESC LIMIT 1',
      )
      .get(characterId, type) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as Record<string, unknown>) : null;
  }

  eventsOf(characterId: string): DomainEvent[] {
    const rows = this.#db
      .prepare('SELECT * FROM domain_events WHERE character_id = ? ORDER BY id ASC')
      .all(characterId) as Array<{
      character_id: string;
      type: string;
      payload: string;
      reason: string;
      seed: string | null;
      created_at: number;
    }>;
    return rows.map((r) => ({
      type: r.type,
      characterId: r.character_id,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      reason: r.reason,
      // M2.16：读回也用 null（与写侧的显式 null 对称）—— undefined 与 null 在布尔上下文里等价，
      // 但「这个事件本来就不掷骰」和「seed 丢了」在排查时是两回事
      seed: r.seed ?? null,
      createdAt: r.created_at,
    }));
  }
}
