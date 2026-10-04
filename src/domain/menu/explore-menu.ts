/**
 * `.探索 地点` 的选项生成器（M2.3 任务一）。
 *
 * 纯函数：`(character, world, location, inventory) → Menu`。
 *
 * 一个必须说清楚的取舍：**.探索 的菜单不是「同一地点换几种说法」**。
 * 任务书 §3.5 的示例（搜索码头 / 深入仓库 / 沿着水边走走）如果全都映射到
 * `.探索 老码头`，三个选项在判定上完全等价 —— 那就是装饰，不是选项。
 * 所以这里把它们落成**真实存在的不同指令**：
 *   选项 1 = 当前地点；选项 2/3 = 危险度更高 / 更低的其它可达地点；
 *   选项 4 = 本条途径专属动作（愚者占卜 / 战士撞事件 / 不眠者先看天）。
 *
 * 关于「门途径专属：穿墙」：MVP 只开放 3 条途径（seer / warrior / sleepless），
 * 没有门途径。所以这一条按**同样的机制**落在现有三条途径上 —— 每个途径各有一条
 * 别人没有的探索前动作。**M2.29 起数据在 `pathway-actions.ts`**（独立表 + 统一触发接口），
 * 本文件只做投影 —— 加行动改那张表。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { dangerLabel } from '../explore/explore.ts';
import type { LocationDef } from '../explore/location.ts';
import { sequenceOrInitiate, type PathwayId } from '../character/types.ts';
import { TIME_OF_DAY_LABELS } from '../world/clock.ts';
import { weatherLabel, weatherRow, worldModifiers, type WeatherId } from '../world/weather.ts';
import { pathwayActionFor, type PathwayAction } from './pathway-actions.ts';
import {
  FREEFORM_KEY,
  inCurrentCity,
  type Item,
  type LocationView,
  type Menu,
  type MenuCharacter,
  type MenuOption,
  type WorldSnapshot,
} from './types.ts';

function pct(value: number): string {
  const delta = value * 100;
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}%`;
}

/** 该地点在此刻的世界里，探索危险被放大了多少（时段 × 雾日 × 该地点天气） */
function dangerMultiplier(world: WorldSnapshot, weather: WeatherId): number {
  return worldModifiers({ clock: world.clock, weather }).exploreDangerMultiplier;
}

/** 「危险 +20%（雾 +10%、夜晚 +10%）」里括号中的那一串 */
function dangerBreakdown(world: WorldSnapshot): string {
  const cfg = NUMERIC.world.timeOfDay;
  const parts: string[] = [];
  const time = cfg.exploreDangerMultiplier[world.clock.timeOfDay] ?? 1;
  if (time !== 1) parts.push(`${TIME_OF_DAY_LABELS[world.clock.timeOfDay]} ${pct(time - 1)}`);
  if (world.clock.foggy) parts.push(`雾日 ${pct(cfg.foggyExploreDangerMultiplier - 1)}`);
  const row = weatherRow(world.weather);
  if (row.exploreDanger !== 1) parts.push(`${row.label} ${pct(row.exploreDanger - 1)}`);
  return parts.join('、');
}

/**
 * 途径专属的「探索前动作」。key = 途径，值 = 一条**真实存在**的指令 + 说明。
 * 加新途径时只改这张表，生成器不用动。
 */
/**
 * 途径专属的「探索前动作」（M2.29 任务 2）。
 *
 * ⚠️ **数据已经搬到 `pathway-actions.ts`**（独立表 + 统一触发接口，P9/P11）。
 * 这里只剩一个**投影**：探索菜单要的是「这条途径此刻该显示哪一条行动」。
 *
 * 迁移是**零行为变化**的：7 条现状逐字搬过去，各补 `seq: 9` / `contexts: ['explore']` / `effect: { kind: 'none' }`，
 * 由 `test/m2-29-pathway-actions.test.ts` 断言「生成的指令与迁移前逐字一致」。
 */
function exploreActionOf(state: MenuCharacter): PathwayAction | null {
  if (!state.pathway) return null;
  // 序列缺省按 9 算（老角色没有 sequence 时的保守口径，与 menu 层其它地方一致）
  return pathwayActionFor(state.pathway, state.sequence ?? 9, 'explore');
}

/**
 * 探索菜单。
 *
 * @param state     角色卡（可带 dailyCounters / potions / isPartyLeader 等只读视图）
 * @param world     当前世界快照（含可达地点列表）
 * @param location  玩家想去的地点（内容表里的那一条）
 * @param inventory 背包（本次菜单里只用于判断「有没有东西可带」，不参与判定）
 */
