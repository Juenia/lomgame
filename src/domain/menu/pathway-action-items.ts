/**
 * M2.65：**途径行动的物品侧** —— 消耗什么、产出什么。
 *
 * ## 为什么单独一个模块
 *
 * M2.29 的内容表里有五条行动写着 `consume: 1 / consume: 2`：
 * 秘偶代行（换一次免行动点的探索）、顺风（换移动折扣）、改装（产出改制品）、
 * 总装（产出合装件）、排程（换回一点行动点）。
 * 而 **`.行动` 一个字节都没读过 `consume`** —— 五条行动都是「白拿」。
 *
 * 这一份就是那个读取点：给定 **payload + 内容表 + 背包**，算出
 * 「扣哪几件、加哪几件」（纯函数，不碰数据库 —— 命令层拿这份清单去 `InventoryRepo` 执行）。
 *
 * ## 三个设计决定
 *
 * 1. **自动挑最不心痛的一件。** 点名的物品优先；没点名就按
 *    `材料 → 消耗品 → 杂物 → 魔药` 的顺序、同类按 id 排（同 seed 同结果）。
 *    **货币与封印物永不自动扣**（前者的单位是钱、后者是玩家的身家），点名才会动它们。
 * 2. **全有或全无。** 计划不成立就整条行动不发生 —— 与 `planRemovalMany` 同一条纪律，
 *    绝不做部分扣减。
 * 3. **改制品与合装件都是变体**（P16 已拍板，见 `docs/M2.31-P16落地.md`）：
 *    产物 id = `<原物品>#<变体>`，库里零迁移就能存。
 *    · 改制品 = 原物品上**没有 `from` 的变体**（拆开再装回去，只要它自己）；
 *    · 合装件 = **带 `from` 的变体**（还要把 `from` 指的那一件装上去，两件合一件）。
 */
import type { ItemDef } from '../item/item.ts';

export type ActionItemEffect = 'variant' | 'assemble';

/** 背包里的一格（只要 itemId 与数量 —— 绑定与否由 InventoryRepo 的规则决定） */
export interface ActionItemSlot {
  itemId: string;
  quantity: number;
}

export interface ActionItemPlan {
  /** false = 这次行动不该发生（含量不足 / 点名的东西不对） */
  ok: boolean;
  /** ok=false 时给玩家看的原因 */
  reason: string;
  /** 这一条 payload 落在哪个物品效果上（'' = 只消耗、不产出） */
  effect: '' | ActionItemEffect;
  /** 要扣掉的物品（**按 id 聚合**：同一种要两件就是一个 qty=2） */
  picks: Array<{ itemId: string; qty: number }>;
  /** 要加的物品（`bindType` 由计划给出：自己造出来的东西一律非绑定，可以拿去交易） */
  grants: Array<{ itemId: string; quantity: number; bindType: 'bound' | 'unbound' }>;
  /** 回执里那一句（说不出就不说） */
  text: string;
}

/** 计划不成立时统一从这几个出口返回，省得每个分支自己拼一份空清单 */
function fail(reason: string, effect: '' | ActionItemEffect = ''): ActionItemPlan {
  return { ok: false, reason, effect, picks: [], grants: [], text: '' };
}

function pass(input: {
  effect: '' | ActionItemEffect;
  picks: Array<{ itemId: string; qty: number }>;
  grants: Array<{ itemId: string; quantity: number; bindType: 'bound' | 'unbound' }>;
  text: string;
}): ActionItemPlan {
  return { ok: true, reason: '', ...input };
}

/** 交给计划函数的上下文（**全部是算好的纯数据**，计划函数不碰 IO） */
export interface ActionItemContext {
  /** 手上有货的物品 id（**已去重、已排序**） */
  held: readonly string[];
  /** 某件东西手上有几件 */
  countOf: (itemId: string) => number;
  /** 物品 id → 定义（含 `variants`；变体的定义也在表里，`baseId` 指向原物品） */
  byId: (itemId: string) => ItemDef | null;
  /** 玩家点名的物品 id（已经解析成 id；可以为空） */
  named: readonly string[];
}

type Planner = (ctx: ActionItemContext) => ActionItemPlan;

/** 一个变体是不是「改制品」（没有 `from` = 只要原物品自己就能改出来） */
function isRetrofitVariant(variant: { from?: string }): boolean {
  return variant.from === undefined || variant.from === '';
}

/**
 * **改制品**（`perfect.retrofit` 改装）。
 *
 * 产物 = 原物品上第一个没有 `from` 的变体。手上没有任何可改装的东西时**不硬造** ——
 * 那正是 K10 的形状（配置里写着、跑起来什么也没发生）。
 */
