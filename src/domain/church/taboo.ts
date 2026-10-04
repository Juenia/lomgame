/**
 * 教义判据的匹配（M2.17 任务 B）—— **判定层纯函数，没有任何 IO、没有 rng**。
 *
 * ## 它在整条链上的位置
 *
 *   内容层   churches.yaml 的 taboos[].when      （写死一份判据）
 *   判定层   本文件 matchTaboos()                （纯函数：动作 + 地点 + 档位 → 违反清单）
 *   命令层   router/commands/taboo-hooks.ts      （读库拿教会/档位、走 applyWithCaps、落事件、拼回执）
 *
 * ## 为什么违反判定**不取 rng**
 *
 * 「这一步有没有违反教义」是一个**确定性**问题：读 flag（我入了哪家教、第几档）
 * 加读指令（我做了什么、在哪）就够了。取一个随机数不会让它更正确，
 * 只会把同 seed 的后续分支整体偏移一位 —— 那正是 M2.16 那 5.2 pp 的来路
 * （见 docs/M2.17-vplayer行为规范.md §一）。
 *
 * 所以这里的契约是一句话：**同输入 → 同输出，且不消耗任何随机性**。
 */
import { NUMERIC } from '../../config/numeric.ts';
import type { ChurchDef, TabooAction, TabooTarget, TabooWhen } from './schema.ts';

/** 一次判定的输入：**全部是事实**，没有一个字段需要再查库 */
export interface TabooMatchInput {
  action: TabooAction;
  /**
   * 玩家**此刻**所在的地点 id。
   *   .探索 —— 刚探索的那个地点（不是出发地）
   *   .使用 / .仪式 —— 脚下地点（flags 里的 loc）
   * 不在任何被打点的地点时是 null（null 不匹配任何写了 location 的判据）。
   */
  locationId: string | null;
  /** 此刻所在城市 id；null 不匹配任何写了 cityId 的判据 */
  cityId: string | null;
  /** 当前档位索引（0 起）。没入教的人不会走到这里 —— 教义只管自己人 */
  rank: number;
  /**
   * M2.18（F）：**战斗类判据的目标情形**（只有 action 是 challenge / battle 时才有值）。
   * 命令层算好传进来 —— 判定层不认识战斗状态，与 relation 同一个手法。
   */
  target?: TabooTarget;
  church: ChurchDef;
}

export interface TabooViolation {
  churchId: string;
  tabooId: string;
  /** 给玩家看的短句（内容表里的 text，原样带出） */
  text: string;
  penalty: { mad: number; cor: number };
}

/**
 * 这一步的**动作类型**是不是配置里声明要检查的那几类。
 *
 * 命令层在三个 handler 里都会调进来看一眼 —— 于是
 * NUMERIC.church.taboo.checkAfter 是一个**真的开关**：
 * 把 'explore' 从数组里删掉，.探索 之后就真的不检查了（测试守着这条）。
 */
export function isTabooChecked(action: TabooAction): boolean {
  return NUMERIC.church.taboo.checkAfter.includes(action);
}

/** 单条判据是否命中（多字段 AND，缺省字段不参与） */
function whenMatches(when: TabooWhen, input: TabooMatchInput): boolean {
  if (when.action !== undefined && when.action !== input.action) return false;
  if (when.location !== undefined && when.location !== input.locationId) return false;
  if (when.cityId !== undefined && when.cityId !== input.cityId) return false;
  // rankBelow / rankAbove 是**适用范围**：越界 = 这条禁忌管不到他，不是「违反了」
  if (when.rankBelow !== undefined && input.rank < when.rankBelow) return false;
  if (when.rankAbove !== undefined && input.rank > when.rankAbove) return false;
  // M2.18（F）：目标情形——不填 target 的判据不看这一位；填了就必须相等
  if (when.target !== undefined && when.target !== input.target) return false;
  return true;
}

/**
 * 这一家教会、这一步动作，违反了哪些禁忌。
 *
 * 返回**全部**命中的条目（不是第一条就短路）：两条判据同时命中时，
 * 回执要把两条都念给玩家听 —— 只报一条会让「我改了这一个怎么还被扣」变成玄学。
 */
export function matchTaboos(input: TabooMatchInput): TabooViolation[] {
  const found: TabooViolation[] = [];
  for (const taboo of input.church.taboos) {
    const when = taboo.when;
    // 纯声明的禁忌（五家占位教会那十五条）不参与判定
    if (!when) continue;
    if (!whenMatches(when, input)) continue;
    found.push({
      churchId: input.church.id,
      tabooId: taboo.id,
      text: taboo.text,
      penalty: { mad: taboo.penalty?.mad ?? 0, cor: taboo.penalty?.cor ?? 0 },
    });
  }
  return found;
}

/**
 * 把多条违反的代价合并成一次扣罚（乘上 NUMERIC.church.taboo.penaltyMultiplier）。
 *
 * 只做加法与一次倍率：倍率是「整轮调难度」用的旋钮，
 * 落在**这里**而不是每条判据里 —— 否则调一次数值要改 21 行 YAML。
 */
export function mergeTabooPenalties(
  violations: readonly TabooViolation[],
): { mad: number; cor: number } {
  const multiplier = NUMERIC.church.taboo.penaltyMultiplier;
  let mad = 0;
  let cor = 0;
  for (const violation of violations) {
    mad += violation.penalty.mad;
    cor += violation.penalty.cor;
  }
  return { mad: Math.round(mad * multiplier), cor: Math.round(cor * multiplier) };
}
