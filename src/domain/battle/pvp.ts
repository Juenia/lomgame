/**
 * PVP（M2.10）—— **纯函数，无 IO**。
 *
 * M2.9 交付了 PVE 的战斗状态机，M2.10 让**对手可以是另一个玩家**。
 * 这一层要做的只有三件事，**判定层（resolve.ts）一个字都不用改**：
 *
 *   1. **对手的物种视图**：把「另一个玩家」包装成一个「用玩家数值的虚拟物种」——
 *      于是 `resolveBattleRound` 眼里的人与生物是同一件事（这正是 0018 里
 *      「一边一个 HP、一边一串状态」那个形状的兑现）。
 *   2. **对手动作的翻译**：对手出的是什么招（攻击 / 防御 / 技能 / 物品 / 撤退 / 认输）
 *      翻译成 `CreatureAction`。
 *   3. **异步回合的推进**：两人各出一个动作，然后**一起结算**。
 *
 * ## 一份状态表示两个玩家：为什么不做「视角转换」
 *
 * 最直觉的做法是「谁出招就把 battle 翻个面」，但那需要给 BattleState 加一堆对称字段
 *（creatureMp / creatureDefensePenalty / playerName……），而且每加一个都要在翻转时交换 ——
 * 漏一个的表现是「某一方的 MP 突然变成了对方的」，极难查。
 *
 * 这里用的是更省的一条路：**固定「发起者 = 判定层的 player 侧」**。
 *   battle.playerHp / playerMp / playerStatuses  → 发起者
 *   battle.creatureHp / creatureStatuses          → 应战者
 * 谁出招都无所谓：发起者出招时他的动作是 `action`，应战者出招时他的动作被翻译成对手动作。
 * **结算永远以发起者为主视角**，于是 `resolveBattleRound` 原样可用。
 *
 * ## 异步的形状
 *
 *   回合 N：发起者出招 → 动作存进 battle.pendingAction，轮到应战者
 *   回合 N：应战者出招 → **两人都有动作了 → 一起结算**，回到发起者
 *   回合 N+1：发起者出招 → …
 *
 * 「先出招的人先亮牌，后出招的人看完再选」——所以**后手有信息优势**，
 * 这是异步 PVP 的固有性质（也是发起者要付的代价）。
 * 每次轮到谁，谁超时，战斗就往前走一格 —— 不会出现「两人都挂机就永远不动」。
 */
import { BATTLE, NUMERIC, PVP } from '../../config/numeric.ts';
import type { CharacterState, Rng } from '../character/types.ts';
import { resolveBattleRound } from './resolve.ts';
import { skillById, skillEffectOf } from './skills.ts';
import type {
  BattleExtraordinaryEffect,
  BattleItemEffect,
  BattleRoundOptions,
  BattleState,
  BattleSpeciesView,
  CreatureAction,
  PlayerAction,
  RoundResult,
} from './types.ts';

const PVP_CFG = PVP;

/* ------------------------------------------------------------------ *
 * 1. 对手的物种视图
 * ------------------------------------------------------------------ */

/**
 * 把「另一个玩家」包装成物种视图。
 *
 * 伤害区间与命中率**直接用玩家侧的数值**（`BATTLE.actions.attack`）——
 * 对手是人，就该用人的尺子；用某个物种的伤害表会让「和谁打」取决于
 * 你碰巧撞上了哪只生物的参数，那是显然错的。
 */
export function opponentSpeciesViewOf(battle: BattleState): BattleSpeciesView {
  return {
    id: battle.opponentCharacterId ?? 'pvp-opponent',
    name: battle.opponentName ?? '对手',
    habits: [],
    special: null,
    specialName: null,
    damage: [BATTLE.actions.attack.baseDamageMin, BATTLE.actions.attack.baseDamageMax],
    hit: BATTLE.actions.attack.baseHit,
    /*
     * 对手「逃跑」的成功率 = 玩家撤退的成功率公式（含危险度）。
     * 生物的 AI 用 species.fleeChance，而 PVP 的撤退是**玩家的动作**，
     * 所以这里必须用玩家那一套 —— 否则「在墓园小径脱身」会比 PVE 里难得多。
     */
    fleeChance: Math.min(
      0.95,
      Math.max(0.05, BATTLE.actions.retreat.baseChance - (battle.world.danger / 5) * BATTLE.actions.retreat.dangerPenalty),
    ),
  };
}

