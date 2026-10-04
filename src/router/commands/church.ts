/**
 * 教会三件套（M2.16）：\`.加入教会 <id>\` / \`.教会\` / \`.教会 捐献 <金额>\`。
 *
 * ## 为什么是一条指令 + 一条子指令，而不是三条
 *
 * \`.教会\` 是**玩家的教会入口**（未入教时它列出本地能入的教会，已入教时它是身份页），
 * \`捐献\` 是它唯一的动作 —— 做成子指令而不是 \`.捐献\`，是因为捐献离开教会没有意义，
 * 而且顶级指令表已经很长了（\`.帮助\` 一屏放不下更多）。
 * \`.加入教会\` 才是顶级指令：它要能被**别人告诉你的 id** 直接触发
 * （\`night_goddess\` 这种 id 不是玩家猜得出来的，社区里传的就是 \`.加入教会 xxx\` 这一串）。
 *
 * ## 这一层的纪律
 *
 * 判定全在 \`domain/church/membership.ts\`（纯函数），这里只做三件事：
 * 读库、把它们拼起来、落库 + 记事件。
 * \`church_contribute\` 与 \`church_rank_up\` 的 \`seed\` 一律 **\`null\`** ——
 * 捐献与晋档都是确定性的，不掷骰（铁律 6）。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { CURRENCY_ITEM_ID } from '../../domain/item/item.ts';
import { formatCurrency } from '../../domain/currency/index.ts';
import {
  canDonate,
  canJoin,
  checkRankUp,
  contribute,
  currentRank,
  nextRankOf,
  rankNameOf,
} from '../../domain/church/membership.ts';
import type { ChurchDef } from '../../domain/church/schema.ts';
import type { CharacterState, DomainEvent } from '../../domain/character/types.ts';
import type { CommandContext, CommandResult, RouterDeps } from '../index.ts';
import { parsePositiveInt } from '../args.ts';
import { requireCharacter } from './common.ts';

export const CHURCH_USAGE =
  '用法：.教会（看教会）｜ .加入教会 <教会 id> ｜ .教会 捐献 <金额>';

export const CHURCH_DONATE_USAGE = '用法：.教会 捐献 <金额>（单位：便士）';

/** 捐献冷却的键（走既有的 cooldowns 表，不新增结构） */
const DONATE_COOLDOWN_KEY = '教会捐献';

/** 把毫秒说成人话（回执用）。只到小时，不追求精确 —— 玩家要看的是「还要等多久」 */
function formatRemaining(ms: number): string {
  const hours = Math.ceil(ms / (60 * 60 * 1000));
  return hours >= 24 ? Math.ceil(hours / 24) + ' 天' : hours + ' 小时';
}

/** 玩家此刻所在城市（id + 中文名） */
function cityOf(deps: RouterDeps, character: CharacterState): { id: string | null; name?: string } {
  const id = character.currentCityId ?? null;
  if (!id) return { id: null };
  const city = deps.geo.city(id);
  return { id, ...(city ? { name: city.name } : {}) };
}

/**
 * 这座城市里**与他途径对应**的正神教会。
 *
 * 空数组有两种成因，回执要把它们分开说（M2.16 的 \`seer\` 专属验收就落在这里）：
 *   1. 这座城里没有任何正神教会（玩家的途径还没做出教会）；
 *   2. 有教会，但途径对不上。
 */
function joinableChurches(deps: RouterDeps, character: CharacterState): ChurchDef[] {
  const { id } = cityOf(deps, character);
  if (!id || !character.pathway) return [];
  return deps.churches.churchesOfCity(id).filter((church) => church.pathway === character.pathway);
}

/* ==================== .加入教会 ==================== */

