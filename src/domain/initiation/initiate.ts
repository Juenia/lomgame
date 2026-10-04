/**
 * 入途径的统一判定入口（M2.7.6 硬约束；M2.85 修订）：
 *
 *   resolveInitiation(state, action, world, rng) -> InitiationResult
 *
 * **纯函数**：无 IO、无时钟、无数据库。调用方（命令层）负责
 * 把库里查到的东西装配成 InitiationWorld 喂进来，再把结果里的 draft 落库。
 * seed 由调用方派生后一并传进来 —— 于是同一条指令重放必然得到同一结果，
 * 而每一次判定都有一条带 seed 的 domain_events 可以复现。
 *
 * M2.85：势力引导（每日掷骰、邀约、任务）整体下线 —— 「走上途径」只剩
 * 探索翻线索这一条路，保底由 cluePityDays 承接（创建满 N 天探索必出线索）。
 * 统一入口保留 explore / drink 两个动作：前者发线索，后者入途径。
 */
import { INITIATION } from '../../config/numeric.ts';
import { PATHWAY_LABELS } from '../character/rules.ts';
import type { CharacterState, PathwayId, Rng } from '../character/types.ts';
import type { InitiationWorld, RecipeClue } from './types.ts';
import { mortalDayOf } from './guided.ts';
import { rollRecipeClue, type RecipeClueDraft } from './clue.ts';

/** 序列 9 的称号（入途径回执里那句「现在，你是愚者序列 9 · 占卜家」） */
export const SEQ9_TITLES: Readonly<Record<PathwayId, string>> = {
  // —— 已实现的 7 条 ——
  seer: '占卜家',
  warrior: '战士',
  sleepless: '不眠者',
  sailor: '水手',
  /*
   * M2.76 修正两格错标（设计书 D1 记的那笔账）：
   *   perfect 原写「工匠」—— 原作链里没有「工匠」，序列 9 是**通识者**；
   *   reader  原写「读者」—— 原作序列 9 是**阅读者**。
   * 两处都以 诡秘之主原作数据/01-途径与序列/序列名称全表.yaml 为准。
   */
  perfect: '通识者',
  reader: '阅读者',
  mother: '耕种者',
  // —— M2.76 落地的 15 条（序列 9 名，取自同一张表）——
  door: '学徒',
  sun: '歌颂者',
  corpse_collector: '收尸人',
  error: '偷盗者',
  mystery_pryer: '窥秘人',
  spectator: '观众',
  apothecary: '药师',
  arbiter: '仲裁人',
  assassin: '刺客',
  criminal: '罪犯',
  hunter: '猎人',
  lawyer: '律师',
  monster: '怪物',
  prisoner: '囚犯',
  secrets_supplicant: '秘祈人',
};

export type InitiationAction =
  /** 探索：可能翻到配方线索（5%；创建满 cluePityDays 天后必出） */
  | { kind: 'explore'; locationId: string; now: number }
  /** 服用序列 9 魔药：入途径 */
  | { kind: 'drink'; pathway: PathwayId; now: number };

export interface InitiationResult {
  /** 本次判定用的 seed（调用方必须把它写进 domain_events） */
  seed: string;
  kind:
    | 'none'
    | 'clue'
    | 'initiated'
    | 'blocked';
  /** 需要新建的线索（若有） */
  clue: RecipeClueDraft | null;
  /** 入途径（若有） */
  initiation: { pathway: PathwayId; sequence: number; title: string } | null;
  /** 被挡住的原因（若有） */
  rejected: string | null;
  /** 抽样留档（写进 domain_events.payload，供复现与报告取证） */
  rolls: Record<string, number>;
  /** 给玩家看的叙事行 */
  lines: string[];
}

function empty(seed: string): InitiationResult {
  return {
    seed,
    kind: 'none',
    clue: null,
    initiation: null,
    rejected: null,
    rolls: {},
    lines: [],
  };
}

