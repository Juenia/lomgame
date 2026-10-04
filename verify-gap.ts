import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ENTITIES, entityById } from './src/admin/schema.ts';
import { readEntity, listEntity } from './src/admin/data.ts';
const ROOT = process.cwd();
let total = 0;
for (const e of ENTITIES) {
  if (e.rootMode !== undefined && e.rootMode !== 'seq') continue;
  const raw = parse(readFileSync(join(ROOT, e.file), 'utf8')) as Record<string, unknown>;
  const arr = raw[e.rootKey ?? ''];
  if (!Array.isArray(arr)) continue;
  const declared = new Set(e.fields.map((f) => f.key));
  const seen = new Map<string, number>();
  for (const row of arr as Record<string, unknown>[]) {
    for (const k of Object.keys(row)) if (!declared.has(k)) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const [k, n] of seen) { console.log('仍未声明：' + e.id + '.' + k + '（' + n + ' 行）'); total += 1; }
}
console.log('剩余未声明字段：' + total);

// 抽几条真实记录，确认新字段读得出来
const items = listEntity(ROOT, entityById('items')!);
const potion = items.filter((r) => r.summary.includes('魔药'))[0];
console.log('\n魔药样例 ' + (potion ? potion.id : '?') + ' = ' + JSON.stringify(readEntity(ROOT, entityById('items')!, potion ? potion.id : '')));
const sealed = items.filter((r) => r.summary.includes('封印'))[0];
if (sealed) console.log('封印物样例 ' + sealed.id + ' = ' + JSON.stringify(readEntity(ROOT, entityById('items')!, sealed.id)));
console.log('\n地点样例 = ' + JSON.stringify(readEntity(ROOT, entityById('locations')!, 'old_dock')));
console.log('\n生物样例 = ' + JSON.stringify(readEntity(ROOT, entityById('creatures')!, 'grey_fog_wraith')));
console.log('\n教会样例 = ' + JSON.stringify(readEntity(ROOT, entityById('churches')!, 'church_tingen')));