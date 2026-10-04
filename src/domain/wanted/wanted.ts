/**
 * 通缉判定（M2.6）：**纯函数，无 IO**。
 *
 * 硬约束（任务书 §二）：判定层签名必须是
 *     (state, action, world, rng) → WantedResult
 * 没有 DB、没有时钟、"此刻"由调用方通过 state.expiresAt 与 world 注入。
 * seed 由命令层生成并写进 domain_events（seed 本身不属于判定）。
 *
 * 三个概念先分清，否则后面全是糊涂账：
 *
 *   1. **通缉状态（WantedState）**：某个势力对某个角色的通缉令，3—7 天后自动失效。
 *      一个角色可以同时有多条（警察厅一条、教会一条），各自独立计时。
 *   2. **势力范围**：玩家此刻站的地点归谁管。无主地点（`none`）永远安全。
 *   3. **遭遇（encounter）**：这一次行动里 NPC 做了什么 —— 盘查 / 追捕 / 围剿 /
 *      全境通缉 / 什么都没有。**遭遇不是状态**，它只是这一次判定的产物；
 *      要不要升级通缉等级，由命令层按触发源另算。
 *
 * ⚠️ M2.85：原「AP 惩罚」（apMultiplier 行动点效率 / baseApCost / apCost）随行动值机制
 *     一并移除 —— 通缉的代价现在只剩罚款（finePenny）与掉血（hpDrain）两维。
 *
 * MVP 的边界（任务书 §主任务五）：**只做「重伤玩家 → 1 级通缉」**。
 * 杀死类触发（2—4 级）的分支、时长、赏金、播报全部就位，但
 * `NUMERIC.wanted.triggers.enabled` 里没有它们 —— 触发源留给 M2.7 非凡物品
 * （封印物 / 致命能力）。这就是"数据结构预留"的具体含义：
 * 判定层认得它们，命令层不会产生它们。
 */
import { NUMERIC } from '../../config/numeric.ts';
import type { Rng } from '../character/types.ts';
import { WILD_FACTION_ID, factionOfLocation as defaultFactionOfLocation } from '../faction/faction.ts';

const CFG = NUMERIC.wanted;

/** 通缉等级：0 = 没被通缉 */
export type WantedLevel = 0 | 1 | 2 | 3 | 4;

/** 遭遇类型：这一次行动里 NPC 干了什么 */
export type EncounterKind = 'none' | 'inquiry' | 'pursuit' | 'siege' | 'dragnet';

/** 通缉令（任务书 §主任务二 的 WantedState，补一个落库用的 id） */
export interface WantedState {
  /** 落库主键；判定层不读它，只有举报（幂等 + 赏金流水）需要 */
  id?: string;
  characterId: string;
  /** 0—4 */
  level: number;
  /** 哪个势力在通缉 */
  factionId: string;
  /** 触发原因（人话，直接进回执与播报） */
  reason: string;
  createdAt: number;
  expiresAt: number;
  /**
   * 赏金缩放倍率（M2.6.1）。
   *
   * 高序列重伤低序列时，赏金按目标序列放大：`1 + (9 − targetSeq) × 0.5`。
   * **必须在签发通缉令时就定下来**：赏金是举报那一刻才发的，
   * 那时"当初打的是谁"已经不在手上了（见 0014 迁移的注释）。
   * 缺省 1 = 不缩放（M2.6 的所有通缉令）。
   */
  bountyMultiplier?: number;
}

export interface WantedLevelConfig {
  level: number;
  trigger: string;
  action: string;
  encounter: EncounterKind;
  duration: number;
  penalty: { hpDrain: number; finePenny: number };
  chance: number;
  acrossAllFactions?: boolean;
}

/** 一次被判定的行动（判定层只关心这两样，别的都是命令层的事） */
export interface WantedAction {
  type: 'act' | 'assault' | 'report' | 'travel';
  /** 行为发生的地点 id；null = 不在任何地点（按安全处理） */
  locationId: string | null;
}

