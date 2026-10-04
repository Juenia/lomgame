/**
 * 战斗的开局与视图（M2.9）—— **纯函数，无 IO**。
 *
 * 分两件事：
 *   createBattleState —— 把「一个玩家 + 一只生物 + 一片雾」变成一个战斗状态机
 *   battleViewFor     —— 把这个状态机变成玩家看到的那一屏
 *
 * 为什么视图也放在领域层：它**不是渲染**，是「这一场战斗向玩家暴露了什么信息」。
 * 判定层之外的任何一层去拼这段话，就会出现「菜单里写 45/60、判定用的是别的数」
 * 这种只有长跑才能发现的错位。
 */
import { BATTLE, NUMERIC } from '../../config/numeric.ts';
import type { CharacterState } from '../character/types.ts';
import { sequenceOrInitiate } from '../character/types.ts';
import type { Creature, CreatureSpecies } from '../creature/types.ts';
import { skillsFor } from './skills.ts';
import { describeStatuses } from './statuses.ts';
import type {
  BattleSpeciesView,
  BattleState,
  BattleView,
  BattleWorld,
  CreatureAction,
} from './types.ts';

/** 玩家侧的数值上限（与 config/effect/apply.ts 的 CLAMP 同一个口径） */
const PLAYER_MAX_HP = 100;
const PLAYER_MAX_MP = 100;

/**
 * 物种模板 → 战斗视图。
 *
 * ⚠️ 这一层只取「打架用得上的那几样」。掉率 / 栖息地 / 五层感知文本一概不进战斗判定 ——
 * 那些是遭遇与生态的事，混进来之后「战斗里为什么会变慢」会变得无法解释。
 */
export function battleSpeciesViewOf(species: CreatureSpecies): BattleSpeciesView {
  const battle = species.battle;
  return {
    id: species.id,
    name: species.name,
    habits: species.habits,
    special: battle?.special ?? null,
    specialName: battle?.specialName ?? null,
    damage: battle?.damage ?? [10, 18],
    hit: battle?.hit ?? BATTLE.actions.attack.baseHit,
    ...(battle?.fleeChance !== undefined ? { fleeChance: battle.fleeChance } : {}),
  };
}

/**
 * 开一场战斗。
 *
 * 三处「开局就该定下来」的东西（都不是随手写的）：
 *   1. **世界冻在战斗里**（night / weatherHitPenalty / danger）—— 见 types.ts 的 BattleWorld；
 *   2. **高序列生物的气场**：序列 ≤ fearAura.maxCreatureSequence 的生物开场就让你怕；
 *   3. **生物的 HP 从世界状态读**（creatures 表里的那个 hp），不是从物种基线重置 ——
 *      你打的是「此时此刻的它」，与 M2.8 的遭遇是同一只。
 */
export function createBattleState(input: {
  id: string;
  character: CharacterState;
  creature: Creature;
  species: CreatureSpecies;
  world: BattleWorld;
  now: number;
  /** M2.85：挑战神用更高的回合上限（默认沿用 BATTLE.maxRounds） */
  maxRounds?: number;
}): BattleState {
  const { character, creature, species, world, now } = input;
  const statuses =
    creature.sequence <= BATTLE.fearAura.maxCreatureSequence
      ? [
          {
            id: 'fear' as const,
            rounds: BATTLE.fearAura.rounds,
            source: `${species.name}的存在感`,
          },
        ]
      : [];
  return {
    id: input.id,
    characterId: character.id,
    creatureId: creature.id,
    speciesId: species.id,
    speciesName: species.name,
    creatureSequence: creature.sequence,
    maxRounds: input.maxRounds ?? BATTLE.maxRounds,
    creatureDying: creature.status === 'dying',
    world,
    round: 1,
    status: 'active',
    playerHp: character.hp,
    playerMp: character.mp,
    playerStatuses: statuses,
    playerDefensePenalty: 0,
    creatureHp: creature.hp,
    creatureMaxHp: creature.maxHp,
    creatureStatuses: [],
    creatureBerserk: false,
    creatureEvolved: false,
    creatureShield: false,
    allyCalled: false,
    allyArrivesAtRound: null,
    allyCount: 0,
    creaturePlayingDead: false,
    negateCreatureActions: 0,
    negatePlayerActions: 0,
    isPvp: false,
    opponentCharacterId: null,
    opponentName: null,
    turnOf: 'challenger' as const,
    pendingAction: null,
    foresight: null,
    lastPlayerDamage: 0,
    startedAt: now,
    lastRoundAt: now,
    resolvedAt: null,
  };
}

