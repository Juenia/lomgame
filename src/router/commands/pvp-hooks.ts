/**
 * PVP 的接线层（M2.10）：把 PVP 判定层与数据库接起来。
 *
 * 与 battle-hooks.ts 同一个手法（查库 → 调纯函数 → 落库 → 每回合一条带 seed 的 domain_events），
 * 但有三件事是 PVP 独有的，全部集中在这个文件里：
 *
 *   1. **异步回合**：一次出招可能只是「等对方」（waiting），也可能是「一起结算」（settled）；
 *   2. **双方各自计时**：轮到谁，谁超时就自动防御 —— 战斗因此永远往前走一格；
 *   3. **胜负后果**：掉落 20% 非绑定物品、胜者吃 3 级通缉、败者重伤不删卡。
 *
 * ⚠️ 一条必须记住的约定：**判定层的 player 侧永远是发起者**（见 domain/battle/pvp.ts 的说明）。
 * 所以 `resolvePvpRound` 的第一个参数永远是**发起者的角色卡**，哪怕这一招是应战者出的。
 */
import { BATTLE, NUMERIC, PVP } from '../../config/numeric.ts';
import type { CharacterState, DomainEvent } from '../../domain/character/types.ts';
import {
  opponentActionOf,
  opponentSpeciesViewOf,
  resolvePvpRound,
  type BattleItemEffect,
  type BattleState,
  type BattleStatusKind,
  type PlayerAction,
  type PvpOutcome,
} from '../../domain/battle/index.ts';
import { describeStatuses } from '../../domain/battle/statuses.ts';
import { factionOfLocation } from '../../domain/faction/faction.ts';
import { isCurrency } from '../../domain/item/item.ts';
import { levelForTrigger, wantedDurationOf } from '../../domain/wanted/wanted.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import type { EffectDelta } from '../../domain/effect/apply.ts';
import type { RouterDeps } from '../index.ts';
import { dateKey } from '../../infra/date.ts';
import { battleActionMarks, battleMarkFlag } from '../../domain/menu/pathway-action-resolve.ts';
import { abilityEffectsOf, applyFor } from './common.ts';
import { battleExtraordinaryEffectOf, battleItemEffectOf } from './battle-hooks.ts';

export interface PvpTurnResult {
  kind: 'waiting' | 'settled' | 'rejected' | 'surrendered';
  /** 给出招方的正文（命令层会再拼菜单） */
  lines: string[];
  /** 给**对方**的私聊通知（waiting 时是「轮到你了」；settled 时是回合结果） */
  opponentNotice: string | null;
  /** 这一回合的终局（settled / surrendered 且分出胜负时） */
  finished: boolean;
  error?: string;
}

/** 出招方是哪一边 */
export function sideOf(battle: BattleState, characterId: string): 'challenger' | 'opponent' | null {
  if (battle.characterId === characterId) return 'challenger';
  if (battle.opponentCharacterId === characterId) return 'opponent';
  return null;
}

/**
 * 走一个 PVP 回合。
 *
 * 三条前置检查按顺序做，每一条都有明确的回执：
 *   不是这场战斗的人 / 还没轮到你 / 这场已经结束了。
 */