/** 探索那条路：5% 线索 + cluePityDays 保底 */
function resolveExplore(
  input: { state: CharacterState; action: Extract<InitiationAction, { kind: 'explore' }>; world: InitiationWorld; rng: Rng; seed: string },
): InitiationResult {
  const result = empty(input.seed);
  const { state, action, world, rng } = input;
  if (state.pathwayStatus === 'initiated') return result;

  // 手上已经有一条未用线索时不再给第二条 ——
  // 那张纸还没看懂，再捡一张只是噪声，而且会让人以为要凑齐才能用
  if (world.openClues.length > 0) return result;

  /*
   * M2.85 的保底：创建满 cluePityDays(5) 天的普通人，探索**必定**翻到线索。
   * 实现就是把概率抬到 1 —— 掷骰、途径落点（pickGuidedFaction）、落库
   * 全部复用原来的路径，唯一的区别是这一次骰子不可能输。
   * 抽样值照样留档（cluePity=1），「他第 6 天为什么必出线索」在事件流里可查。
   */
  const day = mortalDayOf(world.bornAt, action.now);
  const pity = day >= INITIATION.cluePityDays;
  const rolled = rollRecipeClue({
    factions: world.factions,
    rng,
    now: action.now,
    chance: pity ? 1 : undefined,
  });
  result.rolls.clue = rolled.roll;
  result.rolls.clueChance = rolled.chance;
  result.rolls.cluePity = pity ? 1 : 0;
  if (!rolled.found || !rolled.clue) return result;
  result.kind = 'clue';
  result.clue = rolled.clue;
  result.lines.push('在离开之前，你注意到了一样不该出现在这里的东西。');
  result.lines.push(...rolled.clue.clueText.split('\n'));
  return result;
}

/**
 * 入途径的那一刻。
 *
 * 措辞是这一轮最重要的文案之一（任务书 §5.6「这一瞬间要有仪式感」）：
 * 它不是「你的途径已更新为愚者」，而是一件**发生过的事** ——
 * 世界在他眼里变了，而他再也回不去。
 */
export function initiationMomentText(pathway: PathwayId, sequence: number): string {
  return [
    `【入途径 · ${PATHWAY_LABELS[pathway]}】`,
    '你按照配方调制了魔药，在没有人打扰的地方把它喝了下去。',
    '',
    '服下的瞬间，世界变了。',
    '你听见了以前听不见的声音。你看见了以前看不见的东西。',
    '',
    `现在，你是${PATHWAY_LABELS[pathway]}序列 ${sequence} · ${SEQ9_TITLES[pathway]}。`,
  ].join('\n');
}

/** 服用序列 9 魔药 → 入途径 */
function resolveDrink(
  input: { state: CharacterState; action: Extract<InitiationAction, { kind: 'drink' }>; seed: string },
): InitiationResult {
  const result = empty(input.seed);
  const { state, action } = input;
  if (state.pathwayStatus === 'initiated') {
    result.rejected = '你已经走在一条路上了，换一条不是靠再喝一瓶。';
    return result;
  }
  result.kind = 'initiated';
  result.initiation = { pathway: action.pathway, sequence: 9, title: SEQ9_TITLES[action.pathway] };
  result.lines.push(initiationMomentText(action.pathway, 9));
  return result;
}

/**
 * 统一入口。action 决定走哪条分支 —— 两个动作对应生命周期上的两个时刻：
 *   explore → 翻到线索（5%，满 cluePityDays 天必出）
 *   drink   → 入途径
 */
export function resolveInitiation(input: {
  state: CharacterState;
  action: InitiationAction;
  world: InitiationWorld;
  rng: Rng;
  seed: string;
}): InitiationResult {
  switch (input.action.kind) {
    case 'explore':
      return resolveExplore(input as Parameters<typeof resolveExplore>[0]);
    case 'drink':
      return resolveDrink(input as Parameters<typeof resolveDrink>[0]);
    default:
      return empty(input.seed);
  }
}

/** 只读：手上有没有这条途径的线索 */
export function hasClueFor(clues: readonly RecipeClue[], pathway: PathwayId): boolean {
  return clues.some((clue) => clue.pathway === pathway && clue.usedAt === null);
}
