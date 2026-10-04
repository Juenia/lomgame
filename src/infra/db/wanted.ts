/**
 * 通缉与势力的落库（M2.6）：factions / wanted_states / bounty_claims 三张表。
 *
 * 与 domain/wanted 的分工：
 *   domain 决定「会发生什么」（纯函数），这里只负责「记下来、查出来」。
 *   所有等级 / 时长 / 赏金都在 domain 里算好，本文件不写任何游戏常数。
 *
 * 表在 0013_m2_6.sql 里建；**不新增任何角色相关表**（任务书 §三）——
 * 信誉与"此刻在哪"这两件跟角色有关的事，落在既有的 flags 表上
 * （见 flags.ts 的 LOCATION_FLAG / REPUTATION_FLAG）。
 */
import type { Db } from './sqlite.ts';
import type { Faction } from '../../domain/faction/faction.ts';
import type { WantedState } from '../../domain/wanted/wanted.ts';

export interface FactionRow {
  id: string;
  name: string;
  type: string;
  territory: string[];
}

export class FactionRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** 启动时从 NUMERIC.factionTerritory 播种（表是投影，numeric.ts 才是真相） */
  seed(factions: readonly Faction[]): number {
    const stmt = this.#db.prepare(
      `INSERT INTO factions (id, name, type, territory_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, type = excluded.type, territory_json = excluded.territory_json`,
    );
    let count = 0;
    for (const faction of factions) {
      stmt.run(faction.id, faction.name, faction.type, JSON.stringify(faction.territory));
      count += 1;
    }
    return count;
  }

  get(id: string): FactionRow | null {
    const row = this.#db.prepare('SELECT * FROM factions WHERE id = ?').get(id) as
      | { id: string; name: string; type: string; territory_json: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      territory: JSON.parse(row.territory_json) as string[],
    };
  }

  all(): FactionRow[] {
    const rows = this.#db
      .prepare('SELECT * FROM factions ORDER BY id ASC')
      .all() as Array<{ id: string; name: string; type: string; territory_json: string }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      territory: JSON.parse(row.territory_json) as string[],
    }));
  }

  count(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM factions').get() as { n: number }).n;
  }
}

/** 落库后的通缉令：一定有 id */
export type WantedRow = WantedState & { id: string };

interface WantedDbRow {
  id: string;
  character_id: string;
  faction_id: string;
  level: number;
  reason: string;
  created_at: number;
  expires_at: number;
  /** M2.6.1：赏金缩放倍率（0014 迁移加的列；缺省 1 = 不缩放） */
  bounty_multiplier: number | null;
}

function toWanted(row: WantedDbRow): WantedRow {
  return {
    id: row.id,
    characterId: row.character_id,
    factionId: row.faction_id,
    level: row.level,
    reason: row.reason,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    bountyMultiplier: row.bounty_multiplier ?? 1,
  };
}

export interface WantedStats {
  /** 此刻仍然有效的通缉令数 */
  active: number;
  /** 历史累计签发数 */
  total: number;
  byLevel: Record<string, number>;
  byFaction: Record<string, number>;
  /** 被领走的赏金总额（便士） */
  claimedPenny: number;
  claims: number;
}