export function runPvpTurn(input: {
  deps: RouterDeps;
  actor: CharacterState;
  battle: BattleState;
  action: PlayerAction;
  now: number;
  seed: string;
}): PvpTurnResult {
  const { deps, actor, battle, action, now, seed } = input;
  const side = sideOf(battle, actor.id);
  if (!side) {
    return { kind: 'rejected', lines: ['这一场不是你的。'], opponentNotice: null, finished: false, error: '旁观者' };
  }
  if (battle.status !== 'active') {
    return { kind: 'rejected', lines: ['这一场已经结束了。'], opponentNotice: null, finished: true, error: '已结束' };
  }
  /*
   * ⚠️ M2.11：**认输不受「轮到谁」的限制**，所以它从这里放行。
   *
   * M2.10 把认输也挡在这条检查之后，后果是：等对方出招的那段时间里
   * （turnOf 在对方手上）**想认输都认不了** —— 而那恰恰是最想认输的时刻：
   * 对面迟迟不回，你被晾在那里，只能眼看 5 分钟一格地推进。
   * M2.11 的挑战菜单把「认输」摆成了第 3 个选项，这一条也就必须成立，
   * 否则那一项是假的。
   *
   * 认输本来就不是「出招」：双方各出一个动作再一起结算那条路上，
   * 认输没有对手可言（对方做什么都改变不了结果）—— 判定层的注释里写着同一句话。
   */
  if (battle.turnOf !== side && action.kind !== 'surrender') {
    /*
     * 还没轮到你。
     *
     * 这一条是异步 PVP 的**核心约束**：两人各出一个动作、然后一起结算。
     * 先出招的人先亮牌 —— 所以「轮到谁」必须被服务端记住，
     * 而不是谁手快谁就能多打一下。
     */
    return {
      kind: 'rejected',
      lines: ['还没轮到你 —— 你已经出过招了，等对方回应。'],
      opponentNotice: null,
      finished: false,
      error: '未轮到',
    };
  }

  const challenger = deps.characters.findById(battle.characterId);
  const opponent = battle.opponentCharacterId ? deps.characters.findById(battle.opponentCharacterId) : null;
  if (!challenger || !opponent) {
    return { kind: 'rejected', lines: ['对手已经不在了。'], opponentNotice: null, finished: true, error: '对手不存在' };
  }

  /* ---- 认输：立即结束，不是一个回合 ---- */
  if (action.kind === 'surrender') {
    // 从**发起者视角**看：发起者认输 = 发起者败；应战者认输 = 发起者胜
    const status: BattleStatusKind = side === 'challenger' ? 'player_lose' : 'player_win';
    const surrendered: BattleState = {
      ...battle,
      status,
      pendingAction: null,
      lastRoundAt: now,
      resolvedAt: now,
    };
    deps.battles.syncState(surrendered);
    deps.characters.appendEvents([
      {
        // 认输也要留一条终局事件 —— 否则报告里的「认输分布」只能靠猜
        type: 'pvp_end',
        characterId: battle.characterId,
        payload: { battleId: battle.id, status, surrenderedBy: side, bySurrender: true, round: battle.round },
        reason: 'PVP 结束：认输（' + side + '）',
        seed,
        createdAt: now,
      },
    ]);
    const facts = finishPvpOutcome({
      deps,
      battle: surrendered,
      challenger,
      opponent,
      now,
      seed,
      /** 认输**不通缉** —— 不是重伤，是他自己认的（任务书 §五） */
      bySurrender: true,
      surrenderedBy: side,
    });
    /*
     * M2.11：文案按**收件人**渲染两份。
     * M2.10 只有发起者视角那一份，于是应战者认输时屏幕上是
     * 「乙应战者举起手 —— 他不打了」—— 那句话是说给**发起者**听的，
     * 而收件人是乙自己。
     */
    const names = { challenger: challenger.name, opponent: opponent.name };
    const foeSide: 'challenger' | 'opponent' = side === 'challenger' ? 'opponent' : 'challenger';
    return {
      kind: 'surrendered',
      lines: pvpEndingLines(facts, side, names),
      opponentNotice: pvpEndingLines(facts, foeSide, names).join('\n'),
      finished: true,
    };
  }

  /* ---- 扣应战者的灵力（发起者的灵力由判定层管） ---- */
  const deltas: EffectDelta[] = [];
  /*
   * M2.12：命运赌注的代价是消化度（与 PVE 侧同一个手法 —— 判定层只记账，
   * 角色卡上的消化度由命令层扣）。放在这里而不是判定层，是因为
   * 「谁在用这一招」只有这一层知道：PVP 里两边都在用同一台状态机。
   */
  if (action.kind === 'skill' && action.skillId === 'fate_wager') {
    deltas.push({ type: 'dig', value: -BATTLE.skillEffects.fate_wager.digCost });
  }
  if (side === 'opponent' && action.kind === 'skill') {
    // 技能表是内容（numeric.battle.skills），命令层只负责读它的 mpCost
    const skill = (BATTLE.skills as Record<string, { mpCost: number }>)[action.skillId ?? ''];
    if (skill) deltas.push({ type: 'mp', value: -skill.mpCost });
  }

  const item: BattleItemEffect | null = action.itemId ? battleItemEffectOf(deps, action.itemId) : null;
  /*
   * M2.13.1：**封印物在 PVP 里也要接上。**
   * M2.13 只接了 PVE（battle-hooks），PVP 那一半漏了 ——
   * 表现是「用了但什么都没发生，而代价照付」。
   */
  const extraordinary =
    action.kind === 'extraordinary' && action.extraordinaryId
      ? battleExtraordinaryEffectOf(deps, action.extraordinaryId)
      : null;
  /*
   * M2.18（C/D）：势力关系的战斗修正。
   *
   * 加成是**对称**的（敌对 -10% 对双方一样），所以用「发起者 × 对手」算一次就够 ——
   * 不必管这一招是谁出的（`resolvePvpRound` 的第一个参数永远是我方角色卡）。
   */
  const opponentCharacter = battle.opponentCharacterId
    ? deps.characters.findById(battle.opponentCharacterId)
    : null;
  const relation = opponentCharacter ? relationBonusFor(deps, actor, opponentCharacter) : null;
  /*
   * M2.65：**两侧的行动标记**（`.行动` 写的 flags）。
   *
   * 判定层的 player 侧**永远是发起者**（本文件文件头那条约定），所以：
   *   发起者的标记 → `action`（提高自己的出手 / 削减自己挨的伤害 / 削减对方出手）；
   *   应战者的标记 → `action.foe`（方向全部对着发起者）。
   *
   * 只接一侧是不够的：那样「当发起者时立阵有用、当应战者时没用」——
   * 一条只有一半玩家踩得到的规则比没有更糟。
   */
  const markDay = dateKey(now);
  const markLocation = battle.world.locationId;
  const readMark = (characterId: string) => (flag: string): string | null =>
    deps.flags.value(characterId, flag);
  const selfMarks = battleActionMarks(readMark(challenger.id), markLocation, markDay);
  const foeMarks = battleActionMarks(readMark(opponent.id), markLocation, markDay);
  const live = (mark: { nextAttack: number; guardDamage: number; enemyDamage: number }): boolean =>
    mark.nextAttack !== 1 || mark.guardDamage !== 1 || mark.enemyDamage > 0;
  const hasSelf = live(selfMarks);
  const hasFoe = live(foeMarks);

  /*
   * M2.66：**两侧的先手**（`AbilityEffect.initiativeBonus`）。
   * 判定层取差值 —— 与行动标记两侧都接是同一个理由（半边的规则比没有更糟）。
   */
  const challengerInitiative = abilityEffectsOf(deps, challenger).initiativeBonus;
  const opponentInitiative = abilityEffectsOf(deps, opponent).initiativeBonus;

  const outcome: PvpOutcome = resolvePvpRound(challenger, battle, action, createSeededRng(seed), {
    item,
    ...(challengerInitiative !== undefined ? { initiative: challengerInitiative } : {}),
    ...(opponentInitiative !== undefined ? { initiativeFoe: opponentInitiative } : {}),
    ...(extraordinary ? { extraordinary } : {}),
    ...(relation ? { relation } : {}),
    ...(hasSelf || hasFoe
      ? { action: { ...(hasSelf ? selfMarks : {}), ...(hasFoe ? { foe: foeMarks } : {}) } }
      : {}),
  });

  /*
   * **用完即消**（两侧各删各的）：判定层回报「谁用掉了哪几条」，这里去删 flag。
   * 等结算之后才删是必须的 —— 挂上但这一回合没用到的标记（他一直防御 / 对手一直扑空）
   * 不该白吃一次行动。
   */
  for (const mark of outcome.result?.consumedActionMarks ?? []) {
    deps.flags.clear(challenger.id, battleMarkFlag(mark, markLocation, markDay));
  }
  for (const mark of outcome.result?.consumedFoeMarks ?? []) {
    deps.flags.clear(opponent.id, battleMarkFlag(mark, markLocation, markDay));
  }
  outcome.battle.lastRoundAt = now;
  outcome.battle.resolvedAt = outcome.kind === 'settled' && outcome.battle.status !== 'active' ? now : null;

  if (outcome.kind === 'waiting') {
    // 只记下动作 —— **不是一个回合**，所以用 syncState（不写 battle_rounds）
    deps.battles.syncState(outcome.battle);
    const lines = [...outcome.lines];
    if (deltas.length > 0) {
      const applied = applyFor(deps, actor, deltas, 'PVP 出招', now, seed);
      if (!applied.rejected) {
        deps.characters.update(applied.newState);
        /*
         * M2.22 任务 5（K8）：**这一行原来没有。**
         *
         * 等待分支改了状态却不落事件 —— 于是「命运赌注扣 3 点消化度」这一笔
         * 在 domain_events 里彻底消失：状态表扣了、事件流没有。
         * 症状是**事件链断裂**（下一条 `dig_delta` 的 `before` 接不上上一条的 `after`），
         * 而不是末值对不上 —— 所以 M2.18 那种「只比末值」的对账查不出来。
         *
         * 实测（`node scripts/audit-dig.ts --batch m223a`）：8 片 × 25 人 × 30 天里
         * **4 个角色**的链断在这里，缺口全是 3 的倍数（3 / 6 / 6 / 3），reason 全是「PVP 战胜」那条的前一条。
         * 补上这一行之后，那一笔会以 `dig_delta`（reason = 「PVP 出招」）落库，链就接上了。
         */
        deps.characters.appendEvents(applied.events);
      }
    }
    deps.characters.appendEvents([
      {
        type: 'pvp_action_pending',
        characterId: actor.id,
        payload: { battleId: battle.id, side, action: action.kind, round: battle.round },
        reason: 'PVP 出招（等对方）',
        seed,
        createdAt: now,
      },
    ]);
    return {
      kind: 'waiting',
      lines,
      opponentNotice: `${actor.name}已经出招了，轮到你了（.战斗 出招）。`,
      finished: false,
    };
  }

  /* ---- 结算了：落库（状态机 + 回合记录一个事务） ---- */
  const result = outcome.result!;
  deps.battles.saveRound({
    battle: outcome.battle,
    result,
    playerAction: result.playerAction,
    creatureAction: result.creatureAction,
    seed,
    now,
  });

  /* ---- 双方数值写回 ---- */
  // 发起者：判定层的 player 侧
  let challengerNext = challenger;
  const challengerDeltas: EffectDelta[] = [
    { type: 'hp', value: outcome.battle.playerHp - challenger.hp },
    { type: 'mp', value: outcome.battle.playerMp - challenger.mp },
  ];
  if (side === 'challenger') challengerDeltas.push(...deltas);
  const applied = applyFor(deps, challenger, challengerDeltas, 'PVP 回合', now, seed);
  if (!applied.rejected) {
    challengerNext = applied.newState;
    deps.characters.update(challengerNext);
    deps.characters.appendEvents(applied.events);
  }

  // 应战者：判定层的对手侧（只有血量由战斗管；灵力由他出招时自己扣）
  let opponentNext = opponent;
  const opponentDeltas: EffectDelta[] = [{ type: 'hp', value: outcome.battle.creatureHp - opponent.hp }];
  if (side === 'opponent') opponentDeltas.push(...deltas);
  const opponentApplied = applyFor(deps, opponent, opponentDeltas, 'PVP 回合（对手）', now, seed);
  if (!opponentApplied.rejected) {
    opponentNext = opponentApplied.newState;
    deps.characters.update(opponentNext);
    deps.characters.appendEvents(opponentApplied.events);
  }

  deps.characters.appendEvents([
    {
      type: 'pvp_round',
      characterId: battle.characterId,
      payload: {
        battleId: battle.id,
        round: result.round,
        actor: side,
        challengerAction: result.playerAction.kind,
        opponentAction: result.creatureAction.kind,
        opponentSkill: result.creatureAction.skillId ?? null,
        challengerDamageDealt: result.playerDamageDealt,
        opponentDamageDealt: result.creatureDamageDealt,
        challengerHp: outcome.battle.playerHp,
        opponentHp: outcome.battle.creatureHp,
        status: result.status,
        auto: Boolean(action.auto),
      },
      reason: `PVP 第 ${result.round} 回合：${result.playerAction.kind} vs ${result.creatureAction.kind}`,
      seed,
      createdAt: now,
    },
    /*
     * M2.13.1：**PVP 里用封印物也要留档**（与 PVE 那条路同一个事件类型）。
     * 不写这一条的话，报告里的「封印物使用次数」会把 PVP 那一半整个漏掉 ——
     * 而 M2.13 的 14 次「使用」**全部发生在 PVP**（见 M2.13.1 取证报告）。
     */
    ...(action.kind === 'extraordinary' && action.extraordinaryId
      ? [
          {
            type: 'extraordinary_used',
            characterId: actor.id,
            payload: {
              itemId: action.extraordinaryId,
              type: 'sealed',
              actionKind: 'battle_pvp',
              inBattle: true,
              battleId: battle.id,
              round: result.round,
              playerSequence: actor.sequence ?? 9,
              creatureSequence: battle.creatureSequence,
              ignoredSequenceGap: result.ignoredSequenceGap,
            },
            reason: 'PVP 中使用封印物:' + action.extraordinaryId,
            seed,
            createdAt: now,
          },
        ]
      : []),
  ]);

  /* ---- 终局后果 ---- */
  let ending: string[] = [];
  let endingForOpponent: string | null = null;
  if (result.status !== 'active') {
    const facts = finishPvpOutcome({
      deps,
      battle: outcome.battle,
      challenger: challengerNext,
      opponent: opponentNext,
      now,
      seed,
      bySurrender: false,
      surrenderedBy: null,
    });
    const names = { challenger: challengerNext.name, opponent: opponentNext.name };
    const foeSide: 'challenger' | 'opponent' = side === 'challenger' ? 'opponent' : 'challenger';
    ending = pvpEndingLines(facts, side, names);
    endingForOpponent = pvpEndingLines(facts, foeSide, names).join('\n');
    deps.characters.appendEvents([
      {
        type: 'pvp_end',
        characterId: battle.characterId,
        payload: {
          battleId: battle.id,
          status: result.status,
          rounds: result.round,
        },
        reason: 'PVP 结束：' + result.status,
        seed,
        createdAt: now,
      },
    ]);
  }

  const roundLines = result.events.map((event) => event.text);
  return {
    kind: 'settled',
    lines: [...outcome.lines, ...roundLines, ...ending],
    opponentNotice: endingForOpponent,
    finished: result.status !== 'active',
  };
}