function planVariant(ctx: ActionItemContext): ActionItemPlan {
  const candidates = ctx.held.filter((id) => {
    const def = ctx.byId(id);
    return (def?.variants ?? []).some(isRetrofitVariant);
  });
  if (candidates.length === 0) {
    return fail('你手上没有能改装的东西 —— 改装要一件本身留有改造余地的物品。', 'variant');
  }
  let base = candidates[0]!;
  if (ctx.named.length > 0) {
    const wanted = ctx.named[0]!;
    if (!candidates.includes(wanted)) {
      return fail('「' + nameOf(ctx, wanted) + '」没法改装 —— 它身上没有可改的地方。', 'variant');
    }
    base = wanted;
  }
  const def = ctx.byId(base)!;
  const variant = (def.variants ?? []).find(isRetrofitVariant)!;
  const productId = base + '#' + variant.id;
  return pass({
    effect: 'variant',
    picks: [{ itemId: base, qty: 1 }],
    grants: [{ itemId: productId, quantity: 1, bindType: 'unbound' }],
    text: '你把它拆开，又换了个装法装回去 —— 现在它是「' + variant.name + '」。',
  });
}

/**
 * **合装件**（`perfect.assemble` 总装）。
 *
 * 判据只有一条：**每一条满足条件的 (原物品, 带 from 的变体)**，且两件都在手上。
 * 候选按 (原物品 id, 变体在表里的次序) 排 —— 同样的背包永远得到同样的产物。
 */
function planAssemble(ctx: ActionItemContext): ActionItemPlan {
  const rows: Array<{ base: string; from: string; productId: string; name: string }> = [];
  for (const base of ctx.held) {
    const def = ctx.byId(base);
    for (const variant of def?.variants ?? []) {
      const from = variant.from;
      if (from === undefined || from === '') continue;
      if (!ctx.held.includes(from)) continue;
      // 两件是同一件东西时，手上得真有两件（一件装不出一件）
      if (from === base && ctx.countOf(base) < 2) continue;
      rows.push({ base, from, productId: base + '#' + variant.id, name: variant.name });
    }
  }
  if (rows.length === 0) {
    return fail(
      '你手上这两件东西装不到一起 —— 总装要有可以互相装上的两件（一件物品上写着它能被谁装出来）。',
      'assemble',
    );
  }
  let pick = rows[0]!;
  if (ctx.named.length >= 2) {
    const a = ctx.named[0]!;
    const b = ctx.named[1]!;
    const hit = rows.find(
      (row) => (row.base === a && row.from === b) || (row.base === b && row.from === a),
    );
    if (!hit) {
      return fail('「' + nameOf(ctx, a) + '」和「' + nameOf(ctx, b) + '」装不到一起。', 'assemble');
    }
    pick = hit;
  } else if (ctx.named.length === 1) {
    const one = ctx.named[0]!;
    const hit = rows.find((row) => row.base === one || row.from === one);
    if (!hit) return fail('「' + nameOf(ctx, one) + '」没有可以配上的另一半。', 'assemble');
    pick = hit;
  }
  const picks = pick.base === pick.from
    ? [{ itemId: pick.base, qty: 2 }]
    : [{ itemId: pick.base, qty: 1 }, { itemId: pick.from, qty: 1 }];
  return pass({
    effect: 'assemble',
    picks,
    grants: [{ itemId: pick.productId, quantity: 1, bindType: 'unbound' }],
    text: '你把两件东西拆到只剩骨架，再装成一件 —— 「' + pick.name + '」。',
  });
}

/**
 * 物品落点 → 计划函数（**唯一出处**，K22）。
 *
 * ⚠️ 它同时是 `link-check` 的判据：`ACTION_FIELD_EFFECTS` 里 `to: 'item'` 的
 * `effect` 不在这张表里 ⇒ 报 error。查表与执行都走这一处，不会出现
 * 「登记了却没人实现」（K19）。
 */
export const ACTION_ITEM_PLANNERS: Readonly<Record<ActionItemEffect, Planner>> = {
  variant: planVariant,
  assemble: planAssemble,
};

function nameOf(ctx: ActionItemContext, itemId: string): string {
  return ctx.byId(itemId)?.name ?? itemId;
}

/**
 * 自动挑物的次序：**材料 → 消耗品 → 杂物 → 魔药**。
 *
 * 为什么不是「按 id 排就行」：那样 `.行动 顺风` 有可能一言不发地把一件封印物当掉。
 * 数字越小越先被挑走；同档之内按 id 排（同 seed 同结果）。
 * **货币与封印物不参与自动挑物** —— 点名才会动它们。
 */
