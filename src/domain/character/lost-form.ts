/**
 * 堕落形态（M2.76）—— **失控不是「随机抽一句话」，而是进入该途径特有的一个形态**。
 *
 * ## 为什么要有这一层
 *
 * 在此之前，失控的后果（HP −10—30 / MAD +5 / 持续 1 天）是 `NUMERIC.tick` 里的**三个全局常数**，
 * 与途径完全无关；唯一按途径分的东西是「抽到哪句文案」。于是七条途径的失控在机制上一模一样 ——
 * 而原著里不是这样：愚者失控是**看见得太多**，战士是**暴力压不住**，母亲是**身体在长**。
 *
 * ## 这一层只放「类型 + 纯函数」，不放数据
 *
 * 形态的**内容**住在 `src/cards/lost-control.yaml` 的 `forms:` 段（可加、可改、后台可编辑），
 * 这里只声明形状与选择规则。依赖方向因此是单向的：`cards` → `domain`，
 * 判定层不读文件（铁律 1）。
 *
 * ## 数据要能开放地加
 *
 * 一条途径可以有**任意多个**形态（按 `min_seq` 分档、按 `weight` 配比），
 * 加形态 = 往 YAML 里加一段，**不改代码**。
 */
import { weightedPick } from '../random.ts';
import type { PathwayId, Rng } from './types.ts';

/**
 * 一个堕落形态。
 *
 * ⚠️ 每个字段都会在 `src/cards/lost-control.schema.ts` 里**显式声明**（铁律 9）——
 * 没声明的字段会被静默剥掉，而这里 `readonly` 的类型不会替你报错。
 */
export interface LostForm {
  id: string;
  pathway: PathwayId;
  /** 形态名（玩家看到的那个：「窥视者」「血怒者」…） */
  name: string;
  /**
   * **可进入的最高序列**（数字越小要求越高，与卡片/locations 的 `min_seq` 同一口径）：
   * `9` = 新号也能进；`5` = 序列 5 及以下（更高）才够得着。
   *
   * ⚠️ 判据是 `sequence <= minSeq`，**不是 `>=`** —— 这一条在 M2.76 落地时写反过一次，
   * 症状是「高序列反而没有任何形态可选」（序列 4 时 `4 >= 9` 与 `4 >= 5` 全为假），
   * 而返回 null 又是合法值（走全局缺省），所以**不报错、只是静默降级**。
   */
  minSeq: number;
  /** 同途径内多个形态的抽取权重（必须 > 0，加载期就挡） */
  weight: number;
  hpLossMin: number;
  hpLossMax: number;
  madGain: number;
  corGain: number;
  /** 私聊正文里那句「你现在是什么样」 */
  blurb: string;
  /** 群播报（别人看到的） */
  group: string;
}

/**
 * 按途径与序列挑一个形态。
 *
 * 返回 `null` 的三种情形都**不是错误**，调用方要能接受（并回落到全局缺省后果）：
 *   1. 该途径还没有写形态（内容未落地的途径）；
 *   2. 该序列下没有任何形态够得着（`min_seq` 全部更深）；
 *   3. 候选的权重全为 0 —— 这是**内容错误**，但它由加载期拦（schema 要求 weight > 0），
 *      运行期不再猜一个「等概率」出来：猜了就等于把「写错」变成「照常跑」。
 *
 * ⚠️ **只掷一次骰**，且**复用 `weightedPick`**（铁律 7：同一件事不写第二份实现 ——
 * 按权重抽取全仓只有 `domain/random.ts` 那一份，自己再写一遍就会在
 * 「平局/边界/零权重」这些边角上和它悄悄分叉）。
 *
 * 铁律 6「不该掷骰时不掷」在这里的落点是：**没触发失控就走不到这个函数**
 * （调用点在 `planCharacterTick` 的 `if (triggered)` 分支里）。
 */
export function pickLostForm(
  forms: readonly LostForm[],
  pathway: PathwayId,
  sequence: number,
  rng: Rng,
): LostForm | null {
  const candidates = forms.filter((form) => form.pathway === pathway && sequence <= form.minSeq);
  if (candidates.length === 0) return null;
  return weightedPick(candidates, (form) => form.weight, rng);
}

/**
 * 该 (途径, 序列) 下的形态分布 —— **只供报告、后台与可见性预算读**，不参与判定。
 *
 * 与 `pickLostForm` 共用同一份过滤条件（同一处写两遍过滤就会漂）。
 */
export function lostFormDistribution(
  forms: readonly LostForm[],
  pathway: PathwayId,
  sequence: number,
): Array<{ id: string; name: string; weight: number }> {
  return forms
    .filter((form) => form.pathway === pathway && sequence <= form.minSeq)
    .map((form) => ({ id: form.id, name: form.name, weight: form.weight }));
}