/**
 * 胜负后果（任务书 §4.5 / §4.7）。
 *
 * | 结果 | 后果 |
 * | --- | --- |
 * | 胜 | 掉落对方 20% 非绑定物品、DIG +2、胜者吃 3 级通缉 |
 * | 败 | 重伤（**不删卡**）、AP 清空、MAD +5 |
 * | 僵持 | **双方各扣 1 AP**（PVE 不罚，PVP 必须罚 —— 否则「拖」变成策略） |
 * | 认输 | 判负的后果照旧，但**对方不通缉** |
 *
 * ⚠️ 任务书有两处互相矛盾：§4.5 的表格写「对方（败者）被通缉 3 级」，
 * §4.7 的数值段写 `wantedLevelOnWin: 3`（胜者被通缉）。**本实现按 §4.7**：
 *   1. §4.7 是数值段（有明确字段名），§4.5 是叙事表格；
 *   2. §五 的说明「让人不敢随便挑战弱者」只有在**赢的人**吃通缉时才成立 ——
 *      败者吃通缉等于「挨打的人还要背罪」，那说不通；
 *   3. 与 M2.6.1 一致：`.袭击` 也是**动手的人**吃通缉。
 */
/**
 * 终局的**事实**（与视角无关）。
 *
 * M2.11 把它从文案里拆出来，是因为 M2.10 的一句话在**应战者触发结算时是反的**：
 * 那份文案整段是「发起者视角」（「你赢了」「X 倒了下去」），
 * 而它被当成**出招方**的回执发出去 —— 于是应战者打完最后一个回合，
 * 屏幕上写着「你赢了」，而实际上倒下去的是他自己。
 *
 * 拆法：finishPvpOutcome 只做**副作用**（扣血 / 掉落 / 通缉 / 广播）并回一份事实，
 * 文案交给纯函数按视角渲染。副作用只跑一次，文案可以渲染两次 —— 这正是需要的形状。
 */
