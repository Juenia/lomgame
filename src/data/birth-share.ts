/**
 * 报告口径（**单一来源**，铁律 11）：一条途径的**期望出生占比**与**期望人数**。
 *
 * ## 这个数回答什么问题
 *
 * 跑小批时看到「某条途径 0 人」，第一个要问的不是「断链了吗」，而是「**它本来该有多少人**」。
 * 本模块就是那个分母。
 *
 * ## 它必须**输出计算依据**，而不只是数字（M2.26 续三 · 任务 2.5）
 *
 * `perfect` 那次的误判源头就是「只有数字、没有依据」：
 * 一个 4% 的小数摆在报告里，谁也没法当场复核它是怎么来的，
 * 于是它被当成事实用了两批。所以本模块返回的每一行都带**可复算的算式**与**逐城逐势力的贡献明细**。
 *
 * ## ⚠️ 口径在 M2.26 第二批被**整个换掉**过 —— 旧口径是错的
 *
 * ### 旧口径（错）：途径池权重 x 开放它的城市权重占比
 *
 *     share_old = (1 / OPEN_PATHWAYS.length) x (开放这条途径的城市权重和 / 全部城市权重)
 *
 * 它算的是「**画像偏好**抽到这条途径 **且** 出生城市恰好支持它」的概率。
 * 而这两件事**都不决定玩家最终入哪条途径**（见下），所以它给出的是个假数：
 *
 *   · 它给 perfect 算出 4.2%（50 人里 2.1 人）、给 reader 算出 2.5%（1.3 人）；
 *   · 于是「perfect = 0 人」被读成了「抽到 0 人的概率有 12%，属于抽样波动」；
 *   · **真实期望是 0**，那个 0 是结构性的。
 *
 * ### 新口径（对）：**本城引导势力**
 *
 *     share = Σ_城市 [ (城市权重 / 全部城市权重) x (本城传承这条途径的势力权重和 / 本城全部势力权重和) ]
 *
 * 依据（两条入途径的路都只认本城势力名单）：
 *   · 保底那条路 —— 每日结算从本城势力里挑一家（pickGuidedFaction，domain/initiation/guided.ts）；
 *   · 自己找那条路 —— 翻配方线索走的也是同一份本城势力名单（rollRecipeClue，domain/initiation/clue.ts）。
 * 势力权重是 NUMERIC.initiation.factionPriority（primary / secondary）。
 *
 * ## ⚠️ 它仍然只是**期望**，不是「应该有多少人」
 *
 * 不同势力的任务难度不同 ⇒ 完成率不同；材料掉落是概率的 ⇒ 凑齐率不同。
 * 所以个位数的人头偏差是正常的。它唯一的用途是分清**「期望 0」与「期望非 0 但抽到了 0」**——
 * 而那正是这个数存在的理由（K18：没人守的那一端）。
 *
 * ## 谁在用（三处必须用同一个函数，不能各算一遍）
 *
 * · `scripts/content-diagnostics.ts` §1（跑批前的现场读数）
 * · `scripts/m226-small-read.ts` §1（跑批后的四个数）
 * · `src/data/link-check.ts` 第 3 项「跑批可达」（M2.35 任务 1 新增）
 *
 * ## M2.35：它为什么在 `src/` 而不是 `scripts/`
 *
 * 链路检查器要能在 `loadContent()` 里被调用，而数据层不能反向依赖 `scripts/`。
 * 留在原地就只有两个选择：要么数据层反向依赖，要么**再写一份份额算法** ——
 * 后者正是铁律 11 / K16 一起禁掉的形状（M2.26 已经发生过一次「两边各算一遍、
 * 其中一边漏了城市份额」，见本文件 §「口径被整个换掉过」）。
 *
 * `scripts/birth-share-lib.ts` 保留为**转发**（不复制内容），两个脚本的 import 不变。
 */

export interface BirthShareSource {
  cityId: string;
  factionId: string;
  priority: string;
  /** 该城的出生权重原值（如 30） */
  cityWeight: number;
  /** 归一化后的城市占比（如 0.30） */
  cityShare: number;
  /** 本城引导势力**家数** */
  localFactionCount: number;
  /** 本城全部势力的权重和（primary 0.7 + secondary 0.3 + …） */
  localWeightSum: number;
  /** 这一家的权重（primary 0.7 / secondary 0.3） */
  factionWeight: number;
  /** 这一家在本城势力里分到的份额 */
  factionShare: number;
  /** cityShare x factionShare —— 这一家贡献给该途径的期望占比 */
  contribution: number;
  /** 这一格的算式（**可复算**，如 0.30x(0.7/1.00) = 0.2100） */
  term: string;
}

export interface ExpectedAt {
  players: number;
  expected: number;
  /** 一个都没抽到的概率：(1 - share) ^ players */
  zeroProbability: number;
}

