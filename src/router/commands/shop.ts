/**
 * `.商店` / `.卖` —— 在当前地点买卖（M2.87 交易体系）。
 *
 * ## 为什么要有这条命令
 *
 * 在这之前项目里没有商店：`.买` 只能买装备、价格硬编码在 `equipment.ts` 里，
 * 而**玩家不知道自己能买什么** —— 他得先猜到物品名才能发指令。
 *
 * 用户的要求：「减少复杂的指令互动，多利用按钮和文本指令按钮」。
 * 所以这里**每件货给一个按钮**，点一下就买，不用打物品名。
 *
 * ## 一个商店就是一个地点
 *
 * 走到哪儿买到哪儿，没有「打开商店界面」这一步 —— 地点本身就是界面，
 * 与 `.探索 咸鱼市场` 是同一个心智模型。
 */
import { formatCurrency } from '../../domain/currency/currency.ts';
import { SHOP_KIND_LABELS, shelfPriceOf } from '../../domain/economy/shop.ts';
import { priceOfItem } from '../../domain/economy/price.ts';
import { applyPriceFactor, priceFactorAt } from '../../domain/world/authority-effects.ts';

/**
 * **当地权柄的物价倍率**（M2.88，读不到就是 1）。
 *
 * 抽成模块级函数而不是在每个分支里各写一遍：本文件有**三处**要问同一个问题
 * （列货架 / 列可卖的 / 卖指定的那一件），而它们分布在两个函数里 ——
 * 各写一遍的下场是改一处忘一处。
 *
 * 取法与本文件其余部分对地点的取法一致：先 `currentLocationId`，再退 `currentCityId`。
 */
function localPriceFactor(ctx: CommandContext, character: CharacterState): number {
  return priceFactorAt(
    ctx.deps.world,
    character.currentLocationId ?? character.currentCityId ?? null,
    ctx.now,
  );
}
import { hl } from '../../adapter/highlight.ts';
import { EMOJI, withEmoji } from '../../domain/emoji.ts';
import { requireCharacter } from './common.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import type { CharacterState } from '../../domain/character/types.ts';

/** 卖出价：买价的 60%（向下取整，最低 1 便士）—— 与 `domain/economy/price.ts` 同一个数 */
const SELL_RATIO = 0.6;

/** 钱包：背包里的便士总数 */
export function purseOf(ctx: CommandContext, characterId: string): number {
  return ctx.deps.inventory
    .list(characterId)
    .filter((slot) => slot.itemId === '便士')
    .reduce((sum, slot) => sum + slot.quantity, 0);
}

export async function handleShop(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const c = ctx.deps.supportsColor === true;
  // ⚠️ 字段可能是 undefined（老号 / 未初始化）—— 用空串走「这里没有店」那条路
  const here = character.currentLocationId ?? '';
  const shop = ctx.deps.shops.find((s) => s.locationId === here) ?? null;
  const prices = ctx.deps.prices;

  /* ---------------- 这里没有店 ---------------- */
  if (shop === null) {
    /*
     * 「没有店」也要说清下一步 —— 静默失败是这个项目里最难查的一类毛病
     * （用户报过「点了没反应」，那是同一类问题的另一种表现）。
     */
    const name = ctx.deps.locations.get(here)?.name ?? '这里';
    const elsewhere = ctx.deps.shops.slice(0, 4);
    return {
      privateText: [
        withEmoji(EMOJI.place, `【${name}】没有店铺。`),
        '',
        '城里有店的地方：',
        ...elsewhere.map((s) => '  ' + (ctx.deps.locations.get(s.locationId)?.name ?? s.locationId) + '（' + SHOP_KIND_LABELS[s.kind] + '）'),
        '',
        '走到那里再发一次 .商店 —— 或者点下面的按钮直接过去。',
      ].join('\n'),
      nextActions: elsewhere.slice(0, 3).map((s) => {
        const label = ctx.deps.locations.get(s.locationId)?.name ?? s.locationId;
        return { label: '去' + label.slice(0, 4), command: '移动 ' + label };
      }),
      detailToPrivate: true,
    };
  }

  /* ---------------- 有店：列货架 ---------------- */
  const lines: string[] = [
    withEmoji(EMOJI.money, `【${shop.name}】`) + ' · ' + SHOP_KIND_LABELS[shop.kind],
    '> ' + shop.keeper,
    '> ' + shop.greeting,
    '',
  ];
  const actions: Array<{ label: string; command: string; preview?: string }> = [];

  const priceFactor = localPriceFactor(ctx, character);
  if (prices === null) {
    lines.push('（物价表读不到 —— 暂时没法做买卖。）');
  } else {
    const purse = purseOf(ctx, character.id);
    for (const entry of shop.stock) {
      const item = ctx.deps.itemIndex.get(entry.itemId) ?? null;
      const kind = item?.kind ?? '';
      const seq = kind === 'material' || kind === 'potion' ? 9 : undefined;
      const priced = priceOfItem(prices, { id: entry.itemId, kind }, seq);
      const base = shelfPriceOf(entry, priced);
      if (base === null) continue;
      /*
       * M2.88：**当地权柄的物价倍率**。
       *
       * 「大地母神滋长」⇒ 东西便宜，「深渊堕落」⇒ 收取代价 ⇒ 东西更贵。
       * 这是让权柄「摸得到」的一处 —— 玩家不用读播报，看价签就知道这地方不对。
       */
      const shelf = applyPriceFactor(base, priceFactor);
      const label = ctx.deps.items.nameOf(entry.itemId);
      const afford = purse >= shelf;
      /*
       * 买不起的**照样列出来**，只是上个警示色 —— 藏起来的话玩家不知道
       * 「这里到底有没有」，而那正是他进这家店的原因。
       */
      lines.push('  ' + (afford ? '' : '· ') + label + '  ' + hl(formatCurrency(shelf), afford ? 'info' : 'warn', c));
      actions.push({
        label: '买' + label.slice(0, 5),
        command: '买 ' + label,
        preview: formatCurrency(shelf) + (afford ? '' : '（钱不够）'),
      });
    }
    lines.push('', '你带着 ' + hl(formatCurrency(purse), 'gain', c) + '。');
  }

  return {
    privateText: lines.join('\n'),
    /*
     * 每件货一个按钮（上限 4 —— 菜单层的约定，也是群里一屏放得下的量）。
     * 货比 3 件多时只给前 3 个按钮，但**店里那一行照样印着它的价**，不是藏起来的。
     */
    nextActions: [...actions.slice(0, 3), { label: '看看状态', command: '状态' }],
    detailToPrivate: true,
  };
}