export interface PvpEndFacts {
  status: BattleStatusKind;
  /** 谁按下的「认输」（不是认输收场时为 null） */
  surrenderedBy: 'challenger' | 'opponent' | null;
  /** 胜者从败者身上拿走的物品名 */
  loot: string[];
  /** 胜者吃到的通缉（null = 没吃：认输，或者场景没有势力） */
  wanted: { level: number; factionId: string } | null;
}

/**
 * 把终局事实渲染成**某一边看到的那几句话**。
 *
 * ⚠️ 发起者视角的文案**逐字保持 M2.10 的原样**（127 条既有断言建立在那份文本上）；
 * 应战者视角是新增的 —— 两边的每一句都必须说对「你是谁」。
 */
export function pvpEndingLines(
  facts: PvpEndFacts,
  viewer: 'challenger' | 'opponent',
  names: { challenger: string; opponent: string },
): string[] {
  const me = names[viewer];
  const foe = viewer === 'challenger' ? names.opponent : names.challenger;
  const lines: string[] = [];

  /* ---- 认输：第一句永远属于按下它的人 ---- */
  if (facts.surrenderedBy) {
    lines.push(
      facts.surrenderedBy === viewer ? '你举起手 —— 你不打了。' : foe + '举起手 —— 他不打了。',
    );
  }

  /* ---- 僵持：两边看到的是同一件事 ---- */
  if (facts.status === 'stalemate') {
    lines.push('你们都没有倒下。' + BATTLE.maxRounds + ' 个回合过去了，雾散了。');
    return lines;
  }

  /* ---- 有人脱战：谁退的，谁看到「你」 ---- */
  if (facts.status === 'fled' || facts.status === 'creature_fled') {
    const fleer = facts.status === 'fled' ? 'challenger' : 'opponent';
    lines.push(
      fleer === viewer ? '你退了出去。这一场没有输赢。' : names[fleer] + '退了出去。这一场没有输赢。',
    );
    return lines;
  }

  /* ---- 分出胜负 ---- */
  const iWon = (facts.status === 'player_win') === (viewer === 'challenger');
  lines.push(iWon ? '你赢了。' : '你输了。');
  lines.push(
    iWon ? foe + '倒了下去 —— 重伤，但没有死。' : foe + '把你按在了地上 —— 重伤，卡还在。',
  );
  if (facts.loot.length > 0) {
    lines.push((iWon ? '你从他身上' : '他把你身上') + '拿走了：' + facts.loot.join('、') + '。');
  }
  if (facts.wanted) {
    lines.push(
      iWon
        ? '你重伤了他 —— ' +
            facts.wanted.level +
            ' 级通缉（' +
            facts.wanted.factionId +
            '）。这一条与「高序列打低序列」同一档。'
        : '他重伤了你 —— 他吃了 ' +
            facts.wanted.level +
            ' 级通缉（' +
            facts.wanted.factionId +
            '）。你想清算的话，.举报 他。',
    );
  } else if (facts.surrenderedBy) {
    lines.push(
      iWon
        ? '对方是自己认的输 —— 这一次不算重伤，你没有吃通缉。'
        : '你自己认的输 —— 这一次不算重伤，对方没有吃通缉。',
    );
  }
  return lines;
}