/** 判定需要知道的世界事实（注入 → 纯函数可测，也不反向依赖内容表） */
export interface WantedWorld {
  /** 地点 id → 归属势力 id；不认识的地点必须返回 WILD_FACTION_ID */
  factionOfLocation: (locationId: string | null) => string;
}

/** 生产用的世界视图：地点归属来自 domain/faction（而它只读 numeric.ts） */
export function defaultWantedWorld(): WantedWorld {
  return { factionOfLocation: (locationId) => defaultFactionOfLocation(locationId) };
}

export interface WantedResult {
  /** 这一次的遭遇 */
  encounter: EncounterKind;
  /** 生效的通缉等级（0 = 没被通缉 / 通缉已过期） */
  level: number;
  /** 玩家此刻是否处在「通缉他那个势力」的范围内 */
  inTerritory: boolean;
  /** 追捕方势力 id；没有被追捕时为 null */
  factionId: string | null;
  /** 追捕方的动作名（盘查 / 追捕 / 围剿 / 全境通缉） */
  action: string;
  /** 命中时掉的血 */
  hpDrain: number;
  /** 命中时罚的款（便士） */
  finePenny: number;
  /** 遭遇判定是否命中（掉血 / 罚款 / 被抓都看它） */
  hit: boolean;
  chance: number;
  roll: number;
  /** 是否需要「有可疑人物出现」的群播报（在势力范围内被盯上） */
  suspicious: boolean;
  narrative: string[];
}

/* ------------------------------------------------------------------ *
 * 查表（全部来自 numeric.ts，本文件不写任何常数）
 * ------------------------------------------------------------------ */

export function wantedConfigOf(level: number): WantedLevelConfig | null {
  if (!Number.isInteger(level) || level < 1 || level > 4) return null;
  return (CFG as unknown as Record<number, WantedLevelConfig>)[level] ?? null;
}

/** 触发源 → 等级；不认识的触发源返回 null（命令层据此拒绝） */
export function levelForTrigger(trigger: string): number | null {
  for (const level of [1, 2, 3, 4]) {
    if (wantedConfigOf(level)?.trigger === trigger) return level;
  }
  return null;
}

/** 这个触发源在本版是否开放（MVP 只开 injured_player） */
export function isEnabledTrigger(trigger: string): boolean {
  return CFG.triggers.enabled.includes(trigger);
}

export function wantedDurationOf(level: number): number {
  return wantedConfigOf(level)?.duration ?? 0;
}

export function wantedActionOf(level: number): string {
  return wantedConfigOf(level)?.action ?? '未知';
}

export function bountyOf(level: number): number {
  return CFG.bounty[level] ?? 0;
}

/** 通缉令是否仍然有效（到期即自动解除，不需要任何后台任务） */
export function isWantedActive(state: WantedState | null | undefined, now: number): boolean {
  if (!state) return false;
  if (state.level < 1) return false;
  return state.expiresAt > now;
}

/**
 * 从「这个角色的全部通缉令」里挑出此刻真正在管他的那一条。
 *
 * 规则（任务书 §主任务二）：
 *   - 4 级是**全境通缉**：只要不在无主地点，任何一个势力都会动手，优先取 4 级那条；
 *   - 其余等级只在**发通缉的那个势力**的地盘上生效
 *     （被警察厅通缉的人走进教会的地头，教会不管）；
 *   - 同级多条时取最近签发的（createdAt 最大）。
 *   - 全都不适用 → null（此刻安全）。
 */
export function pickActiveWanted(
  states: readonly WantedState[],
  factionIdHere: string,
  now: number,
): WantedState | null {
  const live = states.filter((state) => isWantedActive(state, now));
  if (live.length === 0) return null;
  if (factionIdHere === WILD_FACTION_ID) return null;

  const dragnet = live.filter((state) => wantedConfigOf(state.level)?.acrossAllFactions === true);
  const pool = dragnet.length > 0 ? dragnet : live.filter((state) => state.factionId === factionIdHere);
  if (pool.length === 0) return null;
  return [...pool].sort((a, b) => b.createdAt - a.createdAt || b.level - a.level)[0] ?? null;
}