export function buildExploreMenu(
  state: MenuCharacter,
  world: WorldSnapshot,
  location: LocationDef,
  inventory: readonly Item[],
): Menu {
  const options: MenuOption[] = [];
  const push = (option: Omit<MenuOption, 'key'>): void => {
    options.push({ ...option, key: String(options.length + 1) });
  };

  const usedHere =
    world.exploreUsedToday ?? state.exploreCounts?.[location.id] ?? 0;

  /* ---------- 1) 当前地点（标准） ---------- */
  push({
    label: `搜索${location.name}（掉落 ${location.loot.length} 种 · ${dangerLabel(location.danger)}）`,
    command: `探索 ${location.name}`,
    /*
     * M2.86：**软上限**（用户：「探索每日三次是不合理的机制」）。
     *
     * 原来到第 3 次就把这一项 `disabled`（「今天这里已经待满了」）——
     * 那等于换个说法继续拦。现在**照常可选**，只是把「越刷越亏」明说出来，
     * 让玩家自己决定值不值得再探一次。
     */
    preview: explorePreview(dangerMultiplier(world, world.weather), usedHere)
      + (usedHere >= NUMERIC.explore.dailyCapPerLocation ? '（收益已衰减）' : ''),
  });

  /* ---------- 2/3) 危险更高 / 更低的可达地点 ---------- */
  const known = world.locations ?? [];
  // M2.7：「深入 / 往 / 换个地方去」三个选项也只在**本城**里挑 ——
  // 否则玩家会看到一条通往别城的建议，点下去又被服务端挡回（体验最差的一种不一致）
  // M2.7.6：普通人按序列 9 参与地点准入
  const seq = sequenceOrInitiate(state);
  const open = (view: LocationView): boolean =>
    inCurrentCity(state, view) &&
    seq <= view.minSeq &&
    seq >= view.maxSeq &&
    view.id !== location.id &&
    (view.usedToday ?? 0) < NUMERIC.explore.hardCapPerLocation;

  const higher = known
    .filter((view) => open(view) && view.danger > location.danger)
    .sort((a, b) => b.danger - a.danger || b.lootCount - a.lootCount)[0];
  const lower = known
    .filter((view) => open(view) && view.danger < location.danger)
    .sort((a, b) => a.danger - b.danger || b.lootCount - a.lootCount)[0];
  // 两边都没有（例如已经在最危险的地方、或者只剩同级地点）：用「没去过的地方」兜底，
  // 保证菜单至少给玩家一个「换地方」的出口 —— 任务书 §3.5 的 0 号选项就是这个意思。
  const fallback =
    higher ?? lower
      ? null
      : known.filter((view) => open(view) && view.danger === location.danger)[0];

  const locationOption = (
    view: LocationView,
    verb: string,
    tag: string,
    extra?: string,
  ): void => {
    const weather = view.weather ?? world.weather;
    push({
      label: `${verb}${view.name}（${tag} · ${weatherLabel(weather)} · 掉落 ${view.lootCount} 种）`,
      command: `探索 ${view.name}`,
      // M2.90 修：这里原来把 `view.usedToday ?? 0` 写成了**字面量**（漏了 ${}），
      // 玩家在菜单里看到的就是那串 JS 源码：「今日已探 view.usedToday ?? 0 次」。
      preview: explorePreview(dangerMultiplier(world, weather), view.usedToday ?? 0) + (extra ?? ''),
    });
  };

  let placed = 1;
  if (higher) {
    locationOption(higher, '深入', `危险 ${dangerLabel(higher.danger)}`);
    placed += 1;
  }
  if (lower && placed < NUMERIC.menu.exploreLocationCount) {
    locationOption(lower, '往', `危险 ${dangerLabel(lower.danger)}`);
    placed += 1;
  }
  if (fallback && placed < NUMERIC.menu.exploreLocationCount) {
    locationOption(fallback, '换个地方去', `危险 ${dangerLabel(fallback.danger)}`);
    placed += 1;
  }

  /* ---------- 4) 途径专属动作（任务书里的「门途径穿墙」位） ---------- */
  // M2.7.6：普通人没有途径，也就没有「用能力做这件事」这一项
  const action = exploreActionOf(state);
  if (action) {
    const short = action.needs === 'mp' && state.mp < NUMERIC.divination.mpCost;
    push({
      label: action.label(location.name),
      command: action.command(location.name),
      preview: action.preview,
      ...(short ? { disabled: '灵性不足' } : {}),
    });
  }

  /* ---------- 5) 有队友 → 协作（队伍任务消耗 1 AP，全员分赃） ---------- */
  const partySize = state.partySize ?? 1;
  const taskUsed = state.dailyCounters?.['party_task'] ?? 0;
  if (partySize >= NUMERIC.party.teamCardThreshold && state.isPartyLeader === true) {
    push({
      label: `和队友一起做一趟任务（${partySize} 人）`,
      command: '队伍 任务',
      preview: '全员分赃',
      ...(taskUsed >= NUMERIC.party.taskDailyLimit ? { disabled: '今天已经做过队伍任务了' } : {}),
    });
  }

  // 探索菜单的 inventory 目前只用于「背包是不是空的」这一句上下文（判定一个字都不碰）
  const bagNote = inventory.length === 0 ? '背包是空的' : `背包 ${inventory.length} 格`;
  const breakdown = dangerBreakdown(world);
  const multiplier = dangerMultiplier(world, world.weather);

  return {
    title: `【探索 · ${location.name} · ${weatherLabel(world.weather)} · ${TIME_OF_DAY_LABELS[world.clock.timeOfDay]}】`,
    context: [
      `危险 ${pct(multiplier - 1)}${breakdown ? `（${breakdown}）` : ''} · ` +
        `今日已探 ${usedHere} 次 · ${bagNote}`,
    ],
    options,
    allowFreeform: true,
  };
}

/**
 * 探索项的那句括号（M2.122）。
 *
 * ⚠️ **没意义的部分不显示**：`危险 ×1.00` 说的是「和平时一样」，`今日已探 0 次` 说的是
 * 「今天还没来过」—— 两条都是**默认值**，摆在选项上只是噪音。
 * 用户的原话：「**多余的解释也不要**」。
 *
 * 于是：危险只在**不等于 1** 时出现，次数只在**大于 0** 时出现；两者都没有就整个括号不要。
 */
function explorePreview(danger: number, usedToday: number): string {
  const parts: string[] = [];
  if (Math.abs(danger - 1) > 1e-9) parts.push(`危险 ×${danger.toFixed(2)}`);
  if (usedToday > 0) parts.push(`今日已探 ${usedToday} 次`);
  return parts.length > 0 ? `（${parts.join(' · ')}）` : '';
}