/**
 * M2.18 任务 B：势力争夺的记账（**只记胜者**，见 0023 迁移的注释）。
 *
 * 挂在 `finishPvpOutcome` 的「分出胜负」分支里 —— 僵持与脱战没有胜者，不记。
 * 三条前置：双方**都入了教**、**不是同一家**、两家是 **hostile**（ally / neutral 不争地盘）。
 * 地点取发起者脚下（`.挑战` 的入口已经校验过「同地点」），且必须落在 contestedLocations 里。
 */
function recordTerritoryContest(
  deps: RouterDeps,
  challenger: CharacterState,
  opponent: CharacterState,
  challengerWon: boolean,
  now: number,
): void {
  const conflict = NUMERIC.church.conflict;
  const left = challenger.churchId ?? null;
  const right = opponent.churchId ?? null;
  if (!left || !right || left === right) return;
  if (deps.churches.relationOf(left, right) !== 'hostile') return;
  const locationId = deps.flags.value(challenger.id, 'loc');
  if (!locationId || !conflict.contestedLocations.includes(locationId)) return;
  deps.churchConflict.record({
    locationId,
    winnerChurchId: challengerWon ? left : right,
    delta: conflict.pvpWinDelta,
    now,
  });
}

/**
 * M2.18（C/D）：**势力关系带来的战斗修正**（命中加成 / 伤害加成）。
 *
 * 三条判据，与争夺（recordTerritoryContest）同一套：
 *   1. 有一方没入教 → **中性**（教义只管自己人，也不针对教外的人）
 *   2. 同一家教會 → `sameChurchBonus`（同门互相照应）
 *   3. `relationOf === 'hostile'` → `hostilePenalty`（仇敌相见，手会抖）；
 *      `neutral` / `ally` → 中性。
 *
 * 判据一律走 M2.15 交付的 `relationOf`（对称 / 自反中立 / 未声明即中立），**不重实现**。
 *
 * ⚠️ `hostilePenalty` 里还有 `tradePrice`（交易加价，任务 C1 的另一半）——
 * 那一位**不属于战斗**，所以这里只挑 hit / damage 两个字段出去。
 */
