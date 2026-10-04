/**
 * 战斗（M2.9）：PVE 回合制。
 *
 * 一条指令，三种形态（与 .移动 同一个手法）：
 *
 *   .战斗              看现在这一场（摆回合菜单）
 *   .战斗 开始         对**未决遭遇**里的那只生物动手
 *   .战斗 攻击/防御/撤退/技能 X/物品 Y
 *
 * ⚠️ **它不是一次判定，是一个状态机。** M2.6.1 的 .袭击 打一下、结算、结束；
 * 这里每一回合都要玩家做一次选择，而生物也在做选择 —— 所以对话的形态也不一样：
 * .袭击 的结束语是结果，战斗的结束语是**下一回合**（或者这一场的终局）。
 *
 * 三条口径：
 *   1. **群里不摆战斗菜单**（与 M2.3 一致）：群里只播报匿名的一句，选项在私聊。
 *   2. **战斗不比仪式高调**（任务书 §4.3.7）：开始「某处传来打斗声」、
 *      结束「某处的打斗停了」/「某人被抬走了」—— 匿名是保护。
 *   3. **超时是自动防御，不是判负**：玩家关掉 QQ 五分钟回来说话，
 *      那五分钟会按 5 分钟一格补成「防御」回合，然后接着打。
 */
import { sequenceOrInitiate } from '../../domain/character/types.ts';
import { hl } from '../../adapter/highlight.ts';
import { EMOJI, withEmoji } from '../../domain/emoji.ts';
import { BATTLE, PVP } from '../../config/numeric.ts';
import { actionLabel } from '../../domain/creature/perception.ts';
import { buildBattleMenu } from '../../domain/menu/battle-menu.ts';
import { battleViewFor, isBattleOver, outcomeLine } from '../../domain/battle/index.ts';
import { skillByName, skillsFor } from '../../domain/battle/skills.ts';
import type { BattleSkill } from '../../domain/battle/skill-schema.ts';
import type { BattleState, PlayerAction } from '../../domain/battle/types.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import type { CharacterState } from '../../domain/character/types.ts';
import type { CommandContext, CommandResult, Reply } from '../index.ts';
import { requireCharacter } from './common.ts';
import { GROUP_MENU_HINT } from './common.ts';
import {battleItemsOf, runBattleRound, settleBattleTimeout, startBattle, startDeityBattle } from './battle-hooks.ts';
// M2.90：打完一场也推进仪式流程 —— 与探索 / 扮演 / 事件共用同一份实现
import { dailyFlowLines } from './ritual.ts';
import { pvpWaitBlock, pvpWaitBlockFor, runPvpTurn, sideOf } from './pvp-hooks.ts';

export const BATTLE_USAGE =
  '用法：.战斗（看这一场）· .战斗 开始 · .战斗 攻击 / 防御 / 撤退 / 技能 <名> / 物品 <名>';

/** 结束之后**不摆回合菜单**，把「下一步」交回路由层（战斗已经结束了） */
function finishResult(
  lines: string[],
  groupText: string | undefined,
): CommandResult {
  return {
    privateText: lines.join('\n'),
    ...(groupText ? { groupText } : {}),
    detailToPrivate: true,
    menuOpened: false,
  };
}

