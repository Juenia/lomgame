/**
 * 世界地图（M2.54）：把**这个世界本身**画成一张图。
 *
 * ## 为什么是图，而不是把 58 个地点列出来
 *
 * `.世界` 原来返回的是 58 行「1. 贝克兰德（危险 · 晴）（危险 ×1.00）」——
 * 1691 字、65 行，而且大部分行说的都是同一件事（全服都是晴）。
 * 那不是「展示世界」，那是把数据库倒给玩家看。
 *
 * 一张图能做到文字做不到的三件事：
 *   1. **空间**——地点按区域与城市归位，玩家看得见"世界长什么样"；
 *   2. **一眼看出异常**——正常天气压成安静的底色，罕见的才跳出来；
 *   3. **不占屏**——58 个地点画在一张 620×1120 的图里，聊天窗只占一条消息。
 *
 * ## 与角色卡共用出图通道
 *
 * Edge 无头模式那套（profile 复用、PNG 轮询、stderr 噪音）在 `src/render/browser.ts`，
 * 这里只负责「画什么」。表现层（颜色 / 版式）在 map-template.ts。
 */
import { worldClock, TIME_OF_DAY_LABELS, SEASON_LABELS } from '../domain/world/clock.ts';
import { isEpicWeather, normalizeWeather, weatherLabel } from '../domain/world/weather.ts';
import { CityRepo, RegionRepo } from '../infra/db/geo.ts';
import { LocationRepo } from '../infra/db/locations.ts';
import type { Db } from '../infra/db/sqlite.ts';
import { WorldRepo } from '../infra/db/world.ts';
import { renderHtmlToPng } from '../render/browser.ts';
import { MAP_H, MAP_W, worldMapHtml } from './map-template.ts';

export interface MapLocation {
  id: string;
  name: string;
  /** 1—4，越大越危险。用来定方块的明暗 */
  danger: number;
  weatherId: string;
  weatherLabel: string;
  /** 罕见天气（血月 / 灰雾潮 / 灵界渗透）—— 图上要跳出来 */
  epic: boolean;
  here: boolean;
  /**
   * 还有多少分钟变天；null = 三小时内不会变（或未知）。
   *
   * 这是图上唯一一处**表达"世界在动"**的地方。没有它，地图只是一张静态快照 ——
   * 玩家看到的是"此刻的世界"，看不出世界正在演化。
   * 而因为每一处的节拍是各自错开的（M2.53），图上会同时有好几处亮着不同的倒计时，
   * 一眼就能看出「不是全服一起变，是各处各在变」。
   */
  changesInMin: number | null;
}

/** 三小时内会变天的地点才提醒 —— 再远就没有"即将"的意义了 */
const SOON_MINUTES = 180;

export interface MapCity {
  id: string;
  name: string;
  locations: MapLocation[];
}

export interface MapRegion {
  id: string;
  name: string;
  cities: MapCity[];
}

export interface WorldMapData {
  clock: {
    timeOfDayLabel: string;
    moonPhase: number;
    fullMoon: boolean;
    foggy: boolean;
    seasonLabel: string;
  };
  regions: MapRegion[];
  /** 不属于任何城市的地点（内容表漏登记时不至于把它们弄丢） */
  orphans: MapLocation[];
  legend: Array<{ id: string; label: string }>;
  here: { locationName: string } | null;
  stats: { locations: number; epic: number; soon: number; cities: number; regions: number };
  seed: string;
}