function relationBonusFor(
  deps: RouterDeps,
  left: CharacterState,
  right: CharacterState,
): { hit?: number; damage?: number } | null {
  const a = left.churchId ?? null;
  const b = right.churchId ?? null;
  if (!a || !b) return null;
  const conflict = NUMERIC.church.conflict;
  if (a === b) {
    return { hit: conflict.sameChurchBonus.hit, damage: conflict.sameChurchBonus.damage };
  }
  if (deps.churches.relationOf(a, b) === 'hostile') {
    return { hit: conflict.hostilePenalty.hit, damage: conflict.hostilePenalty.damage };
  }
  return null;
}

function finishPvpOutcome(input: {
  deps: RouterDeps;
  battle: BattleState;
  challenger: CharacterState;
  opponent: CharacterState;
  now: number;
  seed: string;
  bySurrender: boolean;
  /** 谁按下的认输（不是认输收场时给 null）—— 文案要用它说清「谁举的手」 */
  surrenderedBy: 'challenger' | 'opponent' | null;
}): PvpEndFacts {
  const { deps, battle, challenger, opponent, now, seed, bySurrender, surrenderedBy } = input;
  const status = battle.status;

  /* ---- 僵持：M2.85 起行动值移除，不再各扣 1 AP（僵持本来就不播报） ---- */
  if (status === 'stalemate') {
    return { status, surrenderedBy, loot: [], wanted: null };
  }

  /* ---- 有人脱战（撤退成功）：无奖励无惩罚 ---- */
  if (status === 'fled' || status === 'creature_fled') {
    // 注意：M2.11 的「拒绝挑战」也落在这个状态上，但它**不走这里** ——
    // 那条路在 challenge.ts 里自己写文案（拒绝有它自己的说法），并且只记事件不结算。
    return { status, surrenderedBy, loot: [], wanted: null };
  }

  /* ---- 分出胜负 ---- */
  const challengerWon = status === 'player_win';
  const winner = challengerWon ? challenger : opponent;

  /* M2.18 任务 B：敌对教会之间的胜负会改变地点归属（底图不动，只记增量） */
  recordTerritoryContest(deps, challenger, opponent, challengerWon, now);
  const loser = challengerWon ? opponent : challenger;

  // 败者：重伤（不删卡）、MAD +5（M2.85 起不再清空行动点）
  const loserDeltas: EffectDelta[] = [{ type: 'mad', value: BATTLE.rewards.madOnLose }];
  const loserApplied = applyFor(deps, loser, loserDeltas, 'PVP 战败', now, seed);
  let loserNext = loser;
  if (!loserApplied.rejected) {
    loserNext = loserApplied.newState;
    deps.characters.update(loserNext);
    deps.characters.appendEvents(loserApplied.events);
  }
  if (loserNext.hp <= 0 && loserNext.status !== 'injured') {
    const injured = { ...loserNext, status: 'injured' as const, updatedAt: now };
    deps.characters.update(injured);
  }

  // 胜者：DIG +2
  const winnerApplied = applyFor(deps, winner, [{ type: 'dig', value: BATTLE.rewards.digOnWin }], 'PVP 战胜', now, seed);
  if (!winnerApplied.rejected) {
    deps.characters.update(winnerApplied.newState);
    deps.characters.appendEvents(winnerApplied.events);
  }

  /* ---- 掉落：败者的非绑定物品，20%，至少留 lootKeepMinItems 件 ---- */
  const loot = lootFromLoser(deps, loser, winner, now, seed);

  /* ---- 胜者吃 3 级通缉（认输除外） ---- */
  let wanted: { level: number; factionId: string } | null = null;
  if (!bySurrender) {
    const sceneFactionId = factionOfLocation(battle.world.locationId);
    if (sceneFactionId !== 'none') {
      const level = PVP.wantedLevelOnWin;
      const state = {
        id: seedFrom(['pvp-wanted', winner.id, sceneFactionId, String(level), String(battle.id)]),
        characterId: winner.id,
        level,
        factionId: sceneFactionId,
        reason: '在决斗中重伤了 ' + loser.name,
        createdAt: now,
        expiresAt: now + wantedDurationOf(level),
        bountyMultiplier: 1,
      };
      deps.wanted.upsert(state);
      deps.characters.appendEvents([
        {
          type: 'wanted_issued',
          characterId: winner.id,
          payload: {
            wantedId: state.id,
            level,
            factionId: sceneFactionId,
            locationId: battle.world.locationId,
            targetId: loser.id,
            source: 'pvp',
            durationMs: wantedDurationOf(level),
          },
          reason: '通缉签发:决斗重伤 ' + loser.name,
          seed,
          createdAt: now,
        },
      ]);
      wanted = { level, factionId: sceneFactionId };
    }
  }

  // 群内匿名：只说「打斗停了」，不说谁在打谁
  deps.broadcast?.('某处的打斗停了。');

  return { status, surrenderedBy, loot, wanted };
}

