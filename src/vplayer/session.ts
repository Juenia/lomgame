/**
 * 会话模拟（W7）
 *   - 每天按画像登录多次，登录时间在当天内按 seed 分布
 *   - 每次登录按画像发若干条指令，指令间隔 11—19 秒（虚拟时间，由测试驱动服务端时钟）
 *   - 间隔跨过 .扮演 的 10 秒令牌桶冷却：玩家想刷消化度就会等冷却，而不是白刷一次被拒
 *   - 第 0 天建号，第 1—7 天正常游玩
 * 所有动作都走真实 HTTP；状态快照读库（等价于玩家看自己的 .状态/.背包）。
 */
import type { Db } from '../infra/db/sqlite.ts';
import type { PathwayId } from '../domain/character/types.ts';
import { dateKey } from '../infra/date.ts';
import { createSeededRng, seedFrom } from '../domain/rng.ts';
import { BATTLE, NUMERIC } from '../config/numeric.ts';
// M2.18 第 0.5 步：上限检查要能看见**教会技能**（第二层能力），见 readStatCaps
import { loadChurchAbilities, loadChurches } from '../data/loader.ts';
import { unlockedChurchAbilities, type ChurchAbilityDef } from '../domain/ability/ability.ts';
import { currentRank } from '../domain/church/membership.ts';
import type { ChurchDef } from '../domain/church/schema.ts';
import {
  checkAction,
  checkDeadlock,
  checkSnapshotConsistency,
} from './anomaly.ts';
import { commandNameOf } from './coverage.ts';
import { isRejected } from './analyzer.ts';
import { decide } from './decide.ts';
import {
  MENU_MARKER,
  PARTY_GONE_PATTERN,
  WORLD_EVENT_MARKER,
  type MenuSnapshot,
  type PlayerHttp,
  type FakeInbox,
  type GroupChatLog,
} from './http.ts';
import type { Recorder } from './recorder.ts';
import type {
  ActionRecord,
  AnomalyRecord,
  DecisionContext,
  PlayerProfile,
  PlayerSnapshot,
  WorldKnowledge,
} from './types.ts';

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * M2.5：此刻正在举行仪式、且还在干扰窗口内的人（角色名，不含自己）。
 *
 * 为什么让虚拟玩家直接读库：真实玩家只能从群里那条**匿名**播报知道「有人在做仪式」，
 * 不知道是谁 —— 那正是匿名的意义。可如果虚拟玩家也猜不到名字，
 * `.干扰` 这条链路在实例测试里就永远打不到人，覆盖率会永远缺一项。
 * 所以这里给它一个测试专有的作弊视角，游戏规则本身不受影响。
 */
export function runningRitualNames(
  db: Db,
  now: number,
  selfUserId: string,
): string[] {
  try {
    const rows = db
      .prepare(
        "SELECT c.name AS name, c.user_id AS userId FROM rituals r JOIN characters c ON c.id = r.character_id " +
          "WHERE r.status = 'running' AND r.started_at IS NOT NULL AND r.started_at + ? > ?",
      )
      .all(NUMERIC.interference.windowMs, now) as Array<{ name: string; userId: string }>;
    return rows.filter((row) => String(row.userId) !== selfUserId).map((row) => String(row.name));
  } catch {
    return [];
  }
}

/**
 * M2.6.1：同批玩家的序列（不含自己）。
 *
 * 一天读一次即可 —— 袭击是低频动作（5%），每一步都查一次全表不值得。
 * 代价是"同一天里别人刚晋升"要等到第二天才被看到，对实例测试没有影响。
 */
export function readPeers(
  db: Db,
  selfUserId: string,
): Array<{ userId: string; name: string; sequence: number; locationId: string | null; status: string }> {
  try {
    const rows = db
      .prepare(
        'SELECT c.user_id, c.name, c.sequence, c.status, ' +
          "(SELECT value FROM flags f WHERE f.character_id = c.id AND f.flag = 'loc') AS loc, " +
          "(SELECT COUNT(*) FROM battles b WHERE b.status = 'active' " +
          'AND (b.character_id = c.id OR b.opponent_character_id = c.id)) AS in_battle ' +
          'FROM characters c',
    
      )
      .all() as Array<Record<string, unknown>>;
    return rows
      .filter((row) => String(row.user_id) !== selfUserId)
      .map((row) => ({
        userId: String(row.user_id),
        name: String(row.name),
        sequence: Number(row.sequence),
        // M2.10：挑战的发起条件之一是**同地点** —— 虚拟玩家不知道对手在哪就只会撞墙
        locationId: row.loc === null || row.loc === undefined ? null : String(row.loc),
        status: String(row.status ?? 'active'),
        // M2.10：他是不是正在打 —— 拿这个筛掉「对方在战斗中」那类必被拒的尝试
        inBattle: Number(row.in_battle ?? 0) > 0,
      }));
  } catch {
    return [];
  }
}

/**
 * M2.6：此刻全服被通缉的人（角色名，不含自己）。
 *
 * 与 runningRitualNames 同一类做法（**测试工具特权**）：真人只能从群里那条
 * 「某处发生命案」的播报知道有人被通缉，不知道是谁。不给这个视角，
 * `.举报` 这条链路在实例测试里永远无的放矢，覆盖率会永远缺一项。
 * 游戏规则本身不受影响 —— 这里只是把库里的公开事实（谁身上有通缉令）喂给测试侧。
 *
 * 不过滤"目标是否在势力范围内"：举报失败（对方躲进了无主地点）本身
 * 就是必须被覆盖到的一条路径，替玩家筛掉它反而会让失败路径永远测不到。
 */
