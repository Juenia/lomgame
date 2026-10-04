/**
 * 战斗仓储（M2.9）：battles / battle_rounds。
 *
 * 判定层（domain/battle/*）不认识这里 —— 它只吃纯数据、吐纯数据。
 * 本文件的职责就是「把库里的东西变成纯数据」与「把纯数据写回库」，
 * 外加两件只有仓储能做对的事：
 *
 *   1. **一个角色同时只能有一场未决战斗**（activeOf 是那个不变式的查询面）；
 *   2. **一回合的写入是原子的**（状态机 UPDATE + 回合记录 INSERT 同一个事务）——
 *      分成两次写就有机会只写一半，而「回合记录比状态机多一行」
 *      是最难查的一类不一致：报告与战斗现场会各说各话。
 *
 * SQL 一律写成单行双引号字符串（不用模板字面量）：这个文件里全是占位符与关键字，
 * 多行模板只会让「哪一段 SQL 少了空格」这种错变得难以肉眼检查。
 */
import { BATTLE } from '../../config/numeric.ts';
import { withTransaction, type Db } from './sqlite.ts';
import type {
  BattleState,
  BattleStatusEffect,
  BattleStatusKind,
  BattleWorld,
  CreatureAction,
  PlayerAction,
  RoundResult,
} from '../../domain/battle/types.ts';

/**
 * 「这个人此刻有没有在打」。
 *
 * M2.10 起要**同时认两边**：PVP 里应战者不是 character_id 那一方，
 * 只查 character_id 会让应战者看不见自己正被挑战 —— 那是「打起来了但没人知道」的 bug。
 */
const SELECT_ACTIVE =
  "SELECT * FROM battles WHERE status = 'active' AND (character_id = ? OR opponent_character_id = ?) " +
  'ORDER BY started_at DESC LIMIT 1';
const SELECT_BY_ID = 'SELECT * FROM battles WHERE id = ?';
const SELECT_STALE = "SELECT * FROM battles WHERE status = 'active' AND last_round_at <= ? ORDER BY last_round_at ASC";

/**
 * 一行战斗的**列值**（不含 last_round_at / resolved_at —— 那两个由调用方给：
 * 人为出招时是「现在」，超时补齐时是「这一格的时间」）。
 *
 * 抽成一个函数是为了让 INSERT / UPDATE / syncState 三处**共用同一份顺序** ——
 * 三份手写的 ? 列表是这个文件里最容易错的地方，而错了的表现是「某个字段悄悄串位」，
 * 读数字看不出来，只有对局回放时才会发现。
 */
function battleValues(battle: BattleState): Array<string | number | null> {
  return [
    battle.id,
    battle.characterId,
    battle.creatureId === '' ? null : battle.creatureId,
    battle.speciesId,
    battle.speciesName,
    battle.world.locationId,
    battle.round,
    battle.status,
    battle.playerHp,
    battle.playerMp,
    JSON.stringify(battle.playerStatuses),
    battle.playerDefensePenalty,
    battle.creatureHp,
    battle.creatureMaxHp,
    battle.creatureSequence,
    battle.creatureDying ? 1 : 0,
    JSON.stringify(battle.creatureStatuses),
    battle.creatureBerserk ? 1 : 0,
    battle.creatureEvolved ? 1 : 0,
    battle.creatureShield ? 1 : 0,
    battle.creaturePlayingDead ? 1 : 0,
    battle.allyCalled ? 1 : 0,
    battle.allyArrivesAtRound,
    battle.allyCount,
    battle.negateCreatureActions,
    battle.lastPlayerDamage,
    battle.foresight ? JSON.stringify(battle.foresight) : null,
    JSON.stringify(battle.world),
    battle.startedAt,
    // ---- M2.10 ----
    battle.isPvp ? 1 : 0,
    battle.opponentCharacterId,
    battle.turnOf,
    battle.pendingAction ? JSON.stringify(battle.pendingAction) : null,
    battle.negatePlayerActions,
  ];
}

