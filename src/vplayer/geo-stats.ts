/**
 * M2.7：世界地理与移动的统计（采集 / 合并 / 渲染三件事放在一处）。
 *
 * 为什么单独一个模块：这三个数字要同时出现在**单轮报告**、**分片 JSON**、**合并报告**里，
 * 而三处的口径必须完全一样。散着写的话，下一轮改一处忘一处就会得到两份互相矛盾的报告 ——
 * 仓库里已经因为这种事吃过亏（M2.0 的三栏口径统一就是为了这个）。
 *
 * 三个指标各自的来源：
 *   - **出生城市分布**：由 birthDistribution 从 userId 直接算（纯函数），
 *     所以报告里的分布与真实分配**必然一致** —— 不是从库里另统计一遍；
 *   - **移动次数**：travels 表按 status 分组（arrived 才算「走成了」）；
 *   - **路途事件分布**：travels.events_json 里每条事件的 id 与玩家的选择。
 */
import type { Db } from '../infra/db/sqlite.ts';
import { birthDistribution, type BirthCityLike } from '../domain/geo/birth.ts';
import { travelEventLabel } from '../domain/geo/events.ts';

/** 报告里能显示的城市信息：只要 id 与中文名 */
export type CityLabelLike = Pick<BirthCityLike, 'id' | 'name'>;

export interface GeoStats {
  /** 出生城市分布（城市 id → 人数） */
  birthCities: Record<string, number>;
  /** 玩家尝试过的移动次数（落过 travel_start 的） */
  travelsStarted: number;
  /** 真正走完的移动次数（status = arrived） */
  travelsArrived: number;
  /** 期末仍挂在路上的行程（长跑结束时还在走） */
  travelsOngoing: number;
  /** 路途事件分布（事件 id → 触发次数） */
  travelEvents: Record<string, number>;
  /** 玩家对路途事件的应对分布（fight / flee / observe / interact） */
  travelChoices: Record<string, number>;
  /** 全部路费合计（便士） */
  travelPenny: number;
}

export function emptyGeoStats(): GeoStats {
  return {
    birthCities: {},
    travelsStarted: 0,
    travelsArrived: 0,
    travelsOngoing: 0,
    travelEvents: {},
    travelChoices: {},
    travelPenny: 0,
  };
}

interface TravelRow {
  status: string;
  events_json: string | null;
}

/**
 * 采集本批玩家的地理统计。
 * userIds 来自 profiles —— 出生分布在**建号之前**就算得出来（它是纯派生），
 * 所以「有多少人落在拜朗」这件事不依赖任何玩家动作。
 */
export function collectGeoStats(
  db: Db,
  userIds: readonly string[],
  cities: readonly BirthCityLike[],
): GeoStats {
  const stats = emptyGeoStats();
  for (const entry of birthDistribution(userIds, cities)) {
    if (entry.count > 0) stats.birthCities[entry.cityId] = entry.count;
  }

  let rows: TravelRow[] = [];
  try {
    rows = db.prepare('SELECT status, events_json FROM travels').all() as unknown as TravelRow[];
  } catch {
    // 老库（0015 之前）没有 travels 表：统计归零，而不是让整轮报告崩掉
    return stats;
  }
  for (const row of rows) {
    if (row.status === 'traveling') stats.travelsOngoing += 1;
    if (row.status === 'arrived') stats.travelsArrived += 1;
    let events: Array<{ id?: string; choice?: string }> = [];
    try {
      events = JSON.parse(String(row.events_json ?? '[]')) as Array<{ id?: string; choice?: string }>;
    } catch {
      events = [];
    }
    for (const entry of events) {
      if (typeof entry.id === 'string') {
        stats.travelEvents[entry.id] = (stats.travelEvents[entry.id] ?? 0) + 1;
      }
      if (typeof entry.choice === 'string') {
        stats.travelChoices[entry.choice] = (stats.travelChoices[entry.choice] ?? 0) + 1;
      }
    }
  }

  // 次数与花费从 domain_events 取权威值（travel_start 的 payload 里两个都有）
  try {
    const starts = db
      .prepare("SELECT payload FROM domain_events WHERE type = 'travel_start'")
      .all() as Array<{ payload: string }>;
    stats.travelsStarted = starts.length;
    for (const row of starts) {
      try {
        const payload = JSON.parse(row.payload) as { costPenny?: number };
        stats.travelPenny += Number(payload.costPenny ?? 0);
      } catch {
        // 单条坏数据不影响总数
      }
    }
  } catch {
    stats.travelsStarted = rows.length;
  }
  return stats;
}

const CHOICE_LABELS: Record<string, string> = {
  fight: '战斗',
  flee: '逃跑',
  observe: '观察',
  interact: '互动',
};

/** 城市 id → 中文名（报告里显示人话；查不到就退回 id） */
export function cityLabel(cities: readonly CityLabelLike[], cityId: string): string {
  return cities.find((city) => city.id === cityId)?.name ?? cityId;
}

/**
 * 渲染成一节 markdown（单轮报告与合并报告共用同一份排版）。
 */
export function renderGeoSection(
  stats: GeoStats,
  cities: readonly CityLabelLike[],
  options: { sharded?: boolean } = {},
): string[] {
  const lines: string[] = [];
  lines.push('## M2.7 世界地理与跨区域移动');
  lines.push('');
  lines.push('| 指标 | 实测 | 说明 |');
  lines.push('|---|---|---|');
  const birth = Object.entries(stats.birthCities)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([cityId, count]) => `${cityLabel(cities, cityId)} ${count}`)
    .join(' · ');
  lines.push(`| 出生城市分布 | ${birth || '无'} | 由 birthCityOf 直接派生（同一个人永远落在同一座城市） |`);
  lines.push(
    `| 移动次数 | 出发 ${stats.travelsStarted} 次，抵达 ${stats.travelsArrived} 次（期末在路上 ${stats.travelsOngoing}） | 需要在地的指令在路上会被挡回 |`,
  );
  lines.push(`| 路费合计 | ${stats.travelPenny} 便士 | 来自 domain_events 的 travel_start 记录 |`);
  const events = Object.entries(stats.travelEvents)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, count]) => `${travelEventLabel(id)} ${count}`)
    .join(' · ');
  lines.push(`| 路途事件分布 | ${events || '无'} | 八种事件见 src/domain/geo/events.ts |`);
  const choices = Object.entries(stats.travelChoices)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, count]) => `${CHOICE_LABELS[id] ?? id} ${count}`)
    .join(' · ');
  lines.push(`| 路途应对分布 | ${choices || '无'} | 战斗 / 逃跑 / 观察 / 互动 |`);
  lines.push('');
  if (options.sharded) {
    lines.push(
      '> ⚠️ 口径：**移动是跨玩家无关的行为**（一个人的行程不依赖另一个人），所以分片汇总与单轮一致。',
    );
    lines.push('');
  }
  return lines;
}
