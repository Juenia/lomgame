import type { Db } from './sqlite.ts';

/** cooldowns：业务冷却（与令牌桶频控、每日计数是三件不同的事） */
export class CooldownRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  lastUsed(characterId: string, command: string): number | null {
    const row = this.#db
      .prepare('SELECT last_used_at FROM cooldowns WHERE character_id = ? AND command = ?')
      .get(characterId, command) as { last_used_at: number } | undefined;
    return row?.last_used_at ?? null;
  }

  /** 距离冷却结束还剩多少毫秒；0 表示可用 */
  remainingMs(characterId: string, command: string, cooldownMs: number, now: number): number {
    const last = this.lastUsed(characterId, command);
    if (last === null) return 0;
    const elapsed = now - last;
    return elapsed >= cooldownMs ? 0 : cooldownMs - elapsed;
  }

  touch(characterId: string, command: string, now: number): void {
    this.#db
      .prepare(
        `INSERT INTO cooldowns (character_id, command, last_used_at) VALUES (?, ?, ?)
         ON CONFLICT(character_id, command) DO UPDATE SET last_used_at = excluded.last_used_at`,
      )
      .run(characterId, command, now);
  }
}