export interface BirthShare {
  pathway: string;
  /** 绑了这条途径的教会 id；没有教会（如 seer）为 null */
  churchId: string | null;
  /** cities.yaml 里开放它的城市（出生白名单） */
  openCities: string[];
  /** 哪些城市的哪些势力在传承它 —— 明细，出问题时看这一列 */
  sources: BirthShareSource[];
  /** 新口径：本城引导势力决定的期望占比 */
  share: number;
  /** 期望人数，**按人数档**给（默认 50 / 200），每档带 P(0) */
  expectedBy: ExpectedAt[];
  /** 算式总串（可复算）：各城各势力那一项相加 */
  formula: string;
  /** 全部城市权重之和（复算用） */
  cityWeightTotal: number;
  /** 旧口径（途径池 x 城市白名单）—— **保留只为对照与解释历史报告**，别再用它下结论 */
  legacyShare: number;
}

/** `cities.yaml` 里城市的出生权重（snake_case 为准，兼容 camelCase） */
export function cityWeightOf(city: unknown): number {
  const row = city as { birth_weight?: number; birthWeight?: number };
  return Number(row.birth_weight ?? row.birthWeight ?? 0);
}

export interface BirthSharesOptions {
  cities: readonly unknown[];
  /** 权威清单（`OPEN_PATHWAYS`），**不要在这里手抄一份** */
  pathways: readonly string[];
  /** `factions.yaml` 的引导势力：{ id, cityId, pathway, priority } */
  factions: readonly unknown[];
  /** `NUMERIC.initiation.factionPriority` */
  priorityWeight: { primary: number; secondary: number };
  /** 期望人数按哪几档给（默认 50 / 200 —— 小批与大规模各一档） */
  expectAt?: readonly number[];
  /** 绑了途径的教会（用来显示归属）；可省 */
  churchOf?: (pathway: string) => string | null;
}

function weightOfPriority(priority: string, table: { primary: number; secondary: number }): number {
  return priority === 'primary' ? table.primary : table.secondary;
}

/** 逐条算期望 —— 口径见文件头。两个脚本共用这一份。 */
export function birthShares(options: BirthSharesOptions): BirthShare[] {
  const { cities, pathways, factions, priorityWeight } = options;
  const expectAt = options.expectAt ?? [50, 200];
  const churchOf = options.churchOf ?? (() => null);

  let totalCityWeight = 0;
  for (const city of cities) totalCityWeight += cityWeightOf(city);

  const openCities = new Map<string, string[]>();
  for (const pathway of pathways) openCities.set(pathway, []);
  for (const city of cities) {
    const row = city as { id: string; pathways?: readonly string[] };
    for (const pathway of row.pathways ?? []) {
      const list = openCities.get(pathway);
      if (list) list.push(row.id);
    }
  }

  const sources = new Map<string, BirthShareSource[]>();
  for (const pathway of pathways) sources.set(pathway, []);

  for (const raw of cities) {
    const city = raw as { id: string };
    const cityWeight = cityWeightOf(raw);
    const cityShare = totalCityWeight === 0 ? 0 : cityWeight / totalCityWeight;
    const local = factions.filter((faction) => (faction as { cityId: string }).cityId === city.id);
    if (local.length === 0) continue;
    let localWeightSum = 0;
    for (const faction of local) {
      localWeightSum += weightOfPriority((faction as { priority: string }).priority, priorityWeight);
    }
    if (localWeightSum === 0) continue;
    for (const faction of local) {
      const row = faction as { id: string; pathway: string; priority: string };
      const list = sources.get(row.pathway);
      if (!list) continue; // 这条途径不在权威清单里（理论上不该发生）
      const factionWeight = weightOfPriority(row.priority, priorityWeight);
      const factionShare = factionWeight / localWeightSum;
      const contribution = cityShare * factionShare;
      list.push({
        cityId: city.id,
        factionId: row.id,
        priority: row.priority,
        cityWeight,
        cityShare,
        localFactionCount: local.length,
        localWeightSum,
        factionWeight,
        factionShare,
        contribution,
        term:
          cityShare.toFixed(2) + 'x(' + factionWeight.toFixed(1) + '/' + localWeightSum.toFixed(2) + ')' +
          ' = ' + contribution.toFixed(4),
      });
    }
  }

  const poolWeight = pathways.length === 0 ? 0 : 1 / pathways.length;
  return pathways.map((pathway) => {
    const list = sources.get(pathway) ?? [];
    let share = 0;
    for (const source of list) share += source.contribution;
    const opened = openCities.get(pathway) ?? [];
    let openedWeight = 0;
    for (const raw of cities) {
      const row = raw as { id: string };
      if (opened.indexOf(row.id) >= 0) openedWeight += cityWeightOf(raw);
    }
    const legacyShare = poolWeight * (totalCityWeight === 0 ? 0 : openedWeight / totalCityWeight);
    return {
      pathway,
      churchId: churchOf(pathway),
      openCities: opened,
      sources: list,
      share,
      expectedBy: expectAt.map((players) => ({
        players,
        expected: share * players,
        zeroProbability: Math.pow(1 - share, players),
      })),
      formula:
        list.length === 0
          ? '0 —— 没有任何引导势力传承它（期望恒为 0，与人数无关）'
          : list.map((source) => source.term).join(' + '),
      cityWeightTotal: totalCityWeight,
      legacyShare,
    };
  });
}

/** 定宽右补空格（两个脚本的表格共用） */
export function pad(text: string, width: number): string {
  return (text + ' '.repeat(width)).slice(0, width);
}
