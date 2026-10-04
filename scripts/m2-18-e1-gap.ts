#! /usr/bin/env node
/**
 * M2.18 E1 补取证：
 *   A 四个主材料产地的属性（城市 / 序列门槛 / danger / loot 结构）—— 回答「为什么热度低」
 *   B 序列 8 的四种卡点分类 + 缺材料的**人数分布**（缺 1 种 / 2 种 / 3 种）
 *       —— 回答「要让 6 个人过线，需要多出多少货」
 *
 * 用法：node scripts/m2-18-e1-gap.ts --prefix m219c
 */
import { DatabaseSync } from 'node:sqlite';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadContent } from '../src/data/loader.ts';
import { digThresholdFor } from '../src/domain/promotion/promotion.ts';

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const index = argv.indexOf('--' + name);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
};
const PREFIX = argOf('prefix', 'm219c');
const SHARDS = 8;
const content = loadContent();

/* ---- A：四个产地 ---- */
const cityOf = new Map<string, string>();
for (const city of content.cities) for (const id of city.locations) cityOf.set(id, city.id);
const cityName = new Map(content.cities.map((c) => [c.id, c.name]));
const TARGETS = ['lighthouse', 'above_grey_fog', 'backlund_underground', 'plague_camp'];
console.log('=== A：四个主要产地的属性 ===');
for (const id of TARGETS) {
  const loc = content.locations.find((l) => l.id === id);
  if (!loc) { console.log('  ' + id + '：**找不到这个地点**'); continue; }
  const city = cityOf.get(id) ?? '（无城市）';
  const mainEntries = (loc.loot ?? []).filter((entry) => entry.itemId.startsWith('主材料·')).length;
  console.log('  ' + loc.name + '(' + id + ') | 城市 ' + (cityName.get(city) ?? city) +
    ' | 序列 ' + loc.min_seq + '-' + loc.max_seq + ' | danger ' + loc.danger +
    ' | loot 条目 ' + (loc.loot ?? []).length + '（其中主材料 ' + mainEntries + '）');
}

/* ---- B：四种卡点 + 缺材料的缺口分布 ---- */
const seq8 = { bothReady: 0, digShort: 0, materialShort: 0, bothShort: 0, total: 0 };
const missHistogram = new Map<number, number>();   // 缺几种材料 → 人数
const missDetail = new Map<string, number>();      // 缺哪一种 → 人数
for (let shard = 0; shard < SHARDS; shard += 1) {
  let db: DatabaseSync;
  try { db = new DatabaseSync('data/' + PREFIX + '-shard-' + shard + '.db', { readOnly: true }); } catch { continue; }
  const rows = db.prepare('SELECT id, pathway, dig FROM characters WHERE sequence = 8').all() as unknown as Array<{ id: string; pathway: string; dig: number }>;
  for (const row of rows) {
    const recipe = content.recipes.find((r) => r.pathway === row.pathway && r.seq === 8);
    if (!recipe) continue;
    seq8.total += 1;
    const threshold = digThresholdFor(recipe);
    const digOk = Number(row.dig) >= threshold;
    let missing = 0;
    for (const need of recipe.main) {
      const owned = Number((db.prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM inventory WHERE character_id = ? AND item_id = ?').get(row.id, need.itemId) as { n: number }).n);
      if (owned < need.qty * NUMERIC.promotion.mainMaterialMultiplier) {
        missing += 1;
        missDetail.set(need.itemId, (missDetail.get(need.itemId) ?? 0) + 1);
      }
    }
    if (digOk && missing === 0) seq8.bothReady += 1;
    else if (digOk && missing > 0) seq8.materialShort += 1;
    else if (!digOk && missing === 0) seq8.digShort += 1;
    else seq8.bothShort += 1;
    if (missing > 0) missHistogram.set(missing, (missHistogram.get(missing) ?? 0) + 1);
  }
  db.close();
}
console.log('');
console.log('=== B：序列 8 的四种卡点（共 ' + seq8.total + ' 人）===');
console.log('  材料齐 + DIG 够 + 没升（E3 的活）：' + seq8.bothReady);
console.log('  材料齐 + DIG 不够（E2 的活）  ：' + seq8.digShort);
console.log('  材料不齐 + DIG 够（E1 的活）  ：' + seq8.materialShort);
console.log('  **双缺（E1 + E2 的活）**      ：' + seq8.bothShort);
console.log('');
console.log('=== 缺材料的**人数**分布（不是缺口总数）===');
for (const [k, n] of [...missHistogram.entries()].sort((a, b) => a[0] - b[0])) console.log('  缺 ' + k + ' 种：' + n + ' 人');
console.log('  按材料：' + [...missDetail.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => k + '=' + n + '人').join('、'));