export async function handleJoinChurch(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const { deps, now } = ctx;

  const churchId = ctx.args.join(' ').trim();
  if (!churchId) {
    return {
      privateText: '用法：.加入教会 <教会 id>\n' + offerText(deps, character),
      detailToPrivate: true,
    };
  }
  const church = deps.churches.byId(churchId);
  if (!church) {
    return {
      privateText: '没有叫「' + churchId + '」的教会。\n\n' + offerText(deps, character),
      detailToPrivate: true,
    };
  }

  const city = cityOf(deps, character);
  const check = canJoin(character, church, { cityId: city.id, ...(city.name ? { cityName: city.name } : {}) });
  if (!check.ok) {
    return { privateText: '【入教 · ' + church.name + '】\n\n' + check.reason, detailToPrivate: true };
  }

  const state: CharacterState = {
    ...character,
    churchId: church.id,
    churchContribution: character.churchContribution ?? 0,
    updatedAt: now,
  };
  deps.characters.update(state);
  deps.characters.appendEvents([
    {
      // M2.85：**入教让同一条路上的人认你**（交好的第一条正路）
      ...(() => {
        for (const disp of ctx.deps.npcDispositions) {
          if (church.pathway !== null && disp.pathways.includes(church.pathway)) ctx.deps.npcRelations.bump(disp.npcId, character.id, 5, now);
        }
        return [];
      })(),
      type: 'church_join',
      characterId: character.id,
      payload: { churchId: church.id, cityId: city.id },
      reason: '入教:' + church.id,
      // 入教是确定性判定（五条判据全过才允许），不掷骰 —— 显式 null，不是 undefined
      seed: null,
      createdAt: now,
    },
  ]);

  const lines: string[] = [];
  lines.push('【入教 · ' + church.name + '】');
  lines.push('');
  lines.push(church.dogma);
  lines.push('');
  lines.push('你成了' + rankNameOf(church, 0) + '。');
  if (church.taboos.length > 0) {
    lines.push('');
    lines.push('要记住的：');
    // M2.17：taboos 从字符串数组变成对象数组（多了 id / when / penalty），回执念的是 text
    for (const taboo of church.taboos) lines.push('· ' + taboo.text);
  }
  lines.push('');
  lines.push('.教会 看身份｜.教会 捐献 <金额> 捐钱换贡献');

  return {
    privateText: lines.join('\n'),
    groupText: '【' + state.name + '】在' + (city.name ?? '城里') + '的' + church.name + '受了洗。',
    detailToPrivate: true,
  };
}

/* ==================== .教会 ==================== */

export async function handleChurch(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;

  const sub = (ctx.args[0] ?? '').trim();
  if (sub === '捐献' || sub === '捐') return handleDonate(ctx, character);
  if (sub) {
    return { privateText: '没有这个子命令。\n' + CHURCH_USAGE, detailToPrivate: true };
  }
  return showChurch(ctx, character);
}

function showChurch(ctx: CommandContext, character: CharacterState): CommandResult {
  const { deps } = ctx;
  const churchId = character.churchId ?? null;

  if (!churchId) {
    return { privateText: offerText(deps, character), detailToPrivate: true };
  }
  const church = deps.churches.byId(churchId);
  if (!church) {
    // 内容表改过名 / 删过教会时的兜底：不能让玩家卡在一个查不到的 id 上
    return {
      privateText: '你的教会（' + churchId + '）已经不在内容表里了 —— 这不该发生，请联系管理员。',
      detailToPrivate: true,
    };
  }

  const contribution = character.churchContribution ?? 0;
  const rank = currentRank(character, church);
  const lines: string[] = [];
  lines.push('【' + church.name + ' · ' + rankNameOf(church, rank) + '】');
  lines.push('');
  lines.push('贡献 ' + contribution + ' 点');

  const next = nextRankOf(character, church);
  if (next === null) {
    lines.push('你已经在最高一档。');
  } else {
    lines.push('');
    lines.push('下一档：' + next.name + '（需要贡献 ' + next.contribution + ' 点，序列 ' + next.sequence + '）');
    if (next.missingContribution > 0) {
      const penny = next.missingContribution * NUMERIC.church.donation.pennyPerContribution;
      lines.push('　还差 ' + next.missingContribution + ' 点（约 ' + formatCurrency(penny) + '）');
    } else {
      lines.push('　贡献已经够了。');
    }
    if (!next.sequenceOk) {
      // 「贡献够、序列不够」是这一版最容易卡住人的地方 —— 回执必须说清楚差在哪
      lines.push('　但你的序列还不够（要 ' + next.sequence + '，你现在是 ' + (character.sequence ?? 9) + '）。');
      lines.push('　（序列升上来之后，每天结算时会自动认这一档。）');
    }
  }
  lines.push('');
  lines.push('· .教会 捐献 <金额> —— 每日一次，10 便士 = 1 点贡献');
  return { privateText: lines.join('\n'), detailToPrivate: true };
}

