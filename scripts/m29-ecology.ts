/**
 * M2.9 前置 1 的长窗口生态验证（**纯函数，不起服务**）。
 *
 * 与 M2.8 §七 用的是同一个手法：tickCreatures 是纯函数，所以可以直接拿它跑 30 天，
 * 秒级出结果 —— 「生态会不会崩」这种问题只有长窗口能看见，而长窗口跑批要 20 分钟。
 *
 * 本脚本回答三个问题：
 *   1. 补充机制把「30 天存活」从多少提到了多少（与关闭补充的对照）
 *   2. 每个地点是否还有东西（会不会出现空地点）
 *   3. 补充进来的都是什么（物种构成有没有被补充带偏）
 *
 * 用法：node scripts/m29-ecology.ts [天数]（默认 30）
 */
import { CREATURE, applyNumericOverrides, resetNumeric } from '../src/config/numeric.ts';
import { loadCreatures, loadLocations } from '../src/data/loader.ts';
import { spawnInitialCreatures, tickCreatures } from '../src/domain/creature/ecology.ts';
import { createSeededRng } from '../src/domain/rng.ts';
import type { Creature } from '../src/domain/creature/types.ts';

const DAY_HOURS = 24;
const HOUR_MS = 3600_000;
const WORLD_SEED = 'm29-ecology';
/** 与生产同一个基数：locations.yaml 的全部地点 id */
// 只读 locations.yaml 的 id，不引入仓储（本脚本不碰数据库）
const LOCATION_IDS: string[] = loadLocations().locations.map((location) => location.id);

interface RunResult {
  /** 初始播种数量（同 seed 下两种配置完全一致 —— 播种不看 replenish） */
  initial: number;
  alive: number;
  dailyAlive: number[];
  emptyLocationsAtEnd: number;
  /** 有栖息物种、却一只都没有的地点（这**才是**缺陷） */
  emptyWithHabitat: string[];
  minPerLocation: number;
  totals: Record<string, number>;
  bySpecies: Map<string, number>;
}

function run(days: number, replenishEnabled: boolean): RunResult {
  const { creatures: speciesList } = loadCreatures();
  const speciesById = new Map(speciesList.map((species) => [species.id, species]));
  const start = Date.UTC(2026, 0, 1, 0, 0, 0);
  let current: Creature[] = spawnInitialCreatures(
    speciesList,
    createSeededRng(WORLD_SEED + ':spawn'),
    start,
  );
  const initial = current.length;
  const totals: Record<string, number> = {
    migrate: 0,
    feed: 0,
    evolve: 0,
    birth: 0,
    replenish: 0,
    death: 0,
  };
  const dailyAlive: number[] = [];
  const replenishedBySpecies = new Map<string, number>();

  for (let day = 0; day < days; day += 1) {
    for (let hour = 0; hour < DAY_HOURS; hour += 1) {
      const now = start + (day * DAY_HOURS + hour) * HOUR_MS;
      // 逐小时推进 —— 与生产调度器同一个调用形状（world.hours = 1）
      const result = tickCreatures(
        current,
        { speciesById, locationIds: LOCATION_IDS, now, hours: 1 },
        createSeededRng(`${WORLD_SEED}:hour:${Math.floor(now / HOUR_MS)}`),
      );
      totals.migrate += result.migrations.length;
      totals.feed += result.feeds.length;
      totals.evolve += result.evolutions.length;
      totals.birth += result.births.length;
      totals.replenish += result.replenishes.length;
      totals.death += result.deaths.length;
      for (const entry of result.replenishes) {
        replenishedBySpecies.set(entry.speciesId, (replenishedBySpecies.get(entry.speciesId) ?? 0) + 1);
      }
      current = result.creatures;
    }
    dailyAlive.push(current.length);
  }

  const perLocation = new Map<string, number>();
  for (const creature of current) {
    perLocation.set(creature.locationId, (perLocation.get(creature.locationId) ?? 0) + 1);
  }
  // 「本来就没有栖息物种」的地点：初始播种就不会往这些地方放东西，
  // 补充机制也不该往那里放 —— 所以它们为空是**正确的**，不是缺陷。
  const hasHabitat = new Set(speciesList.flatMap((species) => [...species.habitat]));
  const emptyWithHabitat = LOCATION_IDS.filter(
    (id) => (perLocation.get(id) ?? 0) === 0 && hasHabitat.has(id),
  );
  const bySpecies = new Map<string, number>();
  for (const creature of current) {
    bySpecies.set(creature.speciesId, (bySpecies.get(creature.speciesId) ?? 0) + 1);
  }
  return {
    initial,
    alive: current.length,
    dailyAlive,
    emptyLocationsAtEnd: LOCATION_IDS.filter((id) => (perLocation.get(id) ?? 0) === 0).length,
    emptyWithHabitat,
    // 只看**有栖息物种**的地点的最小值 —— 没有栖息物种的地点恒为 0，不该拉低这个数
    minPerLocation: Math.min(...LOCATION_IDS.filter((id) => hasHabitat.has(id)).map((id) => perLocation.get(id) ?? 0)),
    totals,
    bySpecies: new Map([...bySpecies, ...(replenishEnabled ? [] : [])]),
  };
}