export function wantedNamesInWorld(db: Db, now: number, selfUserId: string): string[] {
  try {
    const rows = db
      .prepare(
        'SELECT c.name AS name, c.user_id AS userId FROM wanted_states w ' +
          'JOIN characters c ON c.id = w.character_id WHERE w.expires_at > ?',
      )
      .all(now) as Array<{ name: string; userId: string }>;
    return [...new Set(rows.filter((row) => String(row.userId) !== selfUserId).map((row) => String(row.name)))];
  } catch {
    return [];
  }
}

/**
 * 指令之间的虚拟间隔：11—19 秒。
 * 依据 config/numeric.ts 的 RATE_LIMITS（扮演 capacity 1、refill 1/10s）：
 * 间隔低于 10 秒时，玩家自己的下一条 .扮演 会被冷却挡掉——那不是数值问题，
 * 是测试脚本不等冷却的问题。真人玩家刷消化度时是会等这 10 秒的。
 */
export const MIN_ACTION_GAP_SEC = 11;
export const GAP_JITTER_SEC = 9;

/**
 * M2.9：战斗里「连打」的每回合虚拟间隔（秒）。
 *
 * 12 秒与普通动作间隔（11—19 秒）同一个量级，而**远小于** `BATTLE.playerTimeoutMs`
 * 的 300 秒 —— 这是它必须满足的唯一条件：跨过 300 秒就会被判超时，
 * 那些回合又会被自动防御填掉（正是这条修正要解决的问题）。
 */
export const BATTLE_ROUND_GAP_SEC = 12;

/** 本该改变角色状态的指令（连续无效才算卡住） */
export const ACTION_COMMANDS = new Set([
  '扮演',
  '探索',
  '事件',
  '魔药',
  '服用',
  '晋升',
  '休息',
  '净化',
  '占卜',
  '使用',
  '交易',
  '确认',
  '取消',
  // M2.5：仪式与干扰都要参与「卡死」检测（前者会晋升/重伤，后者会消耗与涨 COR）。
  // 但**仪式的配置类子命令**（准备 / 地点 / 时间 / 见证 / 取消）只动 rituals 表，
  // 一点也不改角色状态 —— 把它们算成「本该改变状态」会刷出一长串假 P1
  // （200×14 第一轮实测：片 0/2/3 各 15/32/22 条 NO_STATE_CHANGE，全部来自这几条子命令）。
  // 所以下面用 ritualConfigOnly() 把它们摘出去。
  '仪式',
  '干扰',
  // M2.6：袭击会改双方状态（掉血 / 重伤），举报会改 AP 与背包里的钱
  '袭击',
  '举报',
]);

/** M2.5：只改仪式配置、不改角色状态的子命令 */
const RITUAL_CONFIG_SUBS = new Set(['准备', '地点', '时间', '见证', '取消']);

/**
 * 这条指令是不是「只改配置、不改角色状态」的仪式子命令。
 * 判据是指令名 + 子命令名，所以 .仪式 开始 / .仪式 融合 仍然会被卡死检测盯着。
 */
export function ritualConfigOnly(command: string): boolean {
  const parts = command.replace(/^[.。．]/, '').trim().split(/\s+/);
  if (parts[0] !== '仪式') return false;
  return RITUAL_CONFIG_SUBS.has(parts[1] ?? '准备');
}

export function signatureOf(snapshot: import('./types.ts').PlayerSnapshot): string {
  return [
    snapshot.dig,
    snapshot.mad,
    snapshot.cor,
    snapshot.hp,
    snapshot.mp,
    snapshot.dp,
    snapshot.sequence,
    snapshot.status,
    snapshot.promotionFails,
    snapshot.inventory.length,
    // 库存总件数：.交易 冻结物品会减数量但栏位数不变，只看 length 会把交易判成「卡住」
    snapshot.inventory.reduce((sum, slot) => sum + slot.quantity, 0),
    snapshot.pendingTradeCount,
    snapshot.flags.size,
  ].join('|');
}

export interface SessionOptions {
  db: Db;
  http: PlayerHttp;
  inbox: FakeInbox;
  recorder: Recorder;
  world: WorldKnowledge;
  /** 虚拟时间基准（第 0 天 00:00） */
  baseEpoch: number;
  /** 群聊台账（方案 C）：把群里出现过的组队公告记下来，供决策层使用 */
  chat: GroupChatLog;
  /** 异常回调 */
  onAnomaly: (anomaly: AnomalyRecord) => void;
}

