/**
 * `.装备栏` / `.装备 <物品>` / `.卸下 <槽位>`（M2.85 RPG 化 B）。
 *
 * 四个槽位：武器（命中/伤害）、防具（HP/防御）、护符（失控/腐蚀抗性）、遗物（灵力/消化）。
 * 每个槽位只能有一件 —— 换装就是覆盖，这与「一个人不可能同时穿两件外套」是一回事。
 *
 * ⚠️ 本轮先做「装上 / 卸下 / 查看」，装备的**掉落与购买**是下一步（现在按名字直接装）。
 */
import type { CommandContext, CommandResult } from '../index.ts';
import { requireCharacter } from './common.ts';
import { formatCurrency } from '../../domain/currency/currency.ts';
import { shelfPriceOf } from '../../domain/economy/shop.ts';
import { priceOfItem } from '../../domain/economy/price.ts';
import { purseOf } from './shop.ts';
import {
  EQUIPMENT_SLOTS, QUALITY_LABELS, SEAL_LEVEL_LABELS, SLOT_LABELS, canEquip, debuffLine, statsLine, totalDebuffs, totalStats,
  type Equipment, type EquipmentSlot,
} from '../../domain/item/equipment.ts';

/**
 * **装备标价的兜底表**（项目派生）：按封印等级给。0 级 = `null` = **买不到**。
 *
 * ⚠️ M2.87：这份表**已经从 `prices.yaml` 搬过去了**（见那里的 `sealLevelPrice`）。
 * 这里保留它**只作为兜底** —— 物价表读不到时（文件坏了）用它，
 * 而正常路径一律走 `priceOfEquipment`。
 *
 * 为什么不直接删：删了之后「物价表读不到」这个场景会变成「装备全都买不了」，
 * 而那是把一个小故障放大成一个大故障。
 */
const PRICES_FALLBACK: Record<string, number | null> = { '0': null, '1': 500, '2': 200, '3': 60, unrated: 30 };

/**
 * 一件装备卖多少钱（`null` = 买不到）。
 *
 * 优先读 `prices.yaml` 的 `sealLevelPrice` —— 那是运营能改的地方（AGENTS §3.3：
 * 调价不该需要改代码）。读不到才退回本文件的兜底表。
 *
 * 抽成函数是因为**两个地方要问同一个问题**：`.买` 要报「多少钱」，
 * `.装备` 在没有这件东西时要提示「可以 .买，多少钱」——
 * 两处各写一遍，改一次价就会有一处忘了跟。
 */
function priceOfEquipment(ctx: CommandContext, item: Equipment): number | null {
  const table = ctx.deps.prices?.sealLevelPrice.prices ?? null;
  if (table === null) return PRICES_FALLBACK[item.level] ?? 30;
  const hit = table[item.level];
  return hit === undefined ? (table['unrated'] ?? 30) : hit;
}

function findEquipment(ctx: CommandContext, key: string): Equipment | null {
  const list = ctx.deps.equipmentTable;
  return (
    list.find((e) => e.id === key) ??
    list.find((e) => e.name === key) ??
    list.find((e) => e.name.startsWith(key)) ??
    list.find((e) => e.name.includes(key)) ??
    null
  );
}

function wornOf(ctx: CommandContext, characterId: string): Equipment[] {
  const byId = new Map(ctx.deps.equipmentTable.map((e) => [e.id, e]));
  return ctx.deps.equipment.of(characterId).map((s) => byId.get(s.equipmentId)).filter((e): e is Equipment => e !== undefined);
}