/** `.卖`：把背包里的一件换成钱。`priceOfItem` → 打六折 → 进便士 */
export async function handleSell(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const want = ctx.args.join(' ').trim();
  const c = ctx.deps.supportsColor === true;
  const prices = ctx.deps.prices;
  if (prices === null) return { privateText: '物价表读不到 —— 暂时没法买卖。', detailToPrivate: true };

  // 便士本身不能卖（它是钱）；其余都列出来
  const slots = ctx.deps.inventory.list(character.id).filter((s) => s.itemId !== '便士');
  if (slots.length === 0) return { privateText: '你身上没有可以卖的东西。', detailToPrivate: true };

  /* ---------------- 空参数：列出来，每件一个「卖 XXX」按钮 ---------------- */
  if (want === '') {
    const lines: string[] = [withEmoji(EMOJI.bag, '【可以卖的】'), ''];
    const actions: Array<{ label: string; command: string; preview?: string }> = [];
    const priceFactor = localPriceFactor(ctx, character);
    for (const slot of slots.slice(0, 8)) {
      const item = ctx.deps.itemIndex.get(slot.itemId) ?? null;
      const kind = item?.kind ?? '';
      const seq = kind === 'material' || kind === 'potion' ? 9 : undefined;
      const priced = priceOfItem(prices, { id: slot.itemId, kind }, seq);
      if (priced.penny <= 0) continue;
      const label = ctx.deps.items.nameOf(slot.itemId);
      const sell = Math.max(1, Math.floor(applyPriceFactor(priced.penny, priceFactor) * SELL_RATIO));
      lines.push('  ' + label + ' ×' + slot.quantity + '  ' + hl(formatCurrency(sell), 'gain', c));
      if (actions.length < 3) {
        actions.push({ label: '卖' + label.slice(0, 5), command: '卖 ' + label, preview: '得 ' + formatCurrency(sell) });
      }
    }
    lines.push('', '行情是买价的六成 —— 收旧货的人也要吃饭。');
    return {
      privateText: lines.join('\n'),
      nextActions: [...actions, { label: '翻翻背包', command: '背包' }],
      detailToPrivate: true,
    };
  }

  /* ---------------- 指定了物品 ---------------- */
  const slot = slots.find((s) => ctx.deps.items.nameOf(s.itemId) === want || s.itemId === want);
  if (slot === undefined) return { privateText: `你身上没有「${want}」。`, detailToPrivate: true };
  const priceFactor = localPriceFactor(ctx, character);
  const item = ctx.deps.itemIndex.get(slot.itemId) ?? null;
  const kind = item?.kind ?? '';
  const seq = kind === 'material' || kind === 'potion' ? 9 : undefined;
  const priced = priceOfItem(prices, { id: slot.itemId, kind }, seq);
  const label = ctx.deps.items.nameOf(slot.itemId);
  if (priced.penny <= 0) return { privateText: label + ' 没人收。', detailToPrivate: true };
  const sell = Math.max(1, Math.floor(priced.penny * SELL_RATIO));
  const removed = ctx.deps.inventory.tryRemoveMany(character.id, [{ itemId: slot.itemId, qty: 1 }], ctx.now);
  if (!removed) return { privateText: '东西不在手上了。', detailToPrivate: true };
  // 便士是 `unbound`：钱不该有绑定状态（`add` 的第 4 个参数就是 bindType）
  ctx.deps.inventory.add(character.id, '便士', sell, 'unbound', ctx.now);
  return {
    privateText: [
      withEmoji(EMOJI.money, '你把 ' + label + ' 卖掉了。'),
      '> 对方掂了掂，没还价 —— ' + hl(formatCurrency(sell), 'gain', c) + '。',
      '',
      '现在你带着 ' + hl(formatCurrency(purseOf(ctx, character.id)), 'gain', c) + '。',
    ].join('\n'),
    nextActions: [
      { label: '继续卖', command: '卖' },
      { label: '逛商店', command: '商店' },
      { label: '看看状态', command: '状态' },
    ],
    detailToPrivate: true,
  };
}