export function readSnapshot(
  db: Db,
  profile: PlayerProfile,
  date: string,
  now: number = Date.now(),
): PlayerSnapshot {
  const row = db
    .prepare('SELECT * FROM characters WHERE user_id = ?')
    .get(profile.userId) as Record<string, unknown> | undefined;

  if (!row) {
    return {
      exists: false,
      characterId: '',
      name: profile.name,
      sequence: 9,
      hp: 100,
      mp: 100,
      mad: 0,
      cor: 0,
      dig: 0,
      dp: 0,
      status: 'active',
      promotionFails: 0,
      inventory: [],
      flags: new Set(),
      pendingTradeCount: 0,
      dailyCounters: {},
      exploreCounts: {},
      triggeredToday: new Map(),
      partyId: null,
      partySize: 1,
      isPartyLeader: false,
      ritualPreparing: false,
      ritualRunning: false,
      ritualLocationId: null,
      wantedLevel: 0,
      wantedFactionId: null,
      currentLocationId: null,
      currentCityId: null,
      churchId: null,
      churchContribution: 0,
      nearbyCreatures: [],
      traveling: false,
      travelRemainingHours: 0,
      reputation: 0,
      pathwayId: null,
      /*
       * M2.7.6：还没有角色时，唯一可能的状态是「已经发了 .创建 姓名，正等着回性别」。
       * 那张菜单挂在 'create:<userId>' 上（见 router/commands/create-menu.ts）——
       * 玩家此刻还没有 characterId，所以查不到它就只能是一次普通的「还没建号」。
       */
      genderPending: hasPendingCreateMenu(db, profile.userId),
    };
  }

  const characterId = String(row.id);
  // M2.5：仪式状态（有没有攒着的配置 / 有没有在等的融合）
  const ritualRows = db
    .prepare(
      "SELECT status, config_json FROM rituals WHERE character_id = ? AND status IN ('preparing', 'running')",
    )
    .all(characterId) as Array<{ status: string; config_json: string }>;
  const ritualPreparing = ritualRows.some((entry) => entry.status === 'preparing');
  const ritualRunning = ritualRows.some((entry) => entry.status === 'running');
  const ritualLocationId =
    ritualRows
      .map((entry) => {
        try {
          return JSON.parse(String(entry.config_json)) as { locationId?: string | null };
        } catch {
          return {} as { locationId?: string | null };
        }
      })
      .find((config) => typeof config.locationId === 'string')?.locationId ?? null;
  const inventory = (
    db
      .prepare('SELECT item_id, quantity, bind_type FROM inventory WHERE character_id = ? AND quantity > 0')
      .all(characterId) as Array<{ item_id: string; quantity: number; bind_type: string }>
  ).map((slot) => ({ itemId: slot.item_id, quantity: slot.quantity, bindType: slot.bind_type }));

  const flags = new Set(
    (
      db.prepare('SELECT flag FROM flags WHERE character_id = ?').all(characterId) as Array<{
        flag: string;
      }>
    ).map((entry) => entry.flag),
  );

  const dailyCounters: Record<string, number> = {};
  for (const entry of db
    .prepare('SELECT key, count FROM daily_counters WHERE character_id = ? AND date = ?')
    .all(characterId, date) as Array<{ key: string; count: number }>) {
    dailyCounters[entry.key] = entry.count;
  }

  const exploreCounts: Record<string, number> = {};
  for (const entry of db
    .prepare('SELECT location_id, count FROM explore_daily WHERE character_id = ? AND date = ?')
    .all(characterId, date) as Array<{ location_id: string; count: number }>) {
    exploreCounts[entry.location_id] = entry.count;
  }

  // M2.69：读**次数**（与 EventTriggerRepo.countsOn 同一口径 —— 这里是为了少开一次仓储）
  const triggeredToday = new Map(
    (
      db
        .prepare('SELECT event_id, count FROM event_triggers WHERE character_id = ? AND date = ?')
        .all(characterId, date) as Array<{ event_id: string; count: number }>
    ).map((entry) => [entry.event_id, Number(entry.count ?? 1)]),
  );

  const pendingTradeCount = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM trades WHERE status = 'pending' AND (seller_id = ? OR buyer_id = ?)",
      )
      .get(characterId, characterId) as { n: number }
  ).n;

  const partyRow = db
    .prepare(
      `SELECT p.id AS party_id, p.leader_id AS leader_id,
              (SELECT COUNT(*) FROM party_members m2 WHERE m2.party_id = p.id) AS size
       FROM parties p JOIN party_members m ON m.party_id = p.id
       WHERE m.character_id = ? AND p.status = 'active' LIMIT 1`,
    )
    .get(characterId) as { party_id: string; leader_id: string; size: number } | undefined;

  // M2.6：通缉状态。取**等级最高的那条有效通缉令**——真人从 .状态 的通缉行看到的是同一个数
  const wantedRow = db
    .prepare(
      'SELECT level, faction_id, expires_at FROM wanted_states WHERE character_id = ? AND expires_at > ? ORDER BY level DESC, created_at DESC LIMIT 1',
    )
    .get(characterId, now) as { level: number; faction_id: string; expires_at: number } | undefined;
  // M2.6：此刻在哪。真实玩家自己记得"上次探索去了哪"，虚拟玩家直接读同一个 flag
  const locationRow = db
    .prepare("SELECT value FROM flags WHERE character_id = ? AND flag = 'loc' LIMIT 1")
    .get(characterId) as { value: string | null } | undefined;
  const reputationRow = db
    .prepare("SELECT value FROM flags WHERE character_id = ? AND flag = 'reputation' LIMIT 1")
    .get(characterId) as { value: string | null } | undefined;

  return {
    exists: true,
    characterId,
    name: String(row.name),
    sequence: Number(row.sequence),
    hp: Number(row.hp),
    mp: Number(row.mp),
    mad: Number(row.mad),
    cor: Number(row.cor),
    dig: Number(row.dig),
    dp: Number(row.dp),
    status: String(row.status),
    promotionFails: Number(row.promotion_fails ?? 0),
    inventory,
    flags,
    pendingTradeCount,
    dailyCounters,
    exploreCounts,
    triggeredToday,
    partyId: partyRow?.party_id ?? null,
    partySize: partyRow?.size ?? 1,
    isPartyLeader: partyRow ? partyRow.leader_id === characterId : false,
    ritualPreparing,
    ritualRunning,
    ritualLocationId,
    wantedLevel: wantedRow?.level ?? 0,
    wantedFactionId: wantedRow?.faction_id ?? null,
    currentLocationId: locationRow?.value ?? null,
    /*
     * M2.8：脚下这个地点此刻有哪些生物。
     * 用 locationRow 的位置（他上次探索/到达的地方），而不是城市 —— 生物是按地点分布的。
     * 表可能不存在（旧库没跑过 0017）时静默给空数组，不让跑批因为这个挂掉。
     */
    nearbyCreatures: (() => {
      const locationId = locationRow?.value ?? null;
      if (!locationId) return [];
      try {
        const rows = db
          .prepare('SELECT species_id, sequence, hp, status FROM creatures WHERE location_id = ? ORDER BY sequence ASC')
          .all(locationId) as Array<Record<string, unknown>>;
        return rows.map((entry) => ({
          speciesId: String(entry.species_id),
          sequence: Number(entry.sequence),
          hp: Number(entry.hp),
          status: String(entry.status),
        }));
      } catch {
        return [];
      }
    })(),
    /*
     * M2.9：此刻有没有一场没打完的战斗。
     * 与 nearbyCreatures 同一个口径：读的是同一个库，只是比真人多看一眼
     * （真人从 .战斗 的那一屏读得到同样的信息）。
     * 表可能不存在（旧库没跑过 0018）时静默给 undefined，不让跑批因为这个挂掉。
     */
    activeBattle: (() => {
      try {
        const row = db
          .prepare(
            "SELECT id, round, species_id, species_name, creature_hp, creature_max_hp, creature_sequence, creature_berserk, player_hp, player_mp, player_status_json, creature_playing_dead, is_pvp, turn_of, character_id, opponent_character_id FROM battles WHERE status = 'active' AND (character_id = ? OR opponent_character_id = ?) ORDER BY started_at DESC LIMIT 1",
          )
          .get(characterId, characterId) as Record<string, unknown> | undefined;
        if (!row) return undefined;
        const isPvp = Number(row.is_pvp ?? 0) !== 0;
        const isChallenger = String(row.character_id) === characterId;
        const turnOf = String(row.turn_of ?? 'challenger');
        return {
          battleId: String(row.id),
          round: Number(row.round),
          speciesId: String(row.species_id),
          speciesName: String(row.species_name),
          creatureHp: Number(row.creature_hp),
          creatureMaxHp: Number(row.creature_max_hp),
          creatureSequence: Number(row.creature_sequence),
          creatureBerserk: Number(row.creature_berserk ?? 0) !== 0,
          playerHp: Number(row.player_hp),
          playerMp: Number(row.player_mp),
          playerStatuses: (JSON.parse(String(row.player_status_json ?? '[]')) as Array<{ id: string }>).map(
            (entry) => String(entry.id),
          ),
          creaturePlayingDead: Number(row.creature_playing_dead ?? 0) !== 0,
          isPvp,
          // PVP 里「对手的名字」就是 species_name 那一列（语义见 domain/battle/types.ts）
          opponentName: isPvp ? String(row.species_name) : null,
          // 轮到我了吗：PVE 永远是（生物不等你）；PVP 看 turn_of 与我在哪一边
          yourTurn: !isPvp || (isChallenger ? turnOf === 'challenger' : turnOf === 'opponent'),
          isChallenger,
        };
      } catch {
        return undefined;
      }
    })(),
    /*
     * M2.13 前置 4：有没有一只「还没处置」的生物站在那里。
     * 与 nearbyCreatures / activeBattle 同一个口径：读同一个库，只是比真人多看一眼
     * （真人从私聊里那张遭遇菜单读得到同样的信息）。
     * 表可能不存在（旧库没跑过 0017）时静默给 undefined，不让跑批因为这个挂掉。
     */
    pendingSighting: (() => {
      try {
        const row = db
          .prepare('SELECT 1 AS n FROM sightings WHERE character_id = ? AND action IS NULL LIMIT 1')
          .get(characterId) as { n: number } | undefined;
        return Boolean(row);
      } catch {
        return undefined;
      }
    })(),
    // M2.7：此刻在哪座城市（.探索 的城市校验、移动决策都要它）
    // M2.7：在路上（服务端在途只放行查看类指令，虚拟玩家必须知道）
    ...(() => {
      const travelRow = db
        .prepare("SELECT arrives_at FROM travels WHERE character_id = ? AND status = 'traveling' ORDER BY started_at DESC LIMIT 1")
        .get(characterId) as { arrives_at: number } | undefined;
      const remaining = travelRow ? Math.max(0, travelRow.arrives_at - now) / 3600000 : 0;
      return {
        traveling: Boolean(travelRow),
        travelRemainingHours: Number(remaining.toFixed(2)),
      };
    })(),
    currentCityId: row.current_city_id === null || row.current_city_id === undefined
      ? null
      : String(row.current_city_id),
    reputation: reputationRow?.value === null || reputationRow?.value === undefined
      ? NUMERIC.wanted.reputation.initial
      : Number(reputationRow.value),
    // M2.7.6：普通人阶段的三件事 —— 有没有途径、有没有人在等他回话、手上有没有那张纸
    pathwayId: row.pathway === null || row.pathway === undefined ? null : (String(row.pathway) as PathwayId),
    // M2.16：教会（老库没有这两列时按「未入教」读 —— 与 CharacterRepo.toState 同一口径）
    churchId: row.church_id === null || row.church_id === undefined ? null : String(row.church_id),
    churchContribution: Number(row.church_contribution ?? 0),
    mortal: String(row.pathway_status ?? '') !== 'initiated' && !row.pathway,
      clueCount: (
      db
        .prepare('SELECT COUNT(*) AS n FROM recipe_clues WHERE character_id = ? AND used_at IS NULL')
        .get(characterId) as { n: number }
    ).n,
    ...recipeStateFor(db, characterId),
  };
}

