/**
 * 地理坐标（M2.85 扩图）—— **纯函数，无 IO**。
 *
 * ## 用户拍板
 *
 * > 「别忘记，**地球是圆的**，而诡秘之主的世界其实也就是地球」
 *
 * 原作《世界地理总览》§1.4 给出的对照表证实了这句话：
 *
 *   北美洲 → 北大陆（五大湖扩大成了间海）    太平洋 → 迷雾海
 *   南美洲 → 南大陆                          大西洋 → 苏尼亚海
 *   欧洲   → 东大陆（神弃之地）              北冰洋 → 北海
 *   亚洲   → 西大陆                          格陵兰 → 苏尼亚岛
 *
 * 各国原型也给得明确：鲁恩 = 维多利亚英国 / 因蒂斯 = 法国 / 塞加尔·马锡·伦堡 = 神圣罗马德国。
 *
 * ## 这一层的意义
 *
 * 地点只有在**球面上**有位置，才谈得上「从这里到那里有多远」「为什么这两个地方通航」——
 * 否则「相邻」就只是一张随手画的图。所以：
 *
 *   · 每个地点可以带 lat / lon（可选，没有的按所属区域推）
 *   · 距离一律用**球面距离**（haversine），不用平面直线
 *
 * ⚠️ 原作注里同时记了一条**存疑**：「太平洋 → 迷雾海」与「迷雾海在西面」方向矛盾。
 * 本文件不调和这个矛盾（原著自己也没调和），只按对照表给坐标；
 * 需要方向时以**内容表里写的位置关系**为准。
 */

/** 地球半径（公里） */
export const EARTH_RADIUS_KM = 6371;

export interface GeoPoint { lat: number; lon: number }

/** 球面距离（公里）—— haversine */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 区域中心（按原作 §1.4 的地球对照）。
 *
 * 顺序即「从西到东、从北到南」的真实排布 —— 它们是**推定值**（原著只给了对照关系，没给经纬度）。
 */
export const REGION_CENTERS: Record<string, GeoPoint> = {
  // 北大陆 = 北美洲
  north_continent: { lat: 45, lon: -100 },
  // 南大陆 = 南美洲
  south_continent: { lat: -15, lon: -60 },
  // 东大陆（神弃之地）= 欧洲
  east_continent: { lat: 50, lon: 15 },
  // 西大陆 = 亚洲
  west_continent: { lat: 45, lon: 90 },
  // 苏尼亚岛 = 格陵兰
  sunia_island: { lat: 72, lon: -40 },
  // 苏尼亚海 = 大西洋
  sunia_sea: { lat: 20, lon: -40 },
  // 迷雾海 = 太平洋
  fog_sea: { lat: 10, lon: -150 },
  // 北海 = 北冰洋
  north_sea: { lat: 82, lon: 0 },
  // 极地海 = 南冰洋
  polar_sea: { lat: -65, lon: -60 },
  // 狂暴海 = 分隔南北大陆的那片（加勒比—赤道大西洋一带）
  raging_sea: { lat: 10, lon: -75 },
  // 间海 = 五大湖
  interior_sea: { lat: 45, lon: -85 },
};

/** 地点坐标：优先用地点自己的 lat/lon，否则退到所属区域的中心 */
export function pointOf(
  location: { lat?: number | null; lon?: number | null; regionId?: string | null },
  regionOfLocation?: (id: string) => string | null,
): GeoPoint | null {
  if (typeof location.lat === 'number' && typeof location.lon === 'number') return { lat: location.lat, lon: location.lon };
  const regionId = location.regionId ?? (regionOfLocation ? null : null);
  if (regionId !== null && regionId !== undefined && REGION_CENTERS[regionId] !== undefined) return REGION_CENTERS[regionId]!;
  return null;
}

/** 两点之间大概要几天（按航海/陆行速度粗算）—— 场景里「多远」的人话 */
export function travelDays(a: GeoPoint, b: GeoPoint, kmPerDay = 300): number {
  return Math.max(1, Math.round(distanceKm(a, b) / kmPerDay));
}