export async function handleBattle(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const { deps, msg, now } = ctx;

  /*
   * 0. 超时先补完。
   * 路由层已经做过一次（每条指令前），这里再做一次不是冗余：
   * 那条路依赖「上一条消息的发送者」，而战斗指令必须**无论怎么进来的**都补齐 ——
   * 玩家点按钮走的是数字回复路径，两条路都要落到同一个地方。
   */
  let character: CharacterState = gate.character;
  const timeout = settleBattleTimeout(deps, character, now);
  if (timeout.rounds > 0) {
    character = deps.characters.findByUserId(msg.userId) ?? character;
  }

  const head = (ctx.args[0] ?? '').trim();
  const rest = ctx.args.slice(1).join(' ').trim();

  /* ---------------- 开始 ---------------- */
  /* ---------------- 挑战神（M2.85 世界演化） ---------------- */
  if (head === '挑战神') {
    const key = rest.trim();
    if (key === '') return { privateText: '挑战哪一位？发 .图鉴 神明 看名单，然后 .战斗 挑战神 <名号>。', detailToPrivate: true };
    const deity = deps.pantheon.find((d) => d.name === key || d.id === key || d.aliases.includes(key));
    if (!deity) return { privateText: `没有叫「${key}」的神。发 .图鉴 神明 看名单。`, detailToPrivate: true };
    const started = startDeityBattle({ deps, character, deity, now });
    if (!started.ok || !started.battle) return { privateText: started.reason ?? '你站不到他面前。', detailToPrivate: true };
    const b = started.battle;
    return {
      privateText:
        `你站到了【${deity.name}】面前。
` +
        `他不是生物 —— 这是序列 0。HP ${b.creatureHp}/${b.creatureMaxHp}。
` +
        '赢了他，神位就是空的；输了你就是这条路上又多的一具尸首。\n' +
        '发 .战斗 <行动> 出手。',
      detailToPrivate: true,
    };
  }

  if (head === '开始') {
    const open = deps.creatures.openSighting(character.id);
    if (!open) {
      return {
        privateText: '你面前没有东西。走到雾里去看看（.探索 某个地方），撞见了才谈得上动手。',
        detailToPrivate: true,
      };
    }
    const started = startBattle({
      deps,
      character,
      creatureId: open.creatureId,
      layer: open.layer,
      sightingId: open.id,
      now,
      seed: seedFrom([msg.messageId, character.id, now, 'battle-start']),
    });
    if (!started.ok || !started.battle) {
      return { privateText: started.reason ?? '打不起来。', detailToPrivate: true };
    }
    /*
     * 开始 ≠ 出招。
     *
     * 开战只做两件事：把状态机建起来、把**第 1 回合的**菜单摆出来。
     * 玩家这一回合要做什么由他自己点 —— 替玩家先打一下是最容易顺手写错的一步，
     * 而它的后果是「第一个回合不是你打的」，这种事只有读回执才发现得了。
     *
     * 群内匿名播报（任务书 §4.3.7）：**战斗不比仪式高调**。
     * 只说「某处传来打斗声」，不说谁在打谁 —— 这是保护。
     */
    // 匿名群播报（独立于回复的通道，不参与群聊/私聊分流）
    deps.broadcast?.('某处传来打斗声。');
    const view = battleViewFor({
      battle: started.battle,
      character,
      items: battleItemsOf(deps, character.id),
    });
    const opened = deps.pendingMenus.openWith(character.id, 'battle', buildBattleMenu(view), now);
    return {
      privateText: [
        `你先动了手。${started.battle.speciesName} HP ${started.battle.creatureHp}/${started.battle.creatureMaxHp}，序列 ${started.battle.creatureSequence}。`,
        '',
        opened.text,
      ].join('\n'),
      detailToPrivate: true,
      menuOpened: true,
      interactive: opened.interactive,
    };
  }

  /* ---------------- 查看 / 出招 ---------------- */
  const battle = timeout.battle ?? deps.battles.activeOf(character.id);
  if (!battle) {
    if (head === '查看' || head === '') {
      const open = deps.creatures.openSighting(character.id);
      return {
        privateText: open
          ? '你现在没有在打。\n雾里那只还在 —— 发 .遭遇 看看它是什么，或者直接 .战斗 开始。'
          : '你现在没有在打。',
        detailToPrivate: true,
      };
    }
    return {
      privateText: `你现在没有在打。\n${BATTLE_USAGE}`,
      detailToPrivate: true,
    };
  }

  // M2.10：PVP 走另一条路（异步回合 + 双方各自计时 + 认输）
  if (battle.isPvp) return pvpTurn(ctx, character, battle, head, rest);

  const action = parseBattleAction(head, rest, character, ctx.deps.battleSkillTable);
  if (!action.ok) {
    return { privateText: action.reason, detailToPrivate: true };
  }
  return battleTurn(ctx, character, battle, action.action);
}