/**
 * M2.7.7：这个人手上有没有配方（与服务端 recipePathwaysOf 同一条口径）。
 *
 * 两个来源，缺一不可：
 *   1. 还没用掉的配方线索（自己翻到的那张纸）；
 *   2. **已经给到手**的势力配方 —— 判据是 stage 走到 recipe_given / task_done，
 *      不是「有未决邀约就算」（那是 M2.7.6 的一个口径错误，见 initiation-hooks.ts）。
 */
function recipeStateFor(db: Db, characterId: string): {
  hasRecipe: boolean;
  recipePathway: PathwayId | null;
} {
  const clue = db
    .prepare(
      'SELECT pathway FROM recipe_clues WHERE character_id = ? AND used_at IS NULL ORDER BY found_at ASC LIMIT 1',
    )
    .get(characterId) as { pathway: string } | undefined;
  if (clue) return { hasRecipe: true, recipePathway: clue.pathway as PathwayId };

  /* M2.85：原来的另一半来源（pathway_offers 的势力配方）随引导玩法一并删除。 */
  return { hasRecipe: false, recipePathway: null };
}

/** M2.7.6：他有没有一张「等着回性别」的菜单（归属键是 create:<userId>） */
function hasPendingCreateMenu(db: Db, userId: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM pending_menus WHERE character_id = ? AND menu_type = 'create'")
    .get(`create:${userId}`) as { ok: number } | undefined;
  return Boolean(row);
}

