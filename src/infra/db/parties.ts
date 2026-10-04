import type { Db } from './sqlite.ts';
import { newShortId } from '../ids.ts';

export interface PartyRow {
  id: string;
  leaderId: string;
  status: 'active' | 'disbanded';
  createdAt: number;
}

export interface PartyMemberRow {
  partyId: string;
  characterId: string;
  role: 'leader' | 'member';
  joinedAt: number;
}

/** parties / party_members：最小队伍实现（上限由 NUMERIC.party.maxMembers 控制） */
export class PartyRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  create(leaderId: string, now: number): PartyRow {
    const party: PartyRow = {
      // 队伍号：确定性模式下由队长 + 创建时间派生（生产仍是随机短号）
      id: newShortId(`party|${leaderId}|${now}`),
      leaderId,
      status: 'active',
      createdAt: now,
    };
    this.#db
      .prepare('INSERT INTO parties (id, leader_id, status, created_at) VALUES (?, ?, ?, ?)')
      .run(party.id, party.leaderId, party.status, party.createdAt);
    this.#db
      .prepare('INSERT INTO party_members (party_id, character_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(party.id, leaderId, 'leader', now);
    return party;
  }

  get(id: string): PartyRow | null {
    const row = this.#db.prepare('SELECT * FROM parties WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toParty(row) : null;
  }

  findByLeader(leaderId: string): PartyRow | null {
    const row = this.#db
      .prepare("SELECT * FROM parties WHERE leader_id = ? AND status = 'active' LIMIT 1")
      .get(leaderId) as Record<string, unknown> | undefined;
    return row ? toParty(row) : null;
  }

  /** 角色当前所在的有效队伍 */
  partyOf(characterId: string): PartyRow | null {
    const row = this.#db
      .prepare(
        `SELECT p.* FROM parties p JOIN party_members m ON m.party_id = p.id
         WHERE m.character_id = ? AND p.status = 'active' LIMIT 1`,
      )
      .get(characterId) as Record<string, unknown> | undefined;
    return row ? toParty(row) : null;
  }

  members(partyId: string): PartyMemberRow[] {
    const rows = this.#db
      .prepare('SELECT * FROM party_members WHERE party_id = ? ORDER BY joined_at ASC')
      .all(partyId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      partyId: String(row.party_id),
      characterId: String(row.character_id),
      role: String(row.role) as 'leader' | 'member',
      joinedAt: Number(row.joined_at),
    }));
  }

  sizeOf(partyId: string): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM party_members WHERE party_id = ?')
      .get(partyId) as { n: number };
    return row.n;
  }

  /** 角色所在队伍的规模；不在队伍里返回 1（只有自己） */
  partySizeOf(characterId: string): number {
    const party = this.partyOf(characterId);
    return party ? this.sizeOf(party.id) : 1;
  }

  addMember(partyId: string, characterId: string, now: number): void {
    this.#db
      .prepare('INSERT OR IGNORE INTO party_members (party_id, character_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(partyId, characterId, 'member', now);
  }

  removeMember(partyId: string, characterId: string): void {
    this.#db
      .prepare('DELETE FROM party_members WHERE party_id = ? AND character_id = ?')
      .run(partyId, characterId);
  }

  /** 解散：清空成员并把队伍标记为 disbanded */
  disband(partyId: string): void {
    this.#db.prepare('DELETE FROM party_members WHERE party_id = ?').run(partyId);
    this.#db.prepare("UPDATE parties SET status = 'disbanded' WHERE id = ?").run(partyId);
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM parties').get() as { n: number };
    return row.n;
  }
}

function toParty(row: Record<string, unknown>): PartyRow {
  return {
    id: String(row.id),
    leaderId: String(row.leader_id),
    status: String(row.status) as 'active' | 'disbanded',
    createdAt: Number(row.created_at),
  };
}