/**
 * PVP 的一个回合（M2.10）。
 *
 * 与 PVE 的分别只有三处：
 *   1. **轮到谁才能出招** —— 还没轮到你时出招会被告知「等对方回应」；
 *   2. **一次出招可能只是「记下动作」**（waiting），等对方出招后才一起结算；
 *   3. 有**认输**，它在命令层直接结束，不进回合结算。
 *
 * 回执的落点也要跟着走：轮到自己 → 摆下一回合的菜单；轮到对方 → 只给一句「等他回应」，
 * 并把「轮到你了」推给对手的私聊（异步场景里，不推他就会一直等）。
 */
function pvpTurn(
  ctx: CommandContext,
  character: CharacterState,
  battle: BattleState,
  head: string,
  rest: string,
): CommandResult {
  const { deps, msg, now } = ctx;
  const side = sideOf(battle, character.id);
  const opponentId = side === 'challenger' ? battle.opponentCharacterId : battle.characterId;
  const opponent = opponentId ? deps.characters.findById(opponentId) : null;
  const myTurn = battle.turnOf === side;
  /*
   * ⚠️ M2.11 修掉的一处显示错误：这里原来写的是 battle.opponentName，
   * 而那个名字是**发起者视角**的（= 应战者的名字）。
   * 应战者自己去看 .战斗 时，回执上写的是「你已经在等了 —— 乙应战者还没出招」，
   * 也就是**他自己的名字**。opponent 这个变量本来就是按 side 算出来的「我的对手」，
   * 用它才两边都对。
   */
  const foeName = opponent?.name ?? battle.opponentName ?? '对手';

  const opponentReply = (notice: string | null): Reply[] =>
    notice && opponent ? [{ scene: 'private', targetId: opponent.userId, text: notice }] : [];

  /* ---- 无参数 / 查看：摆自己这一回合的菜单 ---- */
  if (head === '' || head === '查看') {
    if (!myTurn) {
      /*
       * M2.11 前置 3：等待时给的不再是干巴巴的两句，而是**整块状态**。
       *
       * 原来那两句并没有写错，问题在于它**没回答玩家的下一个问题**：
       * 「那我现在能干嘛？」。M2.10 的 2 条 P1 就是从这里来的 ——
       * 玩家在等待期反复做别的事，而每一件都不改变状态。
       * 现在这一屏把「打到第几回合 / 双方还剩多少 / 他多久没动了 / 超时会发生什么」
       * 一次说清，玩家就不必去试「扮演还有没有用」。
       */
      const wait =
        pvpWaitBlock({ battle, character, now, foeName }) ?? [`你已经在等了 —— ${foeName}还没出招。`];
      return { privateText: wait.join('\n'), detailToPrivate: true };
    }
    const view = battleViewFor({
      battle,
      character,
      items: battleItemsOf(deps, character.id),
      // M2.85 C：技能池带上内容表（一百多条从原作能力派生的技能）
      skillIds: skillsFor(character.pathway, sequenceOrInitiate(character), deps.battleSkillTable).map((s) => s.id),
    });
    const opened = deps.pendingMenus.openWith(character.id, 'battle', buildBattleMenu(view), now);
    return {
      privateText: opened.text,
      detailToPrivate: true,
      menuOpened: true,
      interactive: opened.interactive,
    };
  }

  const parsed = parseBattleAction(head, rest, character, deps.battleSkillTable);
  if (!parsed.ok) return { privateText: parsed.reason, detailToPrivate: true };

  const seed = seedFrom([msg.messageId, character.id, now, 'pvp', battle.round]);
  const outcome = runPvpTurn({ deps, actor: character, battle, action: parsed.action, now, seed });

  if (outcome.kind === 'rejected') {
    /*
     * M2.11 前置 3：「还没轮到你」是**最容易被误判成 bug 的一句话**。
     * 玩家看到它只会想「那我现在干嘛」—— 所以这里紧跟一整块等待状态。
     * 其余的拒绝（旁观者 / 已经结束）不需要它：那时候没有「等待」可言。
     */
    const wait = outcome.error === '未轮到' ? pvpWaitBlockFor(deps, character, now) : null;
    return {
      privateText: [...outcome.lines, ...(wait ? ['', ...wait] : [])].join('\n'),
      detailToPrivate: true,
    };
  }
  const me = deps.characters.findById(character.id) ?? character;

  /* ---- 只是记下动作：等对方 ---- */
  if (outcome.kind === 'waiting') {
    /*
     * M2.11 前置 3：出招之后那一段等待，也要说清楚「现在是什么状况」。
     * 取的是**更新后**的战斗（runPvpTurn 已经把回合权交给了对方）——
     * 拿旧的 battle 去渲染，会写出「轮到你出招」这种让玩家反复点按钮的错话。
     */
    const wait = pvpWaitBlockFor(deps, me, now);
    return {
      privateText: [
        ...outcome.lines,
        '',
        ...(wait ?? [`（${foeName}回应之后，你们这一回合才会一起结算。）`]),
      ].join('\n'),
      detailToPrivate: true,
      extra: opponentReply(outcome.opponentNotice),
    };
  }

  /* ---- 结算了 ---- */
  const lines = [...outcome.lines];
  if (!outcome.finished) {
    const next = deps.battles.activeOf(character.id) ?? battle;
    if (sideOf(next, character.id) === next.turnOf) {
      const view = battleViewFor({ battle: next, character: me, items: battleItemsOf(deps, character.id) });
      const opened = deps.pendingMenus.openWith(character.id, 'battle', buildBattleMenu(view), now);
      return {
        privateText: [...lines, '', opened.text].join('\n'),
        detailToPrivate: true,
        menuOpened: true,
        interactive: opened.interactive,
        extra: opponentReply(outcome.opponentNotice),
      };
    }
    const wait = pvpWaitBlockFor(deps, me, now);
    lines.push('', ...(wait ?? ['现在轮到对方了 —— 等他出招。']));
    return { privateText: lines.join('\n'), detailToPrivate: true, extra: opponentReply(outcome.opponentNotice) };
  }

  // M2.90：PVP 收场同样推进仪式流程 —— 判据与 PVE 一致（收场一次，不是每回合一次）
  const flowLines = dailyFlowLines(deps, me, now, String(msg.messageId) + ':pvp');
  if (flowLines.length > 0) lines.push('', ...flowLines);
  return { privateText: lines.join('\n'), detailToPrivate: true, extra: opponentReply(outcome.opponentNotice) };
}

