/**
 * 回合判定（M2.9）—— **纯函数，无 IO**。这是整个战斗状态机的核心。
 *
 * 接口形状按任务书 §4.2：
 *   resolveBattleRound(state, battle, action, rng) → RoundResult
 * 第 5 个参数是可选的「这一回合的已知条件」（生物动作 / 物种视图 / 物品效果），
 * 不给也能跑 —— 判定层自己会用传入的 rng 现掷生物动作。
 *
 * 一个回合的结算顺序（顺序是设计，不是实现细节）：
 *
 *   0. 增援到达检查（上一回合叫的人到了没）
 *   1. 装死偷袭检查（它上一回合装了死，而你这一回合停手了）
 *   2. 玩家动作（被放逐则不能行动；失控则随机行动）
 *   3. 生物动作（死了 / 被放逐 / 被幻觉干扰则不动）
 *   4. 状态持续伤害（流血 / 中毒）
 *   5. 状态计时推进（归零脱落）
 *   6. 结束判定（胜 / 负 / 僵持）
 *
 * 三条纪律：
 *   1. **不该掷骰时不掷**（沿用 M2.6.1）：被序列差拦住时一次 rng 都不调用，
 *      否则同 seed 下后面的判定会跟着漂。
 *   2. **玩家死了生物就不再打**、**生物死了玩家就不再挨打** —— 死后再补一刀
 *      会让「谁赢了」这件事在回执里说不清。
 *   3. **判定层不认识角色卡以外的任何 IO**：物品、技能池、物种都在参数里。
 */
import { isDeityOpponent } from '../world/god-challenge.ts';
import { BATTLE } from '../../config/numeric.ts';
import type { CharacterState, Rng } from '../character/types.ts';
import { sequenceOrInitiate } from '../character/types.ts';
import { clamp } from '../character/rules.ts';
import { rollChance } from '../random.ts';
import { hitChanceOf, resolveAssault } from '../wanted/assault.ts';
import { creatureCanAct, decideCreatureAction } from './ai.ts';
import { skillById, skillEffectOf } from './skills.ts';
import { specialById } from './specials.ts';
import {
  advanceStatuses,
  applyStatus,
  canActOf,
  dotOf,
  hasStatus,
  hitPenaltyOf,
  removeStatus,
} from './statuses.ts';
import type {
  BattleExtraordinaryEffect,
  BattleItemEffect,
  BattleRoundOptions,
  BattleSpeciesView,
  BattleState,
  BattleStatusEffect,
  BattleStatusKind,
  CreatureAction,
  PlayerAction,
  RoundEvent,
  RoundResult,
} from './types.ts';

const AI = BATTLE.creatureAi;

/** 玩家侧的数值上限（与 config/effect/apply.ts 的 CLAMP 同一个口径，这里只是本地快照） */
const PLAYER_MAX_HP = 100;
const PLAYER_MAX_MP = 100;

/* ------------------------------------------------------------------ *
 * 小工具（全部纯函数）
 * ------------------------------------------------------------------ */

/** [min, max] 闭区间整数抽样 */
function rollRange(min: number, max: number, rng: Rng): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(rng.next() * (hi - lo + 1));
}

/** 物种视图的兜底（命令层没给时用）：只够跑通 AI，特殊行为一律没有 */
function fallbackSpecies(battle: BattleState): BattleSpeciesView {
  return {
    id: battle.speciesId,
    name: battle.speciesName,
    habits: [],
    special: null,
    specialName: null,
    damage: [10, 18],
    hit: BATTLE.actions.attack.baseHit,
  };
}

/** 战斗是不是已经结束 */
export function isBattleOver(status: BattleStatusKind): boolean {
  return status !== 'active';
}

/* ------------------------------------------------------------------ *
 * 一回合
 * ------------------------------------------------------------------ */

