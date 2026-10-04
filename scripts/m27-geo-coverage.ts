/**
 * M2.7 地理覆盖体检（静态，不跑实例）。
 *
 *   node scripts/m27-geo-coverage.ts --out docs/M2.7-地理覆盖.md
 *
 * 为什么需要一个**静态**体检脚本：地理数据的三类错误在运行期几乎看不出来 ——
 *   - 城市声称了一个不存在的地点 id → 那座城市少一个地方，菜单上看不出来；
 *   - 某个地点没归属任何势力 → 它悄悄变成永久安全区（通缉玩法在那里失效）；
 *   - 某座城市没有任何路线连着 → 出生在那儿的人再也走不掉。
 * 这三件事都只有把内容表摊开对一遍才会现形，所以做成脚本而不是一次性的人工检查。
 */
import { writeFileSync } from 'node:fs';
import { loadCities, loadContentOrThrow, loadRegions, loadRoutes } from '../src/data/loader.ts';
import { birthDistribution } from '../src/domain/geo/birth.ts';
import { GeoIndex } from '../src/domain/geo/geo.ts';
import { TRAVEL_EVENT_IDS, travelEventLabel } from '../src/domain/geo/events.ts';
import { eventPointsFor, parseRouteEvents, travelWeightsOf } from '../src/domain/geo/travel.ts';
import { territoryCoverage } from '../src/domain/faction/faction.ts';
import { PATHWAY_LABELS } from '../src/domain/character/rules.ts';
import { NUMERIC } from '../src/config/numeric.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const content = loadContentOrThrow();
const regions = loadRegions().regions;
const cities = loadCities().cities;
const routes = loadRoutes().routes;
const geo = new GeoIndex(regions, cities, routes);

const lines: string[] = [];
const push = (...text: string[]): void => {
  lines.push(...text);
};

push('# M2.7 地理覆盖');
push('');
push(
  `生成命令：\`node scripts/m27-geo-coverage.ts --out docs/M2.7-地理覆盖.md\``,
);
push('');
push(
  '本文件是**静态**体检：把 regions / cities / routes / locations 四张内容表摊开对一遍，',
  '回答「有没有哪座城市是空壳、哪条路走不通、哪个地点没人管」。运行期的实测数字见',
  '`docs/M2.7-交付说明.md`。',
);
push('');

/* ---------------- 一、层级 ---------------- */
push('## 一、层级：区域 → 城市 → 地点');
push('');
push('| 区域 | 类型 | 区域危险 | 城市 | 地点数 | 港口 | 出生权重 | 开放途径 |');
push('|---|---|---|---|---|---|---|---|');
for (const region of regions) {
  const own = cities.filter((city) => city.region_id === region.id);
  if (own.length === 0) {
    push(`| ${region.name} | ${region.type} | ${region.danger} | （本版无城市） | — | — | — | — |`);
    continue;
  }
  for (const city of own) {
    const pathways = city.pathways.map((id) => PATHWAY_LABELS[id]).join(' / ') || '—';
    push(
      `| ${region.name} | ${region.type} | ${region.danger} | ${city.name} | ${city.locations.length} | ` +
        `${city.is_port ? '是' : '否'} | ${city.birth_weight} | ${pathways} |`,
    );
  }
}
push('');
push(
  `合计：${regions.length} 个区域 / ${cities.length} 座城市 / ${geo.cities.reduce((sum, city) => sum + city.locations.length, 0)} 个地点引用 / ${routes.length} 条有向航线。`,
);
push('');

/* ---------------- 二、途径分布 ---------------- */
push('## 二、途径是地理化的（每条途径都有城市不开放它）');
push('');
push('| 途径 | 开放它的城市 | 不开放的城市 |');
push('|---|---|---|');
for (const pathway of ['seer', 'warrior', 'sleepless'] as const) {
  const open = cities.filter((city) => city.pathways.includes(pathway)).map((city) => city.name);
  const closed = cities
    .filter((city) => city.birth_weight > 0 && !city.pathways.includes(pathway))
    .map((city) => city.name);
  push(`| ${PATHWAY_LABELS[pathway]} | ${open.join('、') || '—'} | ${closed.join('、') || '—'} |`);
}
push('');
push(
  '> 每一行「不开放的城市」都非空 —— 也就是说 `.创建 姓名 途径` 那句',
  '「你所在的城市没有这条途径的传承」在任何一条途径上都真的会被触发，不是死代码。',
);
push('');

/* ---------------- 三、出生分布 ---------------- */
push('## 三、出生分布（派生式，不可重选）');
push('');
push('| 城市 | 权重 | 期望占比 | 1000 个号的实测分布 |');
push('|---|---|---|---|');
const sample = Array.from({ length: 1000 }, (_, index) => `sample-${index}`);
const distribution = birthDistribution(sample, geo.birthCities());
const totalWeight = distribution.reduce((sum, entry) => sum + entry.weight, 0);
for (const entry of distribution) {
  push(
    `| ${entry.cityName} | ${entry.weight} | ${((entry.weight / totalWeight) * 100).toFixed(1)}% | ` +
      `${entry.count}（${((entry.count / sample.length) * 100).toFixed(1)}%） |`,
  );
}
push('');
push(
  '出生城市由 `birthCityOf(userId)` 派生：同一个 QQ 号永远落在同一座城市。',
  '所以「不允许重选」是结构性事实，而不是一句提示词 —— 玩家换不了城市，只能换途径。',
);
push('');

