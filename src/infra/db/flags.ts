import type { Db } from './sqlite.ts';

/**
 * flags 表上寄存的**结构化值**（M2.6）。
 *
 * 为什么用 flags 而不是给 characters 加列 / 新建表：
 *   任务书 §三 明确「不新增角色相关表」。而"此刻在哪"与"信誉"都是
 *   **单值、可覆盖、不需要历史**的角色附加状态 —— 正是 flags 的形状
 *   （表本身就有 value 列，只是一直没人用）。给它一个名字，
 *   比在命令层各处写字符串字面量 'loc' 要安全得多。
 *
 * 注意 `FLAG_LOCATION` 存的是**地点 id**（如 'tingen'），不是中文名：
 *   地点改名时只需要动 locations.yaml，已经落库的值不受影响。
 */
export const FLAG_LOCATION = 'loc';

/** 信誉（M2.6 举报机制）：value 存十进制整数字符串 */
export const FLAG_REPUTATION = 'reputation';

/**
 * **晋升仪式的流程进度**（M2.88）—— 存 JSON，形状见 `domain/ritual/flow.ts` 的 `RitualProgress`。
 *
 * ## 为什么放 flags 而不是给 characters 加列
 *
 * 与本文件开头那段注释同一个理由：**单值、可覆盖、不需要历史**。
 * 流程进度正是这个形状 —— 它只回答「这个人的仪式走到第几步了」。
 *
 * ⚠️ 不放 `rituals.config_json` 的理由：那一行**只在「准备期」存在**
 * （`preparingOf` 查的是准备中的那一条），而仪式流程跨很多次上线，
 * 玩家中途去干别的时那一行可能就没了 —— 进度会跟着一起消失。
 */
export const FLAG_RITUAL_FLOW = 'ritual_flow';

/**
 * 系统内部标记前缀：这些 flag 是**机器状态**，不是"这个角色身上发生了什么"，
 * 所以不该出现在 .状态 的「标记」清单里 ——
 * 加了 M2.6 之后如果不挡，玩家的状态面板会被 wanted_alert:tingen 这种字符串塞满。
 */
export const INTERNAL_FLAG_PREFIXES: readonly string[] = [
  'wanted_alert:',
  'assault_cd:',
  /*
   * M2.65：行动标记（action:exploreDanger:tingen:2026-01-01 这种）也是**机器状态** ——
   * 键里带着地点与日期，玩家读它读不出任何东西，只会把状态面板塞满。
   */
  'action:',
];

/** 整值型的内部标记（值有意义，但不是给玩家看的"标记"） */
export const INTERNAL_FLAGS: readonly string[] = [FLAG_LOCATION, FLAG_REPUTATION, FLAG_RITUAL_FLOW];

export function isInternalFlag(flag: string): boolean {
  if (INTERNAL_FLAGS.includes(flag)) return true;
  return INTERNAL_FLAG_PREFIXES.some((prefix) => flag.startsWith(prefix));
}

/** flags：事件卡写入、事件条件读取的角色标记 */
export class FlagRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  has(characterId: string, flag: string): boolean {
    const row = this.#db
      .prepare('SELECT 1 AS ok FROM flags WHERE character_id = ? AND flag = ?')
      .get(characterId, flag);
    return Boolean(row);
  }

  list(characterId: string): string[] {
    const rows = this.#db
      .prepare('SELECT flag FROM flags WHERE character_id = ? ORDER BY flag ASC')
      .all(characterId) as Array<{ flag: string }>;
    return rows.map((row) => row.flag);
  }

  asSet(characterId: string): Set<string> {
    return new Set(this.list(characterId));
  }

  /** 读一个带值的 flag（没有该 flag 时返回 null）。M2.6：'loc' / 'reputation' 走它 */
  value(characterId: string, flag: string): string | null {
    const row = this.#db
      .prepare('SELECT value FROM flags WHERE character_id = ? AND flag = ? LIMIT 1')
      .get(characterId, flag) as { value: string | null } | undefined;
    return row?.value ?? null;
  }

  set(characterId: string, flag: string, now: number, value?: string): void {
    this.#db
      .prepare(
        `INSERT INTO flags (character_id, flag, value, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(character_id, flag) DO UPDATE SET value = excluded.value`,
      )
      .run(characterId, flag, value ?? null, now);
  }

  setMany(characterId: string, flags: readonly string[], now: number): void {
    for (const flag of flags) this.set(characterId, flag, now);
  }

  /**
   * M2.65：**删掉一个标记**（行动标记的「用完即消」走它）。
   *
   * 为什么必须有删除而不是「写个空值」：`value(null)` 与「没有这个 flag」
   * 在 `.状态` / 报告 / 判定层是**两种不同的东西**，而行动标记的口径是后者。
   */
  clear(characterId: string, flag: string): void {
    this.#db.prepare('DELETE FROM flags WHERE character_id = ? AND flag = ?').run(characterId, flag);
  }
}