/** 这个势力此刻有没有在通缉他（不含 4 级跨势力） */
export function isWantedBy(states: readonly WantedState[], factionId: string, now: number): boolean {
  return states.some((state) => isWantedActive(state, now) && state.factionId === factionId);
}

/* ------------------------------------------------------------------ *
 * 判定
 * ------------------------------------------------------------------ */

const NARRATIVE: Record<EncounterKind, { hit: string[]; miss: string[] }> = {
  none: { hit: [], miss: [] },
  inquiry: {
    hit: [
      '两个穿制服的巡警在街角拦住了你。',
      '他们翻来覆去地看你的证件，最后从你手里抽走了一笔"罚款"。',
    ],
    miss: ['巡警扫了你一眼，被旁边的一场争执引开了。'],
  },
  pursuit: {
    hit: [
      '口哨声从两条街外响起，然后是脚步 —— 不是一个人的脚步。',
      '你被堵在巷口，跑起来才发现每一步都比平时沉。',
    ],
    miss: ['你听见口哨声，但它没有朝你这边来。'],
  },
  siege: {
    hit: [
      '前后两个路口同时静了下来。',
      '你不是被追，你是被围 —— 他们比你先到。',
    ],
    miss: ['空气里有股铁锈味，但你绕开了那条街。'],
  },
  dragnet: {
    hit: [
      '街上的每一个巡警手里都有一张画着你的纸。',
      '这一次不是某个势力的私事 —— 整座城都在找你。',
    ],
    miss: ['告示贴满了墙，但贴告示的人不在这条街上。'],
  },
};

/**
 * 核心判定。
 *
 *   1. 没被通缉 / 通缉已过期 → 什么都没发生；
 *   2. 在无主地点 → **安全区，永远不追捕**（这是「逃到势力范围外」的落点）；
 *   3. 不在追捕方的地盘上 → 安全（4 级除外，全境通缉不看这条）；
 *   4. 在追捕方地盘上 → 按等级出遭遇：roll 决定"有没有被按住"
 *      （被按住才掉血 / 罚款）。
 *
 * rng.next() 只在真的会被追捕时才被调用 —— 不然每次行动都在偷偷推进随机流，
 * 同一 seed 下别的判定结果会跟着漂。
 */
export function resolveWanted(
  state: WantedState | null,
  action: WantedAction,
  world: WantedWorld,
  rng: Rng,
): WantedResult {
  const neutral: WantedResult = {
    encounter: 'none',
    level: 0,
    inTerritory: false,
    factionId: null,
    action: '无',
    hpDrain: 0,
    finePenny: 0,
    hit: false,
    chance: 0,
    roll: 0,
    suspicious: false,
    narrative: [],
  };
  if (!state || state.level < 1) return neutral;

  const config = wantedConfigOf(state.level);
  if (!config) return neutral;

  const factionIdHere = world.factionOfLocation(action.locationId);
  // 无主地点 = 安全区。这条必须在 4 级之前判：全境通缉也管不到无主地点。
  if (factionIdHere === WILD_FACTION_ID) return neutral;

  const pursues = config.acrossAllFactions === true || state.factionId === factionIdHere;
  if (!pursues) return neutral;

  const roll = rng.next();
  const hit = roll < config.chance;
  const texts = NARRATIVE[config.encounter];

  return {
    encounter: config.encounter,
    level: state.level,
    inTerritory: true,
    factionId: factionIdHere,
    action: config.action,
    hpDrain: hit ? config.penalty.hpDrain : 0,
    finePenny: hit ? config.penalty.finePenny : 0,
    hit,
    chance: config.chance,
    roll,
    suspicious: true,
    narrative: hit ? [...texts.hit] : [...texts.miss],
  };
}

/* ------------------------------------------------------------------ *
 * 文案 / 结构化摘要
 * ------------------------------------------------------------------ */

