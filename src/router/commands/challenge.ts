/**
 * 挑战（M2.10）：**正式对战**，与 `.袭击` 并存。
 *
 * | 指令 | 形状 | 场景 | 后果 |
 * | --- | --- | --- | --- |
 * | `.袭击 @玩家` | 单次判定（M2.6.1） | 偷袭、快速 | 1 级通缉（重伤对方） |
 * | `.挑战 @玩家` | 多回合战斗（M2.10） | 正式对抗、约战 | **胜者**吃 3 级通缉 + 掉对方 20% 非绑定物品 |
 *
 * **两条路并存，不是「新指令替换旧指令」**：偷袭与约战是两种完全不同的社交行为，
 * 合并成一条会让「我不想打，但有人偷袭我」与「我接受你的挑战」变成同一件事。
 *
 * 四个决定（任务书 §4.3，已定，不重新发明）：
 *   1. **超时各自计时**：轮到谁、谁 5 分钟不回就自动防御，战斗往前走一格；
 *   2. **不能跨城市**：发起条件之一是同地点（否则 M2.7 的移动就没有意义了）；
 *   3. **僵持各扣 1 AP**（PVE 不罚，PVP 必须罚 —— 否则「拖」变成策略）；
 *   4. **群里匿名、私聊知情**：群里说「某处有人打起来了」，双方私聊知道对手是谁。
 */
import { checkTaboosFor } from './taboo-hooks.ts';
import { BATTLE, PVP } from '../../config/numeric.ts';
import { CLAMP } from '../../domain/effect/apply.ts';
import { buildChallengeMenu } from '../../domain/menu/challenge-menu.ts';
import { createPvpBattleState, pvpChallengeBlocked, type BattleState, type BattleWorld } from '../../domain/battle/index.ts';
import { isInitiated } from '../../domain/character/types.ts';
import type { CharacterState } from '../../domain/character/types.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import { isFoggy, timeOfDay } from '../../domain/world/clock.ts';
import { weatherLabel } from '../../domain/world/weather.ts';
import { newBattleId } from '../../infra/ids.ts';
import type { CommandContext, CommandResult, Reply, RouterDeps } from '../index.ts';
import { GROUP_MENU_HINT, requireCharacter } from './common.ts';
import { runPvpTurn } from './pvp-hooks.ts';

export const CHALLENGE_USAGE = '用法：.挑战 @某人（摆出挑战菜单）· .挑战 @某人 发起';

/** 找到挑战对象（与 .袭击 同一套解析：先按 QQ 号，再按名字） */
function resolveTarget(ctx: CommandContext, raw: string): CharacterState | null {
  const { deps } = ctx;
  return (
    deps.characters.findByUserId(raw) ??
    deps.characters.all().find((candidate) => candidate.name === raw) ??
    null
  );
}

/** 这个人此刻在哪（与 M2.9 的战斗同一口径：读 flags.loc） */
function locationOf(deps: RouterDeps, characterId: string): string | null {
  return deps.flags.value(characterId, 'loc');
}

function worldOf(deps: RouterDeps, locationId: string, now: number): BattleWorld {
  const foggy = isFoggy(now, deps.worldSeed ?? 'world');
  return {
    locationId,
    locationName: deps.locations.get(locationId)?.name ?? locationId,
    night: timeOfDay(now) === 'night',
    danger: deps.locations.get(locationId)?.danger ?? 0,
    weatherHitPenalty: foggy ? -0.1 : 0,
    weatherLabel: weatherLabel(deps.world.weatherOf(locationId)),
  };
}

/* ================================================================== *
 * M2.11 方向 B：应战者在接受之前，先看清对面
 * ================================================================== */

/**
 * 「他刚才挑战的就是我」——把那一场找出来。
 *
 * 四条判据缺一不可，而且**不包含 pvpChallengeBlocked**：
 * 拒绝与认输恰恰是「条件已经不满足了」时的出口（发起者可能已经走开了、
 * 或者他自己刚被打成重伤）—— 拿发起条件去卡这两个动作，
 * 等于把玩家锁死在一场他不想打的架里。
 */