const days = Number(process.argv[2] ?? 30);

resetNumeric();
const withReplenish = run(days, true);
applyNumericOverrides({ creature: { ecology: { replenish: { chancePerLocation: 0 } } } });
const without = run(days, false);
resetNumeric();

const pct = (value: number, total: number): string => `${((value / total) * 100).toFixed(1)}%`;

/** 两种配置必须从同一个初态出发 —— 否则「补充有没有用」这个对比本身就不成立 */
function assertSameInitial(a: number, b: number): void {
  if (a !== b) throw new Error(`两次跑的初始播种数不一致（${a} vs ${b}），对比无效`);
}

console.log(`# M2.9 前置 1：世界补充机制长窗口验证（${days} 天）\n`);
console.log('| 指标 | 关闭补充（M2.8 现状） | 开启补充（M2.9） |');
console.log('| --- | --- | --- |');
console.log(`| 存活 | ${without.alive} | **${withReplenish.alive}** |`);
assertSameInitial(without.initial, withReplenish.initial);
console.log(`| 初始播种 | ${without.initial} | ${withReplenish.initial} |`);
console.log(
  `| 存活率 | ${pct(without.alive, without.initial)} | **${pct(withReplenish.alive, withReplenish.initial)}** |`,
);
console.log(`| 空地点数（共 ${LOCATION_IDS.length}） | ${without.emptyLocationsAtEnd} | ${withReplenish.emptyLocationsAtEnd} |`);
console.log(`| **有栖息物种却空着的地点** | ${without.emptyWithHabitat.length} | **${withReplenish.emptyWithHabitat.length}** |`);
console.log(`| 最少的地点生物数（仅有栖息物种的地点） | ${without.minPerLocation} | ${withReplenish.minPerLocation} |`);
console.log(`| 补充次数 | 0 | ${withReplenish.totals.replenish} |`);
console.log(`| 繁衍 | ${without.totals.birth} | ${withReplenish.totals.birth} |`);
console.log(`| 被捕食 / 衰亡 | ${without.totals.death} | ${withReplenish.totals.death} |`);
console.log(`| 捕食 | ${without.totals.feed} | ${withReplenish.totals.feed} |`);
console.log(`| 迁移 | ${without.totals.migrate} | ${withReplenish.totals.migrate} |`);
console.log('');
console.log('补充配置：', JSON.stringify(CREATURE.ecology.replenish));
console.log('');
console.log('开启补充后各物种存活：');
for (const [id, count] of [...withReplenish.bySpecies].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${id}: ${count}`);
}
console.log('');
console.log('（关闭补充的物种存活）');
for (const [id, count] of [...without.bySpecies].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${id}: ${count}`);
}