/** 上面那些列的名字，与 battleValues 的**顺序严格一一对应** */
const BATTLE_COLUMNS = [
  'id', 'character_id', 'creature_id', 'species_id', 'species_name', 'location_id',
  'round', 'status', 'player_hp', 'player_mp', 'player_status_json', 'player_defense_penalty',
  'creature_hp', 'creature_max_hp', 'creature_sequence', 'creature_dying', 'creature_status_json',
  'creature_berserk', 'creature_evolved', 'creature_shield', 'creature_playing_dead',
  'ally_called', 'ally_arrives_at_round', 'ally_count', 'negate_creature_actions',
  'last_player_damage', 'foresight_json', 'world_json', 'started_at',
  'is_pvp', 'opponent_character_id', 'turn_of', 'pending_action_json', 'negate_player_actions',
] as const;

const INSERT_BATTLE =
  'INSERT INTO battles (' + [...BATTLE_COLUMNS, 'last_round_at', 'resolved_at'].join(', ') + ') VALUES (' +
  [...BATTLE_COLUMNS, 'last_round_at', 'resolved_at'].map(() => '?').join(', ') + ')';

const UPDATE_BATTLE =
  'UPDATE battles SET ' +
  [...BATTLE_COLUMNS.slice(1), 'last_round_at', 'resolved_at'].map((column) => column + ' = ?').join(', ') +
  ' WHERE id = ?';

const INSERT_ROUND =
  'INSERT INTO battle_rounds (battle_id, round, player_action, creature_action, result_json, seed, created_at) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?)';

/** 库里存的 status 一定是这六个之一（迁移里有 CHECK 守着） */
function toStatusKind(value: unknown): BattleStatusKind {
  const text = String(value ?? 'active');
  switch (text) {
    case 'player_win':
    case 'player_lose':
    case 'stalemate':
    case 'fled':
    case 'creature_fled':
      return text;
    default:
      return 'active';
  }
}