export class WantedRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * 记一条通缉令。
   *
   * 同一个角色 + 同一个势力**只保留一条活记录**：
   *   - 已经有活记录 → 就地升级 / 续期（等级提高时把 level、reason、expires_at 一起改写）；
   *   - 没有 → 插入新行。
   * 为什么不做成"每次犯罪插一行"：那样一个刷子玩家会攒出几十行通缉，
   * 举报、播报、报告全都要先做一遍去重，而信息量并没有变多。
   */
  upsert(state: WantedState & { id: string }): void {
    const existing = this.#db
      .prepare(
        'SELECT * FROM wanted_states WHERE character_id = ? AND faction_id = ? AND expires_at > ? ORDER BY level DESC LIMIT 1',
      )
      .get(state.characterId, state.factionId, state.createdAt) as WantedDbRow | undefined;

    if (existing) {
      // 升级 / 续期，**不降级**：level、expires_at、bounty_multiplier 三者都取更大的那个。
      // 倍率取 max 的理由：一个已经因为"打了高序列"被重赏的人，
      // 再犯一次轻的，不该让悬赏掉下来。
      this.#db
        .prepare(
          `UPDATE wanted_states SET
             level = MAX(level, ?), reason = ?, created_at = ?, expires_at = MAX(expires_at, ?),
             bounty_multiplier = MAX(bounty_multiplier, ?)
           WHERE id = ?`,
        )
        .run(
          state.level,
          state.reason,
          state.createdAt,
          state.expiresAt,
          state.bountyMultiplier ?? 1,
          existing.id,
        );
      return;
    }

    this.#db
      .prepare(
        `INSERT INTO wanted_states
           (id, character_id, faction_id, level, reason, created_at, expires_at, bounty_multiplier)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        state.id,
        state.characterId,
        state.factionId,
        state.level,
        state.reason,
        state.createdAt,
        state.expiresAt,
        state.bountyMultiplier ?? 1,
      );
  }

  /** 某个角色此刻仍然有效的全部通缉令 */
  listActiveOf(characterId: string, now: number): WantedRow[] {
    const rows = this.#db
      .prepare('SELECT * FROM wanted_states WHERE character_id = ? AND expires_at > ? ORDER BY level DESC, created_at DESC')
      .all(characterId, now) as unknown as WantedDbRow[];
    return rows.map(toWanted);
  }

  /** 全服此刻有效的通缉令（报告与运营看板用） */
  listActive(now: number): WantedRow[] {
    const rows = this.#db
      .prepare('SELECT * FROM wanted_states WHERE expires_at > ? ORDER BY created_at DESC')
      .all(now) as unknown as WantedDbRow[];
    return rows.map(toWanted);
  }

  /** 历史累计（含已过期的），报告口径「一共签发过多少条」 */
  listAll(): WantedRow[] {
    const rows = this.#db
      .prepare('SELECT * FROM wanted_states ORDER BY created_at DESC')
      .all() as unknown as WantedDbRow[];
    return rows.map(toWanted);
  }

  findById(id: string): WantedRow | null {
    const row = this.#db.prepare('SELECT * FROM wanted_states WHERE id = ?').get(id) as
      | WantedDbRow
      | undefined;
    return row ? toWanted(row) : null;
  }

  countActive(now: number): number {
    return (
      this.#db.prepare('SELECT COUNT(*) AS n FROM wanted_states WHERE expires_at > ?').get(now) as {
        n: number;
      }
    ).n;
  }

  /* ---------------- 赏金 ---------------- */

  /** 这条通缉令有没有被领过赏（同一条只能领一次，靠主键保证） */
  hasClaim(wantedId: string): boolean {
    return Boolean(
      this.#db.prepare('SELECT 1 AS ok FROM bounty_claims WHERE wanted_id = ? LIMIT 1').get(wantedId),
    );
  }

  /** 领赏。返回 false = 已经被别人领走了（主键冲突），不是错误 */
  claim(input: { id: string; wantedId: string; claimerId: string; rewardPenny: number; now: number }): boolean {
    try {
      this.#db
        .prepare(
          'INSERT INTO bounty_claims (id, wanted_id, claimer_id, reward_penny, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(input.id, input.wantedId, input.claimerId, input.rewardPenny, input.now);
      return true;
    } catch {
      return false;
    }
  }

  claimsOfWork(claimerId: string): Array<{ wantedId: string; rewardPenny: number; createdAt: number }> {
    const rows = this.#db
      .prepare('SELECT wanted_id, reward_penny, created_at FROM bounty_claims WHERE claimer_id = ? ORDER BY created_at ASC')
      .all(claimerId) as Array<{ wanted_id: string; reward_penny: number; created_at: number }>;
    return rows.map((row) => ({
      wantedId: row.wanted_id,
      rewardPenny: row.reward_penny,
      createdAt: row.created_at,
    }));
  }

  countClaims(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM bounty_claims').get() as { n: number }).n;
  }

  stats(now: number): WantedStats {
    const total = (this.#db.prepare('SELECT COUNT(*) AS n FROM wanted_states').get() as { n: number }).n;
    const active = this.countActive(now);
    const levelRows = this.#db
      .prepare('SELECT level, COUNT(*) AS n FROM wanted_states GROUP BY level')
      .all() as Array<{ level: number; n: number }>;
    const factionRows = this.#db
      .prepare('SELECT faction_id, COUNT(*) AS n FROM wanted_states GROUP BY faction_id')
      .all() as Array<{ faction_id: string; n: number }>;
    const claim = this.#db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(reward_penny), 0) AS s FROM bounty_claims')
      .get() as { n: number; s: number };
    const byLevel: Record<string, number> = {};
    for (const row of levelRows) byLevel[String(row.level)] = row.n;
    const byFaction: Record<string, number> = {};
    for (const row of factionRows) byFaction[row.faction_id] = row.n;
    return {
      active,
      total,
      byLevel,
      byFaction,
      claimedPenny: Number(claim.s),
      claims: Number(claim.n),
    };
  }
}
