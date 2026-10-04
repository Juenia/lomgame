/**
 * 地理索引（M2.7）：把区域 / 城市 / 路线三张表变成一个可查询的只读视图。
 *
 * 为什么是纯数据类而不是仓储：菜单生成器、出生派生、移动判定全是纯函数，
 * 它们必须能在**不碰数据库**的地方跑（虚拟玩家侧要算出生城市、模拟器要跑 1000 人）。
 * 所以命令层从仓储里读一次，构造一个 GeoIndex 塞进 RouterDeps，之后所有判定只读它。
 */
import type { PathwayId } from '../character/types.ts';
import type { City, Region, Route } from './types.ts';

export class GeoIndex {
  #regions: Map<string, Region>;
  #cities: Map<string, City>;
  #routes: Route[];
  /** 地点 id → 城市 id（由 City.locations 反查得出；一个地点只属于一座城市） */
  #locationToCity: Map<string, string>;

  constructor(regions: readonly Region[], cities: readonly City[], routes: readonly Route[]) {
    this.#regions = new Map(regions.map((region) => [region.id, region]));
    this.#cities = new Map(cities.map((city) => [city.id, city]));
    this.#routes = [...routes];
    this.#locationToCity = new Map();
    for (const city of cities) {
      for (const locationId of city.locations) {
        // 先到先得：内容表里如果一个地点被两座城市声称，loader 会报 warn，这里取第一座
        if (!this.#locationToCity.has(locationId)) this.#locationToCity.set(locationId, city.id);
      }
    }
  }

  get regions(): Region[] {
    return [...this.#regions.values()];
  }

  get cities(): City[] {
    return [...this.#cities.values()];
  }

  get routes(): Route[] {
    return [...this.#routes];
  }

  region(id: string): Region | null {
    return this.#regions.get(id) ?? null;
  }

  city(id: string): City | null {
    return this.#cities.get(id) ?? null;
  }

  /**
   * 中文名 / id / **别名**都能查到（.移动 贝克兰德 / .移动 backlund 都认）。
   *
   * M2.85 内容填充 P2：加了**别名**这一档 —— 原作数据里每座城市都有旧称与别名
   * （贝克兰德 = 尘埃之都 / 希望之地 / 万都之都），既然是内容，就该能被玩家用上。
   * 执行点是这条函数（`.移动` 与 `.世界 城市` 都走它），不是某一条命令里的特判。
   */
  cityByNameOrId(text: string): City | null {
    const trimmed = text.trim();
    const byId = this.#cities.get(trimmed);
    if (byId) return byId;
    for (const city of this.#cities.values()) {
      if (city.name === trimmed) return city;
    }
    for (const city of this.#cities.values()) {
      if (city.aliases.includes(trimmed)) return city;
    }
    return null;
  }

  regionName(cityId: string): string {
    const city = this.#cities.get(cityId);
    if (!city) return '未知之地';
    return this.#regions.get(city.region_id)?.name ?? '未知之地';
  }

  /**
   * M2.71：**这座城市属于哪个区域**（区域对象，不是名字）。
   *
   * 加它是因为 `Region.danger` 一直没有读取点 —— 而它的用途在类型注释与
   * regions.yaml 的文件头里都写着「影响该区域内的路线危险与陌生感文案」。
   * 要读那个字段就得先拿得到区域本身（`regionName` 只给名字）。
   */
  regionOfCity(cityId: string): Region | null {
    const city = this.#cities.get(cityId);
    if (!city) return null;
    return this.#regions.get(city.region_id) ?? null;
  }

  /** 这个地点在哪座城市（不在任何城市里返回 null） */
  cityOfLocation(locationId: string): City | null {
    const cityId = this.#locationToCity.get(locationId);
    return cityId ? (this.#cities.get(cityId) ?? null) : null;
  }

  /** 这座城市开放（传承）的途径 */
  pathwaysOf(cityId: string): PathwayId[] {
    return [...(this.#cities.get(cityId)?.pathways ?? [])];
  }

  /** 这座城市是否传承某条途径 —— 出生校验的唯一判据 */
  supportsPathway(cityId: string, pathway: PathwayId): boolean {
    return (this.#cities.get(cityId)?.pathways ?? []).includes(pathway);
  }

  /** 可以作为出生城市的那些（birth_weight > 0） */
  birthCities(): City[] {
    return [...this.#cities.values()].filter((city) => city.birth_weight > 0);
  }

  /** 从某座城市出发的路线（按时长升序：近的排前面，「次近的那座城」是穷人的选择） */
  routesFrom(cityId: string): Route[] {
    return this.#routes
      .filter((route) => route.from === cityId)
      .sort((a, b) => a.duration_hours - b.duration_hours || a.id.localeCompare(b.id));
  }

  route(from: string, to: string): Route | null {
    return this.#routes.find((route) => route.from === from && route.to === to) ?? null;
  }

  /** 两个城市之间有没有直达路线（.移动 的「有没有路线」校验） */
  connected(from: string, to: string): boolean {
    return this.route(from, to) !== null;
  }

  /** 报告用：城市 → 地点数（内容覆盖体检） */
  locationCountOf(cityId: string): number {
    return this.#cities.get(cityId)?.locations.length ?? 0;
  }
}