function parseJson<T>(raw: unknown, fallback: T): T {
  try {
    const parsed = JSON.parse(String(raw ?? ''));
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function toStatuses(raw: unknown): BattleStatusEffect[] {
  const list = parseJson<BattleStatusEffect[]>(raw, []);
  if (!Array.isArray(list)) return [];
  return list.filter((entry) => entry && typeof entry.id === 'string');
}

function bool(value: unknown): boolean {
  return Number(value ?? 0) !== 0;
}

export class BattleRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /* ---------------- 读 ---------------- */

  /** 这个角色此刻未决的那场战斗（没有就是 null） */
  activeOf(characterId: string): BattleState | null {
    const row = this.#db.prepare(SELECT_ACTIVE).get(characterId, characterId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.#toBattle(row) : null;
  }

  /**
   * M2.10：这个人**上一次挑战同一个对手**是什么时候（挑战冷却要读它）。
   *
   * 只看「已结束」的战斗也算 —— 冷却防的是「反复点同一个人」，
   * 而正在打的那一场由 requireNotInBattle 拦着，两件事不重叠。
   */
  lastChallengeAt(challengerId: string, opponentId: string): number | null {
    const row = this.#db
      .prepare(
        'SELECT started_at FROM battles WHERE is_pvp = 1 AND character_id = ? AND opponent_character_id = ? ' +
          'ORDER BY started_at DESC LIMIT 1',
      )
      .get(challengerId, opponentId) as { started_at: number } | undefined;
    return row ? Number(row.started_at) : null;
  }

  /** M2.10：报告用 —— PVP 的战斗摘要（含双方 id 与轮次） */
  pvpSummaries(): Array<{
    id: string;
    challengerId: string;
    opponentId: string;
    status: string;
    rounds: number;
    turnOf: string;
    pending: boolean;
  }> {
    const rows = this.#db
      .prepare(
        'SELECT b.id, b.character_id, b.opponent_character_id, b.status, b.turn_of, b.pending_action_json, ' +
          '(SELECT COUNT(*) FROM battle_rounds r WHERE r.battle_id = b.id) AS rounds ' +
          'FROM battles b WHERE b.is_pvp = 1 ORDER BY b.started_at ASC',
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      challengerId: String(row.character_id),
      opponentId: row.opponent_character_id === null ? '' : String(row.opponent_character_id),
      status: String(row.status),
      rounds: Number(row.rounds ?? 0),
      turnOf: String(row.turn_of),
      pending: row.pending_action_json !== null && row.pending_action_json !== undefined,
    }));
  }

  byId(id: string): BattleState | null {
    const row = this.#db.prepare(SELECT_BY_ID).get(id) as Record<string, unknown> | undefined;
    return row ? this.#toBattle(row) : null;
  }

  /**
   * 已经超时的未决战斗（last_round_at 已经到或早于 deadline）。
   *
   * 为什么用 <= 而不是 <：调用方传进来的是「now - playerTimeoutMs」，
   * 正好卡在边界上的那一场也该算超时 —— 差一毫秒的判定会让「5 分钟」
   * 在测试里变成一个永远差一点点的数。
   */
  staleActive(deadline: number): BattleState[] {
    const rows = this.#db.prepare(SELECT_STALE).all(deadline) as Array<Record<string, unknown>>;
    return rows.map((row) => this.#toBattle(row));
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM battles').get() as { n: number };
    return row.n;
  }

  countRounds(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM battle_rounds').get() as { n: number };
    return row.n;
  }

  /* ---------------- 写 ---------------- */

  /** 开一场战斗 */
  create(battle: BattleState): void {
    this.#db
      .prepare(INSERT_BATTLE)
      .run(...battleValues(battle), battle.lastRoundAt, battle.resolvedAt);
  }

  /**
   * 落一个回合：**状态机 UPDATE + 回合记录 INSERT 一个事务**（见文件头第 2 条）。
   *
   * resolved_at 在这里落定而不是在判定层：判定层不读时钟（它的 resolvedAt 恒为 null），
   * 只有仓储知道「现在」是几点。
   */
  saveRound(input: {
    battle: BattleState;
    result: RoundResult;
    playerAction: PlayerAction;
    creatureAction: CreatureAction;
    seed: string;
    now: number;
  }): void {
    const { battle, result, seed, now } = input;
    withTransaction(this.#db, () => {
      this.#db
        .prepare(UPDATE_BATTLE)
        .run(
          ...battleValues(battle).slice(1),
          now,
          battle.status === 'active' ? null : now,
          battle.id,
        );
      this.#db.prepare(INSERT_ROUND).run(
        battle.id,
        result.round,
        result.playerAction.kind + (result.playerAction.skillId ? ':' + result.playerAction.skillId : ''),
        result.creatureAction.kind + (result.creatureAction.special ? ':' + result.creatureAction.special : ''),
        JSON.stringify({
          status: result.status,
          playerDamageDealt: result.playerDamageDealt,
          creatureDamageDealt: result.creatureDamageDealt,
          creatureActed: result.creatureActed,
          flags: result.flags,
          rolls: result.rolls,
          events: result.events.map((event) => event.kind),
          /*
           * M2.9：这一回合**挂上过哪些状态**。
           *
           * 为什么要单独记一份，而不是报告直接去读 battles 的 status_json：
           * 那一列是**终局残留** —— 一个第 2 回合挂上、第 5 回合到期的「恐惧」，
           * 在战斗结束时早就不在列表里了。用残留当触发次数，
           * 报告会给出「状态触发 0 次」，而实际上它每场都在发生。
           * （这个坑实测踩过：cross-check 时 statusApplyDistribution 全空。）
           */
          appliedStatuses: result.events
            .filter((event) => event.kind === 'status_apply' && event.status)
            .map((event) => event.status),
        }),
        seed,
        now,
      );
    });
  }

  /**
   * **只同步状态机本身，不记回合**（M2.9 修正）。
   *
   * 用途只有一个：玩家在战斗中发了别的指令（`.休息` 会改角色卡的 HP），
   * 战斗里的那份血要跟着角色卡走。这不是一个回合，**不能往 battle_rounds 里写一行** ——
   * 写了的话，报告里的「回合数分布」与「玩家动作分布」会被一堆
   * `defend / 0 伤害` 的假回合污染，而那种污染在读数字时看不出任何异常。
   *
   * 它与 saveRound 共用同一段字段集合，区别只有两个：
   * 不写 battle_rounds、**不动 last_round_at**（超时水位线不该被一次同步推走）。
   */
  syncState(battle: BattleState): void {
    this.#db
      .prepare(UPDATE_BATTLE)
      .run(...battleValues(battle).slice(1), battle.lastRoundAt, battle.resolvedAt, battle.id);
  }

  /**
   * 把战斗里被改变的生物写回世界（creatures 表）。
   *
   * ⚠️ 这是「战斗改世界」的**唯一一条路**：判定层与命令层都不直接碰 creatures 表。
   * 玩家赢 → 那只生物从世界里消失；其余情况 → 带伤写回（HP / 序列 / 状态）。
   *
   * 与生态 tick 的关系：写回的就是同一行，所以「打残了但它跑了」这件事
   * 下一小时的生态 tick 会看得见（它饿着、它弱着、它可能被别的生物吃掉）。
   *
   * creatures 表有 CHECK (hp > 0)：HP 归零的生物不该留在世界里，
   * 所以 hp <= 0 一律走删除分支 —— 与「玩家胜」是同一条路，
   * 而不是一个会被数据库拒绝的 UPDATE。
   */
  writeBackCreature(input: {
    creatureId: string;
    hp: number | null;
    maxHp: number;
    sequence: number;
  }): void {
    if (input.hp === null || input.hp <= 0) {
      this.#db.prepare('DELETE FROM creatures WHERE id = ?').run(input.creatureId);
      return;
    }
    this.#db
      .prepare('UPDATE creatures SET hp = ?, max_hp = ?, sequence = ?, status = ? WHERE id = ?')
      .run(
        input.hp,
        input.maxHp,
        input.sequence,
        input.hp < input.maxHp / 2 ? 'hungry' : 'healthy',
        input.creatureId,
      );
  }

  /* ---------------- 报告口径 ---------------- */

  /** 战斗结局分布（报告「胜 / 负 / 僵持 / 逃跑」） */
  statusDistribution(): Map<string, number> {
    const rows = this.#db
      .prepare('SELECT status, COUNT(*) AS n FROM battles GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    return new Map(rows.map((row) => [String(row.status), Number(row.n)]));
  }

  /**
   * 回合数分布（**「同一场战斗两次不一样」的第一个维度**）。
   *
   * 口径是「实际打了几个回合」= battle_rounds 的行数，不是 battles.round。
   * battles.round 表示「当前等待玩家输入的回合号」，战斗结束时它比实际回合数大 1 ——
   * 拿它做分布会让每一次胜利都多算一回合。
   */
  roundCountDistribution(): Map<number, number> {
    const rows = this.#db
      .prepare(
        'SELECT n AS rounds, COUNT(*) AS battles FROM (' +
          'SELECT battle_id, COUNT(*) AS n FROM battle_rounds GROUP BY battle_id' +
          ') GROUP BY n ORDER BY n ASC',
      )
      .all() as Array<{ rounds: number; battles: number }>;
    return new Map(rows.map((row) => [Number(row.rounds), Number(row.battles)]));
  }

  /** 玩家动作分布 */
  playerActionDistribution(): Map<string, number> {
    const rows = this.#db
      .prepare('SELECT player_action, COUNT(*) AS n FROM battle_rounds GROUP BY player_action ORDER BY n DESC')
      .all() as Array<{ player_action: string; n: number }>;
    return new Map(rows.map((row) => [String(row.player_action), Number(row.n)]));
  }

  /** 生物行为分布（**「同一场战斗两次不一样」的第二个维度**） */
  creatureActionDistribution(): Map<string, number> {
    const rows = this.#db
      .prepare('SELECT creature_action, COUNT(*) AS n FROM battle_rounds GROUP BY creature_action ORDER BY n DESC')
      .all() as Array<{ creature_action: string; n: number }>;
    return new Map(rows.map((row) => [String(row.creature_action), Number(row.n)]));
  }

  /**
   * **状态被挂上过几次**（按状态 id 数）—— 报告里「状态触发分布」的口径。
   *
   * 数据源是 battle_rounds 的 result_json.appliedStatuses，**不是** battles 的 status_json：
   * 后者是终局残留，用它统计会把「第 2 回合挂上、第 5 回合到期」的状态全部漏掉。
   */
  statusTriggerTotals(): Map<string, number> {
    const rows = this.#db
      .prepare('SELECT result_json FROM battle_rounds')
      .all() as Array<{ result_json: string }>;
    const totals = new Map<string, number>();
    for (const row of rows) {
      const parsed = parseJson<{ appliedStatuses?: string[] }>(row.result_json, {});
      for (const id of parsed.appliedStatuses ?? []) {
        totals.set(id, (totals.get(id) ?? 0) + 1);
      }
    }
    return totals;
  }

  /** 每一条回合记录的 flags 汇总（暴击 / 流血 / 援军到达 / 超时自动防御 / 预知） */
  flagTotals(): Map<string, number> {
    const rows = this.#db.prepare('SELECT result_json FROM battle_rounds').all() as Array<{
      result_json: string;
    }>;
    const totals = new Map<string, number>();
    for (const row of rows) {
      const parsed = parseJson<{ flags?: Record<string, boolean> }>(row.result_json, {});
      for (const [key, value] of Object.entries(parsed.flags ?? {})) {
        if (value === true) totals.set(key, (totals.get(key) ?? 0) + 1);
      }
    }
    return totals;
  }

  /** 状态被挂上过几次（按 status id 数） */
  statusApplyDistribution(): Map<string, number> {
    const rows = this.#db
      .prepare(
        // ⚠️ 状态是**对象**（{id, rounds, source}）不是裸字符串：
        //    早先写成 json_each 的 status 列，查出来的是 battles.status（结局）——
        //    于是「状态触发分布」那一栏显示的是 player_win / fled 之类，看起来像有数据、其实是错的。
        "SELECT json_extract(value, '$.id') AS status, COUNT(*) AS n " +
          'FROM battles, json_each(battles.creature_status_json) GROUP BY status',
      )
      .all() as Array<{ status: string; n: number }>;
    return new Map(rows.map((row) => [String(row.status), Number(row.n)]));
  }

  /** 玩家这一侧挂上过几个状态（与上面那张表合起来才是「状态触发分布」） */
  playerStatusApplyDistribution(): Map<string, number> {
    const rows = this.#db
      .prepare(
        "SELECT json_extract(value, '$.id') AS status, COUNT(*) AS n " +
          'FROM battles, json_each(battles.player_status_json) GROUP BY status',
      )
      .all() as Array<{ status: string; n: number }>;
    return new Map(rows.map((row) => [String(row.status), Number(row.n)]));
  }

  /** 战斗里被改过序列的生物数（「战斗进化」的证据） */
  evolvedInBattle(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM battles WHERE creature_evolved = 1').get() as {
      n: number;
    };
    return row.n;
  }

  /** 报告用：每一场战斗的摘要（不拉 result_json，够画分布图了） */
  summaries(): Array<{
    id: string;
    characterId: string;
    speciesId: string;
    status: string;
    rounds: number;
    creatureEvolved: boolean;
    allyCount: number;
  }> {
    const rows = this.#db
      .prepare(
        'SELECT b.id, b.character_id, b.species_id, b.status, b.creature_evolved, b.ally_count, ' +
          '(SELECT COUNT(*) FROM battle_rounds r WHERE r.battle_id = b.id) AS rounds ' +
          'FROM battles b ORDER BY b.started_at ASC',
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      characterId: String(row.character_id),
      speciesId: String(row.species_id),
      status: String(row.status),
      rounds: Number(row.rounds ?? 0),
      creatureEvolved: bool(row.creature_evolved),
      allyCount: Number(row.ally_count ?? 0),
    }));
  }

  /* ---------------- 行 → 领域对象 ---------------- */

  #toBattle(row: Record<string, unknown>): BattleState {
    const world = parseJson<BattleWorld>(row.world_json, {
      locationId: String(row.location_id),
      locationName: String(row.location_id),
      night: false,
      danger: 0,
      weatherHitPenalty: 0,
      weatherLabel: '',
    });
    return {
      id: String(row.id),
      characterId: String(row.character_id),
      // PVP 时这一列是 NULL —— 回空串（判定层从不读它，命令层用 isPvp 判断）
      creatureId: row.creature_id === null || row.creature_id === undefined ? '' : String(row.creature_id),
    /*
     * M2.85：回合上限**不存库**，反序列化时按「是不是神战」推导。
     *
     * 为什么不加一列：它完全由对手决定（神 = 40、其余 = 8），存下来只会多一个
     * 「什么时候会被写坏」的地方；而 `deity:` 前缀本来就是权威标记。
     */
    maxRounds: String(row.creature_id ?? '').startsWith('deity:') ? BATTLE.godMaxRounds : BATTLE.maxRounds,
      speciesId: String(row.species_id),
      speciesName: String(row.species_name),
      creatureSequence: Number(row.creature_sequence),
      creatureDying: bool(row.creature_dying),
      world,
      round: Number(row.round),
      status: toStatusKind(row.status),
      playerHp: Number(row.player_hp),
      playerMp: Number(row.player_mp),
      playerStatuses: toStatuses(row.player_status_json),
      playerDefensePenalty: Number(row.player_defense_penalty ?? 0),
      creatureHp: Number(row.creature_hp),
      creatureMaxHp: Number(row.creature_max_hp ?? row.creature_hp),
      creatureStatuses: toStatuses(row.creature_status_json),
      creatureBerserk: bool(row.creature_berserk),
      creatureEvolved: bool(row.creature_evolved),
      creatureShield: bool(row.creature_shield),
      creaturePlayingDead: bool(row.creature_playing_dead),
      allyCalled: bool(row.ally_called),
      allyArrivesAtRound:
        row.ally_arrives_at_round === null || row.ally_arrives_at_round === undefined
          ? null
          : Number(row.ally_arrives_at_round),
      allyCount: Number(row.ally_count ?? 0),
      negateCreatureActions: Number(row.negate_creature_actions ?? 0),
      negatePlayerActions: Number(row.negate_player_actions ?? 0),
      isPvp: bool(row.is_pvp),
      opponentCharacterId:
        row.opponent_character_id === null || row.opponent_character_id === undefined
          ? null
          : String(row.opponent_character_id),
      /*
       * PVP 的对手显示名：库里存的是 species_name 那一列（语义是「对手方的名字」）。
       * 不额外加一列 opponent_name 是因为它**只用于显示**，而名字改了之后
       * 回放时该显示「当时的名字」还是「现在的名字」本身就没有唯一答案 ——
       * 存当时的那个（与物种名同一个道理）。
       */
      opponentName: bool(row.is_pvp) ? String(row.species_name) : null,
      turnOf: String(row.turn_of) === 'opponent' ? 'opponent' : 'challenger',
      pendingAction: parseJson<PlayerAction | null>(row.pending_action_json, null),
      lastPlayerDamage: Number(row.last_player_damage ?? 0),
      foresight: parseJson<BattleState['foresight']>(row.foresight_json, null),
      startedAt: Number(row.started_at),
      lastRoundAt: Number(row.last_round_at),
      resolvedAt:
        row.resolved_at === null || row.resolved_at === undefined ? null : Number(row.resolved_at),
    };
  }
}