export function worldMapData(db: Db, now: number, here: string | null = null): WorldMapData {
  const world = new WorldRepo(db);
  const seed = world.seed();
  const clock = worldClock(now, seed);

  const weatherOf = new Map<string, { weather: string; until: number }>();
  for (const row of db.prepare('SELECT location_id, weather, until FROM location_weather').all() as Array<
    Record<string, unknown>
  >) {
    weatherOf.set(String(row['location_id']), {
      weather: String(row['weather']),
      until: Number(row['until']),
    });
  }

  const locations = new LocationRepo(db).all();
  const byId = new Map(locations.map((location) => [location.id, location]));

  const toMapLocation = (id: string): MapLocation | null => {
    const location = byId.get(id);
    if (location === undefined) return null;
    const row = weatherOf.get(id);
    const weatherId = normalizeWeather(row?.weather ?? 'clear');
    const leftMin = row === undefined ? null : Math.round((row.until - now) / 60_000);
    return {
      id,
      name: location.name,
      danger: location.danger,
      weatherId,
      weatherLabel: weatherLabel(weatherId),
      epic: isEpicWeather(weatherId),
      here: here !== null && here === id,
      changesInMin: leftMin !== null && leftMin >= 0 && leftMin <= SOON_MINUTES ? leftMin : null,
    };
  };

  const cities = new CityRepo(db).all();
  const claimed = new Set<string>();
  const regions: MapRegion[] = [];

  for (const region of new RegionRepo(db).all()) {
    const inRegion: MapCity[] = [];
    for (const city of cities) {
      if (city.region_id !== region.id) continue;
      const inCity: MapLocation[] = [];
      for (const id of city.locations) {
        const mapped = toMapLocation(id);
        if (mapped === null) continue;
        claimed.add(id);
        inCity.push(mapped);
      }
      // 一个地点都没有的城市不画 —— 空框只会让人以为那里坏了
      if (inCity.length > 0) inRegion.push({ id: city.id, name: city.name, locations: inCity });
    }
    if (inRegion.length > 0) regions.push({ id: region.id, name: region.name, cities: inRegion });
  }

  /*
   * 没被任何城市认领的地点单独兜底。
   * 内容表里漏写 city.locations 是**很可能发生的**（M2.7 之前地点根本不属于城市），
   * 而"图上少几个地点"这种错很难被发现 —— 所以宁可多画一组，也不要静默丢掉。
   */
  const orphans: MapLocation[] = [];
  for (const location of locations) {
    if (claimed.has(location.id)) continue;
    const mapped = toMapLocation(location.id);
    if (mapped !== null) orphans.push(mapped);
  }

  const all = [...regions.flatMap((r) => r.cities.flatMap((c) => c.locations)), ...orphans];
  const hereLocation = all.find((location) => location.here) ?? null;

  // 图例只列**此刻真的出现过**的天气：把八种全列上，等于告诉玩家"这些都可能"，
  // 而玩家真正需要的是"我现在看到的颜色是什么意思"
  const present = new Set(all.map((location) => location.weatherId));
  const legend = [...present]
    .map((id) => ({ id, label: weatherLabel(normalizeWeather(id)) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh'));

  return {
    clock: {
      timeOfDayLabel: TIME_OF_DAY_LABELS[clock.timeOfDay],
      moonPhase: clock.moonPhase,
      fullMoon: clock.moonPhase === 15,
      foggy: clock.foggy,
      seasonLabel: SEASON_LABELS[clock.season],
    },
    regions,
    orphans,
    legend,
    here: hereLocation === null ? null : { locationName: hereLocation.name },
    stats: {
      locations: all.length,
      epic: all.filter((location) => location.epic).length,
      soon: all.filter((location) => location.changesInMin !== null).length,
      cities: regions.reduce((n, region) => n + region.cities.length, 0) + (orphans.length > 0 ? 1 : 0),
      regions: regions.length,
    },
    seed,
  };
}

/** 出图。scale 默认 2（与角色卡同口径）：1240×2240，QQ 里够清 */
export function renderWorldMap(
  db: Db,
  now: number,
  here: string | null = null,
  scale = 2,
): Buffer {
  return renderHtmlToPng(worldMapHtml(worldMapData(db, now, here)), {
    width: MAP_W,
    height: MAP_H,
    scale,
    tag: 'world',
  });
}
