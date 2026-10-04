/**
 * 本地势力的只读索引（M2.7.6；M2.85 起服务于线索的途径落点）。
 *
 * 与 GeoIndex 同一手法：**纯数据 + 纯查询**，不认识数据库、不认识时钟。
 * 于是「这个人在廷根，谁会来找他」在测试侧不需要启服务就能算出来
 * （虚拟玩家要预判本城的线索会指向哪条途径）。
 */
import type { GuidedFaction } from './types.ts';

export class InitiationIndex {
  #byCity = new Map<string, GuidedFaction[]>();
  #byId = new Map<string, GuidedFaction>();

  constructor(factions: readonly GuidedFaction[] = []) {
    for (const faction of factions) {
      this.#byId.set(faction.id, faction);
      const list = this.#byCity.get(faction.cityId) ?? [];
      list.push(faction);
      this.#byCity.set(faction.cityId, list);
    }
  }

  /**
   * 这座城市的本地势力。
   * 顺序稳定（先 primary 后 secondary、同档按 id 排序），
   * 所以「同一份内容跑两遍得到同一个世界」这件事在途径落点上也成立。
   */
  factionsOfCity(cityId: string | null | undefined): GuidedFaction[] {
    if (!cityId) return [];
    return (this.#byCity.get(cityId) ?? []).slice().sort((a, b) => {
      if (a.priority !== b.priority) return a.priority === 'primary' ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
  }

  byId(id: string): GuidedFaction | null {
    return this.#byId.get(id) ?? null;
  }

  all(): GuidedFaction[] {
    return [...this.#byId.values()];
  }

  count(): number {
    return this.#byId.size;
  }
}