type ParsedAction = { ok: true; action: PlayerAction } | { ok: false; reason: string };

/** 玩家的输入 → 判定层的动作。所有「这一下能不能点」的检查都在这里 */
/**
 * 解析这一回合要做什么。
 *
 * M2.85 C：`skillTable` 是内容表（battle-skills.yaml）—— 不传也能跑（退回 numeric 那 44 个），
 * 传了才能用到那一百多条从原作能力派生的技能。
 */
export function parseBattleAction(
  head: string,
  rest: string,
  character: CharacterState,
  skillTable: readonly BattleSkill[] = [],
): ParsedAction {
  switch (head) {
    case '':
    case '查看':
      return { ok: false, reason: '这一回合你要做什么？\n' + BATTLE_USAGE };
    case '攻击':
      return { ok: true, action: { kind: 'attack' } };
    case '防御':
      return { ok: true, action: { kind: 'defend' } };
    case '认输': {
      // M2.10：PVP 特有的人工出口（PVE 里按它没有对手可认，命令层会挡回去）
      return { ok: true, action: { kind: 'surrender' } };
    }
    case '撤退': {
      return { ok: true, action: { kind: 'retreat' } };
    }
    case '技能': {
      // M2.85 C：技能名要能在**内容表**里查到（那里有一百多条）
      const skill = skillByName(rest, skillTable);
      if (!skill) {
        return { ok: false, reason: `没有这个技能：${rest}\n${BATTLE_USAGE}` };
      }
      if (!character.pathway || skill.pathway !== character.pathway) {
        return { ok: false, reason: `「${skill.name}」不是你那条途径的能力。` };
      }
      const sequence = character.sequence ?? 9;
      if (sequence > skill.seq) {
        // 「技能是解禁，不是升级」在玩家侧的说法
        return {
          ok: false,
          reason: `你还用不了「${skill.name}」—— 它是序列 ${skill.seq} 的能力，而你现在是序列 ${sequence}。`,
        };
      }
      if (character.mp < skill.mpCost) {
        return { ok: false, reason: `灵力不够：「${skill.name}」要 ${skill.mpCost}，你只剩 ${character.mp}。` };
      }
      return { ok: true, action: { kind: 'skill', skillId: skill.id } };
    }
    case '物品':
    case '使用': {
      if (!rest) return { ok: false, reason: '用哪一件？' };
      return { ok: true, action: { kind: 'item', itemId: rest } };
    }
    default:
      return { ok: false, reason: `不知道该做什么：${head}\n${BATTLE_USAGE}` };
  }
}