/** 从败者身上取 20% 非绑定物品（货币不算「物品」，不参与抢夺） */
function lootFromLoser(
  deps: RouterDeps,
  loser: CharacterState,
  winner: CharacterState,
  now: number,
  seed: string,
): string[] {
  const slots = deps.inventory
    .list(loser.id)
    .filter((slot) => slot.bindType === 'unbound' && !isCurrency(deps.items.get(slot.itemId)));
  const expanded: string[] = [];
  for (const slot of slots) {
    for (let index = 0; index < slot.quantity; index += 1) expanded.push(slot.itemId);
  }
  // 「至少留 lootKeepMinItems 件」：20% 在一个只剩两件东西的人身上就是「全抢光」，
  // 而「被抢光」与「被打伤」是两种完全不同的挫败
  const maxTake = Math.max(0, expanded.length - PVP.lootKeepMinItems);
  const takeCount = Math.min(Math.floor(expanded.length * PVP.lootPercent), maxTake);
  const taken = expanded.slice(0, takeCount);
  for (const itemId of taken) {
    if (!deps.inventory.tryRemove(loser.id, itemId, 1, now)) continue;
    deps.inventory.add(winner.id, itemId, 1, 'unbound', now);
    deps.characters.appendEvents([
      {
        type: 'item_gain',
        characterId: winner.id,
        payload: { itemId, quantity: 1, bindType: 'unbound', from: loser.id },
        reason: '决斗掉落',
        seed,
        createdAt: now,
      } satisfies DomainEvent,
    ]);
  }
  return taken;
}

/**
 * PVP 的超时（任务书 §4.3.1）：**双方各自计时，各自自动防御**。
 *
 * 与 PVE 的超时有三处不同，每一处都是任务书点名的：
 *   1. **谁轮到就替谁防御** —— PVE 里只有玩家会超时（生物永远在线），
 *      而 PVP 里两边都可能挂机。每次轮到谁，谁超时，战斗就往前走一格；
 *      于是**不会出现「两人都挂机就永远不动」的僵局**；
 *   2. 一格仍然是 5 分钟（与 PVE 同值）；
 *   3. 推进的每一格都落库（状态机 + 回合记录），关掉浏览器回来照样接着打。
 *
 * 只处理**这个人参与的**战斗（与路由层的 #settleBattle 同一手法：
 * 没人看见的那一场，等有人看见时再补）。
 */
export function settlePvpTimeout(deps: RouterDeps, character: CharacterState, now: number): number {
  let battle = deps.battles.activeOf(character.id);
  if (!battle || !battle.isPvp) return 0;

  let rounds = 0;
  while (
    battle &&
    battle.isPvp &&
    battle.status === 'active' &&
    now - battle.lastRoundAt >= PVP.playerTimeoutMs &&
    rounds < BATTLE.maxRounds
  ) {
    const actorSide = battle.turnOf;
    const actorId = actorSide === 'challenger' ? battle.characterId : battle.opponentCharacterId;
    const actor = actorId ? deps.characters.findById(actorId) : null;
    if (!actor) break;
    const roundAt = battle.lastRoundAt + PVP.playerTimeoutMs;
    const seed = seedFrom([battle.id, battle.round, 'pvp-timeout', roundAt]);
    const outcome = runPvpTurn({
      deps,
      actor,
      battle,
      action: { kind: 'defend', auto: true },
      now,
      seed,
    });
    rounds += 1;
    if (outcome.kind === 'rejected') break;
    battle = deps.battles.activeOf(character.id);
  }
  return rounds;
}

/* ====================================================================== *
 * M2.11 前置 3：「等待中」的那一块（**UX 补丁，不是异常判定的补丁**）
 * ====================================================================== */

/**
 * 等待的时候，这一屏该说什么。
 *
 * ## 为什么要有它
 *
 * M2.10 的 200×14 跑出 2 条 P1（NO_STATE_CHANGE），追下去是同一个形状：
 *
 *   玩家在 PVP 里等对手出招（这是对的，真人也会去做别的事）
 *     → 他连着发 .扮演，而 DIG 已经满了 → 状态不变
 *     → noChangeStreak 累积到 10 → P1
 *
 * M2.10 把「DIG 满了就别再扮演」这条保护记成了下一轮的落点。但 **P1 只是症状**：
 * 真正的空白是「玩家在等待时不知道该做什么」—— 他看背包、看状态、看世界，
 * 然后发现**什么都没用**，因为这一回合还没轮到他。
 *
 * 所以这一块不是去调异常阈值，而是**把等待这件事本身说清楚**：
 *   1. 打到第几回合了；
 *   2. 双方现在什么状态（他剩多少血、我还剩多少）；
 *   3. **他已经多久没动了** —— 让玩家知道对方还在，不是卡住了；
 *   4. **超时会发生什么** —— 就算对方不回，这一场也会自己往前走。
 *
 * ## 「他已经 N 分钟没动了」为什么是准的
 *
 * 用的是 battle.lastRoundAt（这一场最后一次推进的时刻），而不是另查一张表。
 * 在 turnOf 不等于自己 的前提下，有一条不变量：
 *
 *   **对手只要动过，这一场就会推进（waiting 或结算），turnOf 就会变回 challenger。**
 *
 * 所以「现在轮到他、而这一场停在 X 分钟前」等价于「他从那之后就再没动过」。
 * 不需要读 domain_events，也不会说出「他 2 分钟前活动过」这种**看似更具体、
 * 其实要靠猜**的话（对手上一次动作发生在 lastRoundAt 之前，从这一行推不出来）。
 */
