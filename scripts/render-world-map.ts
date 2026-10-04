/**
 * 出一张世界地图到本地，用来迭代版式（开发工具，不是产品代码）。
 *
 *   node scripts/render-world-map.ts            # 默认 1.5 倍，便于整张看清
 *   node scripts/render-world-map.ts 2          # 上线口径（1240×2240）
 *
 * 为什么要单独有一个：地图的版式靠读代码是调不出来的 —— 字号、色条宽度、
 * 一排放几个、留白够不够，**只能看图**。改完 map-template.ts 就跑一次。
 */
import { writeFileSync } from 'node:fs';
import { openDatabase } from '../src/infra/db/sqlite.ts';
import { renderWorldMap, worldMapData } from '../src/world/map.ts';
const db = openDatabase('data/game.db');
const d = worldMapData(db, Date.now(), 'old_dock');
console.log('区域 ' + d.regions.length + ' / 城市 ' + d.stats.cities + ' / 地点 ' + d.stats.locations +
  ' / 异象 ' + d.stats.epic + ' / 图例 ' + d.legend.map((x) => x.label).join(','));
for (const r of d.regions) console.log('  ' + r.name + ' → ' + r.cities.map((c) => c.name + '(' + c.locations.length + ')').join(' '));
if (d.orphans.length) console.log('  无所属 ' + d.orphans.length + ' 个');
const scale = Number(process.argv[2] ?? '1.5');
// 用真库里的玩家实际所在地点，这样出图与 .世界 发出去的那张完全一致
const who = db.prepare('SELECT id FROM characters LIMIT 1').get();
const flagRow = who === undefined
  ? undefined
  : db.prepare('SELECT value FROM flags WHERE character_id = ? AND flag = ?').get(who.id, 'loc');
const rawHere = flagRow === undefined ? null : (flagRow as { value?: unknown }).value;
const here = rawHere === null || rawHere === undefined ? null : String(rawHere);
console.log('玩家所在地点：' + (here ?? '（未记录）'));
const png = renderWorldMap(db, Date.now(), here, scale);
writeFileSync('world-map.png', png);
console.log('出图 ' + scale + ' 倍，' + png.length + ' 字节 → world-map.png');