/**
 * 跑一个回合，然后把结果摆出来。
 *
 * 一整条链路只有这一处：判定（runBattleRound）→ 落库 → 回执 → 下一回合的菜单。
 * 命令层在这里做的只有三件事：造 seed、扣消耗品、拼文案。
 */
export function battleTurn(
  ctx: CommandContext,
  character: CharacterState,
  battle: import('../../domain/battle/types.ts').BattleState,
  action: PlayerAction,
): CommandResult {
  const { deps, msg, now } = ctx;

  /* ---- 物品：先确认真的有，再在回合跑完之后扣 ---- */
  if (action.kind === 'item') {
    const items = battleItemsOf(deps, character.id);
    const found = items.find((entry) => entry.itemId === action.itemId || entry.name === action.itemId);
    if (!found) {
      return {
        privateText: `背包里没有能用的「${action.itemId}」。\n` + BATTLE_USAGE,
        detailToPrivate: true,
      };
    }
    /*
     * M2.13：**封印物与消耗品不是同一类**（见 domain/item/item.ts 的注释）——
     * 同一句话（`.战斗 物品 封印之刃`）落到判定层时要走另一条路：
     *   消耗品 / 符咒 → `kind: 'item'`（用了之后**对面**怎么样），跑完扣 1 件；
     *   封印物        → `kind: 'extraordinary'`（这一下**我**怎么样），**不扣**（代价写在 sideEffect 里）。
     *
     * 分派点放在**这里**而不是解析器里：解析器只拿到一个字符串，
     * 它不认识 items 表 —— 让它去查库会把「判定层不认识内容表」这条纪律从后门打开。
     */
    const item = deps.items.get(found.itemId);
    action =
      item?.type === 'sealed'
        ? { kind: 'extraordinary', extraordinaryId: found.itemId }
        : { kind: 'item', itemId: found.itemId };
  }

  const seed = seedFrom([msg.messageId, character.id, now, 'battle', battle.round]);
  const outcome = runBattleRound({ deps, character, battle, action, now, seed, roundAt: now });
  const result = outcome.result;

  if (action.kind === 'item' && action.itemId) {
    deps.inventory.tryRemove(character.id, action.itemId, 1, now);
  }

  const lines: string[] = [];
  for (const event of result.events) lines.push(event.text);

  const over = isBattleOver(result.status);
  if (!over) {
    // 还有下一回合：把菜单摆出来（回执 = 本回合叙事 + 下一回合的选项）
    const view = battleViewFor({
      battle: result.battle,
      character: outcome.character,
      items: battleItemsOf(deps, character.id),
    });
    const opened = deps.pendingMenus.openWith(character.id, 'battle', buildBattleMenu(view), now);
    return {
      privateText: [...lines, '', opened.text].join('\n'),
      detailToPrivate: true,
      menuOpened: true,
      interactive: opened.interactive,
      menuNotes: [`第 ${result.round} 回合：${actionLabelOf(result.playerAction)} → ${outcome.creatureAction.label}`],
    };
  }

  /*
   * ---- 结束 ----
   *
   * M2.86：**胜负、掉落、代价三件事各自上色 + emoji**（用户：「上色的地方也少，
   * 该用 emoji 的也不要省」）。
   *
   * 这一屏是玩家最需要「一眼看清结果」的地方：赢了什么、输了什么、掉了什么。
   * 颜色（LaTeX）让人更快看见，emoji 保证颜色失效时分层还在 —— 两者叠加。
   */
  const bc = ctx.deps.supportsColor === true;
  const won = result.status === 'player_win';
  lines.push('');
  lines.push(outcomeLine(result.status, battle.speciesName));
  lines.push('');
  lines.push(
    withEmoji(EMOJI.battle,
      '【战斗结果】' + hl(BATTLE_OUTCOME_LABEL[result.status] ?? result.status, won ? 'gain' : 'danger', bc)
        + ' · ' + result.round + ' 回合'),
  );
  if (won) {
    lines.push(
      outcome.drops.length > 0
        ? withEmoji(EMOJI.money, '掉落：' + hl(outcome.drops.join('、'), 'gain', bc))
        : '它身上没有剩下什么可用的东西。',
    );
    lines.push(withEmoji(EMOJI.arcane, '消化度 +' + hl(String(BATTLE.rewards.digOnWin), 'gain', bc)));
  }
  if (result.status === 'player_lose') {
    // M2.85：不再有「行动点清空」这回事（行动值已删）
    lines.push('你被抬了回去。' + withEmoji(EMOJI.mind, '疯狂 +' + hl(String(BATTLE.rewards.madOnLose), 'danger', bc)));
  }
  if (result.status === 'stalemate') {
    lines.push('八回合打满，谁也没能按住谁 —— 没有奖励，也没有惩罚。');
  }

  /*
   * M2.90：**打完一场也算「在别处下的功夫」。**
   *
   * 输赢都算：sustain 的语义本来就是「在做别的事时反复判定」，而失败的分量
   * 这一场已经结算过了（疯狂、掉落、被抬走）—— 再叠加一次就是双重惩罚。
   * **每一回合不算**，只有收场这一下算：同一个回合里反复掷骰等于把一步拆成十步。
   */
  const flowLines = dailyFlowLines(deps, outcome.character, now, String(msg.messageId) + ':battle');
  if (flowLines.length > 0) lines.push('', ...flowLines);

  // 结束时的群内匿名播报（任务书 §4.3.7）：赢了说「打斗停了」，输了说「某人被抬走了」
  const groupText = groupTextFor(result.status);
  if (groupText) deps.broadcast?.(groupText);

  return finishResult(lines, groupText);
}

