/**
 * .移动（M2.7 主任务三）：跨城市移动。
 *
 * 一条指令，三种形态 —— 这是有意的：玩家只需要记住「.移动」两个字。
 *
 *   .移动                  看可去的地方（原生按钮：目的地 + 花费 + 时长 + 危险）
 *   .移动 贝克兰德          出发（校验 → 扣钱扣 AP → 规划路途事件 → 上路）
 *   .移动 抉择 战斗         处理路上撞见的事（按钮点下去发出的也是这条指令）
 *
 * 四条设计约定：
 *   1. **移动本身是一段内容**（任务书 §5.3）：上路就立刻呈现第一个事件，
 *      而不是「你走了 8 小时，到了」。其余事件按计划时刻触发 ——
 *      任何一条指令前都会先结算「已经到点」的那一件（见 arrival.ts）。
 *   2. **到达是惰性的**：不依赖定时器。玩家下次发任何指令时 requireCharacter 会先跑
 *      settleArrival —— 世界 tick、压测、实例测试都没有「按时醒来」的保证，
 *      靠定时器会让「到没到」取决于服务器有没有重启过。
 *   3. **在路上不能做需要「在地」的事**：探索 / 扮演 / 晋升 / 仪式 / 袭击会被挡回，
 *      只放行查看类指令与处理路途事件本身。拦截点在路由层（一处生效、不会漏）。
 *   4. **付了钱就一定上路**：AP 扣不动时把钱退回去 —— 否则玩家会白白损失一趟路费，
 *      而那种 bug 在实例测试里表现为「钱莫名少了」，极难复查。
 */
import type { Menu } from '../../domain/menu/types.ts';
import { EMOJI, withEmoji } from '../../domain/emoji.ts';
import { renderMenu } from '../../domain/menu/render.ts';
import {
  TRAVEL_CHOICE_LABELS,
  choicesOf,
  resolveTravelChoice,
  travelEventDef,
  type TravelChoiceId,
} from '../../domain/geo/index.ts';
import { effectiveRouteDanger, planTravel } from '../../domain/geo/travel.ts';
import { CURRENCY_ITEM_ID } from '../../domain/item/item.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import { newTravelId } from '../../infra/ids.ts';
import { sequenceOrInitiate } from '../../domain/character/types.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { pendingTravelEvent, settleArrival, travelProgressText } from './arrival.ts';
import { applyFor, GROUP_MENU_HINT, requireCharacter, today } from './common.ts';
import { actionMarkFlag, travelApDiscountOf } from '../../domain/menu/pathway-action-resolve.ts';
import { renderDeltaSummary } from './render.ts';

export const MOVE_USAGE = '用法：.移动 <目的地>（例：.移动 贝克兰德）；不带参数看可去的地方';

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * 路途事件的选择菜单。
 *
 * ⚠️ 返回的是 Menu（要落 pending_menus），不是裸的 InteractiveMessage。
 * 为什么：玩家点按钮 / 回数字之后，服务端要能从 pending_menus 里查出「第 2 项是什么」——
 * 不落库的话 player 回数字只会得到「菜单已过期」，
 * 而**所有路途事件都会被到达时的自动结算按「观察」处理**（第一版就是这么错的，
 * 后果是 61 个事件的应对分布清一色是 observe，等于「移动中的选择」根本不存在）。
 */
export function travelEventMenu(
  eventId: Parameters<typeof travelEventDef>[0],
  title: string,
  body: string,
): Menu {
  return {
    title,
    context: [body],
    options: choicesOf(eventId).map((choice, index) => ({
      key: String(index + 1),
      label: TRAVEL_CHOICE_LABELS[choice],
      command: `移动 抉择 ${choice}`,
    })),
    allowFreeform: false,
  };
}

