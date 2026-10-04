#! /usr/bin/env node
/**
 * M2.17 收尾取证：**序列 8 → 7 的漏斗卡在哪一档**（用现成的 m218a 库复算，不跑批）。
 *
 * 用法：node scripts/m2-17-8to7-census.ts
 *
 * 为什么可以复算：晋升判据是**纯函数**（checkPromotion），三个门槛全部能从库里读出来 ——
 *   1. 服下本序列魔药（flag）  2. DIG >= 门槛  3. 材料齐（配方主材料 x 2）
 * 所以「够门槛却没发起」这件事根本不需要再跑一批，库里就有答案。
 */
import { DatabaseSync } from 'node:sqlite';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadContent } from '../src/data/loader.ts';
import { digThresholdFor } from '../src/domain/promotion/promotion.ts';

const content = loadContent();
const SHARDS = 8;
/*
 * M2.18 任务 A1：加 `--prefix <库前缀>`。
 *
 * 原来前缀写死成 m218a（只看了 M2.17 那一批）。A1 要的是「卡点分布稳不稳定」，
 * 所以同一份脚本要在两个不同的批上跑 —— 前缀必须是参数，否则两次跑的是同一批。
 * 用法：node scripts/m2-17-8to7-census.ts --prefix m216
 */
const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const index = argv.indexOf('--' + name);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
};
const PREFIX = argOf('prefix', 'm218a');

// 探测一次表结构（脚本要能自己说清它读的是哪张表）
const probe = new DatabaseSync('data/' + PREFIX + '-shard-0.db', { readOnly: true });
const tables = (probe.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as unknown as Array<{ name: string }>).map((t) => t.name);
console.log('表：' + tables.join(', '));
for (const name of ['flags', 'inventory']) {
  if (!tables.includes(name)) continue;
  const cols = (probe.prepare('PRAGMA table_info(' + name + ')').all() as unknown as Array<{ name: string }>).map((c) => c.name);
  console.log(name + ' 列：' + cols.join(', '));
}
probe.close();

interface Bucket { total: number; recipeMissing: number; flagMissing: number; digShort: number; materialShort: number; ready: number; digShortValues: number[] }
const bucket = (): Bucket => ({ total: 0, recipeMissing: 0, flagMissing: 0, digShort: 0, materialShort: 0, ready: 0, digShortValues: [] });

const seq8 = bucket();
const seq7 = bucket();
const missingItems = new Map<string, number>();

for (let shard = 0; shard < SHARDS; shard += 1) {
  const db = new DatabaseSync('data/' + PREFIX + '-shard-' + shard + '.db', { readOnly: true });
  for (const target of [8, 7] as const) {
    const rows = db.prepare('SELECT id, pathway, dig, sequence, status FROM characters WHERE sequence = ?').all(target) as unknown as Array<{ id: string; pathway: string | null; dig: number; sequence: number; status: string }>;
    const bucketRef = target === 8 ? seq8 : seq7;
    for (const row of rows) {
      bucketRef.total += 1;
      // 目标配方：从 target 升到 target-1（seer_8 是 9→8 的那份，所以 8→7 用 seq=7 的配方）
      const recipe = content.recipes.find((r) => r.pathway === row.pathway && r.seq === target);
      if (!recipe) { bucketRef.recipeMissing += 1; continue; }
      const threshold = digThresholdFor(recipe);
      const flag = 'ability_' + row.pathway + '_' + target;
      const hasFlag = Number((db.prepare('SELECT COUNT(*) AS n FROM flags WHERE character_id = ? AND flag = ?').get(row.id, flag) as { n: number }).n) > 0;
      if (!hasFlag) { bucketRef.flagMissing += 1; continue; }
      if (row.dig < threshold) { bucketRef.digShort += 1; bucketRef.digShortValues.push(Number(row.dig.toFixed(1))); continue; }
      const missing: string[] = [];
      for (const need of recipe.main) {
        const owned = Number((db.prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM inventory WHERE character_id = ? AND item_id = ?').get(row.id, need.itemId) as { n: number }).n);
        if (owned < need.qty * NUMERIC.promotion.mainMaterialMultiplier) {
          missing.push(need.itemId + '(' + owned + '/' + need.qty * NUMERIC.promotion.mainMaterialMultiplier + ')');
          missingItems.set(need.itemId, (missingItems.get(need.itemId) ?? 0) + 1);
        }
      }
      if (missing.length > 0) { bucketRef.materialShort += 1; continue; }
      bucketRef.ready += 1;
    }
  }
  db.close();
}

const line = (label: string, b: Bucket): string =>
  label + '：共 ' + b.total + ' 人 —— 无配方 ' + b.recipeMissing + ' / 没服魔药 ' + b.flagMissing +
  ' / DIG 不够 ' + b.digShort + ' / 材料不齐 ' + b.materialShort + ' / **三项都够却没升 ' + b.ready + '**';

console.log('');
console.log('批：' + PREFIX);
console.log('DIG 门槛：9→8 = ' + NUMERIC.promotion.digThreshold + '，8→7 = ' + NUMERIC.sequence7.digThreshold + '（sequence7.recipeSeq = ' + NUMERIC.sequence7.recipeSeq + '）');
console.log(line('序列 8（准备升 7）', seq8));
console.log(line('序列 7（准备升 6）', seq7));
console.log('');
console.log('DIG 不够的那批，消化度样本：' + seq8.digShortValues.slice(0, 20).join(', '));
console.log('材料缺口 Top：' + [...missingItems.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, n]) => id + '=' + n).join('、'));
