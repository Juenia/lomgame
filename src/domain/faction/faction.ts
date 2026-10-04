/**
 * 势力（M2.6）：**纯函数 + 常量，无 IO**。
 *
 * 势力回答一个很具体的问题：**玩家此刻站的地方，归谁管**。
 * 这个问题是通缉系统的地基 —— 「势力范围内被盘查」「逃到无主地点就安全」
 * 全靠它。所以它被抽成一个只读 `NUMERIC.factionTerritory` 的模块，
 * 命令层、判定层、报告脚本都从同一处取，不允许任何地方再写一遍地点名单。
 *
 * 四个势力（任务书 §主任务一）：
 *   police 警察厅 —— 廷根市、贝克兰德、蒸汽车站。通缉后追捕最积极
 *   church 教会   —— 黑荆棘修道院、烛火书店。通缉后可净化惩罚（M2.7）
 *   gang   黑帮   —— 老码头、无光地下室。通缉后可贿赂（M2.7）
 *   none   无主   —— 灰雾之上、墓园小径、封存档案室、迷雾街区。**安全区，永远不追捕**
 *
 * `none` 既是一个「势力」（数据上要能落库、能在 wanted_states 里留痕），
 * 又是「没有任何势力」的语义。这里用 `isWildOf(factionId)` 把两者说清楚，
 * 免得后人把 `factionId === 'none'` 当成"没有通缉"来写。
 */
import { NUMERIC } from '../../config/numeric.ts';

export type FactionId = 'police' | 'church' | 'gang' | 'none';

export type FactionType = 'police' | 'church' | 'gang' | 'none';

export interface Faction {
  id: FactionId;
  name: string;
  type: FactionType;
  /** 控制的地点 id（对应 src/data/locations.yaml 的 id，不是中文名） */
  territory: string[];
}

/** 无主势力的 id。它的语义是「没有任何人管」，不是「第四个帮派」 */
export const WILD_FACTION_ID: FactionId = 'none';

/** 固定顺序：报告与落库都按它来，保证同一份数据每次渲染都一样 */
export const FACTION_IDS: readonly FactionId[] = ['police', 'church', 'gang', 'none'];

const TERRITORY = NUMERIC.factionTerritory;
const META = NUMERIC.factions;

/** 四个势力的定义（territory 与 name/type 都来自 numeric.ts 这一个出处） */
export const FACTIONS: readonly Faction[] = FACTION_IDS.map((id) => ({
  id,
  name: META[id].name,
  type: META[id].type as FactionType,
  territory: [...TERRITORY[id]],
}));

const BY_ID = new Map<FactionId, Faction>(FACTIONS.map((faction) => [faction.id, faction]));

export function factionById(id: string): Faction | null {
  return BY_ID.get(id as FactionId) ?? null;
}

/** 某个势力控制的地点 id 列表 */
export function territoryOf(id: string): readonly string[] {
  return BY_ID.get(id as FactionId)?.territory ?? [];
}

/** 这个势力是不是「无主」（没有任何人管 = 安全区） */
export function isWildFaction(id: string): boolean {
  return id === WILD_FACTION_ID;
}

/**
 * 地点 → 归属势力 id。
 * **不认识的地点返回 'none'**（安全侧）：内容表加了新地点但忘了归入势力时，
 * 宁可漏判一次追捕，也不要让玩家在一个"不存在于任何势力"的地方被凭空围剿。
 */
export function factionOfLocation(locationId: string | null | undefined): FactionId {
  if (!locationId) return WILD_FACTION_ID;
  for (const faction of FACTIONS) {
    if (faction.territory.includes(locationId)) return faction.id;
  }
  return WILD_FACTION_ID;
}

/** 这个地点是不是无主地点（安全区） */
export function isWildLocation(locationId: string | null | undefined): boolean {
  return isWildFaction(factionOfLocation(locationId));
}

/** 这个地点是否属于指定势力 */
export function isTerritoryOf(factionId: string, locationId: string | null | undefined): boolean {
  if (!locationId) return false;
  return territoryOf(factionId).includes(locationId);
}

export interface TerritoryCoverage {
  /** 每个势力覆盖到的地点数 */
  byFaction: Array<{ id: FactionId; name: string; count: number }>;
  /** 所有势力合起来覆盖的地点（去重） */
  controlled: string[];
  /** 被两个及以上势力同时声称的地点（数据错误） */
  overlaps: string[];
  /** 内容表里有、但没有任何势力声明的地点（内容缺口） */
  unclaimed: string[];
}

/**
 * 势力范围对内容表的覆盖体检。
 *
 * 为什么要它：M2.6 的任务书写了三个**并不存在**的地点 id
 * （lightless_basement / cemetery_path / foggy_street，实际是 dark_cellar /
 * graveyard_path / mist_street）。照抄会让黑帮和无主各少一半地盘，
 * 而这件事在运行期完全看不出来 —— 只有拿 locations.yaml 对一遍才会现形。
 * 所以把它做成一个能被单测与报告调用的纯函数，而不是一次性的人工检查。
 */
export function territoryCoverage(contentLocationIds: readonly string[]): TerritoryCoverage {
  const counts = new Map<string, number>();
  for (const faction of FACTIONS) {
    for (const locationId of faction.territory) {
      counts.set(locationId, (counts.get(locationId) ?? 0) + 1);
    }
  }
  const controlled = [...counts.keys()];
  return {
    byFaction: FACTIONS.map((faction) => ({
      id: faction.id,
      name: faction.name,
      count: faction.territory.length,
    })),
    controlled,
    overlaps: controlled.filter((id) => (counts.get(id) ?? 0) > 1),
    unclaimed: contentLocationIds.filter((id) => !counts.has(id)),
  };
}

export function factionLabel(id: string): string {
  return factionById(id)?.name ?? id;
}