export function pvpWaitBlock(input: {
  battle: BattleState;
  character: CharacterState;
  now: number;
  /**
   * **从「我」这一侧看**，对面叫什么。
   *
   * ⚠️ 不能直接用 battle.opponentName —— 那个名字是**发起者视角**的
   * （createPvpBattleState 把应战者的名字写进了 speciesName / opponentName）。
   * 应战者拿到它，看到的会是**自己的名字**：M2.11 实测抓到过
   * 「【战斗 · 第 1 回合 · 等 乙应战者 出招】」出现在乙自己的屏幕上。
   * 调用方要么传这一项，要么走 pvpWaitBlockFor（它自己按 side 查库）。
   */
  foeName?: string;
}): string[] | null {
  const { battle, character, now } = input;
  if (!battle.isPvp || battle.status !== 'active') return null;
  const side = sideOf(battle, character.id);
  if (!side) return null;
  // 轮到自己就不是「等待」—— 这一屏该给的是出招菜单，不是安慰
  if (battle.turnOf === side) return null;

  const foeName = input.foeName ?? battle.opponentName ?? '对手';
  const idleMs = Math.max(0, now - battle.lastRoundAt);
  const leftMin = Math.max(0, Math.ceil((PVP.playerTimeoutMs - idleMs) / 60000));
  const idleText =
    idleMs < 60_000 ? '他还没动（不到 1 分钟）' : '他已经 ' + Math.floor(idleMs / 60_000) + ' 分钟没动了';

  return [
    '【战斗 · 第 ' + battle.round + ' 回合 · 等 ' + foeName + ' 出招】',
    foeName +
      ' · HP ' +
      battle.creatureHp +
      '/' +
      battle.creatureMaxHp +
      ' · 状态：' +
      describeStatuses(battle.creatureStatuses),
    '你 · HP ' + battle.playerHp + '/100 · MP ' + battle.playerMp + '/100 · MAD ' + character.mad,
    idleText + '。',
    '',
    side === 'challenger'
      ? '你出了手 —— 但他还没动，等他回应。'
      : '他还没出手 —— 等他出招，你们这一回合才会一起结算。',
    '（再过 ' + leftMin + ' 分钟他还不回，系统会替他防御，这一回合照样结算。）',
  ];
}

/**
 * 「从我这一侧看，对面是谁」。
 *
 * 发起者 → 应战者（opponentCharacterId）；应战者 → 发起者（characterId）。
 * 库里的名字才是权威的 —— battle.opponentName 只对发起者成立。
 */
function foeNameOf(deps: RouterDeps, battle: BattleState, side: 'challenger' | 'opponent'): string {
  const foeId = side === 'challenger' ? battle.opponentCharacterId : battle.characterId;
  const name = foeId ? deps.characters.findById(foeId)?.name : null;
  return name ?? battle.opponentName ?? '对手';
}

/** 等待块（自己查库版）：.今日 / .状态 这些**不是战斗指令**的地方用它 */
export function pvpWaitBlockFor(
  deps: RouterDeps,
  character: CharacterState,
  now: number,
): string[] | null {
  const battle = deps.battles.activeOf(character.id);
  if (!battle || !battle.isPvp) return null;
  const side = sideOf(battle, character.id);
  if (!side) return null;
  return pvpWaitBlock({ battle, character, now, foeName: foeNameOf(deps, battle, side) });
}

/**
 * 一句话的引导：**等对手的时候做了一件不改变状态的事**。
 *
 * 与 pvpWaitBlock 分开，因为两者的位置不同：
 *   块 —— 玩家主动看状态时给，越长越好（他要的就是信息）；
 *   句 —— 玩家做了一件没用的事时给，一句话就够（他不想要一屏字，他想要「那我该干嘛」）。
 *
 * 触发点只有两个明确的地方（.扮演 而 DIG 没动、.占卜 而次数用完），
 * 而不是「任何在等待期发的指令」—— 后者会在玩家看背包、看帮助时也念一遍，
 * 那不是提示，那是唠叨。
 */
export function pvpWaitNudge(deps: RouterDeps, character: CharacterState, now: number): string | null {
  const battle = deps.battles.activeOf(character.id);
  if (!battle || !battle.isPvp || battle.status !== 'active') return null;
  const side = sideOf(battle, character.id);
  if (!side || battle.turnOf === side) return null;
  const foeName = foeNameOf(deps, battle, side);
  const idleMs = Math.max(0, now - battle.lastRoundAt);
  const idleText =
    idleMs < 60_000 ? '他还没动（不到 1 分钟）' : '他已经 ' + Math.floor(idleMs / 60_000) + ' 分钟没动了';
  return '（你在等 ' + foeName + ' 出招。' + idleText + '。）';
}

/** 供命令层复用：对手动作的翻译（PVP 里「对方上一回合出了什么」要说给玩家听） */
export { opponentActionOf, opponentSpeciesViewOf };
export { levelForTrigger };