/* ------------------------------------------------------------------ *
 * 2. 对手动作的翻译
 * ------------------------------------------------------------------ */

/**
 * 应战者的玩家动作 → 对手动作（`CreatureAction`）。
 *
 * 六个技能在这里各自落到一个明确的字段上（效果表见 numeric.battle.skillEffects）：
 *
 *   强攻    伤害 ×1.5                → damageMultiplier
 *   连击    一回合两次               → hits
 *   夜视    夜晚命中 +20% / 白天 -10% → hitBonus
 *   梦魇    打断暴走 + 施加恐惧       → applyToOpponent（PVP 里对手没有暴走，只剩恐惧）
 *   幻觉干扰 吞掉对手一次行动         → negateOpponentActions
 *   占卜预判 看对手下回合动作         → PVP 里**没有意义**（对手已经亮牌了），退化成一次普通攻击
 */
export function opponentActionOf(
  action: PlayerAction,
  ctx: {
    /** 对手的显示名（回执文案用） */
    name: string;
    /** 夜间（夜视技能要用） */
    night: boolean;
    /** 对手这一回合用的物品效果（命令层查内容表后喂进来） */
    item?: BattleItemEffect | null;
  },
): CreatureAction {
  const who = ctx.name;
  switch (action.kind) {
    case 'attack':
      return { kind: 'attack', label: '攻击', note: `${who}朝你打过来。` };
    case 'defend':
      return { kind: 'defend', label: '防御', note: `${who}压低了身子，等你先动。` };
    case 'retreat':
      return { kind: 'flee', label: '撤退', note: `${who}往后退了半步。` };
    case 'item': {
      const damage = ctx.item?.battle?.damage;
      if (damage && damage > 0) {
        return {
          kind: 'attack',
          label: '使用物品',
          note: `${who}掏出一样东西 —— ${ctx.item?.name ?? '符咒'}。`,
          flatDamage: damage,
        };
      }
      // 不带伤害的物品（净除类）在 PVP 里当成一次防守 —— 他在给自己争取时间
      return { kind: 'defend', label: '使用物品', note: `${who}用了${ctx.item?.name ?? '一样东西'}。` };
    }
    case 'skill': {
      const skill = skillById(action.skillId ?? '');
      if (!skill) return { kind: 'attack', label: '攻击', note: `${who}朝你打过来。` };
      const effect = skillEffectOf(skill.id);
      const strike: CreatureAction = {
        kind: 'attack',
        label: skill.name,
        skillId: skill.id,
        note: `${who}用了「${skill.name}」。`,
      };
      if (typeof effect.damageMultiplier === 'number') strike.damageMultiplier = effect.damageMultiplier;
      if (typeof effect.hits === 'number') strike.hits = Math.round(effect.hits);
      if (typeof effect.nightHitBonus === 'number' && ctx.night) strike.hitBonus = effect.nightHitBonus;
      if (typeof effect.dayHitPenalty === 'number' && !ctx.night) strike.hitBonus = effect.dayHitPenalty;
      if (effect.applyFear === true) strike.applyToOpponent = ['fear'];
      if (typeof effect.negateOpponentActions === 'number') {
        strike.negateOpponentActions = Math.round(effect.negateOpponentActions);
      }
      // 占卜预判在 PVP 里没有落点（对手已经亮牌），退化成普通攻击 —— 但仍要说清它用了什么
      return strike;
    }
    default:
      return { kind: 'attack', label: '攻击', note: `${who}朝你打过来。` };
  }
}

/* ------------------------------------------------------------------ *
 * 3. 异步回合的推进
 * ------------------------------------------------------------------ */

export interface PvpOutcome {
  /** 'waiting' = 动作已记下、等对方出招；'settled' = 这一回合结算了 */
  kind: 'waiting' | 'settled';
  /** 结算之后的战斗状态（waiting 时是「记下动作、交换回合权」之后的那一份） */
  battle: BattleState;
  /** settled 时才有：**发起者视角**的回合结果 */
  result: RoundResult | null;
  /** 这一回合是谁在出招 */
  actor: 'challenger' | 'opponent';
  /** 给**出招方**看的回执文本 */
  lines: string[];
  /** 给**对方**看的回执文本（waiting 时是「对方出招了，轮到你了」） */
  opponentLines: string[];
}