/**
 * 已解锁能力带来的数值上限（战士序列 8：HP 上限 +10）。
 * 只读 abilities 表 + flags，规则与 domain/ability.ts 的 capsFromAbilityEffects 一致：
 * 检查器必须按「玩家面板上真正显示的上限」判定，否则合法值会被误报成 P0。
 */
/**
 * M2.18 第 0.5 步：上限检查要用的两层能力。
 *
 * 教会技能**不落库**（它按 churchId + rank 算出来，M2.17 的设计），
 * 所以这里从内容表加载一次、模块级缓存 —— 内容表是静态的，缓存没有失效问题。
 */
export interface ChurchContentForCaps {
  churches: readonly ChurchDef[];
  abilities: readonly ChurchAbilityDef[];
}

let cachedChurchContent: ChurchContentForCaps | null = null;

function churchContentForCaps(): ChurchContentForCaps {
  if (!cachedChurchContent) {
    cachedChurchContent = {
      churches: loadChurches().churches,
      abilities: loadChurchAbilities().abilities,
    };
  }
  return cachedChurchContent;
}

/**
 * 玩家此刻的数值上下限（**检查器视角**）。
 *
 * ## M2.18 第 0.5 步：补上第二层能力（教会技能）
 *
 * M2.17 的 A2 取证发现：执行层（`capsFromAbilityEffects`）算的是「途径能力 + 教会技能」两源，
 * 而这个检查器**只查 abilities 表** —— 于是战神 rank 3 的信徒在执行层是 125、在这里是 110，
 * 而 HP 111—125 会被判成越界 P0（正是下面那段注释警告的场景）。
 *
 * 修法保持 M2.17 的设计不变（**教会技能不落库**）：读 characters 的 church_id / contribution，
 * 用 `currentRank` + `unlockedChurchAbilities` 两个**已有的纯函数**把第二层算出来。
 *
 * `churchContent` 参数只为测试注入用；生产路径走模块级缓存的内容表。
 */
export function readStatCaps(
  db: Db,
  characterId: string,
  pathway: string,
  churchContent: ChurchContentForCaps = churchContentForCaps(),
): Record<string, [number, number]> {
  const rows = db
    .prepare(
      `SELECT a.effect_json AS effect FROM abilities a
       JOIN flags f ON f.character_id = ? AND f.flag = 'ability_' || a.pathway || '_' || a.seq
       WHERE a.pathway = ?`,
    )
    .all(characterId, pathway) as Array<{ effect: string }>;

  let hpBonus = 0;
  let mpBonus = 0;
  for (const row of rows) {
    const effect = JSON.parse(row.effect || '{}') as { maxHpBonus?: number; maxMpBonus?: number };
    hpBonus += effect.maxHpBonus ?? 0;
    mpBonus += effect.maxMpBonus ?? 0;
  }

  /*
   * M2.18 第 0.5 步：**第二层 —— 教会技能**。
   * 它与途径能力叠在同一个数上（执行层也是这么合的，见 mergeAbilityEffects 的两源注释）。
   */
  const member = db
    .prepare('SELECT church_id, church_contribution, sequence FROM characters WHERE id = ?')
    .get(characterId) as
    | { church_id: string | null; church_contribution: number | null; sequence: number | null }
    | undefined;
  const churchId = member?.church_id ?? null;
  if (churchId) {
    const church = churchContent.churches.find((entry) => entry.id === churchId);
    if (church) {
      const rank = currentRank(
        { churchContribution: member?.church_contribution ?? 0, sequence: member?.sequence ?? null },
        church,
      );
      for (const ability of unlockedChurchAbilities(rank, churchId, churchContent.abilities)) {
        hpBonus += ability.effect.maxHpBonus ?? 0;
        mpBonus += ability.effect.maxMpBonus ?? 0;
      }
    }
  }

  const caps: Record<string, [number, number]> = {};
  if (hpBonus !== 0) caps.hp = [0, 100 + hpBonus];
  if (mpBonus !== 0) caps.mp = [0, 100 + mpBonus];
  return caps;
}