export function resolveBattleRound(
  state: CharacterState,
  battle: BattleState,
  action: PlayerAction,
  rng: Rng,
  options: BattleRoundOptions = {},
): RoundResult {
  const world = battle.world;
  const species = options.species ?? fallbackSpecies(battle);
  const playerSeq = sequenceOrInitiate(state);

  const events: RoundEvent[] = [];
  const rolls: Record<string, number> = {};
  const flags = {
    crit: false,
    bleed: false,
    allyArrived: false,
    autoDefend: Boolean(action.auto),
    foresight: false,
  };

  /* ---- 可变工作副本：输入对象一个字段都不动 ---- */
  let playerHp = battle.playerHp;
  /*
   * M2.85 B（重做）：**这一回合因为动用非凡物品付出的代价**。
   *
   * 战斗状态里没有 MAD（理智住在角色卡上），所以这里只**记账**，
   * 由命令层在回合结算时落到角色身上 —— 判定层不碰角色卡是既定分工。
   */
  const equipmentCost = { mad: 0, cor: 0 };
  let playerMp = battle.playerMp;
  let playerStatuses: BattleStatusEffect[] = [...battle.playerStatuses];
  let creatureHp = battle.creatureHp;
  let creatureMaxHp = battle.creatureMaxHp;
  let creatureStatuses: BattleStatusEffect[] = [...battle.creatureStatuses];
  let creatureBerserk = battle.creatureBerserk;
  let creatureEvolved = battle.creatureEvolved;
  let creatureSequence = battle.creatureSequence;
  let allyCount = battle.allyCount;
  let allyCalled = battle.allyCalled;
  let allyArrivesAtRound = battle.allyArrivesAtRound;
  let creaturePlayingDead = battle.creaturePlayingDead;
  let negateCreatureActions = battle.negateCreatureActions;
  let negatePlayerActions = battle.negatePlayerActions;
  let lastPlayerDamage = battle.lastPlayerDamage;
  // 镜中客的「镜像」：上一回合挂上的一次性标记，这一回合被玩家的第一击消耗掉
  let creatureShield = battle.creatureShield;
  /**
   * M2.10：对手的称呼。
   *
   * PVE 是「它」（一只生物），PVP 是「他」（另一个玩家）——
   * 同一句「它打中了你，造成 12 点伤害」在 PVP 里读起来是错的。
   * 一个变量管住所有回执文案，比在每句话里判断 isPvp 可靠得多。
   */
  const subject = battle.isPvp ? '他' : '它';
  /** M2.10：对手这一回合在防御（他受到的伤害减半）。生物的 AI 不会用它 */
  let creatureDefending = false;
  // 物品带来的 MAD 净变化：判定层只记账，由命令层走「唯一数值入口」提交（判定层不认识角色卡）
  let itemMadDelta = 0;
  /** M2.13：使用封印物带来的 COR 净变化（同一手法，同一个理由） */
  let itemCorDelta = 0;
  /*
   * M2.13：**这一回合的封印物加成**（默认全部中性）。
   *
   * 默认值就是「没传封印物」时的行为，所以 M2.9 / M2.10 的既有战斗路径
   * 经过这里时一个字节都不会变 —— 这是既有战斗用例一条都不用改的前提。
   */
  let extraordinaryIgnoreGap = false;
  let extraordinaryHitModifier = 0;
  let extraordinaryDamageMultiplier = 1;
  let extraordinaryReroll = false;
  /** 这一回合真的用上了「无视序列差」没有（报告要数它） */
  let ignoredSequenceGap = false;

  // 强攻的「下回合防御 -30%」：这一回合生效的是**上一回合留下的**那个
  const activeDefensePenalty = battle.playerDefensePenalty;
  let nextDefensePenalty = 0;
  /*
   * M2.26 第三批：藤蔓缠绕（vine_bind）留下的减益 —— 对方**下一次出手**的伤害倍率削减。
   *
   * 「用完即消」写在 creatureSingleStrike 里（真的打出那一下时才消耗），
   * 所以它扑空 / 被挡住的那一次**不会**白白花掉这个减益。
   */
  let enemyDamagePenalty = 0;
  let defendingThisRound = false;
  /** M2.12（战士序列 7「守护」）：这一回合受到的伤害减半，并把挡下来的那一半推回去 */
  let guardingThisRound = false;
/**
 * M2.39：本回合生效的减伤倍率。
 *
 * 默认值就是守护（warrior_7）那一档 —— `case 'guardian'` 不显式赋值，
 * 所以**它的行为与这条改动之前逐字一致**。之所以要把它从
 * `BATTLE.skillEffects.guardian.guardDamageMultiplier` 的硬编码里提出来：
 * 序列 3 的「承载」（mother）声明的是 0.4，而照抄 guardian 的 case 只能读到 0.5
 * —— 表里写着 0.4、跑起来是 0.5，正是 K10 要抓的「配置里有、玩法里没有」。
 */
let guardMultiplier = BATTLE.skillEffects.guardian.guardDamageMultiplier;
  /*
   * M2.65：**途径行动留下的三条战斗标记**。
   *
   * 默认值就是「没挂标记」时的中性值（1 / 1 / 0）—— 所以 `options.action` 不传时，
   * 下面每一处的行为都与这条改动之前**逐位相同**（既有战斗用例一条都不用改）。
   *
   * 三条全部**用完即消**：真的用掉的那一下把变量清零，并把名字记进
   * `consumedActionMarks`，由命令层去删 flag（判定层不做 IO）。
   */
  let actionNextAttack = options.action?.nextAttack ?? 1;
  let actionGuard = options.action?.guardDamage ?? 1;
  let actionEnemyPenalty = options.action?.enemyDamage ?? 0;
  const consumedActionMarks: Array<'nextAttack' | 'guardDamage' | 'enemyDamage'> = [];
  /*
   * M2.65：**对手那一侧**的同一组标记（只有 PVP 会传，PVE 恒为中性）。
   * 方向相反：它提高对手的出手伤害、削减你打出去的那一下。
   */
  let foeNextAttack = options.action?.foe?.nextAttack ?? 1;
  let foeGuard = options.action?.foe?.guardDamage ?? 1;
  let foeEnemyPenalty = options.action?.foe?.enemyDamage ?? 0;
  const consumedFoeMarks: Array<'nextAttack' | 'guardDamage' | 'enemyDamage'> = [];
  /*
   * M2.66：**净先手差**（自己的先手 − 对手的先手）× perPoint，只在前几个回合生效。
   *
   * 不掷骰：掷骰会改变既有战斗的随机流水，而「谁更快」用差值已经表达完了
   *（理由写在 config/numeric.ts 的 BATTLE.initiative 上面）。
   * 两边都没有这个能力时恒为 0 ⇒ 命中链与加这一层之前逐位相同。
   */
  const initiativeEdge = battle.round <= BATTLE.initiative.rounds
    ? ((options.initiative ?? 0) - (options.initiativeFoe ?? 0)) * BATTLE.initiative.perPoint
    : 0;
  let status: BattleStatusKind = 'active';
  let playerDamageDealt = 0;
  let creatureDamageDealt = 0;

  const round = battle.round;

  /* ---- 0. 增援到达 ---- */
  if (allyArrivesAtRound !== null && round >= allyArrivesAtRound && allyCount < AI.allyMaxCount) {
    allyCount += 1;
    creatureMaxHp += AI.allyHpBonus;
    creatureHp += AI.allyHpBonus;
    creatureStatuses = removeStatus(creatureStatuses, 'lostControl');
    flags.allyArrived = true;
    events.push({
      kind: 'creature_call_ally',
      text: `援军到了 —— 雾里又走出来一只同类的轮廓（第 ${allyCount} 只）。`,
    });
  }

  /*
   * M2.66：先手在回执里要看得见 —— 否则玩家只会觉得「这一场我手感不错」。
   * 只在真的有差值且还在生效回合内时说，没有这个能力的人一个字都不会多。
   */
  if (initiativeEdge !== 0) {
    events.push({
      kind: 'player_skill',
      text: initiativeEdge > 0
        ? '你先动了手 —— 它慢了半拍。'
        : '它比你快 —— 你刚站稳，它已经到了面前。',
    });
  }

  /* ---- 1. 玩家动作 ---- */
  const playerCanAct = canActOf(playerStatuses);
  let effectiveAction = action;
  if (negatePlayerActions > 0) {
    // M2.10：被对手的「幻觉干扰」吞掉一次行动（PVP 专用路径；PVE 里这个数恒为 0）
    negatePlayerActions -= 1;
    events.push({ kind: 'negated', text: '你想动，但刚才那一下没落下来 —— 手是空的。' });
  } else if (!playerCanAct) {
    events.push({ kind: 'negated', text: '你想动，但身体还在上一个瞬间里。' });
  } else {
    if (hasStatus(playerStatuses, 'lostControl')) {
      // 失控：随机行动，**不能选技能**（任务书 §4.3.4）
      const pool: PlayerAction['kind'][] = ['attack', 'defend', 'retreat'];
      effectiveAction = { kind: pool[Math.floor(rng.next() * pool.length)] ?? 'attack' };
      rolls.lostControl = rng.next();
      events.push({ kind: 'negated', text: '你没按自己想的那样动 —— 手先动了。' });
    }
    switch (effectiveAction.kind) {
      case 'attack':
        playerAttack({ rng, rolls, events, flags, multiplier: 1, extraHit: 0 });
        break;
      case 'defend':
        defendingThisRound = true;
        playerMp = clamp(playerMp + BATTLE.actions.defend.mpRestore, 0, PLAYER_MAX_MP);
        events.push({
          kind: 'player_defend',
          text: `你压低了身子等它先动。灵力 +${BATTLE.actions.defend.mpRestore}。`,
        });
        break;
      case 'retreat': {
        const chance = clamp(
          BATTLE.actions.retreat.baseChance -
            (world.danger / 5) * BATTLE.actions.retreat.dangerPenalty,
          0.05,
          0.95,
        );
        const roll = rng.next();
        rolls.retreat = roll;
        /*
         * M2.10 前置 2：撤退的代价要说清楚。
         *
         * 撤退**不是惩罚**：什么都不花（不掉血 / 不掉 MAD / 不丢东西），
         * 失败也不花。玩家在连续挨打的时候最需要知道的就是这件事 ——
         * 否则他会以为「退出去」也要付一笔代价，于是硬扛到被打死。
         */
        if (roll < chance) {
          status = 'fled';
          events.push({
            kind: 'player_retreat',
            text: '你退了出去，雾合上来把它隔在外面 —— 不掉血、不掉 MAD、不丢东西。',
          });
        } else {
          events.push({
            kind: 'player_retreat',
            text: '没能甩掉它 —— 这一次退不出去。',
          });
        }
        break;
      }
      case 'item':
        useItem(options.item ?? null, events);
        break;
      /*
       * M2.13：**用一件封印物。**
       *
       * 它不是「加一个战斗动作」，是「这一回合的攻击换一种打法」：
       * 封印之刃 / 血月之刃的效果都作用在**这一回合的那一下**上，
       * 所以这里紧接着就调用 playerAttack（而不是把加成留到下一回合）。
       */
      case 'extraordinary':
        useExtraordinary(options.extraordinary ?? null, events);
        // M2.85 B（重做）：动用非凡物品就要付代价 —— 理智与腐蚀
        equipmentCost.mad += world.equipmentDebuffs?.madPerUse ?? 0;
        equipmentCost.cor += world.equipmentDebuffs?.corGain ?? 0;
        break;
      case 'skill':
        playerSkill(effectiveAction.skillId ?? '', { rng, rolls, events, flags });
        // 「每次使用理智 −N」的落点就是这里：技能是主动动用它们的动作
        equipmentCost.mad += world.equipmentDebuffs?.madPerUse ?? 0;
        equipmentCost.cor += world.equipmentDebuffs?.corGain ?? 0;
        break;
      default:
        break;
    }
  }

  /* ---- 2. 生物动作 ---- */
  const decided: CreatureAction =
    options.creatureAction ?? decideCreatureAction(species, battle, rng);
  let creatureAction = decided;
  let creatureActed = false;

  if (status === 'active' && creatureHp > 0 && playerHp > 0) {
    const canAct =
      creatureCanAct({ ...battle, creatureStatuses, negateCreatureActions }) && creatureHp > 0;
    if (!canAct) {
      if (negateCreatureActions > 0) {
        negateCreatureActions -= 1;
        events.push({ kind: 'negated', text: `${species.name}想动，但那一下没落下来。` });
      } else {
        events.push({ kind: 'negated', text: `${species.name}被按在原地，动不了。` });
      }
    } else {
      creatureActed = true;
      resolveCreatureAction(decided, { rng, rolls, events, flags });
    }
  }

  /* ---- 3. 状态持续伤害 ---- */
  for (const [side, list] of [
    ['player', playerStatuses],
    ['creature', creatureStatuses],
  ] as const) {
    const dot = dotOf(list);
    if (dot.hp === 0 && dot.mp === 0) continue;
    if (side === 'player') {
      playerHp = clamp(playerHp + dot.hp, 0, PLAYER_MAX_HP);
      playerMp = clamp(playerMp + dot.mp, 0, PLAYER_MAX_MP);
    } else {
      creatureHp = Math.max(0, creatureHp + dot.hp);
    }
    for (const line of dot.lines) events.push({ kind: 'status_tick', text: line });
  }

  /*
   * ---- 3.5 非凡物品的代价（M2.85 B 重做）----
   *
   * 用户拍板：「装备其实就是非凡物品啊，装备上去有增幅，但也有 debuff」。
   * 原著的规则是**必然伴随** —— 所以代价必须在判定层真的扣，而不是只写在描述里。
   *
   * ⚠️ 放在这个位置（而不是上面那个循环里）是因为上面那句 `continue`：
   * 没有状态伤害时整个循环会被跳过，装备的流血就**永远不会发生**。
   */
  const equipDrain = world.equipmentDebuffs?.hpDrain ?? 0;
  if (equipDrain > 0 && playerHp > 0) {
    playerHp = clamp(playerHp - equipDrain, 0, PLAYER_MAX_HP);
    events.push({ kind: 'status_tick', text: '身上的东西在吸你 —— 流血 ' + equipDrain + '。' });
  }

  /* ---- 4. 状态计时推进 ---- */
  const playerAdvance = advanceStatuses(playerStatuses);
  const creatureAdvance = advanceStatuses(creatureStatuses);
  playerStatuses = playerAdvance.list;
  creatureStatuses = creatureAdvance.list;

  /* ---- 5. 结束判定 ---- */
  if (status === 'active') {
    if (creatureHp <= 0) {
      status = 'player_win';
      events.push({ kind: 'ended', text: `${species.name}倒了。它没有再动。` });
    } else if (playerHp <= 0) {
  // M2.85：神战 40 回合（BATTLE.godMaxRounds）。字段是**可选 + 兜底**，
  // 这样所有老构造点（DB 反序列化、PVP、既有测试）都不用动
  } else if (round >= (battle.maxRounds ?? BATTLE.maxRounds)) {
      status = 'stalemate';
      events.push({ kind: 'ended', text: '你们谁也没能按住谁。它先退进了雾里。' });
    }
  }

  /* ---- 6. 把这一回合的结果拼成完整状态 ---- */
  const battleAfter: BattleState = {
    ...battle,
    round: round + 1,
    status,
    playerHp,
    playerMp,
    playerStatuses,
    playerDefensePenalty: nextDefensePenalty,
    creatureHp: Math.max(0, creatureHp),
    creatureMaxHp,
    creatureStatuses,
    creatureBerserk,
    creatureEvolved,
    creatureSequence,
    allyCount,
    allyCalled,
    allyArrivesAtRound,
    creaturePlayingDead,
    negateCreatureActions,
    negatePlayerActions,
    lastPlayerDamage,
    creatureShield,
    foresight: null,
    lastRoundAt: battle.lastRoundAt,
    /*
     * resolvedAt 由**仓储**在写回时落定（它才知道「现在」是几点）。
     * 判定层不读时钟，所以这里只负责把「结束了没有」表达清楚。
     */
    resolvedAt: null,
  };

  /* ---- 7. 占卜预判：算的是**这一回合结束之后**的下一回合 ---- */
  if (flags.foresight && status === 'active') {
    /*
     * 预知必须**说真话**：这里用的随机源与下一回合真正决策时用的那个是同一个
     * （由命令层按「battleId:回合号:ai」派生并传进来），所以「它要扑上来」
     * 与它真的扑上来是同一件事，不是两次独立的掷骰。
     */
    const aiRng = options.aiRng ?? rng;
    battleAfter.foresight = {
      round: round + 1,
      action: decideCreatureAction(species, battleAfter, aiRng),
    };
  }

  return {
    battleId: battle.id,
    round,
    playerAction: effectiveAction,
    creatureAction,
    creatureActed,
    events,
    playerHp,
    playerMp,
    creatureHp: Math.max(0, creatureHp),
    playerStatuses,
    creatureStatuses,
    playerDamageDealt,
    creatureDamageDealt,
    // M2.85 B（重做）：非凡物品的代价（由命令层落到角色卡上）
    equipmentCost,
    status,
    flags,
    rolls,
    /** 使用物品带来的 MAD 净变化（命令层据此提交，不写进 battle 状态） */
    itemMadDelta,
    /** M2.13：使用封印物带来的 COR 净变化（同上） */
    itemCorDelta,
    /** M2.13：这一回合有没有真的用上「无视序列差拦截」 */
    ignoredSequenceGap,
    /** M2.65：这一回合真的用掉了哪几条行动标记（命令层据此删 flag） */
    consumedActionMarks,
    /** M2.65：对手那一侧用掉的那几条（PVP 专用，PVE 恒为空） */
    consumedFoeMarks,
    battle: battleAfter,
  };

  /* ================================================================ *
   * 下面全是闭包形式的内部步骤（共享上面那份可变工作副本）
   * ================================================================ */

  /** 玩家打出去的一击。倍率与命中加成都从这里进，好让「谁改了什么」只有一处 */
  function playerAttack(input: {
    rng: Rng;
    rolls: Record<string, number>;
    events: RoundEvent[];
    flags: typeof flags;
    multiplier: number;
    extraHit: number;
    /** M2.13（封印之刃）：这一击**无视一次序列差拦截**；默认 false = 与 M2.9 逐位一致 */
    ignoreSequenceGap?: boolean;
    /** M2.13（命运骰子）：打空后**重抽一次**；默认 false */
    reroll?: boolean;
    /*
     * M2.26 第三批：返回值 = **这一击实际造成的伤害**（没打中 / 被拦住时是 0）。
     *
     * 为什么改成有返回值：`life_drain`（生命汲取）要按实伤回血，而实伤只有这里知道。
     * 改之前它是 void —— 想拿到这个数就只能去读 `lastPlayerDamage`，而那是**本回合最后一次**攻击的伤害，
     * 打空时它还是**上一次**的旧值 ⇒ 会凭空回血（一个只在 miss 时出现的 bug）。
     * 有返回值的写法对其它 20 多个调用点是**完全无感**的（它们本来就不接收）。
     */
  }): number {
    const cfg = BATTLE.actions.attack;
    /*
     * M2.65：**下一次出手**的倍率（破绽 / 断局 / 破阵 / 预演）—— 用完即消。
     *
     * 只在**真的打中**时消耗（与藤蔓缠绕的减益同一条口径：扑空了那一次不该白白花掉）。
     * 多段技能只吃一次：第一段打中就把变量清零，后面几段照旧。
     */
    const actionAttackBonus = actionNextAttack;
    // 对手挂在你身上的那两条：它挡得住的（guardDamage）× 它让你使不上力的（enemyDamage）
    const foeDefense = foeGuard * (1 - foeEnemyPenalty);
    const baseDamage = Math.max(
      1,
      Math.round(
        rollRange(cfg.baseDamageMin, cfg.baseDamageMax, input.rng) *
          input.multiplier *
          actionAttackBonus *
          foeDefense *
          // M2.18（C/D）：关系加成 → 倍率（不传 = ×1，与 M2.17 逐位相同）
          (1 + (options.relation?.damage ?? 0)) *
          (creatureBerserk ? 1 / AI.berserkDefenseMult : 1) *
          (creatureShield ? 0.5 : 1),
      ),
    );
    // 镜中客的「镜像」：打向它的第一击减半，用完即消
    if (creatureShield) creatureShield = false;
    /*
     * M2.18（C/D）：势力关系的命中加成（**相加**，与封印物那条链不冲突）。
     * 不传 relation 时是 0 —— 默认行为与 M2.17 逐位相同。
     */
    const hitModifier =
      hitPenaltyOf(playerStatuses) +
      world.weatherHitPenalty +
      input.extraHit +
      (options.relation?.hit ?? 0) +
      // M2.66：先手（第一回合才有值；没有这个能力时是 0）
      initiativeEdge;
    const assaultInput = {
      attackerSeq: playerSeq,
      targetSeq: creatureSequence,
      // M2.85：挑战神时豁免高序列抗性（否则序列 1 的玩家对序列 0 命中率被压到 0）
      ignoreResist: isDeityOpponent(battle.creatureId),
      baseHit: cfg.baseHit,
      baseDamage,
      baseDamageMax: baseDamage,
      hitModifier,
      // 只有真的带着封印之刃时才写这一位：默认不写 = 与 M2.9 的调用完全一致
      ...(input.ignoreSequenceGap === true ? { ignoreSequenceGap: true } : {}),
    };
    let assault = resolveAssault(assaultInput, input.rng);
    input.rolls.attack = assault.roll;
    input.rolls.hitChance = Number(assault.hitChance.toFixed(4));

    /*
     * M2.13（命运骰子）：**打空了就重抽一次**。
     *
     * 三条口径都写在这里：
     *   1. **只在「没被拦、也没中」时重抽。** 被序列差拦住的那种是确定性的
     *      （不掷骰、重掷一百次还是拦），为它花掉一件封印物是骗玩家 ——
     *      那种情况的正解是封印之刃，不是命运骰子；
     *   2. **只采用「第二次中了」的那一次。** 第二次也空的话不覆盖第一次，
     *      规则固定成这一条，「同 seed 同结果」才不需要额外的解释；
     *   3. **消耗一个随机数**（rng.next() 在 resolveAssault 内部）。
     *      只有在真的重抽时才消耗 —— 与「不该掷骰时不掷」同一条纪律。
     */
    if (input.reroll === true && !assault.blocked && assault.hit !== true) {
      const second = resolveAssault(assaultInput, input.rng);
      input.rolls.reroll = second.roll;
      input.rolls.rerollHit = second.hit === true ? 1 : 0;
      if (second.hit === true) {
        assault = second;
        input.events.push({
          kind: 'player_extraordinary',
          text: '骰子又滚了一次 —— 这一次它停在了另一个面上。',
        });
      }
    }
    if (assault.ignoredSequenceGap) ignoredSequenceGap = true;

    if (assault.blocked) {
      input.events.push({ kind: 'player_attack', text: assault.reason ?? '你近不了它的身。' });
      return 0;
    }
    if (!assault.hit) {
      input.events.push({ kind: 'player_attack', text: '你挥空了。它比你想象的快。' });
      return 0;
    }

    let damage = assault.damage ?? 0;
    /* 暴击：**「流血」的唯一来源**（任务书 §4.3.4 写的就是「攻击暴击」） */
    if (rollChance(input.rng, BATTLE.crit.chance)) {
      input.flags.crit = true;
      damage = Math.round(damage * BATTLE.crit.multiplier);
      creatureStatuses = applyStatus(creatureStatuses, 'bleed', '你的重击');
      input.flags.bleed = true;
      input.events.push({
        kind: 'status_apply',
        text: '这一下打实了 —— 它开始流血。',
        status: 'bleed',
      });
    }

    // 打中了才算用掉（上面两处 return 是「被拦住」与「挥空」）
    if (actionNextAttack !== 1) {
      actionNextAttack = 1;
      consumedActionMarks.push('nextAttack');
    }
    // 对手那两条同理：这一下真的落到他身上了，才算把它们用掉
    if (foeGuard !== 1) {
      foeGuard = 1;
      consumedFoeMarks.push('guardDamage');
    }
    if (foeEnemyPenalty > 0) {
      foeEnemyPenalty = 0;
      consumedFoeMarks.push('enemyDamage');
    }
    creatureHp -= damage;
    playerDamageDealt += damage;
    lastPlayerDamage = damage;
    input.events.push({ kind: 'player_attack', text: `你打中了，造成 ${damage} 点伤害。`, damage });
    return damage;
  }

  /** 技能：判定层只认 numeric 里的 skillEffects，不写任何 if (pathway === ...) */
  function playerSkill(
    skillId: string,
    ctx: { rng: Rng; rolls: Record<string, number>; events: RoundEvent[]; flags: typeof flags },
  ): void {
    const skill = skillById(skillId);
    if (!skill || playerMp < skill.mpCost) {
      ctx.events.push({ kind: 'player_skill', text: '你想用它，但灵力不够 —— 这一回合白过了。' });
      return;
    }
    playerMp -= skill.mpCost;
    const effect = skillEffectOf(skill.id, world.skillEffects);
    const number = (key: string): number => {
      const value = effect[key];
      return typeof value === 'number' ? value : 0;
    };

    switch (skill.id) {
      case 'divine_foresight': {
        flags.foresight = true;
        ctx.events.push({ kind: 'foresight', text: `你用了「${skill.name}」—— 下一步的形状先落进你眼里。` });
        break;
      }
      case 'hallucination': {
        negateCreatureActions += Math.max(1, number('negateOpponentActions'));
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：它看见的东西和你站的地方错开了。` });
        break;
      }
      case 'power_strike': {
        playerAttack({
          rng: ctx.rng,
          rolls: ctx.rolls,
          events: ctx.events,
          flags: ctx.flags,
          multiplier: number('damageMultiplier') || 1.5,
          extraHit: 0,
        });
        nextDefensePenalty = number('nextRoundDefensePenalty') || 0.3;
        ctx.events.push({
          kind: 'player_skill',
          text: `「${skill.name}」：你不管不顾地撞上去。下一回合你的防御会差一点。`,
        });
        break;
      }
      case 'double_strike': {
        const hits = Math.max(1, Math.round(number('hits') || 2));
        const decay = number('secondHitDecay') || 0.6;
        for (let index = 0; index < hits; index += 1) {
          // 第二下命中递减：把「命中率 × decay」表达成加性修正（判定层只收 hitModifier）
          const rawChance = clamp(hitChanceOf(playerSeq - creatureSequence) + (world.equipmentHitBonus ?? 0), 0, 1);
          const extraHit = index === 0 ? 0 : -rawChance * (1 - decay);
          playerAttack({
            rng: ctx.rng,
            rolls: ctx.rolls,
            events: ctx.events,
            flags: ctx.flags,
            multiplier: 1,
            extraHit,
          });
        }
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：两下连着上去，第二下没那么准。` });
        break;
      }
      case 'night_vision': {
        const bonus = world.night ? number('nightHitBonus') : number('dayHitPenalty');
        playerAttack({
          rng: ctx.rng,
          rolls: ctx.rolls,
          events: ctx.events,
          flags: ctx.flags,
          multiplier: 1,
          extraHit: bonus,
        });
        ctx.events.push({
          kind: 'player_skill',
          text: world.night
            ? `「${skill.name}」：夜里你看得比它清楚。`
            : `「${skill.name}」：天太亮了，你反而有点晃眼。`,
        });
        break;
      }
      case 'nightmare': {
        // 先记「你用了它」—— 否则打断暴走失败时这一回合在回执里会像什么都没发生
        ctx.events.push({
          kind: 'player_skill',
          text: `「${skill.name}」：你把那个念头按进它的脑子里。`,
        });
        if (effect.breakBerserk === true && creatureBerserk) {
          creatureBerserk = false;
          ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：它的暴走被打断了。` });
        }
        creatureStatuses = applyStatus(creatureStatuses, 'fear', `你的${skill.name}`);
        ctx.events.push({
          kind: 'status_apply',
          text: `「${skill.name}」：它开始怕了。`,
          status: 'fear',
        });
        break;
      }
      /* ---------------- M2.12：三条途径的序列 7 ---------------- */
      /* M2.29 批次 A1：序列 6 的技能。形状照既有那批 —— 复用字段，不造新读点。 */
      case 'mirror_image': {
        const hits = Math.max(1, Math.round(number('hits') || 2));
        const decay = number('secondHitDecay') || 0.6;
        for (let index = 0; index < hits; index += 1) {
          const rawChance = clamp(hitChanceOf(playerSeq - creatureSequence) + (world.equipmentHitBonus ?? 0), 0, 1);
          const extraHit = index === 0 ? 0 : -rawChance * (1 - decay);
          playerAttack({
            rng: ctx.rng,
            rolls: ctx.rolls,
            events: ctx.events,
            flags: ctx.flags,
            multiplier: 1,
            extraHit,
          });
        }
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你站成两个 —— 它打中的那一个不是真的。` });
        break;
      }
      /* M2.29 批次 A1：序列 6 的其余六条。形状全部复用既有字段（零新读点）。 */
      case 'steadfast': {
        const hits = Math.max(1, Math.round(number('hits') || 2));
        const decay = number('secondHitDecay') || 0.85;
        for (let index = 0; index < hits; index += 1) {
          const rawChance = clamp(hitChanceOf(playerSeq - creatureSequence) + (world.equipmentHitBonus ?? 0), 0, 1);
          const extraHit = index === 0 ? 0 : -rawChance * (1 - decay);
          playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: 1, extraHit });
        }
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你站住不动 —— 它撞上来两次，你一次都没退。` });
        break;
      }
      case 'dream_walk': {
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.4, extraHit: 0 });
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你从它的梦里走过去，顺手带走了点东西。` });
        break;
      }
      case 'song_of_deep': {
        const hits = Math.max(1, Math.round(number('hits') || 3));
        const decay = number('secondHitDecay') || 0.8;
        for (let index = 0; index < hits; index += 1) {
          const rawChance = clamp(hitChanceOf(playerSeq - creatureSequence) + (world.equipmentHitBonus ?? 0), 0, 1);
          const extraHit = index === 0 ? 0 : -rawChance * (1 - decay);
          playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: 1, extraHit });
        }
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你唱了三个音 —— 海跟着应了三下。` });
        break;
      }
      case 'calibrated_shot': {
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.5, extraHit: 0 });
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：这一下是量过的 —— 它没量过你。` });
        break;
      }
      case 'annotate': {
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.2, extraHit: 0 });
        enemyDamagePenalty = number('enemyDamagePenalty') || 0.2;
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你在它身上写了一句批注 —— 它读不懂，但它慢了。` });
        break;
      }
      case 'nurture': {
        const cost = Math.max(0, Math.round(number('selfHpCost') || 5));
        playerHp = clamp(playerHp - cost, 0, PLAYER_MAX_HP);
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.3, extraHit: 0 });
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你把它当成还没长成的东西（-${cost}）。` });
        break;
      }
      /* M2.29 批次 A2：序列 5 的七条。形状沿用 A1 的三种（单段 / 多段 / 自扣+减益）。 */
      case 'puppet_strings': {
        const hits = Math.max(1, Math.round(number('hits') || 2));
        const decay = number('secondHitDecay') || 0.7;
        for (let index = 0; index < hits; index += 1) {
          const rawChance = clamp(hitChanceOf(playerSeq - creatureSequence) + (world.equipmentHitBonus ?? 0), 0, 1);
          const extraHit = index === 0 ? 0 : -rawChance * (1 - decay);
          playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: 1, extraHit });
        }
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：线一抖，替你动手的那个也跟着抖。` });
        break;
      }
      /* M2.39 批次 B：序列 4、3 的两条。判定层是 switch (skill.id)，不是纯 effect 驱动 ——
       * 只改 numeric 两张表的症状是「扣了灵力、回执说『什么也没发生』、伤害 0」，而 tsc 一声不吭。 */
      case 'misalign': {
        const hits = Math.max(1, Math.round(number('hits') || 3));
        const decay = number('secondHitDecay') || 0.65;
        for (let index = 0; index < hits; index += 1) {
          const rawChance = clamp(hitChanceOf(playerSeq - creatureSequence) + (world.equipmentHitBonus ?? 0), 0, 1);
          const extraHit = index === 0 ? 0 : -rawChance * (1 - decay);
          playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: 1, extraHit });
        }
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你把它该站的位置挪了一格，它打中的是刚才的你。` });
        break;
      }
      case 'reel_in': {
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.7, extraHit: 0 });
        nextDefensePenalty = number('nextRoundDefensePenalty') || 0.3;
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：线收到头 —— 你把它拽过来了，自己也跟着晃了一下。` });
        break;
      }
      case 'deep_root': {
        const dealt = playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.5, extraHit: 0 });
        const drained = Math.round(dealt * (number('lifeSteal') || 0.3));
        if (drained > 0) {
          playerHp = clamp(playerHp + drained, 0, PLAYER_MAX_HP);
          ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：根从底下伸过去，把它的力气接了过来（+${drained}）。` });
        } else {
          ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：根伸出去了，可那底下什么也没有。` });
        }
        break;
      }
      case 'bearing': {
        guardingThisRound = true;
        guardMultiplier = number('guardDamageMultiplier') || 0.4;
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：他把脚踩进地里 —— 撞上来的那一下，大地先接住了。` });
        break;
      }
      /* M2.39 批次 B：reader 的两条（设计稿只写了「各 +1 条技能」，没给定义 ——
       * 这里按本途径既有档位补：序列 9/8/7 是 1.35 / 两段 / 2.0，这一批沿 26 → 30 → 34 → 38 的灵力档，
       * 形状取「伤害 + 给对方挂减益」（与 consult 同族），**不越过 2.0 的上限**。 */
      case 'recite': {
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.4, extraHit: 0 });
        enemyDamagePenalty = number('enemyDamagePenalty') || 0.3;
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你把它的来历念了出来 —— 被说中的东西会慢下来。` });
        break;
      }
      case 'omniscience': {
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.8, extraHit: 0 });
        enemyDamagePenalty = number('enemyDamagePenalty') || 0.3;
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你知道它下一步要做什么 —— 它自己还不知道你知道。` });
        break;
      }
      /* M2.43 批次 C：序列 2 的七条。判定层是 switch (skill.id) —— 只改 numeric 两张表的症状是
       * 「扣了灵力、回执说『什么也没发生』、伤害 0」，而 tsc 一声不吭。
       * 七条**全部照既有分支的形状写**：控制抄 hallucination / shutdown，定身抄 long_night，
       * 减益抄 ballast_stance，吸血抄 deep_root —— 没有新变量、没有新字段。 */
      case 'net_of_fate': {
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.6, extraHit: 0 });
        negateCreatureActions += Math.max(1, Math.round(number('negateOpponentActions') || 1));
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：网不是用来缠的 —— 它只是让下一步没有地方落。` });
        break;
      }
      case 'break_formation': {
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.75, extraHit: 0 });
        creatureStatuses = applyStatus(
          creatureStatuses,
          'banish',
          `你的${skill.name}`,
          Math.max(1, Math.round(number('banishRounds') || 2)),
        );
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你不是在打它 —— 你在打它站的那个位置。` });
        ctx.events.push({ kind: 'status_apply', text: `「${skill.name}」：阵脚散了，它得先找回自己的位置。`, status: 'banish' });
        break;
      }
      case 'eternal_night': {
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.6, extraHit: 0 });
        creatureStatuses = applyStatus(
          creatureStatuses,
          'banish',
          `你的${skill.name}`,
          Math.max(1, Math.round(number('banishRounds') || 2)),
        );
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：天不会再亮了，而它还在等天亮。` });
        ctx.events.push({ kind: 'status_apply', text: `「${skill.name}」：它连自己在等什么都忘了。`, status: 'banish' });
        break;
      }
      case 'capsize': {
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.6, extraHit: 0 });
        enemyDamagePenalty = number('enemyDamagePenalty') || 0.4;
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：水从底下翻上来，它踩着的那块地先没了。` });
        break;
      }
      case 'sequencing': {
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.8, extraHit: 0 });
        creatureStatuses = applyStatus(
          creatureStatuses,
          'banish',
          `你的${skill.name}`,
          Math.max(1, Math.round(number('banishRounds') || 2)),
        );
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你把它的下一步挪到了你的后面。` });
        ctx.events.push({ kind: 'status_apply', text: `「${skill.name}」：它按原来的顺序出手，可那一步已经过去了。`, status: 'banish' });
        break;
      }
      case 'rehearsal': {
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.8, extraHit: 0 });
        enemyDamagePenalty = number('enemyDamagePenalty') || 0.4;
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：这一下你在脑子里已经打过一遍了。` });
        break;
      }
      case 'rebirth': {
        const dealt = playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.6, extraHit: 0 });
        const drained = Math.round(dealt * (number('lifeSteal') || 0.4));
        if (drained > 0) {
          playerHp = clamp(playerHp + drained, 0, PLAYER_MAX_HP);
          ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你把自己的一口气分了出去 —— 它得先还回来（+${drained}）。` });
        } else {
          ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你分出去的那口气，没有回来。` });
        }
        break;
      }
      case 'assemble': {
        const hits = Math.max(1, Math.round(number('hits') || 3));
        const decay = number('secondHitDecay') || 0.8;
        for (let index = 0; index < hits; index += 1) {
          const rawChance = clamp(hitChanceOf(playerSeq - creatureSequence) + (world.equipmentHitBonus ?? 0), 0, 1);
          const extraHit = index === 0 ? 0 : -rawChance * (1 - decay);
          playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: 1, extraHit });
        }
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你把三件东西装到一起 —— 装完才发现它们是同一件。` });
        break;
      }
      case 'shutdown': {
        negateCreatureActions += Math.max(1, number('negateOpponentActions'));
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你找到那个还在转的东西，把它按停了。` });
        break;
      }
      case 'ballast_stance': {
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.25, extraHit: 0 });
        enemyDamagePenalty = number('enemyDamagePenalty') || 0.25;
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你把重心压下去 —— 它再推你，推的是整条船。` });
        break;
      }
      case 'storm_eye': {
        const hits = Math.max(1, Math.round(number('hits') || 2));
        const decay = number('secondHitDecay') || 0.9;
        for (let index = 0; index < hits; index += 1) {
          const rawChance = clamp(hitChanceOf(playerSeq - creatureSequence) + (world.equipmentHitBonus ?? 0), 0, 1);
          const extraHit = index === 0 ? 0 : -rawChance * (1 - decay);
          playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: 1, extraHit });
        }
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：风停了一下 —— 那一下里只有你动。` });
        break;
      }
      /* sleepless 4 的 night_raid：**倍率 + 昼夜加成**的组合。既有的 night_vision 写死 multiplier: 1，
       * dream_walk 读倍率但不看昼夜 —— 两个都不能单独照抄。这里显式读两个字段。 */
      case 'night_raid': {
        const extraHit = world.night ? number('nightHitBonus') : 0;
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.4, extraHit });
        ctx.events.push({ kind: 'player_skill', text: world.night ? `「${skill.name}」：天黑了 —— 你比它先看见。` : `「${skill.name}」：天还亮着，这一下没占到便宜。` });
        break;
      }
      /* sleepless 3 的 long_night：**倍率 + 定身**的组合。dread_projection 根本不调用 playerAttack，
       * 所以照抄它会把 1.6 倍整个丢掉。这里按 annotate / vine_bind 的「先打、再挂状态」形状写。 */
      case 'long_night': {
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.6, extraHit: 0 });
        creatureStatuses = applyStatus(
          creatureStatuses,
          'banish',
          `你的${skill.name}`,
          Math.max(1, Math.round(number('banishRounds') || 1)),
        );
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：夜整个压下来 —— 它连自己在哪都忘了。` });
        ctx.events.push({ kind: 'status_apply', text: `「${skill.name}」：它定在原地 —— 下一回合它动不了。`, status: 'banish' });
        break;
      }
      case 'decisive_blow': {
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.75, extraHit: 0 });
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：这一下你没有留手 —— 留手是给还有下一回合的人用的。` });
        break;
      }
      /* M2.39 批次 B：**倍率 + 多段**的唯一一条。既有多段 case（double_strike / steadfast /
       * mirror_image / puppet_strings / wave_rush / chain_calibration / deconstruct / song_of_deep）
       * 全部写死 multiplier: 1（只读 hits / secondHitDecay）—— 照抄任何一个都会**静默丢掉 1.6 倍**。
       * 所以这里显式读 damageMultiplier，让两个字段同时生效。 */
      case 'crushing_charge': {
        const hits = Math.max(1, Math.round(number('hits') || 2));
        const decay = number('secondHitDecay') || 0.8;
        const multiplier = number('damageMultiplier') || 1.6;
        for (let index = 0; index < hits; index += 1) {
          const rawChance = clamp(hitChanceOf(playerSeq - creatureSequence) + (world.equipmentHitBonus ?? 0), 0, 1);
          const extraHit = index === 0 ? 0 : -rawChance * (1 - decay);
          playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier, extraHit });
        }
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：第一下撞开它，第二下从缺口进去。` });
        break;
      }
      case 'opening_strike': {
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.6, extraHit: 0 });
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你早就看见了那个空档 —— 它自己不知道。` });
        break;
      }
      case 'dream_enter': {
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.5, extraHit: 0 });
        nextDefensePenalty = number('nextRoundDefensePenalty') || 0.3;
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你走进它的梦里 —— 代价是醒来时你还在晃。` });
        break;
      }
      case 'tailwind': {
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.45, extraHit: 0 });
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：风是从背后来的 —— 这一下不是你自己打的。` });
        break;
      }
      case 'retrofit': {
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.5, extraHit: 0 });
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：手上这件东西本来不是干这个的 —— 现在是了。` });
        break;
      }
      case 'consult': {
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.2, extraHit: 0 });
        enemyDamagePenalty = number('enemyDamagePenalty') || 0.25;
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你翻到了那一页 —— 上面写着它接下来会怎么做。` });
        break;
      }
      case 'ripen': {
        const cost = Math.max(0, Math.round(number('selfHpCost') || 8));
        playerHp = clamp(playerHp - cost, 0, PLAYER_MAX_HP);
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: number('damageMultiplier') || 1.4, extraHit: 0 });
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：还没到时候 —— 你让它到了（-${cost}）。` });
        break;
      }
      case 'fate_wager': {
        /*
         * 命运赌注：**打空了就重掷一次**。
         *
         * 实现上不是「加命中」而是**真的重掷**（消耗第二个随机数）——
         * 这两件事在玩家侧的感觉不同：「必中」是变强，「重抽」是运气被改写了一次。
         * 手法是把第一次的过程从事件流里抹掉（记下长度再截断），
         * 否则回执会变成「你挥空了。你打中了。」——两次判定都留在纸上。
         */
        ctx.events.push({
          kind: 'player_skill',
          text: `「${skill.name}」：你把那根线折了一下 —— 这一下本来不是这样落的。`,
        });
        const mark = ctx.events.length;
        const before = playerDamageDealt;
        playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: 1, extraHit: 0 });
        if (effect.rerollMiss === true && playerDamageDealt === before) {
          ctx.events.length = mark;
          ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：线的那一头又动了一下 —— 再来一次。` });
          playerAttack({ rng: ctx.rng, rolls: ctx.rolls, events: ctx.events, flags: ctx.flags, multiplier: 1, extraHit: 0 });
        }
        break;
      }
      case 'guardian': {
        guardingThisRound = true;
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你把自己挡在了这一下前面。` });
        break;
      }
      case 'dread_projection': {
        // 与梦魇同一个手法：先记「你用了它」，免得失败时这一回合像什么都没发生
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你把这个夜晚里最坏的那个念头推了过去。` });
        creatureStatuses = applyStatus(
          creatureStatuses,
          'banish',
          `你的${skill.name}`,
          Math.max(1, Math.round(number('banishRounds') || 1)),
        );
        ctx.events.push({
          kind: 'status_apply',
          text: `「${skill.name}」：它定在原地 —— 下一回合它动不了。`,
          status: 'banish',
        });
        break;
      }
      /* ---------------- M2.19：水手的序列 9 / 8 / 7 ----------------
       *
       * ⚠️ **加一条技能要改三处**（这一轮踩到的）：
       *   1. numeric.ts 的 battle.skills（名字 / mpCost / 解禁序列）
       *   2. numeric.ts 的 battle.skillEffects（数值）
       *   3. **这里** —— 判定层是 `switch (skill.id)`，不是纯 effect 驱动。
       *
       * 只改前两处的症状是：技能扣了灵力、回执写「你用了「潮击」，但什么也没发生」、伤害 0 ——
       * 而 tsc 一声不吭（前两处都是 Record，不校验有没有分支）。
       * 守住它的是 test/m2-19-sailor-battle.test.ts 的 D3：**每条途径都要打得出来**。
       */
      case 'tide_strike': {
        playerAttack({
          rng: ctx.rng,
          rolls: ctx.rolls,
          events: ctx.events,
          flags: ctx.flags,
          multiplier: number('damageMultiplier') || 1.35,
          extraHit: 0,
        });
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你把重心压下去，顺着那一下推了一把。` });
        break;
      }
      case 'wave_rush': {
        const hits = Math.max(1, Math.round(number('hits') || 2));
        const decay = number('secondHitDecay') || 0.75;
        for (let index = 0; index < hits; index += 1) {
          const rawChance = clamp(hitChanceOf(playerSeq - creatureSequence) + (world.equipmentHitBonus ?? 0), 0, 1);
          const extraHit = index === 0 ? 0 : -rawChance * (1 - decay);
          playerAttack({
            rng: ctx.rng,
            rolls: ctx.rolls,
            events: ctx.events,
            flags: ctx.flags,
            multiplier: 1,
            extraHit,
          });
        }
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你踩着浪一步跨过去，两下都招呼上了。` });
        break;
      }
      case 'maelstrom': {
        playerAttack({
          rng: ctx.rng,
          rolls: ctx.rolls,
          events: ctx.events,
          flags: ctx.flags,
          multiplier: number('damageMultiplier') || 2,
          extraHit: 0,
        });
        nextDefensePenalty = number('nextRoundDefensePenalty') || 0.5;
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：整片海压下去 —— 你自己也站不稳。` });
        break;
      }
      /*
       * M2.26 第一批：完美者（perfect）的三条。
       *
       * 形状与 M2.12 / M2.19 那两批对齐，**每一段都复用已有的效果字段**
       * （`damageMultiplier` / `hits` / `secondHitDecay` / `nextRoundDefensePenalty`）——
       * 一条新字段都不造。守住「三条都真的能打」的是
       * test/m2-26-steam-battle.test.ts 的 D3：**每条途径都要打得出来**。
       *
       * ⚠️ K2 的教训在这里同样适用：这三条用例的随机源要选在**会命中的那一侧**，
       * 否则测出来的是「有没有打中」而不是「技能有没有生效」。
       */
      case 'precise_strike': {
        playerAttack({
          rng: ctx.rng,
          rolls: ctx.rolls,
          events: ctx.events,
          flags: ctx.flags,
          multiplier: number('damageMultiplier') || 1.35,
          extraHit: 0,
        });
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你把它校到零位，然后才动手。` });
        break;
      }
      case 'chain_calibration': {
        const hits = Math.max(1, Math.round(number('hits') || 2));
        const decay = number('secondHitDecay') || 0.75;
        for (let index = 0; index < hits; index += 1) {
          const rawChance = clamp(hitChanceOf(playerSeq - creatureSequence) + (world.equipmentHitBonus ?? 0), 0, 1);
          const extraHit = index === 0 ? 0 : -rawChance * (1 - decay);
          playerAttack({
            rng: ctx.rng,
            rolls: ctx.rolls,
            events: ctx.events,
            flags: ctx.flags,
            multiplier: 1,
            extraHit,
          });
        }
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：两下落在同一个点上 —— 第二下才是校准过的那一下。` });
        break;
      }
      case 'overload': {
        playerAttack({
          rng: ctx.rng,
          rolls: ctx.rolls,
          events: ctx.events,
          flags: ctx.flags,
          multiplier: number('damageMultiplier') || 2,
          extraHit: 0,
        });
        nextDefensePenalty = number('nextRoundDefensePenalty') || 0.5;
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你把阀门全开了 —— 那一下很重，你自己也在抖。` });
        break;
      }
      /* M2.26 第二批：阅读者（reader）的三条。形状与上一批对齐，效果字段全部复用。 */
      case 'quick_read': {
        playerAttack({
          rng: ctx.rng,
          rolls: ctx.rolls,
          events: ctx.events,
          flags: ctx.flags,
          multiplier: number('damageMultiplier') || 1.35,
          extraHit: 0,
        });
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你比他先读到下一步。` });
        break;
      }
      case 'deconstruct': {
        const hits = Math.max(1, Math.round(number('hits') || 2));
        const decay = number('secondHitDecay') || 0.75;
        for (let index = 0; index < hits; index += 1) {
          const rawChance = clamp(hitChanceOf(playerSeq - creatureSequence) + (world.equipmentHitBonus ?? 0), 0, 1);
          const extraHit = index === 0 ? 0 : -rawChance * (1 - decay);
          playerAttack({
            rng: ctx.rng,
            rolls: ctx.rolls,
            events: ctx.events,
            flags: ctx.flags,
            multiplier: 1,
            extraHit,
          });
        }
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你把他这一招拆成了两步，一步一步来。` });
        break;
      }
      case 'knowledge_crush': {
        playerAttack({
          rng: ctx.rng,
          rolls: ctx.rolls,
          events: ctx.events,
          flags: ctx.flags,
          multiplier: number('damageMultiplier') || 2,
          extraHit: 0,
        });
        nextDefensePenalty = number('nextRoundDefensePenalty') || 0.5;
        ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你把他会的每一样都念了一遍 —— 他愣在那里。` });
        break;
      }
      /*
       * M2.26 第三批：母亲（mother）的三条。
       *
       * 与第一批（复用已有字段）、第二批（同样零新字段）不同，这一批**造了三个字段**：
       * 现有 15 条技能里没有「控制」「吸血」「自伤换输出」这三种形状，用旧字段拼不出来。
       * 三个字段的读取点分别是这里（lifeSteal / selfHpCost）与 creatureSingleStrike（enemyDamagePenalty）。
       * 守住「配置里有、玩法里真的有」的是 test/m2-26-mother-battle.test.ts（K10）。
       */
      case 'vine_bind': {
        const dealt = playerAttack({
          rng: ctx.rng,
          rolls: ctx.rolls,
          events: ctx.events,
          flags: ctx.flags,
          multiplier: number('damageMultiplier') || 0.85,
          extraHit: 0,
        });
        enemyDamagePenalty = number('enemyDamagePenalty') || 0.3;
        ctx.events.push({
          kind: 'player_skill',
          text:
            dealt > 0
              ? `「${skill.name}」：藤蔓从土里钻出来，把它绞住了一瞬 —— 它下一次挥手会慢。`
              : `「${skill.name}」：藤蔓扑了个空，它踩着断枝退开了。`,
        });
        break;
      }
      case 'life_drain': {
        const dealt = playerAttack({
          rng: ctx.rng,
          rolls: ctx.rolls,
          events: ctx.events,
          flags: ctx.flags,
          multiplier: number('damageMultiplier') || 1.2,
          extraHit: 0,
        });
        const drained = Math.round(dealt * (number('lifeSteal') || 0.5));
        if (drained > 0) {
          playerHp = clamp(playerHp + drained, 0, PLAYER_MAX_HP);
          ctx.events.push({
            kind: 'player_skill',
            text: `「${skill.name}」：你从它身上把那一口补了回来（+${drained}）。`,
          });
        } else {
          ctx.events.push({ kind: 'player_skill', text: `「${skill.name}」：你伸手了，但什么也没抓到。` });
        }
        break;
      }
      case 'earth_embrace': {
        const cost = Math.max(0, Math.round(number('selfHpCost') || 20));
        playerHp = clamp(playerHp - cost, 0, PLAYER_MAX_HP);
        playerAttack({
          rng: ctx.rng,
          rolls: ctx.rolls,
          events: ctx.events,
          flags: ctx.flags,
          multiplier: number('damageMultiplier') || 2.2,
          extraHit: 0,
        });
        ctx.events.push({
          kind: 'player_skill',
          text: `「${skill.name}」：你把这一季攒下的东西全砸了出去（-${cost}）。`,
        });
        break;
      }
      default:
        ctx.events.push({ kind: 'player_skill', text: `你用了「${skill.name}」，但什么也没发生。` });
        break;
    }
  }

  /** 使用物品：自身数值 + 战斗效果（符咒） */
  /**
   * M2.13：**用一件封印物。**
   *
   * 与 `useItem` 是姊妹函数，但问的是另一个问题：
   *   `useItem`          —— 用了之后**对面**会怎么样（灼烧 / 定身 / 净除）
   *   `useExtraordinary` —— 用了之后**我这一下**会怎么样（无视序列差 / 伤害翻倍 / 重抽）
   *
   * 所以它在设置完加成之后**紧接着打出去**：封印之刃与血月之刃的效果
   * 都只作用在「这一回合的那一下」上，留着不加成才是 bug。
   *
   * 代价（MAD / COR）只记账，由命令层走唯一数值入口提交 ——
   * 与 `useItem` 的 `itemMadDelta` 同一条纪律（判定层不认识角色卡）。
   */
  function useExtraordinary(entry: BattleExtraordinaryEffect | null, out: RoundEvent[]): void {
    if (!entry) {
      out.push({ kind: 'player_extraordinary', text: '你伸手去摸那件东西 —— 它不在你身上。' });
      return;
    }
    if (entry.ignoreSequenceGap === true) extraordinaryIgnoreGap = true;
    if (typeof entry.hitModifier === 'number') extraordinaryHitModifier += entry.hitModifier;
    if (typeof entry.damageMultiplier === 'number') {
      extraordinaryDamageMultiplier *= entry.damageMultiplier;
    }
    if (entry.reroll === true) extraordinaryReroll = true;
    if (entry.cost?.mad) itemMadDelta += entry.cost.mad;
    if (entry.cost?.cor) itemCorDelta += entry.cost.cor;

    out.push({
      kind: 'player_extraordinary',
      text:
        entry.ignoreSequenceGap === true
          ? `${entry.name}上的封条松了一道 —— 你和${subject}之间那段距离忽然不存在了。`
          : `${entry.name}在你手里沉了一下。这一下的分量不一样。`,
    });

    playerAttack({
      rng,
      rolls,
      events: out,
      flags,
      multiplier: extraordinaryDamageMultiplier,
      extraHit: extraordinaryHitModifier,
      ignoreSequenceGap: extraordinaryIgnoreGap,
      reroll: extraordinaryReroll,
    });
  }

  function useItem(item: BattleItemEffect | null, out: RoundEvent[]): void {
    if (!item) {
      out.push({ kind: 'player_item', text: '你摸了半天，没摸出能用的东西。' });
      return;
    }
    const self = item.self ?? {};
    if (self.hp) playerHp = clamp(playerHp + self.hp, 0, PLAYER_MAX_HP);
    if (self.mp) playerMp = clamp(playerMp + self.mp, 0, PLAYER_MAX_MP);
    if (self.mad) {
      // MAD 不在战斗状态里（它属于角色卡），命令层按「净变化」统一提交 —— 这里只记账
      itemMadDelta += self.mad;
    }
    if (item.battle?.cleanse) playerStatuses = [];
    let damage = 0;
    if (item.battle?.damage) {
      damage = item.battle.damage;
      creatureHp -= damage;
      playerDamageDealt += damage;
      lastPlayerDamage = damage;
    }
    for (const id of item.battle?.applyToCreature ?? []) {
      creatureStatuses = applyStatus(creatureStatuses, id, item.name);
      out.push({ kind: 'status_apply', text: `${item.name}生效了：它身上多了一个「${id}」。`, status: id });
    }
    out.push({
      kind: 'player_item',
      text:
        damage > 0
          ? `你用了${item.name} —— ${damage} 点伤害落在它身上。`
          : `你用了${item.name}。`,
      damage,
    });
  }

  /** 生物的动作 */
  function resolveCreatureAction(
    chosen: CreatureAction,
    ctx: { rng: Rng; rolls: Record<string, number>; events: RoundEvent[]; flags: typeof flags },
  ): void {
    /* 装死得手：它上一回合装了死，而你这一回合**没有攻击** */
    const stoppedAttacking = effectiveAction.kind !== 'attack' && effectiveAction.kind !== 'skill';
    if (creaturePlayingDead && stoppedAttacking) {
      creaturePlayingDead = false;
      creatureAction = {
        kind: 'special',
        label: '偷袭',
        special: 'ambush',
        note: '它从地上弹起来，你甚至没看清它是怎么起来的。',
      };
      const damage = creatureStrike(
        ctx,
        (AI.playDeadAmbushMultiplier * (creatureBerserk ? AI.berserkDamageMult : 1)),
      );
      ctx.events.push({ kind: 'ambush', text: creatureAction.note, damage });
      return;
    }
    creaturePlayingDead = false;

    switch (chosen.kind) {
      /**
       * M2.10（PVP）：对手在防御。
       *
       * 与玩家侧的「防御」完全对称：本回合受到的伤害减半。位置摆在最前面是因为
       * 它不是一个「出手」—— 一个在防御的人这一回合不会再打你。
       */
      case 'defend': {
        creatureDefending = true;
        ctx.events.push({
          kind: 'creature_attack',
          text: chosen.note || `${subject}压低了身子，等你先动。`,
        });
        return;
      }
      /**
       * M2.10（PVP）：对手认输。
       *
       * 从**发起者视角**（本状态机的 player 侧）看，对手认输 = 自己胜。
       * 认输与「被打倒」的区别在接线层：认输**不触发通缉**（不是重伤，是他自己认的）。
       */
      case 'surrender': {
        status = 'player_win';
        ctx.events.push({ kind: 'ended', text: chosen.note || `${subject}举起手 —— 他不打了。` });
        return;
      }
      case 'attack':
        creatureStrike(ctx, creatureBerserk ? AI.berserkDamageMult : 1, 0, chosen);
        applyOpponentEffects(ctx, chosen);
        return;
      case 'berserk': {
        const firstTime = !creatureBerserk;
        creatureBerserk = true;
        creatureStrike(ctx, AI.berserkDamageMult);
        if (firstTime) {
          ctx.events.push({
            kind: 'creature_special',
            text: '它不再躲了 —— 从现在起它只会往你身上来。',
          });
        }
        return;
      }
      case 'flee': {
        const chance = clamp(species.fleeChance ?? AI.fleeChance, 0, 1);
        const roll = ctx.rng.next();
        ctx.rolls.creatureFlee = roll;
        if (roll < chance) {
          status = 'creature_fled';
          ctx.events.push({ kind: 'creature_flee', text: '它转身钻进了雾里。你没有追。' });
        } else {
          ctx.events.push({ kind: 'creature_flee', text: '它想跑，但腿在抖 —— 没跑掉。' });
        }
        return;
      }
      case 'call_ally': {
        allyCalled = true;
        const delay = rollRange(AI.callAllyDelay[0]!, AI.callAllyDelay[1]!, ctx.rng);
        allyArrivesAtRound = round + delay;
        ctx.rolls.allyDelay = delay;
        ctx.events.push({
          kind: 'creature_call_ally',
          text: `它仰头叫了一声，远处有别的东西在回应 —— 大概 ${delay} 个回合之后到。`,
        });
        return;
      }
      case 'play_dead': {
        creaturePlayingDead = true;
        ctx.events.push({ kind: 'creature_play_dead', text: '它倒了下去，一动不动。' });
        return;
      }
      case 'evolve': {
        creatureEvolved = true;
        creatureSequence = Math.max(1, creatureSequence - 1);
        creatureMaxHp += AI.evolveHpBonus;
        creatureHp = Math.min(creatureMaxHp, creatureHp + AI.evolveHpBonus);
        // 蜕了一层：旧伤旧状态一起没了。**这是它变强的意思，不是回血的意思**
        creatureStatuses = [];
        ctx.events.push({
          kind: 'creature_evolve',
          text: `${species.name}蜕了一层壳 —— 它现在是序列 ${creatureSequence} 了。`,
        });
        return;
      }
      case 'special': {
        const special = specialById(chosen.special ?? null);
        if (!special) {
          creatureStrike(ctx, 1);
          return;
        }
        creatureShield = special.shield;
        if (special.mimic) {
          const damage = lastPlayerDamage;
          if (damage > 0) {
            playerHp = clamp(playerHp - damage, 0, PLAYER_MAX_HP);
            creatureDamageDealt += damage;
            ctx.events.push({ kind: 'creature_special', text: special.note, damage });
          } else {
            ctx.events.push({ kind: 'creature_special', text: special.note, damage: 0 });
          }
          return;
        }
        let damage = 0;
        if (special.damageMultiplier > 0) {
          damage = creatureStrike(ctx, special.damageMultiplier, special.hitBonus);
        }
        if (special.mpDrain > 0) {
          playerMp = clamp(playerMp - special.mpDrain, 0, PLAYER_MAX_MP);
        }
        for (const id of special.applyToPlayer) {
          playerStatuses = applyStatus(playerStatuses, id, species.name);
          ctx.events.push({
            kind: 'status_apply',
            text: `${species.name}的${special.name}：你身上多了一个「${id}」。`,
            status: id,
          });
        }
        ctx.events.push({ kind: 'creature_special', text: special.note, damage });
        return;
      }
      default:
        return;
    }
  }

  /**
   * M2.10：对手动作带来的**附加效果**（生物的 AI 一个都不填，所以 PVE 完全不受影响）。
   *
   * 三个效果各自对应一个玩家技能或物品，在 PVP 里由对手的 PlayerAction 翻译而来：
   *   applyToOpponent       —— 梦魇：给**你**挂恐惧
   *   negateOpponentActions —— 幻觉干扰：吞掉**你**的下一次行动
   * 而伤害倍率 / 次数 / 命中加成走 creatureStrike 的 effect 参数（那是出手本身的一部分）。
   */
  function applyOpponentEffects(
    ctx: { rng: Rng; rolls: Record<string, number>; events: RoundEvent[] },
    chosen: CreatureAction,
  ): void {
    for (const id of chosen.applyToOpponent ?? []) {
      playerStatuses = applyStatus(playerStatuses, id, species.name);
      ctx.events.push({
        kind: 'status_apply',
        text: `${subject}的${chosen.label}：你身上多了一个「${id}」。`,
        status: id,
      });
    }
    if (chosen.negateOpponentActions && chosen.negateOpponentActions > 0) {
      negatePlayerActions += chosen.negateOpponentActions;
      ctx.events.push({
        kind: 'negated',
        text: `${subject}的${chosen.label}：你看见的东西和他站的地方错开了 —— 下一次出手会落空。`,
      });
    }
  }

  /**
   * 对手的一次出手（走 M2.6.1 的序列差框架，与玩家用的是同一套）。
   *
   * M2.10：`effect` 是 PVP 才填的一组字段（生物的 AI 一个都不填）——
   * 有了它，`resolveBattleRound` 就能原样处理「对手是一个玩家」这件事，
   * 而不需要为 PVP 再写一套平行的结算。
   */
  function creatureStrike(
    ctx: { rng: Rng; rolls: Record<string, number>; events: RoundEvent[] },
    multiplier: number,
    hitBonus = 0,
    effect: { damageMultiplier?: number; hits?: number; hitBonus?: number; flatDamage?: number } = {},
  ): number {
    const rounds = Math.max(1, Math.round(effect.hits ?? 1));
    let total = 0;
    for (let index = 0; index < rounds; index += 1) {
      total += creatureSingleStrike(ctx, multiplier, hitBonus + (effect.hitBonus ?? 0), effect.flatDamage);
      if (playerHp <= 0 || status !== 'active') break;
    }
    return total;
  }

  function creatureSingleStrike(
    ctx: { rng: Rng; rolls: Record<string, number>; events: RoundEvent[] },
    multiplier: number,
    hitBonus: number,
    flatDamage: number | undefined,
  ): number {
    // M2.65：对手挂的「下一次出手」倍率（用完即消 —— 只在真的打中时消耗）
    const foeAttackBonus = foeNextAttack;
    const base = Math.max(
      1,
      Math.round(
        (flatDamage ?? rollRange(species.damage[0], species.damage[1], ctx.rng)) *
          multiplier *
          foeAttackBonus *
          (1 + allyCount * AI.allyDamageBonus),
      ),
    );
    const hitModifier =
      // M2.66：先手对**它**是反向的 —— 你先动了手，它慢了半拍
      hitPenaltyOf(creatureStatuses) + world.weatherHitPenalty + hitBonus - initiativeEdge;
    const assault = resolveAssault(
      {
        attackerSeq: creatureSequence,
        targetSeq: playerSeq,
        baseHit: species.hit || BATTLE.actions.attack.baseHit,
        baseDamage: base,
        baseDamageMax: base,
        hitModifier,
      },
      ctx.rng,
    );
    if (assault.blocked) {
      ctx.events.push({ kind: 'creature_attack', text: assault.reason ?? `${subject}近不了你的身。` });
      return 0;
    }
    if (!assault.hit) {
      ctx.events.push({ kind: 'creature_attack', text: `${subject}扑空了。` });
      return 0;
    }
    let post = defendingThisRound ? BATTLE.actions.defend.damageMultiplier : 1;
    // 强攻的代价：上一回合用了它，这一回合你的防御 -30%
    post *= 1 + activeDefensePenalty;
    // M2.10：对手防御时，他受到的伤害也减半（与玩家侧完全对称）
    if (creatureDefending) post *= BATTLE.actions.defend.damageMultiplier;
    // M2.12「守护」：这一回合受到的伤害减半（与「防御」不叠加 —— 一个回合只能选一个动作）
    if (guardingThisRound) post *= guardMultiplier;
    /*
     * M2.26 第三批：藤蔓缠绕（vine_bind）的减益，**用完即消**。
     *
     * 放在这里而不是回合末，是因为它只该影响「它的下一次出手」：
     * 如果它这一下扑空了（上面那两处 return），减益就没被消耗，留到下一次真打中时再生效。
     * 不清零的话，一次缠绕会给它**之后每一击**都挂上减伤。
     */
    if (enemyDamagePenalty > 0) {
      post *= 1 - enemyDamagePenalty;
      enemyDamagePenalty = 0;
    }
    /*
     * M2.65：**行动标记的两条减伤**，与上面那段同一个位置、同一条「用完即消」纪律。
     *
     *  · `guardDamage`（立阵）—— 自己这一下挨得轻：直接乘一个 ≤1 的倍率；
     *  · `enemyDamage`（压阵 / 驳论 / 覆舟）—— 对方这一下使不上力：乘 (1 - 削减)。
     *
     * ⚠️ 与技能侧的 `guardMultiplier` **分开乘**，不是取最小值：
     * 一个是「守护」这个动作给的（还带推回去），一个是行动提前布好的 ——
     * 两件事同时发生就该两条都算数（叠起来仍然不会变成负数伤害，下面有 max(1, ...)）。
     *
     * 顺序不动摇：位置在扑空 / 被拦住的两处 return **之后**，
     * 所以「它这一下没打中」不会白白花掉你的标记。
     */
    // M2.65：对手的出手倍率与你的减伤同一个位置 —— 都是「真的挨了这一下」才算用掉
    if (foeNextAttack !== 1) {
      foeNextAttack = 1;
      consumedFoeMarks.push('nextAttack');
    }
    if (actionGuard !== 1) {
      post *= actionGuard;
      actionGuard = 1;
      consumedActionMarks.push('guardDamage');
    }
    if (actionEnemyPenalty > 0) {
      post *= 1 - actionEnemyPenalty;
      actionEnemyPenalty = 0;
      consumedActionMarks.push('enemyDamage');
    }
    const damage = Math.max(1, Math.round((assault.damage ?? 0) * post));
    playerHp = clamp(playerHp - damage, 0, PLAYER_MAX_HP);
    creatureDamageDealt += damage;
    ctx.events.push({ kind: 'creature_attack', text: `${subject}打中了你，造成 ${damage} 点伤害。`, damage });
    if (guardingThisRound) {
      /*
       * 把挡下来的那一半推回去。
       * 用「原本的伤害 − 实际受到的伤害」算，而不是再乘一次 0.5 ——
       * 这样无论减伤叠了几层，推回去的永远是**你替他挡掉的那一份**。
       */
      const blocked = Math.max(0, (assault.damage ?? 0) - damage);
      if (blocked > 0) {
        creatureHp -= blocked;
        ctx.events.push({ kind: 'player_skill', text: `你把挡住的那 ${blocked} 点推了回去。`, damage: blocked });
      }
    }
    return damage;
  }
}