/**
 * PVP 的一个回合。
 *
 * ⚠️ `state` 必须是**发起者的角色卡**（判定层的 player 侧永远是发起者，见文件头）。
 * 应战者出招时，命令层也要把发起者的角色卡传进来 —— 这是这一层唯一一个
 * 「反直觉但必须」的约定，写在签名旁边而不是藏在对局逻辑里。
 *
 * 返回的 `battle.turnOf` 是**下一次该谁出招**，接线层据此决定把菜单推给谁。
 */
export function resolvePvpRound(
  state: CharacterState,
  battle: BattleState,
  action: PlayerAction,
  rng: Rng,
  options: {
    item?: BattleItemEffect | null;
    extraordinary?: BattleExtraordinaryEffect | null;
    /** M2.18（C/D）：势力关系的战斗修正，由命令层算好（见 BattleRoundOptions.relation） */
    relation?: { hit?: number; damage?: number };
    /** M2.65：两侧的行动标记（见 BattleRoundOptions.action） */
    action?: BattleRoundOptions['action'];
    /** M2.66：两侧的先手点数（见 BattleRoundOptions.initiative / initiativeFoe） */
    initiative?: number;
    initiativeFoe?: number;
  } = {},
): PvpOutcome {
  const actor = battle.turnOf;
  const challengerActing = actor === 'challenger';

  if (battle.status !== 'active') {
    return {
      kind: 'waiting',
      battle,
      result: null,
      actor,
      lines: ['这一场已经结束了。'],
      opponentLines: [],
    };
  }

  /* ---- 对方还没出招：记下自己的动作，把回合权交给他 ---- */
  if (battle.pendingAction === null) {
    const nextTurn = challengerActing ? 'opponent' : 'challenger';
    const next: BattleState = { ...battle, pendingAction: action, turnOf: nextTurn };
    return {
      kind: 'waiting',
      battle: next,
      result: null,
      actor,
      lines: [
        challengerActing
          ? '你出了手 —— 但他还没动。等他回应。'
          : '你出了手 —— 等他回应。',
      ],
      opponentLines: [
        `${challengerActing ? '对方' : '对方'}已经出招了，轮到你了（.战斗 出招）。`,
      ],
    };
  }

  /* ---- 两人都出招了：一起结算 ---- */
  const pending = battle.pendingAction;
  const challengerAction = challengerActing ? action : pending;
  const opponentAction = challengerActing ? pending : action;
  const opponentName = battle.opponentName ?? '对手';
  const creatureAction = opponentActionOf(opponentAction, {
    name: opponentName,
    night: battle.world.night,
    item: options.item ?? null,
  });

  const result = resolveBattleRound(
    state,
    { ...battle, pendingAction: null },
    challengerAction,
    rng,
    {
      creatureAction,
      species: opponentSpeciesViewOf(battle),
      // M2.18（C/D）：透传势力关系修正（不传时判定层按中性处理）
      ...(options.relation ? { relation: options.relation } : {}),
      /*
       * M2.13.1：**PVP 也要把封印物的效果喂进去。**
       *
       * M2.13 只接了 PVE 那条路（battle-hooks 的 runBattleRound），
       * 于是 PVP 里用封印之刃会落到 useExtraordinary(null) 那一支 ——
       * 回执是「你伸手去摸那件东西 —— 它不在你身上」，而**代价照付**。
       * 实测就是这么发生的：沈默的 14 次「使用」全部无效（见 M2.13.1 取证报告）。
       */
      ...(options.extraordinary ? { extraordinary: options.extraordinary } : {}),
      /*
       * M2.65：**途径行动留下的战斗标记**，两侧都透传。
       *
       * 顺序不能反：`action` 是发起者那一侧（判定层的 player 永远是他），
       * `action.foe` 是应战者 —— 与 `challengerAction` / `opponentAction` 对齐。
       * 由命令层读好（判定层不认识 flags），读法与 PVE 完全同一处（battleActionMarks）。
       */
      ...(options.action ? { action: options.action } : {}),
      /*
       * M2.66：**先手**两侧都透传。判定层的 player 侧永远是发起者，
       * 所以他自己那一份走 initiative、应战者的走 initiativeFoe —— 判定层取差值。
       */
      ...(options.initiative !== undefined ? { initiative: options.initiative } : {}),
      ...(options.initiativeFoe !== undefined ? { initiativeFoe: options.initiativeFoe } : {}),
    },
  );

  return {
    kind: 'settled',
    /*
     * 结算之后**回合权回到发起者**：一个「回合」= 两个人各出一个动作，
     * 而发起者是先手 —— 所以下一个回合又从发起者开始。
     * （这一行漏掉的话，应战者出完招之后 turnOf 还停在 'opponent'，
     * 于是发起者再出招会被「还没轮到你」挡住，整场战斗就停在第一个回合了。实测踩过。）
     */
    battle: { ...result.battle, turnOf: 'challenger', pendingAction: null },
    result,
    actor,
    lines: [`这一回合：你出「${labelOf(challengerAction)}」，${opponentName}出「${creatureAction.label}」。`],
    opponentLines: [],
  };
}

