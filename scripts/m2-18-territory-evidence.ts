#! /usr/bin/env node
/**
 * M2.18 任务 A3 取证：势力层争夺的**粒度**该选城市还是地点。
 *
 * 用法：node scripts/m2-18-territory-evidence.ts
 *
 * 三组数（全部从现成产物里数，不跑批）：
 *   1. 玩家**活动地点分布** —— 从 m218a 的 8 份行为日志里数 .探索 的地名
 *   2. PVP 的**地理分布** —— 从 m218a 库里的 pvp 事件 payload
 *   3. 教会据点城市 vs 玩家活动 —— 把地点折成城市，看「城市级」能不能承载争夺
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadContent } from '../src/data/loader.ts';
import { NUMERIC } from '../src/config/numeric.ts';

const content = loadContent();
const SHARDS = 8;
const PREFIX = 'm218a';

const locationByName = new Map(content.locations.map((l) => [l.name, l]));
const cityOfLocation = new Map<string, string>();
for (const city of content.cities) for (const id of city.locations) cityOfLocation.set(id, city.id);
const cityName = new Map(content.cities.map((c) => [c.id, c.name]));

/* 每个地点的探索次数（8 片合计） */
const exploreCount = new Map<string, number>();
for (let shard = 0; shard < SHARDS; shard += 1) {
  let text = '';
  try { text = readFileSync('docs/' + PREFIX + '-shard' + shard + '-行为日志.jsonl', 'utf8'); } catch { continue; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec: { command?: string };
    try { rec = JSON.parse(line) as { command?: string }; } catch { continue; }
    const m = /^\.探索\s+(.+)$/.exec(rec.command ?? '');
    if (!m) continue;
    const name = (m[1] ?? '').trim();
    exploreCount.set(name, (exploreCount.get(name) ?? 0) + 1);
  }
}

const totalExplore = [...exploreCount.values()].reduce((a, b) => a + b, 0);
console.log('探索总数（8 片）：' + totalExplore + '，涉及地点 ' + exploreCount.size + ' 个');
console.log('');
console.log('### 探索次数 Top 20');
for (const [name, n] of [...exploreCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  const loc = locationByName.get(name);
  const city = loc ? cityOfLocation.get(loc.id) ?? '?' : '?';
  console.log('  ' + name + '（' + (loc?.id ?? '?') + ' / ' + city + '）：' + n + ' 次（' + ((n / totalExplore) * 100).toFixed(1) + '%）');
}

/* 按城市聚合 */
const byCity = new Map<string, number>();
for (const [name, n] of exploreCount) {
  const loc = locationByName.get(name);
  const city = loc ? cityOfLocation.get(loc.id) ?? '(不属于任何城市)' : '(未知)';
  byCity.set(city, (byCity.get(city) ?? 0) + n);
}
console.log('');
console.log('### 按城市聚合');
for (const [city, n] of [...byCity.entries()].sort((a, b) => b[1] - a[1])) {
  console.log('  ' + (cityName.get(city) ?? city) + '：' + n + ' 次（' + ((n / totalExplore) * 100).toFixed(1) + '%）');
}

/* 教会据点城市内的活动占比 */
const seatCities = new Set(content.churches.flatMap((c) => c.seats));
let inSeats = 0;
for (const [city, n] of byCity) if (seatCities.has(city)) inSeats += n;
console.log('');
console.log('教会有堂口的城市：' + [...seatCities].map((c) => cityName.get(c) ?? c).join('、'));
console.log('落在这些城市里的探索：' + inSeats + ' / ' + totalExplore + ' = ' + ((inSeats / totalExplore) * 100).toFixed(1) + '%');

/* M2.6 势力范围的现状（地点归属） */
console.log('');
console.log('### M2.6 势力范围覆盖的地点数');
for (const [key, list] of Object.entries(NUMERIC.factionTerritory)) {
  console.log('  ' + key + '：' + (list as string[]).length + ' 个地点');
}
const churchFaction = new Set(NUMERIC.factionTerritory.church as string[]);
const overlap = [...exploreCount.entries()].filter(([name]) => {
  const loc = locationByName.get(name);
  return loc ? churchFaction.has(loc.id) : false;
}).reduce((a, [, n]) => a + n, 0);
console.log('  探索落在「教会势力范围」6 个地点里的：' + overlap + ' / ' + totalExplore + ' = ' + ((overlap / totalExplore) * 100).toFixed(1) + '%');

/* PVP 的地理分布 */
const pvpTypes = ['pvp_challenge', 'pvp_challenged', 'pvp_round', 'assault_resolved', 'battle_start'];
const pvpByLoc = new Map<string, number>();
let pvpSamplePrinted = false;
for (let shard = 0; shard < SHARDS; shard += 1) {
  const db = new DatabaseSync('data/' + PREFIX + '-shard-' + shard + '.db', { readOnly: true });
  const rows = db.prepare("SELECT type, payload FROM domain_events WHERE type IN ('pvp_challenge','pvp_challenged','assault_resolved','battle_start') LIMIT 400").all() as unknown as Array<{ type: string; payload: string }>;
  for (const row of rows) {
    if (!pvpSamplePrinted) { console.log(''); console.log('PVP 事件 payload 样本：' + row.type + ' → ' + row.payload.slice(0, 200)); pvpSamplePrinted = true; }
    let locationId = '未记录';
    try {
      const parsed = JSON.parse(row.payload) as Record<string, unknown>;
      locationId = String(parsed.locationId ?? parsed.location ?? '未记录');
    } catch { /* 保持未记录 */ }
    pvpByLoc.set(locationId, (pvpByLoc.get(locationId) ?? 0) + 1);
  }
  db.close();
}
console.log('');
console.log('### PVP 事件的地理分布（' + [...pvpByLoc.values()].reduce((a, b) => a + b, 0) + ' 条）');
for (const [loc, n] of [...pvpByLoc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log('  ' + loc + '：' + n);
}