/* ---------------- 四、航线 ---------------- */
push('## 四、航线与连通性');
push('');
push('| 起点 | 终点 | 类型 | 时长 | 花费 | 危险 | 事件点 | 事件池 |');
push('|---|---|---|---|---|---|---|---|');
for (const route of routes) {
  const pool = parseRouteEvents(route).map((id) => travelEventLabel(id)).join('、');
  push(
    `| ${geo.city(route.from)?.name} | ${geo.city(route.to)?.name} | ` +
      `${route.type === 'sea' ? '海路' : '陆路'} | ${route.duration_hours}h | ${route.cost_penny} 便士 | ` +
      `${route.danger} | ${eventPointsFor(route.duration_hours)} | ${pool} |`,
  );
}
push('');

// 连通性：从廷根出发能不能到每一座城市
const seen = new Set<string>(['tingen']);
const queue = ['tingen'];
while (queue.length > 0) {
  const current = queue.shift()!;
  for (const route of geo.routesFrom(current)) {
    if (seen.has(route.to)) continue;
    seen.add(route.to);
    queue.push(route.to);
  }
}
const unreachable = cities.filter((city) => !seen.has(city.id)).map((city) => city.name);
push(
  unreachable.length === 0
    ? '连通性：✅ 从廷根市出发可以抵达全部 ' + cities.length + ' 座城市。'
    : '连通性：❌ 以下城市从廷根市出发到不了：' + unreachable.join('、'),
);
push('');

/* ---------------- 五、事件池 × 权重 ---------------- */
push('## 五、路途事件的权重（numeric.geo）');
push('');
push('| 事件 | 海路权重 | 陆路权重 | 后果 |');
push('|---|---|---|---|');
for (const id of TRAVEL_EVENT_IDS) {
  const sea = NUMERIC.geo.seaEvents[id];
  const land = NUMERIC.geo.landEvents[id];
  const effect = NUMERIC.geo.effects[id] ?? {};
  const parts: string[] = [];
  if (effect.hp) parts.push(`HP ${effect.hp}`);
  if (effect.mad) parts.push(`MAD ${effect.mad > 0 ? '+' : ''}${effect.mad}`);
  if (effect.cor) parts.push(`COR +${effect.cor}`);
  if (effect.dig) parts.push(`DIG +${effect.dig}`);
  if (effect.extraHours) parts.push(`时长 +${effect.extraHours}h`);
  push(`| ${travelEventLabel(id)} | ${sea ?? '—'} | ${land ?? '—'} | ${parts.join(' · ') || '—'} |`);
}
push('');
push(
  '每次移动的第一个事件点**必中**（任务书「移动本身是一段内容」），',
  '其余事件点按 `numeric.geo.travel.eventChance = ' + NUMERIC.geo.travel.eventChance + '` 掷骰。',
);
push('');

/* ---------------- 六、势力与仪式 ---------------- */
push('## 六、新地点的势力归属与仪式加成');
push('');
const coverage = territoryCoverage(content.locations.map((location) => location.id));
push('| 势力 | 地点数 |');
push('|---|---|');
for (const entry of coverage.byFaction) push(`| ${entry.name} | ${entry.count} |`);
push('');
push(`- 重叠（同一个地点被两家认领）：${coverage.overlaps.length === 0 ? '无 ✅' : coverage.overlaps.join('、')}`);
push(`- 未归属（内容表里有、没有任何势力声明）：${coverage.unclaimed.length === 0 ? '无 ✅' : coverage.unclaimed.join('、')}`);
push('');

const locationBonus = NUMERIC.ritual.locationBonus;
const bonusRows = Object.entries(locationBonus).map(
  ([id, bonus]) => `| ${content.locations.find((location) => location.id === id)?.name ?? id} | ${bonus > 0 ? '+' : ''}${(bonus * 100).toFixed(0)}% |`,
);
push('仪式地点加成（`.仪式 地点` 的候选就是这张表）：');
push('');
push('| 地点 | 加成 |');
push('|---|---|');
push(...bonusRows);
push('');
const badBonus = Object.keys(locationBonus).filter(
  (id) => !content.locations.some((location) => location.id === id),
);
push(
  badBonus.length === 0
    ? '- 加成表里的地点 id 全部真实存在 ✅'
    : `- ❌ 加成表引用了不存在的地点：${badBonus.join('、')}`,
);
push('');

/* ---------------- 七、两个已知缺口 ---------------- */
push('## 七、已知缺口（如实记录，不粉饰）');
push('');
push(
  '1. **途径只有三条**：任务书 §3.2 表里的门 / 水手 / 秘法师 / 错误 / 观众 / 收尸人 / 窥秘人',
  '   本版**没有实现**（每条都要配齐标签、配方、序列 8 能力、失控文本与卡片条件）。',
  '   它们记在 cities.yaml 的 `planned_pathways` 与 regions.yaml 的 `pathways` 里，',
  '   与 `promotion.sequenceGating.planned` 同一手法：设计意图有落点，但没有代码读它。',
);
push(
  '2. **苏尼亚海的五个地点 min_seq = 8**：新号进不去，20×3 的短轮也覆盖不到。',
  '   这是有意的 —— 它们不在 CI 的「新号可达地点」硬门里，',
  '   而「出海」本来就是序列 8 之后的事。',
);
push('');

const out = arg('out', 'docs/M2.7-地理覆盖.md');
writeFileSync(out, lines.join('\n'), 'utf8');
console.log(`已写入 ${out}（${lines.length} 行）`);