function actionLabelOf(action: PlayerAction): string {
  switch (action.kind) {
    case 'attack':
      return '攻击';
    case 'defend':
      return action.auto ? '防御（超时自动）' : '防御';
    case 'skill':
      return '技能';
    case 'item':
      return '物品';
    case 'retreat':
      return '撤退';
    default:
      return action.kind;
  }
}

const BATTLE_OUTCOME_LABEL: Readonly<Record<string, string>> = {
  player_win: '玩家胜',
  player_lose: '玩家败',
  stalemate: '僵持',
  fled: '玩家逃',
  creature_fled: '生物逃',
};

/**
 * 群内播报（任务书 §4.3.7）。
 *
 * **只有三种，而且都是匿名的。** 战斗不比仪式高调 ——
 * 「某处传来打斗声」让群里知道世界在动，但不告诉任何人是谁在打谁。
 * 僵持与逃跑**不播报**（表里没有），因为那两种结局没有值得让整群知道的后果。
 */
function groupTextFor(status: string): string | undefined {
  switch (status) {
    case 'player_win':
      return '某处的打斗停了。';
    case 'player_lose':
      return '某人被抬走了。';
    default:
      return undefined;
  }
}

/** 战斗菜单的入口（遭遇菜单与「下一步」菜单共用一份说明） */
export const BATTLE_ENTRY_LABEL = '动手';
export { createSeededRng, isBattleOver };