export async function handleEquipment(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const want = ctx.args.join(' ').trim();
  // ⚠️ CommandContext 里没有「正在跑哪条命令」这个字段 —— 三条指令共用一个 handler，
  //    所以从原始文本里取第一个词（.卸下 x 的第一个词就是「卸下」）。
  const invoked = (ctx.msg.rawText ?? '').trim().replace(/^[.。]/, '').split(/[\s　]+/)[0] ?? '';
  const byId = new Map(ctx.deps.equipmentTable.map((e) => [e.id, e]));
  const slots = ctx.deps.equipment.of(character.id);

  /* ---------------- .买 <名字>：用便士换一件 ---------------- */
  if (invoked === '买') {
    /*
     * M2.87：**先查商店，再查装备表。**
     *
     * 在这之前 `.买` 只能买装备，而且价格硬编码在 `PRICES` 里（本文件第 21 行）——
     * 也就是说「商店」这个概念当时只存在于这一个分支里，玩家也没法买日用品。
     *
     * 现在的顺序：
     *   ① 当前地点的商店货架上有没有它 → 按货架价买（普通物品，进背包）；
     *   ② 没有 → 是装备表里的吗 → 按 `prices.yaml` 的封印等级价买；
     *   ③ 都没有 → 说清「这家店不卖」，并指出哪里有店。
     *
     * ⚠️ **顺序不能反**：货架价是运营写在 YAML 里的（可以「这家卖得贵」），
     * 装备价是全局派生值 —— 具体的那一个更该赢。
     */
    const here = ctx.deps.shops.find((s) => s.locationId === (character.currentLocationId ?? '')) ?? null;
    const prices = ctx.deps.prices;
    if (here !== null && prices !== null) {
      const entry = here.stock.find((s) => ctx.deps.items.nameOf(s.itemId) === want || s.itemId === want);
      if (entry !== undefined) {
        const goods = ctx.deps.itemIndex.get(entry.itemId) ?? null;
        const kind = goods?.kind ?? '';
        const seq = kind === 'material' || kind === 'potion' ? 9 : undefined;
        const priced = priceOfItem(prices, { id: entry.itemId, kind }, seq);
        const shelf = shelfPriceOf(entry, priced);
        const label = ctx.deps.items.nameOf(entry.itemId);
        if (shelf === null) return { privateText: here.name + ' 不卖 ' + label + '。', detailToPrivate: true };
        const purse = purseOf(ctx, character.id);
        if (purse < shelf) {
          return {
            privateText: '钱不够：' + label + ' 要 ' + formatCurrency(shelf) + '，你只有 ' + formatCurrency(purse) + '。',
            detailToPrivate: true,
          };
        }
        const taken = ctx.deps.inventory.tryRemoveMany(character.id, [{ itemId: '便士', qty: shelf }], ctx.now);
        if (!taken) return { privateText: '钱不够。', detailToPrivate: true };
        ctx.deps.inventory.add(character.id, entry.itemId, 1, 'unbound', ctx.now);
        return {
          privateText: [
            '你花了 ' + formatCurrency(shelf) + '，把它带走了。',
            '> ' + here.name + ' 的老板连头都没抬。',
            '',
            '现在你带着 ' + formatCurrency(purseOf(ctx, character.id)) + '。',
          ].join('\n'),
          nextActions: [
            { label: '再买一个', command: '买 ' + label },
            { label: '继续逛', command: '商店' },
            { label: '翻翻背包', command: '背包' },
          ],
          detailToPrivate: true,
        };
      }
    }

    /* ---- 不是货架上的：看它是不是装备 ---- */
    const item = findEquipment(ctx, want);
    if (item === null) {
      /*
       * 找不到时要说清**两种可能**：这东西不存在，或者这家店不卖。
       * 只说「没有叫 X 的东西」会让玩家以为名字打错了 —— 而其实他可能在别的城市见过。
       */
      const where = here === null ? '这里' : here.name;
      return {
        privateText:
          '没有叫「' + want + '」的东西。' +
          (here === null ? '\n（' + where + '没有店铺 —— 发 .商店 看看哪里有。）' : '\n（' + where + ' 的货架上也没有它。）'),
        detailToPrivate: true,
        nextActions: here === null ? [{ label: '找商店', command: '商店' }] : [{ label: '看货架', command: '商店' }],
      };
    }
    /*
     * 装备价从 `prices.yaml` 的 `sealLevelPrice` 读 —— 不再硬编码。
     * 这一条是 AGENTS §3.3 的直接体现：调价是运营动作，不该需要改代码。
     */
    const price = priceOfEquipment(ctx, item);
    if (price === null) return { privateText: item.name + '不是钱能买到的东西。', detailToPrivate: true };
    if (ctx.deps.equipment.owns(character.id, item.id)) return { privateText: '你已经有一件了。', detailToPrivate: true };
    const purse2 = purseOf(ctx, character.id);
    if (purse2 < price) {
      return { privateText: '钱不够：' + item.name + ' 要 ' + formatCurrency(price) + '，你只有 ' + formatCurrency(purse2) + '。', detailToPrivate: true };
    }
    const taken2 = ctx.deps.inventory.tryRemoveMany(character.id, [{ itemId: '便士', qty: price }], ctx.now);
    if (!taken2) return { privateText: '钱不够。', detailToPrivate: true };
    ctx.deps.equipment.acquire(character.id, item.id, 'shop', ctx.now);
    return {
      /*
       * M2.100：**别再往玩家脸上糊原文**（用户：「装备的模板没删信息尾」）。
       *
       * 原来这里 `item.negativeEffects[0]` 是**整段照抄**的 —— 而那一栏在原作里
       * 可能是一长串分号列举（有 5 条、200 多字的），装备栏那一处（第 184 行）
       * 早就截到 60 字了，两处口径不一致。
       *
       * `item.text.trim()` 也是同一件事：数据里有 18 条 text 末尾没有句读，
       * 不 trim 就会拼出「……血迹。\n\n代价：」这种尾巴上多一层的形状。
       */
      privateText: '你花了 ' + formatCurrency(price) + '，把它带了回来。\n\n' + item.name + '\n' + item.text.trim() +
        '\n\n代价：' + debuffLine(item.debuffs) +
        (item.negativeEffects.length > 0 ? '\n' + item.negativeEffects[0]!.slice(0, 60) : ''),
      nextActions: [
        { label: '装备它', command: '装备 ' + item.name },
        { label: '看看装备栏', command: '装备栏' },
      ],
      detailToPrivate: true,
    };
  }

  /* ---------------- 空参数：看装备栏 ---------------- */
  if (want === '') {
    const worn = slots.map((s) => byId.get(s.equipmentId)).filter((e): e is Equipment => e !== undefined);
    const lines: string[] = [`【${character.name} 的装备栏】`];
    for (const slot of EQUIPMENT_SLOTS) {
      const item = worn.find((e) => e.slot === slot);
      if (item === undefined) lines.push('  ' + SLOT_LABELS[slot] + '：（空）');
      else {
        lines.push('  ' + SLOT_LABELS[slot] + '：' + item.name + '（' + SEAL_LEVEL_LABELS[item.level] + '）｜' + statsLine(item.stats));
        // 代价必须与加成同时显示 —— 只看得到好处的装备栏是不诚实的
        lines.push('     代价：' + debuffLine(item.debuffs));
        if (item.negativeEffects.length > 0) lines.push('     ' + item.negativeEffects[0]!.slice(0, 60));
      }
    }
    // M2.85 B（重做）：**手里的**与**身上的**分开 —— 没有这一层，「获得」就没有落点
    const owned = ctx.deps.equipment.ownedOf(character.id).map((id) => byId.get(id)).filter((x): x is Equipment => x !== undefined);
    const spare = owned.filter((x) => !worn.some((w) => w.id === x.id));
    if (spare.length > 0) {
      lines.push('', '手里还有（未装备）：');
      for (const s of spare.slice(0, 6)) lines.push('  · ' + s.name + '（' + SLOT_LABELS[s.slot] + ' · ' + SEAL_LEVEL_LABELS[s.level] + '）');
    }
    const total = totalStats(worn, character);
    lines.push('', '合计加成：' + statsLine(total));
    // ⚠️ 代价也一起算：这是「增幅 / 代价」的权衡，藏起来等于把设计抹掉
    lines.push('合计代价：' + debuffLine(totalDebuffs(worn)));
    lines.push('', '换装：.装备 <物品名>｜卸下：.卸下 <槽位>');
    return { privateText: lines.join('\n'), detailToPrivate: true };
  }

  /* ---------------- 卸下 ---------------- */
  const slotArg = EQUIPMENT_SLOTS.find((s) => SLOT_LABELS[s] === want || s === want);
  if (invoked === '卸下' || slotArg !== undefined) {
    const slot = slotArg ?? (findEquipment(ctx, want)?.slot);
    if (slot === undefined) return { privateText: `没有这个槽位：${want}。四个槽位是武器 / 防具 / 护符 / 遗物。`, detailToPrivate: true };
    const removed = ctx.deps.equipment.unequip(character.id, slot);
    if (removed === null) return { privateText: `${SLOT_LABELS[slot]}本来就是空的。`, detailToPrivate: true };
    const item = byId.get(removed);
    return { privateText: `卸下了 ${SLOT_LABELS[slot]}：${item?.name ?? removed}。`, detailToPrivate: true };
  }

  /* ---------------- 装备 ---------------- */
  const item = findEquipment(ctx, want);
  if (item === null) return { privateText: `没有叫「${want}」的装备。`, detailToPrivate: true };
  const allowed = canEquip(item, character);
  if (!allowed.ok) return { privateText: allowed.reason ?? '装不上。', detailToPrivate: true };
  // M2.85 B（重做）：**只能装备你手里有的** —— 否则装备就是凭空变出来的
  if (!ctx.deps.equipment.owns(character.id, item.id)) {
    const price = priceOfEquipment(ctx, item);
    return {
      privateText:
        '你手里没有「' + item.name + '」。' +
        (price === null
          ? '它是被封印在教堂底下的东西，不是钱能买到的。'
          : '（可以 .买 ' + item.name + ' —— ' + formatCurrency(price) + '。）'),
      detailToPrivate: true,
      // 提示里给了「可以 .买」，那就顺手给个按钮 —— 说了能做，就该能点
      ...(price !== null ? { nextActions: [{ label: '买' + item.name.slice(0, 5), command: '买 ' + item.name }] } : {}),
    };
  }
  ctx.deps.equipment.equip(character.id, item.slot, item.id, ctx.now);
  const worn = wornOf(ctx, character.id);
  return {
    privateText:
      `${character.name} 换上了 ${item.name}（${SLOT_LABELS[item.slot]} · ${QUALITY_LABELS[item.quality]}）。\n` +
      `${item.text}\n` +
      `加成：${statsLine(item.stats)}\n` +
      // ⚠️ 代价必须与加成一并给出 —— 用户拍板的规则是「有增幅，但也有 debuff」
      `代价：${debuffLine(item.debuffs)}\n` +
      (item.negativeEffects.length > 0 ? `${item.negativeEffects[0]!.slice(0, 60)}\n` : '') +
      (allowed.reason === undefined ? '' : `${allowed.reason}\n`) +
      `\n合计：${statsLine(totalStats(worn, character))}`,
    detailToPrivate: true,
  };
}