function labelOf(action: PlayerAction): string {
  switch (action.kind) {
    case 'attack':
      return '攻击';
    case 'defend':
      return '防御';
    case 'retreat':
      return '撤退';
    case 'item':
      return '物品';
    case 'skill': {
      const skill = skillById(action.skillId ?? '');
      return skill?.name ?? '技能';
    }
    default:
      return action.kind;
  }
}

/* ------------------------------------------------------------------ *
 * 4. 发起条件
 * ------------------------------------------------------------------ */

/**
 * 能不能发起挑战。返回 `null` = 可以；否则是**给玩家看的拒绝理由**。
 *
 * 做成纯函数收一堆布尔量（而不是收角色卡）的理由：命令层查库、判定层判断，
 * 两边都不需要认识对方 —— 而且「跨地点被拒」这件事因此可以被单测逐条钉住，
 * 不需要起服务。
 */
export function pvpChallengeBlocked(input: {
  /** 挑战者与目标在不在同一个地点 */
  sameLocation: boolean;
  /** 目标存在吗（QQ 号查不到角色就是 false） */
  opponentExists: boolean;
  /** 挑战者是不是重伤 */
  selfAlive: boolean;
  /** 目标是不是重伤 */
  opponentAlive: boolean;
  /** 挑战者是不是正在战斗中 */
  selfInBattle: boolean;
  /** 目标是不是正在战斗中 */
  opponentInBattle: boolean;
  /** 是不是在挑战自己 */
  selfIsOpponent: boolean;
  /** 上一次挑战这个人的时间（毫秒）；没挑战过就是 null */
  lastChallengedAt: number | null;
  now: number;
}): string | null {
  if (input.selfIsOpponent) return '自己挑战自己？雾里的东西比你清醒。';
  if (!input.opponentExists) return '没有找到这个人。';
  if (PVP_CFG.requireSameLocation && !input.sameLocation) {
    // 跨地点必须明确拒绝：M2.7 的移动要花 AP / 金钱 / 时间，允许隔着城市打就把它作废了
    return '你们不在同一个地方 —— 要打，先走过去（.移动）。';
  }
  if (PVP_CFG.requireBothAlive && !input.selfAlive) return '你自己还受着重伤，先养好再说。';
  if (PVP_CFG.requireBothAlive && !input.opponentAlive) return '他已经受着重伤躺着了 —— 再打也只是欺负人。';
  if (PVP_CFG.requireNotInBattle && input.selfInBattle) return '你正在打。先把手上的这一场打完。';
  if (PVP_CFG.requireNotInBattle && input.opponentInBattle) return '他正在和别人打 —— 排队。';
  if (input.lastChallengedAt !== null && input.now - input.lastChallengedAt < PVP_CFG.challengeCooldownMs) {
    const left = Math.ceil((PVP_CFG.challengeCooldownMs - (input.now - input.lastChallengedAt)) / 60000);
    return `你刚找过他 —— 再过 ${left} 分钟。`;
  }
  return null;
}

/** 挑战冷却的剩余毫秒（0 = 可以打）；报告与回执都要用同一个口径 */
export function challengeCooldownLeft(lastChallengedAt: number | null, now: number): number {
  if (lastChallengedAt === null) return 0;
  return Math.max(0, PVP_CFG.challengeCooldownMs - (now - lastChallengedAt));
}

/** PVP 的超时（与 PVE 同值但独立成一条，改 PVP 的超时不该动到 PVE） */
export const PVP_TIMEOUT_MS = PVP_CFG.playerTimeoutMs;

/** 自证：PVP 的超时与 PVE 的必须是同一个数（单测守着这一条） */
export function pvpTimeoutMatchesPve(): boolean {
  return PVP_CFG.playerTimeoutMs === BATTLE.playerTimeoutMs;
}

/** 供报告与视图用的只读配置（避免别处再 import 一次 NUMERIC） */
export const PVP_CONFIG = PVP_CFG;
export { NUMERIC as PVP_NUMERIC };