interface PendingTrade {
  id: string;
  fromUserId: string;
  price: number;
}

/** 从收件箱里解析交易单号（模拟玩家读私聊） */
export function parseTradeNotices(messages: Array<{ text: string }>): PendingTrade[] {
  const out: PendingTrade[] = [];
  for (const message of messages) {
    const matched = /单号：(\w{6})/.exec(message.text);
    if (matched) out.push({ id: matched[1]!, fromUserId: '', price: 0 });
  }
  return out;
}

/** 一天的虚拟时间线：登录时刻 + 每条指令的虚拟时间与间隔 */
export function planDayTimeline(
  profile: PlayerProfile,
  day: number,
): Array<{ login: number; steps: Array<{ step: number; intervalSec: number }> }> {
  const rng = createSeededRng(seedFrom([profile.seed, 'timeline', day]));
  const logins: Array<{ login: number; steps: Array<{ step: number; intervalSec: number }> }> = [];
  const loginCount = Math.max(1, profile.loginTimesPerDay);
  const slot = MS_PER_DAY / loginCount;
  for (let login = 0; login < loginCount; login += 1) {
    const steps: Array<{ step: number; intervalSec: number }> = [];
    for (let step = 0; step < profile.actionsPerLogin; step += 1) {
      steps.push({ step, intervalSec: MIN_ACTION_GAP_SEC + Math.floor(rng.next() * GAP_JITTER_SEC) });
    }
    logins.push({ login, steps });
  }
  return logins;
}

export interface PlayerDayResult {
  actions: ActionRecord[];
  anomalies: AnomalyRecord[];
}