/** 目的地菜单：从当前城市出发的每一条路线一个选项 */
function destinationMenu(ctx: CommandContext): { menu: Menu; count: number } {
  const { deps } = ctx;
  const character = deps.characters.findByUserId(ctx.msg.userId);
  const cityId = character?.currentCityId ?? null;
  if (!character || !cityId) {
    const menu: Menu = {
      title: '【移动】',
      context: ['你还没有落脚的城市 —— 先发 .今日 看看自己在哪。'],
      options: [],
      allowFreeform: false,
    };
    return { menu, count: 0 };
  }
  const city = deps.geo.city(cityId);
  const routes = deps.geo.routesFrom(cityId);
  const wallet = deps.inventory.count(character.id, CURRENCY_ITEM_ID);
  const lines = [
    `【移动 · 从${city?.name ?? cityId}出发】`,
    `口袋 ${wallet} 便士 · 序列 ${character.sequence}`,
  ];
  const options: Menu['options'] = [];
  for (const route of routes) {
    const target = deps.geo.city(route.to);
    const reasons: string[] = [];
    if (wallet < route.cost_penny) reasons.push(`钱不够（差 ${route.cost_penny - wallet} 便士）`);
    if (route.type === 'sea' && !city?.is_port) reasons.push('这里不是港口');
    // M2.7.6：普通人按序列 9 参与城市准入
    if (target && sequenceOrInitiate(character) > target.min_seq) {
      reasons.push(`需要序列 ${target.min_seq} 以内`);
    }
    const label = `${target?.name ?? route.to}（${route.type === 'sea' ? '海路' : '陆路'} ${route.duration_hours}h）`;
    /*
     * M2.71：预览里的危险必须与**实际判定用的**是同一个数
     *（区域危险度已经折进去了，见 effectiveRouteDanger）——
     * 否则玩家按预览做决定、系统按另一个数结算，那是「文案与机制各说各话」的老形状。
     */
    const effectiveDanger = effectiveRouteDanger(route.danger, deps.geo.regionOfCity(route.to)?.danger ?? null);
    options.push({
      key: String(options.length + 1),
      label,
      command: `移动 ${target?.name ?? route.to}`,
      preview: `${route.cost_penny} 便士 · 危险 ${effectiveDanger.toFixed(2)} · ${deps.geo.regionName(route.to)}`,
      ...(reasons.length > 0 ? { disabled: reasons[0]! } : {}),
    });
  }
  if (options.length === 0) lines.push('这里没有任何一条路通往别处。');
  return {
    menu: { title: lines[0]!, context: lines.slice(1), options, allowFreeform: false },
    count: options.length,
  };
}

/** 处理玩家对路途事件的选择 */
function resolveChoice(ctx: CommandContext, choiceRaw: string): CommandResult {
  const { deps, now } = ctx;
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const pending = pendingTravelEvent(deps, gate.character.id, now);
  if (!pending) return { privateText: '你现在没有需要处理的事。', detailToPrivate: true };

  const choice = choiceRaw as TravelChoiceId;
  if (!pending.choices.includes(choice)) {
    const allowed = pending.choices.map((entry) => TRAVEL_CHOICE_LABELS[entry]).join(' / ');
    return { privateText: `这件事不能这么应对。可以：${allowed}`, detailToPrivate: true };
  }

  const route = deps.routes.get(pending.travel.routeId);
  const seed = seedFrom([ctx.msg.messageId, gate.character.id, now, 'travel-choice']);
  /*
   * M2.71：**区域危险度折进这条路**（Region.danger 的落点）。
   * 读的是**目的地**所在区域 —— 见 effectiveRouteDanger 的注释。
   */
  const regionDanger = route === null ? null : (deps.geo.regionOfCity(route.to)?.danger ?? null);
  const result = resolveTravelChoice({
    eventId: pending.eventId,
    choice,
    routeDanger: effectiveRouteDanger(route?.danger ?? 0.3, regionDanger),
    rng: createSeededRng(seedFrom([seed, 'roll'])),
  });
  const applied = applyFor(deps, gate.character, result.deltas, `旅途抉择:${pending.eventId}`, now, seed);
  deps.characters.update(applied.newState);
  deps.characters.appendEvents(applied.events);

  pending.record.resolved = true;
  pending.record.choice = choice;
  pending.record.outcome = result.outcome;
  pending.travel.events = pending.travel.events.map((entry) =>
    entry.at === pending.record.at && entry.id === pending.record.id ? pending.record : entry,
  );
  deps.travels.update(pending.travel);

  // M2.86：路途事件标题带 ⚠️ —— 这一屏是「路上出事了」
  const lines = [`${EMOJI.danger} 【${pending.label} · ${TRAVEL_CHOICE_LABELS[choice]}】`, ...result.narrative];
  // 变化按方向配色（绿 ▲ 涨 / 红 ▼ 跌）—— 开关来自 deps，这一层没有局部变量
  const deltas = renderDeltaSummary(applied.events, deps.supportsColor === true, (id) => deps.items.nameOf(id));
  if (deltas.length > 0) lines.push('', ...deltas);
  lines.push('', travelProgressText(deps, pending.travel, now));
  return {
    privateText: lines.join('\n'),
    detailToPrivate: true,
    menuNotes: [`路途事件：${pending.label} → ${result.outcome}`],
  };
}