/** 未入教时的「这里有什么」文案。**\`seer\` 玩家会走到最后那一支**（M2.16 的专属验收） */
function offerText(deps: RouterDeps, character: CharacterState): string {
  const city = cityOf(deps, character);
  const lines: string[] = [];

  if (!character.pathway) {
    lines.push('你还没有走上任何途径，谈信仰还早。');
    lines.push('');
    lines.push('.线索 看看手上有没有翻到过配方线索；还没有的话，去 .探索。');
    return lines.join('\n');
  }

  lines.push('你还没有入教。');
  lines.push('');
  lines.push('当前城市：' + (city.name ?? city.id ?? '（还没有落脚的城市）'));

  const joinable = joinableChurches(deps, character);
  if (joinable.length === 0) {
    /*
     * 这一支是 M2.16 的**专属验收回执**：走 seer 途径的玩家（占出生权重 80）
     * 在七正神里没有落点 —— 他该看到的是「这里没有你的教会」，
     * 而不是「你条件不够」。前者是设计，后者是故障。
     */
    lines.push('');
    lines.push('当前城市没有与你途径对应的正神教会。');
    lines.push('先找到自己的路：.探索 翻线索，.线索 看手上的纸。');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('这座城市里，与你的途径对应的正神教会：');
  for (const church of joinable) {
    lines.push('');
    lines.push('· ' + church.name + '（' + church.id + '）');
    lines.push('　' + church.dogma);
    lines.push('　.加入教会 ' + church.id);
  }
  lines.push('');
  lines.push('一个人只能属于一家，且没有退出的路。想清楚再发。');
  return lines.join('\n');
}

/* ==================== .教会 捐献 ==================== */

function handleDonate(ctx: CommandContext, character: CharacterState): CommandResult {
  const { deps, now } = ctx;

  const churchId = character.churchId ?? null;
  if (!churchId) {
    return {
      privateText: '你还没有入教。先看看 .教会，再 .加入教会 <教会 id>。',
      detailToPrivate: true,
    };
  }
  const church = deps.churches.byId(churchId);
  if (!church) {
    return {
      privateText: '你的教会（' + churchId + '）已经不在内容表里了 —— 这不该发生，请联系管理员。',
      detailToPrivate: true,
    };
  }

  const remaining = deps.cooldowns.remainingMs(
    character.id,
    DONATE_COOLDOWN_KEY,
    NUMERIC.church.donation.cooldownMs,
    now,
  );
  if (remaining > 0) {
    return {
      privateText: '今天已经捐过了。' + formatRemaining(remaining) + '之后再来。',
      detailToPrivate: true,
    };
  }

  const amount = parsePositiveInt(ctx.args[1] ?? '');
  if (amount === null || amount === undefined) {
    return { privateText: CHURCH_DONATE_USAGE, detailToPrivate: true };
  }

  const penny = deps.inventory.count(character.id, CURRENCY_ITEM_ID);
  const check = canDonate(
    { churchId, churchContribution: character.churchContribution ?? 0, penny },
    church,
    amount,
  );
  if (!check.ok) return { privateText: check.reason, detailToPrivate: true };

  // 先扣钱：扣不动就什么都不做（与 .确认 的交易结算同一顺序：钱先走）
  if (!deps.inventory.tryRemove(character.id, CURRENCY_ITEM_ID, amount, now)) {
    return { privateText: '你的钱不够了。', detailToPrivate: true };
  }
  deps.cooldowns.touch(character.id, DONATE_COOLDOWN_KEY, now);

  const before = currentRank(character, church);
  const delta = contribute(amount, character.churchContribution ?? 0);
  const state: CharacterState = { ...character, churchContribution: delta.total, updatedAt: now };
  const up = checkRankUp(state, church, before);
  deps.characters.update(state);

  const events: DomainEvent[] = [
    {
      type: 'church_contribute',
      characterId: character.id,
      payload: {
        churchId: church.id,
        penny: amount,
        contribution: delta.contribution,
        // 这一条事件**自洽**：不必 JOIN 下一条 church_rank_up 才知道升了没
        rankBefore: before,
        rankAfter: up.to,
        // 哪一处触发的（另一处是每日结算）—— 报告要能分开数
        source: 'donate',
      },
      reason: '捐献:' + church.id,
      seed: null, // 捐献是确定性换算，不掷骰（铁律 6）
      createdAt: now,
    },
  ];
  if (up.canUp) {
    events.push({
      type: 'church_rank_up',
      characterId: character.id,
      payload: { churchId: church.id, fromRank: up.from, toRank: up.to, source: 'donate' },
      reason: '教内晋升:' + church.id,
      seed: null,
      createdAt: now,
    });
  }
  deps.characters.appendEvents(events);

  const lines: string[] = [];
  lines.push('【捐献 · ' + church.name + '】');
  lines.push('');
  const remainder = amount % NUMERIC.church.donation.pennyPerContribution;
  lines.push('你投下 ' + formatCurrency(amount) + '，执事记下了你的名字。');
  lines.push(
    '贡献 +' + delta.contribution + '（共 ' + delta.total + ' 点）' +
      (remainder > 0 ? '　零头 ' + remainder + ' 便士不计。' : ''),
  );

  if (up.canUp) {
    lines.push('');
    lines.push('教会认可了你的付出 —— 你现在是' + rankNameOf(church, up.to) + '。');
  } else {
    const next = nextRankOf(state, church);
    if (next && next.missingContribution > 0) {
      lines.push('');
      lines.push('离' + next.name + '还差 ' + next.missingContribution + ' 点贡献。');
    }
    if (next && next.missingContribution === 0 && !next.sequenceOk) {
      lines.push('');
      lines.push('贡献够了，但序列还差一截（要 ' + next.sequence + '）—— 序列升上来之后每日结算会自动认。');
    }
  }

  return {
    privateText: lines.join('\n'),
    groupText: '【' + state.name + '】往' + church.name + '的捐献箱里投了一笔钱。',
    detailToPrivate: true,
  };
}