const KIND_TIER: Readonly<Record<string, number>> = {
  material: 0,
  consumable: 1,
  trinket: 2,
  potion: 3,
};

/** 一件东西能不能被**自动**扣掉（点名不算自动） */
function autoPickable(def: ItemDef): boolean {
  if (def.kind === 'currency') return false;
  if (def.type === 'sealed') return false;
  return true;
}

/**
 * 算一份「这次行动要搬哪些东西」的清单。
 *
 * @param payload 行动的 `effect.payload`（**本函数是 `consume` / `variant` / `grant` 的读取点**）
 * @param items   内容表里的全部物品（`deps.items.all()`）
 * @param slots   背包（`deps.inventory.list(id)`）
 * @param named   玩家点名的物品**原文**（`.行动 改装 淬火匕首` 里的「淬火匕首」）
 */
export function planActionItems(input: {
  payload: Readonly<Record<string, unknown>>;
  items: readonly ItemDef[];
  slots: readonly ActionItemSlot[];
  named?: readonly string[];
}): ActionItemPlan {
  const { payload, items, slots } = input;
  const byIdMap = new Map(items.map((item) => [item.id, item]));
  const byId = (id: string): ItemDef | null => byIdMap.get(id) ?? null;

  const counts = new Map<string, number>();
  for (const slot of slots) {
    if (slot.quantity <= 0) continue;
    counts.set(slot.itemId, (counts.get(slot.itemId) ?? 0) + slot.quantity);
  }
  const held = [...counts.keys()].sort();
  const ctx: ActionItemContext = {
    held,
    countOf: (id) => counts.get(id) ?? 0,
    byId,
    named: [],
  };

  // 点名 → id（名字或 id 都认；两样都不认就是「你身上没有这件东西」）
  const namedIds: string[] = [];
  for (const query of input.named ?? []) {
    const text = query.trim();
    if (text === '') continue;
    const hit = items.find((item) => item.name === text || item.id === text);
    if (!hit) return fail('没有「' + text + '」这件东西。');
    if ((counts.get(hit.id) ?? 0) <= 0) return fail('你身上没有「' + hit.name + '」。');
    namedIds.push(hit.id);
  }
  const withNamed: ActionItemContext = { ...ctx, named: namedIds };

  /*
   * 落点：`grant: 'assembled'` 或 `variant: true`。
   * 两个键名是 M2.29 时代留下的（一条写 grant、一条写 variant），
   * **两种写法都要认** —— 只认一种会让另一种静默失效（K4 的老形状）。
   */
  const grant = typeof payload.grant === 'string' ? payload.grant : '';
  const effect: '' | ActionItemEffect =
    grant === 'assembled' ? 'assemble' : payload.variant === true || grant === 'variant' ? 'variant' : '';
  if (effect !== '') return ACTION_ITEM_PLANNERS[effect](withNamed);

  const want = Number(payload.consume ?? 0);
  const need = Number.isFinite(want) && want > 0 ? Math.floor(want) : 0;
  if (need === 0) return pass({ effect: '', picks: [], grants: [], text: '' });

  const picks: string[] = [];
  for (const id of namedIds) picks.push(id);
  if (picks.length > need) {
    return fail('这条行动只用得上 ' + need + ' 件东西，你点了 ' + picks.length + ' 件。');
  }
  if (picks.length < need) {
    const auto = held
      .filter((id) => !picks.includes(id))
      .filter((id) => {
        const def = byId(id);
        return def !== null && autoPickable(def);
      })
      .sort((left, right) => {
        const tl = KIND_TIER[byId(left)!.kind] ?? 9;
        const tr = KIND_TIER[byId(right)!.kind] ?? 9;
        if (tl !== tr) return tl - tr;
        return left < right ? -1 : left > right ? 1 : 0;
      });
    for (const id of auto) {
      if (picks.length >= need) break;
      // 同一件东西可以连扣两件（只要手上有那么多）
      const already = picks.filter((picked) => picked === id).length;
      if (ctx.countOf(id) > already) picks.push(id);
    }
  }
  if (picks.length < need) {
    return fail('这条行动要消耗 ' + need + ' 件东西，你身上可用的是 ' + picks.length + ' 件。');
  }
  const tally = new Map<string, number>();
  for (const id of picks) tally.set(id, (tally.get(id) ?? 0) + 1);
  return pass({
    effect: '',
    picks: [...tally.entries()].map(([itemId, qty]) => ({ itemId, qty })),
    grants: [],
    text: '你拿出' + picks.map((id) => '「' + nameOf(ctx, id) + '」').join('、') + '，把它用掉了。',
  });
}