function pendingChallengeFrom(
  deps: RouterDeps,
  character: CharacterState,
  challengerId: string,
): BattleState | null {
  const battle = deps.battles.activeOf(character.id);
  if (!battle || !battle.isPvp) return null;
  if (battle.opponentCharacterId !== character.id) return null;
  if (battle.characterId !== challengerId) return null;
  return battle;
}

/**
 * 应战者的三个表态：接受 / 拒绝 / 认输。
 *
 * | 选项 | 落到哪里 |
 * | --- | --- |
 * | 接受 | 只留一条 \`pvp_challenge_accepted\` 事件 —— 战斗本来就已经建立，他只是表了态 |
 * | 拒绝 | 这一场以 \`creature_fled\` 收尾（**没有输赢**，不掉血不掉东西），并通知发起者 |
 * | 认输 | 走判定层的认输（自己判负、对方不通缉） |
 *
 * ⚠️ 「拒绝」为什么用 creature_fled 而不是新增一个状态：
 * battles.status 有 CHECK 约束，加状态要**新增迁移**，而 M2.11 的约束是「不新增迁移」。
 * creature_fled 在判定层的语义正好是「对手脱战 → 双方无奖励无惩罚」——
 * 与「他拒绝 = 这一场没打成」是同一件事。报告里靠 \`pvp_challenge_declined\`
 * 事件把两者分开（不会与「生物逃跑」混在一起）。
 */
function answerChallenge(
  ctx: CommandContext,
  character: CharacterState,
  challenger: CharacterState,
  verb: string,
): CommandResult {
  const { deps, msg, now } = ctx;
  const battle = pendingChallengeFrom(deps, character, challenger.id);
  if (!battle) {
    return {
      privateText: `现在没有来自 ${challenger.name} 的挑战。`,
      detailToPrivate: true,
    };
  }
  const seed = seedFrom([msg.messageId, character.id, challenger.id, now, 'challenge-' + verb]);

  /* ---- 接受：表态而已，战斗的形状一个字节都不改 ---- */
  if (verb === '接受') {
    deps.characters.appendEvents([
      {
        type: 'pvp_challenge_accepted',
        characterId: character.id,
        payload: { battleId: battle.id, challengerId: challenger.id, round: battle.round },
        reason: '接受挑战',
        seed,
        createdAt: now,
      },
    ]);
    return {
      privateText: [
        `你接下了 @${challenger.name} 的挑战。`,
        `他在第 ${battle.round} 回合先出招 —— 你看完他的动作再选。`,
        '',
        '出招：.战斗 攻击 / 防御 / 技能 <名> / 物品 <名> / 撤退 / 认输',
      ].join('\n'),
      detailToPrivate: true,
      extra: [
        {
          scene: 'private',
          targetId: challenger.userId,
          text: `${character.name}接下了你的挑战 —— 你先出招（.战斗 攻击）。`,
        },
      ],
    };
  }

  /* ---- 拒绝：这一场没有输赢地结束 ---- */
  if (verb === '拒绝') {
    deps.battles.syncState({
      ...battle,
      status: 'creature_fled',
      pendingAction: null,
      lastRoundAt: now,
      resolvedAt: now,
    });
    deps.characters.appendEvents([
      {
        type: 'pvp_challenge_declined',
        characterId: character.id,
        payload: { battleId: battle.id, challengerId: challenger.id, round: battle.round },
        reason: '拒绝挑战',
        seed,
        createdAt: now,
      },
      {
        type: 'pvp_end',
        characterId: battle.characterId,
        payload: { battleId: battle.id, status: 'creature_fled', byDecline: true, round: battle.round },
        reason: 'PVP 结束：应战者拒绝',
        seed,
        createdAt: now,
      },
    ]);
    return {
      privateText: [
        `你拒绝了 @${challenger.name} 的挑战。`,
        '这一场没有输赢 —— 你没有掉血，也没有掉东西。',
        '（他会知道。拒绝不是认输，你不欠他什么。）',
      ].join('\n'),
      detailToPrivate: true,
      extra: [
        {
          scene: 'private',
          targetId: challenger.userId,
          text: [
            `${character.name}拒绝了你的挑战 —— 这一场没打成。`,
            '你没有损失，也没有通缉。等冷却过了，或者换个人再试。',
          ].join('\n'),
        },
      ],
    };
  }

  /* ---- 认输：走判定层那一条（自己判负、对方不通缉） ---- */
  const outcome = runPvpTurn({
    deps,
    actor: character,
    battle,
    action: { kind: 'surrender' },
    now,
    seed,
  });
  return {
    privateText: outcome.lines.join('\n'),
    detailToPrivate: true,
    extra: outcome.opponentNotice && challenger
      ? [{ scene: 'private', targetId: challenger.userId, text: outcome.opponentNotice }]
      : [],
  };
}

