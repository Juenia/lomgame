/**
 * 正神教会领域（M2.15）的对外入口。
 *
 * 层次（本轮只有这两层，其余是后续轮次）：
 *   schema.ts     内容表的 zod 定义（YAML 写错了在启动时报错）
 *   territory.ts  动态据点：纯 seed 派生的函数，现场算、不落库
 *   index.ts      只读索引 ChurchIndex（纯数据 + 纯查询，不认识数据库、不认识时钟）
 *
 * `ChurchIndex` 与 `InitiationIndex`（M2.7.6）是同一个手法：
 * 「这个人在哪座城市、能遇到哪几家教会、他们此刻占着哪几个地点」
 * 在测试侧不需要启服务就能算出来。
 *
 * 与 `GeoIndex` 的区别只在**数据从哪来**：地理三表落库（`regions` / `cities` / `routes`），
 * 教会**不落库** —— 它是骨架，不是世界状态；会随世界演化的那一半（据点）在 territory.ts 里现场算。
 */
import type { PathwayId } from '../character/types.ts';
import type { LocationDef } from '../explore/location.ts';
import type { City } from '../geo/types.ts';
import type { ChurchDef, Relation } from './schema.ts';
import { churchTerritoryAt } from './territory.ts';

export * from './schema.ts';
export * from './territory.ts';

/**
 * 关系索引的 key。
 *
 * 任务书 C1 写的是 `ReadonlyMap<[idA, idB], Relation>` —— 但 JS 的 Map 对**数组 key**
 * 是按引用比较的，`['a','b']` 与 `['b','a']` 是两个不同的键，那份映射查不出任何东西。
 * 所以这里把一对 id 规范化成**排序后拼接的字符串**：两个键只存一份，
 * 对称性从「记得两边都查」变成**结构上的事实**。
 */
function relationKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export class ChurchIndex {
  #byId = new Map<string, ChurchDef>();
  /**
   * 途径 → 教会。
   * **一对一**（教会与途径强绑定，七正神各走一条）—— loader 里的交叉校验守着这条不变式，
   * 所以这里用 Map 而不是「一个途径对应一串教会」：后者会让 M2.16 的「你能入哪家教会」
   * 变成一个需要再拍一次板的问题。
   */
  #byPathway = new Map<PathwayId, ChurchDef>();
  #byCity = new Map<string, ChurchDef[]>();
  /** 静态关系的规范化索引（key 见 `relationKey`）：只存非中立的对 */
  #relations = new Map<string, Relation>();
  /** 城市 id → 该城的落脚地点 id（cities.yaml 的 center）：seats（城市）与据点（地点）之间的那一次映射 */
  #centers = new Map<string, string>();
  /** 地点 id → 邻居地点 id（无向：内容侧声明单边即可，与 M2.2 的天气扩散同一口径） */
  #adjacency = new Map<string, string[]>();

  constructor(
    churches: readonly ChurchDef[] = [],
    cities: readonly City[] = [],
    locations: readonly LocationDef[] = [],
  ) {
    for (const church of churches) {
      this.#byId.set(church.id, church);
      if (church.pathway) this.#byPathway.set(church.pathway, church);
      for (const seat of church.seats) {
        const list = this.#byCity.get(seat) ?? [];
        list.push(church);
        this.#byCity.set(seat, list);
      }
      for (const [otherId, relation] of Object.entries(church.relations)) {
        /*
         * 两侧都声明时值必然相同（loader 的对称性校验守着），所以谁后写都一样 ——
         * 这条「谁后写都一样」正是把关系做成规范化 key 换来的性质。
         */
        this.#relations.set(relationKey(church.id, otherId), relation);
      }
    }
    for (const city of cities) this.#centers.set(city.id, city.center);
    for (const location of locations) {
      for (const next of location.adjacent) {
        this.#addEdge(location.id, next);
        this.#addEdge(next, location.id);
      }
    }
  }

  #addEdge(from: string, to: string): void {
    const list = this.#adjacency.get(from) ?? [];
    if (!list.includes(to)) list.push(to);
    this.#adjacency.set(from, list);
  }

  byId(id: string): ChurchDef | null {
    return this.#byId.get(id) ?? null;
  }

  /** 全部教会，**按内容表顺序**（YAML 里怎么写的就怎么返回；同一份内容两遍得到同一个世界） */
  all(): ChurchDef[] {
    return [...this.#byId.values()];
  }

  count(): number {
    return this.#byId.size;
  }

  /* ==================== 任务 A：内容查询 ==================== */

  /** 这条途径属于哪家教会；没绑（途径未实现）或不是正神教会 → null */
  ofPathway(pathway: PathwayId): ChurchDef | null {
    return this.#byPathway.get(pathway) ?? null;
  }

  /**
   * 途径**已经实现**的教会（`pathway !== null`）。
   * M2.16 的入教判定只会看到这一批 —— 这是本轮「先绑能绑的、其余标待定」的直接结果。
   */
  bound(): ChurchDef[] {
    return this.all().filter((church) => church.pathway !== null);
  }

  /** 途径待定的教会（`pathway === null`）：内容表已声明，等途径实现之后搬进 pathway */
  pending(): ChurchDef[] {
    return this.all().filter((church) => church.pathway === null);
  }

  /**
   * 据点在**这座城市**的教会。
   * 顺序稳定（按 id 排序），与 `InitiationIndex.factionsOfCity` 一个口径。
   */
  churchesOfCity(cityId: string | null | undefined): ChurchDef[] {
    if (!cityId) return [];
    return (this.#byCity.get(cityId) ?? []).slice().sort((a, b) => a.id.localeCompare(b.id));
  }

  /* ==================== 任务 C：教会间关系 ==================== */

  /**
   * 两家教会之间的关系。三条性质与内容表**无关**，是这个方法自己保证的：
   *
   *   - **对称**：`relationOf(a, b) === relationOf(b, a)`（规范化 key 的必然结果）；
   *   - **自反为中立**：`relationOf(a, a) === 'neutral'`（内容表里不许声明自指，loader 挡着）；
   *   - **未声明即中立**：YAML 里只写非中立的对，其余 21 对里没有写到的全是 neutral；
   *   - 未登记的 id 也返回 neutral —— 关系表只对登记过的教会负责，写错 id 由 loader 挡住，
   *     不会悄悄降级成「这两家是敌人」。
   */
  relationOf(a: string, b: string): Relation {
    if (a === b) return 'neutral';
    return this.#relations.get(relationKey(a, b)) ?? 'neutral';
  }

  /**
   * 规范化之后的关系表（只读视图）：21 对里**已声明**的那些。
   * 给报告与测试用；判定层请走 `relationOf`（那里才是「未声明即中立」的语义）。
   */
  relationEntries(): ReadonlyMap<string, Relation> {
    return this.#relations;
  }

  /* ==================== 任务 B：动态据点 ==================== */

  /**
   * 静态据点：`seats`（城市 id）→ 该城的**落脚地点**（`cities.center`），去重排序。
   *
   * 为什么用 center 而不是另找一座「教堂」地点：`center` 是城市已有的权威落点
   * （玩家抵达这座城市时落脚的地方，通缉系统读的 `flags.loc` 就是它）——
   * 本轮不新增地点，也就不需要在这里编一个「某某大教堂」出来。
   */
  baseLocationsOf(churchId: string): readonly string[] {
    const church = this.#byId.get(churchId);
    if (!church) return [];
    const ids = new Set<string>();
    for (const seat of church.seats) {
      const center = this.#centers.get(seat);
      if (center) ids.add(center);
    }
    return [...ids].sort();
  }

  /**
   * 这家教会在时刻 t 占据的地点（静态据点 + 本窗口的动态扩张）。
   *
   * 薄薄一层：把内容侧的 `seats` 映射成地点、把邻接图交给纯函数，
   * 真正的判定全在 `territory.ts` 里（那里可以在测试侧脱离索引直接调用）。
   * 未登记的教会 id → 空数组（不是抛错：查询一个不存在的教会不是异常，是「没有」）。
   */
  territoryAt(seed: string, t: number, churchId: string): readonly string[] {
    if (!this.#byId.has(churchId)) return [];
    return churchTerritoryAt(seed, t, churchId, this.baseLocationsOf(churchId), this.#adjacency);
  }
}