/** 出发 */
function depart(ctx: CommandContext, destinationRaw: string): CommandResult {
  const { deps, now, msg } = ctx;
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const cityId = character.currentCityId ?? null;
  if (!cityId) return { privateText: '你还没有落脚的城市。', detailToPrivate: true };

  const here = deps.geo.city(cityId);
  const reachable = deps.geo.routesFrom(cityId).map((route) => deps.geo.city(route.to)?.name ?? route.to);
  const target = deps.geo.cityByNameOrId(destinationRaw);
  if (!target) {
    return { privateText: `没有叫「${destinationRaw}」的地方。从这里能去：${reachable.join('、') || '（无）'}`, detailToPrivate: true };
  }
  if (target.id === cityId) return { privateText: `你已经在${target.name}了。`, detailToPrivate: true };

  const route = deps.geo.route(cityId, target.id);
  if (!route) {
    return { privateText: `从${here?.name ?? cityId}没有直接去${target.name}的路。能去的：${reachable.join('、') || '（无）'}`, detailToPrivate: true };
  }
  if (route.type === 'sea' && !here?.is_port) {
    return { privateText: `${here?.name ?? cityId}不是港口，走不了海路。`, detailToPrivate: true };
  }
  const seq = sequenceOrInitiate(character);
  if (seq > target.min_seq) {
    return { privateText: `${target.name}不是序列 ${seq} 能踏足的地方。`, detailToPrivate: true };
  }

  const wallet = deps.inventory.count(character.id, CURRENCY_ITEM_ID);
  if (wallet < route.cost_penny) {
    return {
      // M2.86：用 💰 标出这是「钱的问题」—— 一眼知道该去攒钱还是换目的地
      privateText: withEmoji(EMOJI.money, `去${target.name}要 ${route.cost_penny} 便士，你只有 ${wallet}。`),
      detailToPrivate: true,
    };
  }
  /*
   * M2.85：行动值机制移除 —— 移动不再扣点，也不再需要「顺风」那条行动点折扣
   * （M2.65 的 travelDiscount 标记一并下线）。
   */
  if (!deps.inventory.tryRemove(character.id, CURRENCY_ITEM_ID, route.cost_penny, now)) {
    return { privateText: '钱不够。', detailToPrivate: true };
  }
  const seed = seedFrom([msg.messageId, character.id, now, 'travel-plan']);

  const state = character;
  const plan = planTravel({ route, now, rng: createSeededRng(seedFrom([seed, 'plan'])) });
  const travelId = newTravelId(character.id, now);
  deps.travels.create({
    id: travelId,
    characterId: character.id,
    routeId: route.id,
    startedAt: now,
    arrivesAt: plan.arrivesAt,
    status: 'traveling',
    events: plan.events.map((entry) => ({ id: entry.id, at: entry.at, resolved: false })),
  });
  deps.characters.update(state);
  deps.characters.appendEvents([
    {
      type: 'travel_start',
      characterId: character.id,
      payload: {
        travelId,
        routeId: route.id,
        from: route.from,
        to: route.to,
        costPenny: route.cost_penny,
        hours: route.duration_hours,
        events: plan.events.map((entry) => entry.id),
      },
      reason: `移动:${route.from}->${route.to}`,
      seed,
      createdAt: now,
    },
  ]);

  const hoursToArrive = (plan.arrivesAt - now) / MS_PER_HOUR;
  const result: CommandResult = {
    privateText: [
      withEmoji(EMOJI.world, `你踏上了去${target.name}的路`)
        + `（${route.type === 'sea' ? '海路' : '陆路'} ${route.duration_hours} 小时，${route.cost_penny} 便士）。`,
      withEmoji(EMOJI.time, `${hoursToArrive} 小时后抵达`) + `；路上安排了 ${plan.events.length} 件事。`,
    ].join('\n'),
    groupText: `【${state.name}】动身前往${target.name}。`,
    detailToPrivate: true,
    menuNotes: [`移动：${here?.name ?? cityId} → ${target.name}`],
  };

  const first = plan.events[0];
  if (first) {
    const def = travelEventDef(first.id);
    // 菜单**必须落 pending_menus**：玩家回数字时服务端要能查出「第 2 项是什么」。
    // openWith 同时给出文本与结构化选项 —— 两者是同一件事的两种形态，不会说两样话。
    const opened = deps.pendingMenus.openWith(
      character.id,
      'travel',
      travelEventMenu(first.id, `【路上 · ${def.label}】`, def.text),
      now,
    );
    result.privateText = `${result.privateText}\n\n${opened.text}`;
    result.interactive = opened.interactive;
    result.menuOpened = true;
  }
  return result;
}