export async function handleChallenge(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const { deps, msg, now } = ctx;

  const parts = ctx.args.map((part) => part.trim()).filter((part) => part.length > 0);
  const rawTarget = (parts[0] ?? '').replace(/^@/, '');
  const verb = parts[1] ?? '';
  if (!rawTarget) return { privateText: CHALLENGE_USAGE, detailToPrivate: true };

  const target = resolveTarget(ctx, rawTarget);
  if (!target) {
    return { privateText: `找不到这个人：${rawTarget}\n${CHALLENGE_USAGE}`, detailToPrivate: true };
  }

  /*
   * M2.11 方向 B：**应战者的三个表态**先于一切校验。
   *
   * 顺序是有意的：拿「发起条件」（同地点 / 双方都不在战斗 / 非重伤）
   * 去卡「接受 / 拒绝 / 认输」，会在最需要出口的时候把出口关上 ——
   * 一个刚被打成重伤的人想认输，却被告知「你不能发起挑战」。
   */
  if (verb === '接受' || verb === '拒绝' || verb === '认输') {
    return answerChallenge(ctx, character, target, verb);
  }

  /* ---- 校验（判定层给理由，命令层只查库） ---- */
  const selfLoc = locationOf(deps, character.id);
  const targetLoc = locationOf(deps, target.id);
  const blocked = pvpChallengeBlocked({
    sameLocation: selfLoc !== null && selfLoc === targetLoc,
    opponentExists: true,
    selfAlive: character.status !== 'injured' && character.hp > 0,
    opponentAlive: target.status !== 'injured' && target.hp > 0,
    selfInBattle: deps.battles.activeOf(character.id) !== null,
    opponentInBattle: deps.battles.activeOf(target.id) !== null,
    selfIsOpponent: target.id === character.id,
    lastChallengedAt: deps.battles.lastChallengeAt(character.id, target.id),
    now,
  });
  if (blocked) {
    /*
     * 被拒也要留一条痕（任务书 §4.10 的验收项：「跨地点拒绝次数」）。
     * 与「每一次遭遇判定都留档」同一个理由：**只有记下被拒，才能回答
     * 「同地点约束到底有没有生效」** —— 否则报告里那一栏永远是 0，
     * 而 0 既可能是「没人试过」，也可能是「试了但没拦住」。
     */
    deps.characters.appendEvents([
      {
        type: 'pvp_challenge_rejected',
        characterId: character.id,
        payload: { targetId: target.id, reason: blocked, selfLocation: selfLoc, targetLocation: targetLoc },
        reason: '挑战被拒:' + blocked,
        seed: seedFrom([msg.messageId, character.id, target.id, now, 'challenge-reject']),
        createdAt: now,
      },
    ]);
    return { privateText: blocked, detailToPrivate: true };
  }

  /* ---- 不带动作 = 摆菜单（任务书 §4.8 那一屏） ---- */
  if (verb === '') {
    return {
      privateText: [
        `【挑战 · 你 → @${target.name}】`,
        `你在${deps.locations.get(selfLoc!)?.name ?? '这里'}遇到了他。他看了你一眼，没有退。`,
        '',
        '1. 发起挑战（正式对战，多回合）',
        '2. 说句话（聊天，不进入战斗）',
        '3. 转身离开',
        '',
        '回复数字选择。',
      ].join('\n'),
      detailToPrivate: true,
      menuOpened: true,
    };
  }
  if (verb === '说话') {
    return {
      privateText: '想说什么就直接在群里说吧 —— 这一条不进入战斗。',
      detailToPrivate: true,
    };
  }
  if (verb !== '发起') {
    return { privateText: `不知道该做什么：${verb}\n${CHALLENGE_USAGE}`, detailToPrivate: true };
  }

  /* ---- 发起 ---- */
  const seed = seedFrom([msg.messageId, character.id, target.id, now, 'challenge']);
  const battle = createPvpBattleState({
    id: newBattleId(character.id, now),
    challenger: character,
    opponent: target,
    world: worldOf(deps, selfLoc!, now),
    now,
  });
  deps.battles.create(battle);

  /*
   * M2.18（F）：**战斗类教义判据的检查点之一 —— 发起挑战之后**。
   *
   * `target: 'mortal'` 表示「对手还没入途径」（序列 9，没有非凡能力 ≈ 未持械）——
   * 战神的「不得对未持械的人出手」判的就是这一步。
   * 判定层不认识战斗状态，所以这一位由命令层算好传进去（与 relation 同一手法）。
   */
  const targetCharacter = deps.characters.findById(target.id);
  const challengeTaboo = checkTaboosFor(ctx, character, 'challenge', {
    locationId: selfLoc,
    cityId: character.currentCityId ?? null,
    ...(targetCharacter && (targetCharacter.sequence ?? 9) === 9 ? { target: 'mortal' as const } : {}),
  });

  deps.characters.appendEvents([
    {
      type: 'pvp_challenge',
      characterId: character.id,
      payload: {
        battleId: battle.id,
        challengerId: character.id,
        opponentId: target.id,
        locationId: selfLoc,
        challengerHp: battle.playerHp,
        opponentHp: battle.creatureHp,
      },
      reason: '发起挑战',
      seed,
      createdAt: now,
    },
    {
      // 对手那一侧也要留一条：他的事件流里必须能查到「我被人挑战了」
      type: 'pvp_challenged',
      characterId: target.id,
      payload: { battleId: battle.id, challengerId: character.id, challengerName: character.name },
      reason: '被挑战',
      seed,
      createdAt: now,
    },
  ]);

  // 群内匿名（不暴露谁在打谁 —— 匿名是保护），双方私聊知情（对局要博弈）
  deps.broadcast?.('某处有人打起来了。');
  void createSeededRng(seed);

  /*
   * M2.11 方向 B：**给应战者一张能看清对面的选择**。
   *
   * M2.10 的第一句话是「他朝你发起了挑战 —— 多回合的对战」，而应战者
   * 一个数值都看不到：他只能在被打之后才知道自己接了一场什么仗。
   * 前置 1 的实测（40×7）给出的接受率是 43.8% —— 落在任务书 §2.3 判定的
   * 「30%—50% → 方向 B」区间，所以这里把「看清了再决定」补上。
   *
   * 三项都是**可观察的事实**（血量 / 灵力 / 序列 / 有没有伤），
   * 没有任何隐藏数值 —— 站在你对面的人本来就看得到这些。
   */
  const opened = deps.pendingMenus.openWith(
    target.id,
    'challenge',
    buildChallengeMenu({
      challengerName: character.name,
      challengerHp: character.hp,
      challengerMaxHp: CLAMP.hp[1],
      challengerMp: character.mp,
      challengerMaxMp: CLAMP.mp[1],
      challengerSequence: isInitiated(character) ? character.sequence : null,
      maxRounds: BATTLE.maxRounds,
    }),
    now,
  );

  const notice: Reply = {
    scene: 'private',
    targetId: target.userId,
    text: opened.text,
    interactive: opened.interactive,
  };

  return {
    privateText: [
      `你先动了手 —— ${target.name}还没回应。`,
      `他手上有一张写着你状态的选择：接、还是不接（${PVP.playerTimeoutMs / 60000} 分钟不表态，系统会替他防御）。`,
      `（你比他${sequenceWord(character, target)}。）`,
    ].join('\n'),
    groupText: undefined,
    detailToPrivate: true,
    extra: [notice],
  };
}

/** 序列差的说法（与 encounter-menu / battleViewFor 共用同一套语义：号小 = 强） */
function sequenceWord(self: CharacterState, other: CharacterState): string {
  const selfSeq = self.sequence ?? 9;
  const otherSeq = other.sequence ?? 9;
  const gap = selfSeq - otherSeq;
  if (gap === 0) return '们序列相同';
  return gap > 0 ? `弱 ${gap} 个序列` : `强 ${-gap} 个序列`;
}

/** 挑战能不能发起（供虚拟玩家与测试复用；返回 null = 可以） */
export { pvpChallengeBlocked };
export { isInitiated };