/**
 * M2.10 前置 2：**序列差的人话**（`玩家序列 − 生物序列`，**正数 = 玩家更弱**）。
 *
 * 符号约定与 M2.6.1 的 `resolveAssault` 里的 `diff = attackerSeq − targetSeq` **同号**
 * —— 序列号越小越强，所以「玩家更弱」就是「玩家的号更大」。
 * ⚠️ 这个方向实测写反过一次（生物 − 玩家）：那样序列 9 的玩家打序列 8 的低语者
 * 会看到「你比它强 1 个序列」，而那是**完全相反**的一句话。
 *
 * 一个函数、两处用（遭遇菜单的「动手」预览 + 战斗回执），
 * 所以两处说的永远是同一句话 —— 而不是「菜单说弱 1 级、回执说弱 2 级」。
 *
 * **它只是显示层**：一个数值都没动，判定仍然完全由 M2.6.1 的 `sequenceGating` 决定
 * （下面的措辞就是照着那三条分支写的）。
 */
export function sequenceGapHint(gap: number): string {
  if (gap >= NUMERIC.assault.sequenceGating.blockThreshold) {
    return `你比它弱 ${gap} 个序列 —— 你根本近不了它的身`;
  }
  if (gap > 0) return `你比它弱 ${gap} 个序列，命中与伤害都被大幅压制`;
  if (gap === 0) return '你们序列相同，势均力敌';
  return `你比它强 ${-gap} 个序列`;
}

/**
 * M2.10：开一场 **PVP**。
 *
 * 与 `createBattleState` 的分别只有三处，都在这里写死：
 *   1. 没有生物实例（`creatureId = ''` → 落库为 NULL）；
 *   2. `creature*` 那一串从**应战者的角色卡**初始化（血量 / 序列），
 *      而不是从 creatures 表 —— 「对手是另一个人」这件事在数据上的全部含义就这一句；
 *   3. `turnOf = 'challenger'`：**发起者先手**（先出招的人先亮牌，后手有信息优势 ——
 *      这是异步 PVP 的固有性质，也是发起者要付的代价）。
 */
export function createPvpBattleState(input: {
  id: string;
  challenger: CharacterState;
  opponent: CharacterState;
  world: BattleWorld;
  now: number;
}): BattleState {
  const { challenger, opponent, world, now } = input;
  return {
    id: input.id,
    characterId: challenger.id,
    creatureId: '',
    speciesId: 'pvp',
    // 语义是「对手方的名字」（见 types.ts 的说明）；PVE 时它才是物种名
    speciesName: opponent.name,
    creatureSequence: sequenceOrInitiate(opponent),
    creatureDying: false,
    world,
    isPvp: true,
    opponentCharacterId: opponent.id,
    opponentName: opponent.name,
    round: 1,
    status: 'active',
    playerHp: challenger.hp,
    playerMp: challenger.mp,
    playerStatuses: [],
    playerDefensePenalty: 0,
    creatureHp: opponent.hp,
    creatureMaxHp: PLAYER_MAX_HP,
    creatureStatuses: [],
    creatureBerserk: false,
    creatureEvolved: false,
    creatureShield: false,
    allyCalled: false,
    allyArrivesAtRound: null,
    allyCount: 0,
    creaturePlayingDead: false,
    negateCreatureActions: 0,
    negatePlayerActions: 0,
    foresight: null,
    lastPlayerDamage: 0,
    turnOf: 'challenger',
    pendingAction: null,
    startedAt: now,
    lastRoundAt: now,
    resolvedAt: null,
  };
}

/** 命中修正在回执里的说法（玩家要能看出「这一枪为什么偏了」） */
function hitPenaltyLabel(penalty: number): string | null {
  if (penalty === 0) return null;
  const sign = penalty > 0 ? '+' : '';
  return `命中 ${sign}${Math.round(penalty * 100)}%`;
}

/**
 * 这一场战斗此刻长什么样（任务书 §4.6 的那一屏）。
 *
 * 返回 lines 而不是一段拼好的文本：菜单层要用它做 context，
 * 报告脚本要用它做快照，两者不该各拼一遍。
 */