export async function handleMove(ctx: CommandContext): Promise<CommandResult> {
  const { deps, now } = ctx;
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;

  // 先结算到期的行程：玩家可能正是在到达之后才想起再走一趟
  const settled = settleArrival(deps, gate.character, now);
  const lines = [...settled.lines];

  const arg = ctx.args.join(' ').trim();
  if (arg.startsWith('抉择')) return resolveChoice(ctx, arg.replace(/^抉择\s*/, '').trim());

  const active = deps.travels.activeOf(settled.character.id);
  if (active) {
    const pending = pendingTravelEvent(deps, settled.character.id, now);
    if (pending) {
      const def = travelEventDef(pending.eventId);
      const opened = deps.pendingMenus.openWith(
        settled.character.id,
        'travel',
        travelEventMenu(pending.eventId, `【路上 · ${def.label}】`, def.text),
        now,
      );
      return {
        privateText: [...lines, opened.text].filter(Boolean).join('\n\n'),
        detailToPrivate: true,
        interactive: opened.interactive,
        menuOpened: true,
      };
    }
    return {
      privateText: [...lines, travelProgressText(deps, active, now)].filter(Boolean).join('\n\n'),
      detailToPrivate: true,
    };
  }

  if (!arg) {
    const menu = destinationMenu(ctx);
    if (menu.count === 0) {
      return { privateText: renderMenu(menu.menu), detailToPrivate: true };
    }
    const opened = deps.pendingMenus.openWith(settled.character.id, 'travel', menu.menu, now);
    return {
      privateText: opened.text,
      detailToPrivate: true,
      interactive: opened.interactive,
      menuOpened: true,
    };
  }
  return depart(ctx, arg);
}

export { GROUP_MENU_HINT, MOVE_USAGE as MOVE_USAGE_EXPORT };
