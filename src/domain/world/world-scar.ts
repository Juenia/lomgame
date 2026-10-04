/**
 * **世界伤痕**（M2.169）—— 神明级事件在地上留下的东西（纯数据 + 纯函数）。
 *
 * 阴谋改了神座（谁坐在那儿），但那还是「神界的事」。玩家要感觉到它，
 * 就必须有**地上的痕迹** —— 而原作里这些痕迹是明写着的：
 *
 *   · 「陨落真神造成的污染物100克」「陨落于背叛的真神尸液3滴」（序列 1 配方的材料）
 *   · 神战遗迹里遗留「真实造物主呓语，以及黑夜、太阳、大地、空想、死神的神力」
 *
 * ## 为什么是「叠加」而不是「改内容」
 *
 * `locations.yaml` 是**内容**，每次 reload 都会被覆盖 —— 把伤痕写进它，
 * 下一次热重载就没了（而且不报错）。所以伤痕是**运行时的**，
 * 读取时与内容叠加：与 `npc_progress` / `divine_throne_state` 同一条口径。
 */
import type { LocationDef } from '../explore/location.ts';

export interface WorldScar {
  id: string;
  /** divine_fall（某位神陨落）/ god_war（神战痕迹） */
  kind: string;
  pathway: string;
  locationId: string;
  since: number;
  note: string;
  /** 叠加到内容的 danger 上（地点 schema 的上限是 5） */
  dangerBonus: number;
  /** 这里是不是变成了堕落源（与地点的 corruption_source 同一条判定） */
  corruption: boolean;
  /** 能捡到什么（空 = 不掉） */
  lootItem: string;
  lootChance: number;
}

/**
 * **把伤痕叠到地点上** —— 探索读的是这一份，而不是内容里那一份。
 *
 * 三样一起变（少了任何一样，「世界级后果」就只兑现了三分之一）：
 *   · danger               更危险（那地方出过事）
 *   · corruption_source    变成堕落源（神明陨落的地方会把人变成怪物）
 *   · loot                 多出原本拿不到的材料（陨落真神的残骸）
 *
 * 没有伤痕时**逐字返回原对象**（与加这一层之前逐位相同 —— 兼容性口径与全项目一致）。
 */
export function mergeScars(location: LocationDef, scars: readonly WorldScar[]): LocationDef {
  const here = scars.filter((scar) => scar.locationId === location.id);
  if (here.length === 0) return location;
  const dangerBonus = here.reduce((sum, scar) => sum + scar.dangerBonus, 0);
  const corruption = location.corruption_source || here.some((scar) => scar.corruption);
  const extraLoot = here
    .filter((scar) => scar.lootItem !== '' && scar.lootChance > 0)
    .map((scar) => ({
      itemId: scar.lootItem,
      // 权重口径与 locations.yaml 一致（那里的 weight 是整数权重）
      weight: Math.max(1, Math.round(scar.lootChance * 100)),
      minQty: 1,
      maxQty: 1,
      bindType: 'unbound' as const,
    }));
  return {
    ...location,
    danger: Math.max(0, Math.min(5, location.danger + dangerBonus)),
    corruption_source: corruption,
    loot: extraLoot.length === 0 ? location.loot : [...location.loot, ...extraLoot],
  };
}

/** 玩家读到的那一句（`.世界 <地点>` 与探索回执用它） */
export function scarLineOf(scar: WorldScar): string {
  return scar.note === '' ? '这里出过事。' : scar.note;
}