export function battleViewFor(input: {
  battle: BattleState;
  character: CharacterState;
  /** 背包里能用的东西（命令层查库后喂进来；判定层不认识背包） */
  items: readonly { itemId: string; name: string; quantity: number }[];
  /**
   * M2.85 C：技能池（命令层从**内容表**算好喂进来）。
   *
   * 为什么不在这里直接读内容表：判定层对着的是 numeric，内容表是运行时才加载的。
   * 不传就退回 numeric 那 44 个 —— 与 skillsFor 的可选参数同一个口径。
   */
  skillIds?: readonly string[];
}): BattleView {
  const { battle, character } = input;
  const sequence = sequenceOrInitiate(character);
  const skills = input.skillIds ?? skillsFor(character.pathway, sequence).map((skill) => skill.id);

  const lines: string[] = [];
  lines.push(`【战斗 · 第 ${battle.round} 回合】`);
  const foeLabel = battle.isPvp ? `@${battle.opponentName ?? '对手'}` : battle.speciesName;
  lines.push(
    `${foeLabel}${battle.allyCount > 0 ? `（+${battle.allyCount} 只援军）` : ''} · HP ${battle.creatureHp}/${battle.creatureMaxHp} · 状态：${describeStatuses(battle.creatureStatuses)}`,
  );
  /*
   * M2.10 前置 2：紧跟在对手信息后面说清序列差。
   * 玩家在这一屏上要能一眼看出「这一架我打不打得动」——
   * M2.9 实测 33 场里玩家胜 4 / 败 12 / 逃 12，而当时的回执**一个字都没提**这件事。
   */
  lines.push(sequenceGapHint(sequence - battle.creatureSequence));
  lines.push(
    `你 · HP ${battle.playerHp}/${PLAYER_MAX_HP} · MP ${battle.playerMp}/${PLAYER_MAX_MP} · MAD ${character.mad}`,
  );
  lines.push(`你的状态：${describeStatuses(battle.playerStatuses)}`);
  const modifier = hitPenaltyLabel(battle.world.weatherHitPenalty);
  lines.push(
    `环境：${battle.world.weatherLabel}${modifier ? `（${modifier}）` : ''} · ${battle.world.locationName}`,
  );
  if (battle.foresight) {
    lines.push(`预知：它下一步想做的是「${battle.foresight.action.label}」。`);
  }

  return {
    battleId: battle.id,
    round: battle.round,
    maxRounds: battle.maxRounds ?? BATTLE.maxRounds,
    status: battle.status,
    headline: `【战斗 · 第 ${battle.round} 回合】`,
    creatureName: battle.speciesName,
    creatureHp: battle.creatureHp,
    creatureMaxHp: battle.creatureMaxHp,
    creatureStatuses: battle.creatureStatuses,
    playerHp: battle.playerHp,
    playerMaxHp: PLAYER_MAX_HP,
    playerMp: battle.playerMp,
    playerMaxMp: PLAYER_MAX_MP,
    playerMad: character.mad,
    playerStatuses: battle.playerStatuses,
    pathway: character.pathway,
    sequence,
    isPvp: battle.isPvp,
    // 轮到谁出招：PVE 永远是「你」（生物不等你）；PVP 要看 turnOf 与自己在哪一边
    yourTurn:
      !battle.isPvp ||
      (battle.turnOf === 'challenger'
        ? character.id === battle.characterId
        : character.id === battle.opponentCharacterId),
    skills,
    items: input.items,
    world: battle.world,
    foresight: battle.foresight?.action ?? null,
    lines,
  };
}

/** 战斗结局的中文（回执标题与报告都用它） */
export const BATTLE_OUTCOME_LABELS: Readonly<Record<string, string>> = {
  player_win: '玩家胜',
  player_lose: '玩家败',
  stalemate: '僵持',
  fled: '玩家逃',
  creature_fled: '生物逃',
};

/** 一句话的结局（回执最后一行） */
export function outcomeLine(status: string, speciesName: string): string {
  switch (status) {
    case 'player_win':
      return `你赢了。${speciesName}倒在那里，没有再动。`;
    case 'player_lose':
      return '你输了。醒过来的时候天已经变了，身上多了几处不记得怎么来的伤。';
    case 'stalemate':
      return '你们谁也没能按住谁。它退进了雾里，你也没有追。';
    case 'fled':
      return '你脱身了。身后那点声音很快就听不见了。';
    case 'creature_fled':
      return `${speciesName}跑了。地上留了一点东西。`;
    default:
      return '';
  }
}

export type { CreatureAction };
