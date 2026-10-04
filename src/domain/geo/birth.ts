/**
 * 出生城市（M2.7 主任务二）：**由 userId 确定性派生**。
 *
 * 为什么不是「每次创建时掷一次骰子」：任务书 §4.3 要求「出生是一次性的，不允许重选」。
 * 如果城市在每次 .创建 时重掷，玩家只要反复重发就能刷到想要的城市 —— 那等于可以重选，
 * 只是收了一点手续费。派生式分配把这条规则变成**结构性事实**：
 * 同一个 QQ 号永远落在同一座城市，途径不匹配时只能换途径，换不了城市。
 *
 * 三个附带好处：
 *   1. 实例测试可复现 —— 同一份 seed 必然跑出同一份地理分布；
 *   2. 虚拟玩家可以**预判**自己会落在哪，从而直接选合法的途径（否则它会在
 *      「创建失败 → 重试」上烧掉大量动作，把覆盖率打穿）；
 *   3. 服务端与测试侧共用同一份实现，永远不会各算各的。
 *
 * ⚠️ 这不是「按权重抽卡」的退化：权重仍然决定**玩家群的分布**（廷根 30% 的人），
 * 只是每个具体的人落在哪里是固定的。
 */
import { createSeededRng, seedFrom } from '../rng.ts';
import type { PathwayId } from '../character/types.ts';
import type { City } from './types.ts';

/**
 * 出生派生只关心四件事：身份、名字、开放途径、权重。
 * 做成结构类型而不是直接收 City，是为了让**虚拟玩家侧**能传自己的简化视图
 * （它不该为了建个号把整个 City 都装配一遍）——
 * 两边算的必须是同一个函数，否则测试侧预判的城市会与服务端不一致。
 */
export interface BirthCityLike {
  id: string;
  name: string;
  pathways: readonly PathwayId[];
  /** 出生权重；两种命名都认（内容侧是 birth_weight，虚拟玩家侧是 birthWeight） */
  birthWeight?: number;
  birth_weight?: number;
}

function weightOf(city: BirthCityLike): number {
  return city.birthWeight ?? city.birth_weight ?? 0;
}

/** 派生用的命名空间：改这个字符串会让全服的人重新分配城市（别随手改） */
export const BIRTH_CITY_TAG = 'birth-city';

/**
 * 某个玩家的出生城市。
 * 排序后加权：**先按 id 排序再掷骰**，这样结果只取决于 (userId, 城市集合)，
 * 与 cities.yaml 里的书写顺序无关 —— 否则调整一次 YAML 的段落顺序就会让全服搬家。
 */
export function birthCityOf<T extends BirthCityLike>(userId: string, cities: readonly T[]): T {
  const pool = cities
    .filter((city) => weightOf(city) > 0)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
  if (pool.length === 0) throw new Error('没有任何城市可以出生（所有 birth_weight 都是 0）');
  const rng = createSeededRng(seedFrom([BIRTH_CITY_TAG, userId]));
  const total = pool.reduce((sum, city) => sum + weightOf(city), 0);
  let roll = rng.next() * total;
  for (const city of pool) {
    roll -= weightOf(city);
    if (roll < 0) return city;
  }
  return pool[pool.length - 1]!;
}

export function birthCityIdOf<T extends BirthCityLike>(userId: string, cities: readonly T[]): string {
  return birthCityOf(userId, cities).id;
}

/**
 * 一撮样本的出生分布（报告用，不参与任何判定）。
 * 直接复用 birthCityOf，所以报告里的分布与真实分配**必然一致** —— 不是另算一遍。
 */
export function birthDistribution(
  userIds: readonly string[],
  cities: readonly BirthCityLike[],
): Array<{ cityId: string; cityName: string; count: number; weight: number }> {
  const counts = new Map<string, number>();
  for (const userId of userIds) {
    const id = birthCityIdOf(userId, cities);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return cities
    .filter((city) => weightOf(city) > 0)
    .slice()
    .sort((a, b) => weightOf(b) - weightOf(a))
    .map((city) => ({
      cityId: city.id,
      cityName: city.name,
      count: counts.get(city.id) ?? 0,
      weight: weightOf(city),
    }));
}