/** 通缉令的人话（回执、播报、报告共用一份，避免三处写死） */
export function describeWanted(state: WantedState, now: number): string {
  const config = wantedConfigOf(state.level);
  const left = Math.max(0, state.expiresAt - now);
  const days = Math.ceil(left / (24 * 3600 * 1000));
  return (
    state.level + ' 级 · ' + (config?.action ?? '') + ' · ' +
    '（' + state.reason + '，剩余 ' + days + ' 天）'
  );
}

/** 发布一条通缉令（纯函数；落库由 WantedRepo 做） */
export interface IssueWantedInput {
  characterId: string;
  trigger: string;
  factionId: string;
  reason: string;
  now: number;
  level: number;
}

export function issueWanted(input: IssueWantedInput): WantedState | null {
  const config = wantedConfigOf(input.level);
  if (!config) return null;
  return {
    characterId: input.characterId,
    level: input.level,
    factionId: input.factionId,
    reason: input.reason,
    createdAt: input.now,
    expiresAt: input.now + config.duration,
  };
}

/** 提前解除通缉的方式（任务书：贿赂 / 伪造身份 / 组织庇护）—— 本版只留接口，M2.7 实现 */
export type WantedSettleMethod = 'bribe' | 'forgery' | 'asylum';

export const WANTED_SETTLE_METHODS: ReadonlyArray<{ id: WantedSettleMethod; label: string; note: string }> = [
  { id: 'bribe', label: '贿赂', note: '黑帮地盘上花钱消灾（M2.7）' },
  { id: 'forgery', label: '伪造身份', note: '需要非凡物品（M2.7）' },
  { id: 'asylum', label: '组织庇护', note: '需要加入组织（M2.7）' },
];

/** 举报判定的纯函数（命令层负责落库 / 播报） */
export interface ReportOutcome {
  ok: boolean;
  reason: string;
  rewardPenny: number;
  reputationDelta: number;
  /** 命中的那条通缉令 id（命令层用它做「同一人同一案只能领一次」的幂等键） */
  wantedId: string | null;
  /** 命中的通缉等级（0 = 没命中） */
  level: number;
}

export function resolveReport(input: {
  targetStates: readonly WantedState[];
  /** 目标此刻所在地点归属的势力 */
  targetFactionId: string;
  now: number;
}): ReportOutcome {
  const live = input.targetStates.filter((state) => isWantedActive(state, input.now));
  if (live.length === 0) {
    return {
      ok: false,
      reason: '对方没有被通缉 —— 你浪费了一次举报。',
      rewardPenny: 0,
      reputationDelta: CFG.reportFailReputation,
      wantedId: null,
      level: 0,
    };
  }
  // 目标必须在**通缉他那个势力**的范围内：人已经跑进无主地点了，谁也抓不了
  if (input.targetFactionId === WILD_FACTION_ID) {
    return {
      ok: false,
      reason: '对方藏在无主的地方，没人接这个案子。',
      rewardPenny: 0,
      reputationDelta: CFG.reportFailReputation,
      wantedId: null,
      level: 0,
    };
  }
  const claimable = live.filter(
    (state) =>
      state.factionId === input.targetFactionId ||
      wantedConfigOf(state.level)?.acrossAllFactions === true,
  );
  if (claimable.length === 0) {
    return {
      ok: false,
      reason: '对方身上的案子不归这里管 —— 你举报错了衙门。',
      rewardPenny: 0,
      reputationDelta: CFG.reportFailReputation,
      wantedId: null,
      level: 0,
    };
  }
  // 赏金按**最重的那条**结算：情报贩子当然挑贵的报
  const best = [...claimable].sort((a, b) => b.level - a.level || b.createdAt - a.createdAt)[0]!;
  // M2.6.1：高打低签发的通缉令带着赏金缩放（目标序列越高、赏金越高）
  const multiplier = Number.isFinite(best.bountyMultiplier) ? (best.bountyMultiplier ?? 1) : 1;
  return {
    ok: true,
    reason: best.reason,
    rewardPenny: Math.max(0, Math.round(bountyOf(best.level) * multiplier)),
    reputationDelta: 0,
    wantedId: best.id ?? null,
    level: best.level,
  };
}
