/**
 * 物种模板的只读索引（M2.8）。
 *
 * 与 GeoIndex / InitiationIndex 同一手法：**纯数据 + 纯查询**，
 * 不认识数据库、不认识时钟。于是「老码头此刻可能有哪几种东西」在测试侧
 * 不需要启服务就能算出来。
 *
 * 注意它与库里的 creature_species 表的分工：
 *   这张索引用的是**内容侧**（creatures.yaml）的模板 —— 判定层读它；
 *   库里的那张是同一份内容的运行时副本，供世界状态外键引用与审计回溯。
 *   内容永远是真相，库里的副本只是为了让生物实例有个稳定的引用点。
 */
import type { CreatureSpecies } from './types.ts';

export class CreatureIndex {
  #byId = new Map<string, CreatureSpecies>();
  /** 地点 → 以它为栖息地的物种（顺序稳定，保证「同一份内容跑两遍同一个世界」） */
  #byLocation = new Map<string, CreatureSpecies[]>();

  constructor(speciesList: readonly CreatureSpecies[] = []) {
    // 先按 id 排序再建索引：构造函数拿到的顺序不该影响任何查询结果
    const sorted = [...speciesList].sort((a, b) => a.id.localeCompare(b.id));
    for (const species of sorted) {
      this.#byId.set(species.id, species);
      for (const locationId of species.habitat) {
        const list = this.#byLocation.get(locationId) ?? [];
        list.push(species);
        this.#byLocation.set(locationId, list);
      }
    }
  }

  byId(id: string): CreatureSpecies | null {
    return this.#byId.get(id) ?? null;
  }

  /**
   * 这个地点可能有哪几种生物（按栖息地）。
   * **这是「候选物种」而不是「此刻在那里的生物」**——后者要从库里读实例（CreatureRepo.atLocation）。
   */
  atLocation(locationId: string): CreatureSpecies[] {
    return (this.#byLocation.get(locationId) ?? []).slice();
  }

  /** 这个地点会不会有生物（遭遇挂点用它做 O(1) 的短路） */
  hasAtLocation(locationId: string): boolean {
    return (this.#byLocation.get(locationId) ?? []).length > 0;
  }

  all(): CreatureSpecies[] {
    return [...this.#byId.values()];
  }

  count(): number {
    return this.#byId.size;
  }
}