/** 跑一个玩家的一天 */
export async function runPlayerDay(
  options: SessionOptions,
  profile: PlayerProfile,
  day: number,
  virtualDayStart: number,
): Promise<PlayerDayResult> {
  const { db, http, inbox, recorder, world, chat } = options;
  const actions: ActionRecord[] = [];
  const anomalies: AnomalyRecord[] = [];
  const pendingTrades: PendingTrade[] = [];
  const handledTrades = new Set<string>();
  const visited = new Set<string>();

  const timeline = planDayTimeline(profile, day);
  /**
   * M2.3 对照实验（任务书 §7.3）：偶数号玩家走菜单路径（收菜单 → 回数字），
   * 奇数号走完整指令路径（直接发指令）。两条路必须给出同一份判定结果。
   */
  const menuPath = profile.id % 2 === 0;
  /** 服务端此刻挂着的菜单（上一条指令的回执里出现过「回复数字。」才去拉） */
  let pendingMenu: MenuSnapshot | null = null;
  let messageSeq = 0;
  /** 当天成功打出去的 .扮演 次数：决定下一条扮演该押哪个标签 */
  let playsToday = 0;
  let previousSignature: string | null = null;
  let noChangeStreak = 0;
  /** 上一条被系统拒绝的指令（"冷却中" 之类），玩家会换招 */
  let lastRejectedCommand: string | null = null;
  // M2.6.1：同批玩家的序列，一天读一次（袭击目标选择要用）
  const peers = readPeers(db, profile.userId);

  for (const login of timeline) {
    let cursor = virtualDayStart + (MS_PER_DAY / timeline.length) * login.login;
    /** 这次登录里为了打完一架额外多打的回合数（见循环末尾那段） */
    let battleStepsThisLogin = 0;
    // ⚠️ 用下标而不是 for...of：循环末尾会往 login.steps 里**追加**战斗回合，
    //    而那个追加是有意的（M2.8 抓到的「新生代连锁生育」是同一手法用错了地方）
    for (let stepIndex = 0; stepIndex < login.steps.length; stepIndex += 1) {
      const step = login.steps[stepIndex]!;
      cursor += step.intervalSec * 1000;
      const date = dateKey(cursor);

      await http.pinClock(cursor);
      const snapshot = readSnapshot(db, profile, date, cursor);
      const runningRituals = runningRitualNames(db, cursor, profile.userId);
      const wantedNames = wantedNamesInWorld(db, cursor, profile.userId);

      const context: DecisionContext = {
        profile,
        snapshot,
        playsToday,
        day,
        login: login.login,
        step: step.step,
        visitedLocations: visited,
        pendingTrades,
        lastRejected: lastRejectedCommand,
        // 方案 C：群里公告过的队伍（虚拟时间口径，同 seed 同结果）
        knownParties: chat.openParties(cursor),
        menuPath,
        pendingMenu,
        // M2.5：谁在举行仪式（测试工具特权，见 types.ts 的说明）
        runningRituals,
        // M2.6：谁被通缉（同类特权）
        wantedNames,
        // M2.6.1：同批玩家的序列（同类特权）
        peers,
      };
      const decision = decide(context, world);
      /*
       * M2.7.6：玩家自己决定「今天不玩了」。
       * 这不是偷懒的兜底 —— 普通人阶段确实存在「没事可做」的时刻，
       * 而继续发指令只会得到拒绝（拒绝不算卡死，但会灌满异常清单）。
       */
      if (decision.skip) break;
      // 菜单路径下 decision.command 是一个数字，真正执行的是菜单里那一条完整指令。
      // 日志、覆盖率、异常检测一律按 effectiveCommand 记 —— 否则全会被统计成「1」。
      const effectiveCommand = decision.menuPath
        ? (pendingMenu?.options.find((option) => option.key === decision.command)?.command ??
          decision.command)
        : decision.command;

      messageSeq += 1;
      const scene: 'private' | 'group' = step.step % 3 === 0 ? 'group' : 'private';
      const result = await http.send({
        messageId: `vp-${profile.id}-${day}-${login.login}-${step.step}`,
        userId: profile.userId,
        rawText: decision.command,
        scene,
        nickname: profile.name,
      });

      if (/^\.探索\s+(.+)$/.test(effectiveCommand)) {
        visited.add(effectiveCommand.replace(/^\.探索\s+/, '').trim());
      }

      // 服务端的出站回执是异步发的（HTTP 响应先返回，消息后到）：
      // 不等一下就 drain，会把"被冷却挡回"的指令误判成"执行了但状态没变"。
      await inbox.flush();
      const inboxMessages = inbox.drainPrivate(profile.userId);
      // 自己挂的单子：卖家回执里也有单号，但只有买家能确认 —— 记成「已处理」，别自己确认自己
      if (/^\.交易\s/.test(effectiveCommand.trim())) {
        for (const notice of parseTradeNotices(inboxMessages)) handledTrades.add(notice.id);
      }
      for (const notice of parseTradeNotices(inboxMessages)) {
        if (!handledTrades.has(notice.id)) pendingTrades.push(notice);
      }
      // 已经确认/取消过的单子不要再重复处理
      if (/^\.(确认|取消)\s+(\w{6})$/.test(effectiveCommand.trim())) {
        const id = effectiveCommand.trim().split(/\s+/)[1];
        if (id) {
          handledTrades.add(id);
          const index = pendingTrades.findIndex((trade) => trade.id === id);
          if (index >= 0) pendingTrades.splice(index, 1);
        }
      }
      while (pendingTrades.length > 6) pendingTrades.shift();

      const record: ActionRecord = {
        playerId: profile.id,
        persona: profile.persona,
        goal: profile.goal,
        day,
        login: login.login,
        step: step.step,
        virtualNow: cursor,
        intervalSec: step.intervalSec,
        command: effectiveCommand,
        ...(decision.menuPath ? { menuPath: true as const, rawSent: decision.command } : {}),
        // M2.4：这一步回的数字来自世界播报（而不是自己的个人菜单）—— 验收证据
        ...(pendingMenu?.menuType === 'world_event' ? { worldEvent: true as const } : {}),
        reason: decision.reason,
        status: result.status,
        costMs: Number(result.costMs.toFixed(2)),
        replies: inboxMessages.length,
        replyTexts: inboxMessages.slice(0, 3).map((message) => message.text.slice(0, 200)),
      };
      recorder.record(record);
      actions.push(record);
      const rejected = isRejected(record.replyTexts);
      lastRejectedCommand = rejected ? commandNameOf(effectiveCommand) : null;
      // 方案 C 的收尾：加入一个已解散/已满/不存在的队之后，把它从群聊台账里划掉。
      // 不这么做的话，一次 20×3 的小轮就能打出 209 次加入、214 次被拒（其中 170 次是死队）。
      const joinAttempt = /^\.?队伍\s+加入\s+([0-9A-Za-z]{4,12})$/.exec(effectiveCommand.trim());
      if (joinAttempt?.[1] && PARTY_GONE_PATTERN.test(record.replyTexts.join(' '))) {
        chat.close(joinAttempt[1]);
      }
      // 被拒的扮演不计入标签用量（服务端在 handler 之前就挡掉了，标签也没记上）
      if (!rejected && commandNameOf(effectiveCommand) === '扮演') playsToday += 1;

      // 异常检测
      // 无状态变化只统计「本该改变状态」的指令：查帮助、看状态这类不算卡住
      const name = commandNameOf(effectiveCommand);
      const isActionCommand = ACTION_COMMANDS.has(name) && !ritualConfigOnly(effectiveCommand);
      if (isActionCommand && snapshot.exists && !rejected) {
        const post = readSnapshot(db, profile, date, cursor);
        const changed = signatureOf(post) !== signatureOf(snapshot);
        noChangeStreak = changed ? 0 : noChangeStreak + 1;
      } else {
        // 被系统明确拒绝的指令不算卡死：玩家已经拿到原因，下一轮就会换招
        noChangeStreak = 0;
      }
      previousSignature = signatureOf(snapshot);
      void previousSignature;

      for (const anomaly of checkAction({ record, noChangeStreak })) {
        anomalies.push(anomaly);
        options.onAnomaly(anomaly);
      }
      // 群聊回执也归到这个玩家头上（覆盖率与拒绝率都要用到）；
      // 注意只取群聊：私聊要留给它真正的收件人，不能被顺手清掉
      // M2.3：回执里出现「回复数字。」= 服务端刚递了一份菜单。
      // 这时候才去拉结构化菜单（多一次 HTTP 只在菜单真的出现时发生，长跑开销可控）。
      pendingMenu = inboxMessages.some((message) => message.text.includes(MENU_MARKER))
        ? await http.menu(profile.userId)
        : null;

      const groupReplies = inbox.drainGroup().filter((message) => message.path === 'send_group_msg');
      if (groupReplies.length > 0) {
        // 方案 C：群里读到的组队公告要真的进决策，而不是只算进覆盖率
        chat.ingest(groupReplies, cursor);
        record.replies += groupReplies.length;
        for (const reply of groupReplies.slice(0, 2)) record.replyTexts.push(reply.text.slice(0, 200));
      }

      // M2.4：群里读到世界播报 → 玩家会去私聊回数字（任务书 §4「引导去私聊」）。
      // 服务端的数字回复有两条菜单源，个人菜单优先；这里只在**没有个人菜单**时
      // 去拉「房间里那张」世界事件菜单，下一步就按它回数字。
      // 为什么放在群里读完之后：播报是异步到的，先 drainGroup 才看得到它。
      if (!pendingMenu && groupReplies.some((message) => message.text.includes(WORLD_EVENT_MARKER))) {
        const shared = await http.menu(profile.userId);
        if (shared && shared.menuType === 'world_event') pendingMenu = shared;
      }

      // 每 3 条指令做一次完整一致性检查（读库，成本可控）
      if (messageSeq % 3 === 0 && snapshot.exists) {
        const where = {
          playerId: profile.id,
          day,
          virtualNow: cursor,
          command: effectiveCommand,
        };
        const fresh = readSnapshot(db, profile, date, cursor);
        /*
         * M2.7.6：上限按他**实际**走上的那条途径算，不是按 profile 里的偏好。
         * 两者从 M2.7.6 起可以不一致（M2.85 起途径只由线索决定），
         * 用错那一个会把合法的「战士序列 8 · HP 110」误报成 P0。
         */
        const caps = fresh.characterId
          ? readStatCaps(db, fresh.characterId, fresh.pathwayId ?? profile.pathway)
          : {};
        for (const anomaly of checkSnapshotConsistency(db, fresh, where, caps)) {
          anomalies.push(anomaly);
          options.onAnomaly(anomaly);
        }
        const deadlock = checkDeadlock(fresh, where);
        if (deadlock) {
          anomalies.push(deadlock);
          options.onAnomaly(deadlock);
        }
      }

      /*
       * M2.9：**架没打完就不下线。**
       *
       * 为什么必须有这一段：战斗的超时是**虚拟时间**的 5 分钟，而虚拟玩家两次登录之间
       * 会跳过好几个小时 —— 打一个回合就去做别的事，回来时服务端已经按「一格 5 分钟」
       * 把剩下的回合全补成了自动防御。
       *
       * 实测抓到的正是这个：28 个回合里 21 次防御、**攻击 0 次**（另外 7 次是技能与撤退）。
       * 后果不只是「玩家不还手」，而是**生物从头到尾满血** ——
       * 于是「逃跑 / 暴走 / 求援 / 进化 / 装死」五种行为一个都触发不了，
       * 报告里的生物行为分布只剩「攻击 + 特殊」两项。
       *
       * 真人在打架的时候也不会去干别的，这里就是同一件事：
       * 只要还挂着一场没打完的战斗，这次登录就继续出招 ——
       * 最多补一场战斗的硬上限（`BATTLE.maxRounds`）那么多回合，
       * 且每回合只推进 12 秒虚拟时间（远小于 5 分钟超时，所以不会又被判超时）。
       */
      /*
       * M2.12：**只在「轮到自己」时才继续出招。**
       *
       * 上面那一段的理由（「架没打完不下线」）是为 **PVE** 写的：对手是 AI，
       * 永远在线，所以「挂着战斗」就等于「你还没打完，接着打」。
       *
       * 但 PVP 不是这样：异步 PVP 里有一半的时间**在等对方出招**，
       * 而对方的下一次上线可能在几小时后 —— 这段时间里无论发多少条指令，
       * 状态都不会有任何变化（服务端只会回「还没轮到你」）。
       *
       * M2.12 前置 1 把 PVP 超时从 5 分钟拉到 24 小时之后，这个差别被放大了：
       * 实测（200×30 第一轮）每次登录都会追加满 8 个「等对方」的步骤，
       * 而每一步都不改变任何状态 —— 于是 NO_STATE_CHANGE（P1）从 M2.11 的 0 条涨到几十条。
       *
       * 判据用 snapshot 里现成的 yourTurn：PVE 恒为 true（生物不等你），
       * 所以这一条对 PVE 的行为**一个字节都没改**。
       */
      if (stepIndex === login.steps.length - 1 && battleStepsThisLogin < BATTLE.maxRounds) {
        const after = readSnapshot(db, profile, date, cursor);
        if (after.activeBattle && after.activeBattle.yourTurn) {
          battleStepsThisLogin += 1;
          login.steps.push({ step: login.steps.length, intervalSec: BATTLE_ROUND_GAP_SEC });
        }
      }
    }
  }

  return { actions, anomalies };
}
