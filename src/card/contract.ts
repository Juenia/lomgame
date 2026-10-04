/**
 * 角色卡数据契约（M2.47）：**CharacterState → 卡面数据**的唯一映射点。
 *
 * ## 为什么要有这一层
 *
 * 卡面是游戏数据的**投影**，不是另画一张图。映射散在渲染器里会立刻出问题：
 * 渲染器只拿到字符串，没人能回答「这个 84 是 HP 还是别的」—— 参照卡上的
 * 「幸运 9 / 神秘」正是这么来的：**画面上的数字没有出处**。
 * 所以规矩是：**卡面每个数字都在这里从字段算出来，渲染器一个数字都不许自己编**。
 *
 * ## 与 render.ts 的分工
 *   本模块：纯函数，无 IO —— 角色 + 已查好的事实（城市名/教会名/晋升率）→ 卡面数据
 *   render.ts：拿着卡面数据去调 Edge 出图（画什么在 template.ts）
 * 城市名、教会名、晋升成功率需要仓储/判定层，由**调用方**查好传进来（见 CardFacts）。
 * 这样本模块保持纯函数，可被测试直接构造，不必起数据库。
 *
 * ## 不可达序列
 * 序列 1/0 本版没有配方（`PLAYER_REACHABLE_SEQUENCE`），但卡面模板要画得出 ——
 * 画的时候用 `seqNote` 明说「本版不可达」，**不允许**画成一张看起来能升上去的卡。
 */

import { PATHWAY_LABELS } from '../domain/character/rules.ts';
import { isInitiated, type CharacterState } from '../domain/character/types.ts';
import type { CharacterCardData } from './render.ts';
import { PLAYER_REACHABLE_SEQUENCE, playableSequence, sequenceTitle } from './titles.ts';

/** 调用方查好的事实：卡面渲染层不碰仓储 */
export interface CardFacts {
  /** 当前城市名（`currentCityId` 解出来的中文） */
  cityName?: string;
  /** 所属教会名 */
  churchName?: string;
  /** 晋升成功率（0—1，由 computePromotionSuccess 算好传进来） */
  promotionSuccess?: number;
  /** 失控闸门（由 lossOfControlThresholdFor 算好） */
  lossGate?: { mad: number; cor: number };
  /** 已下载到本地的 QQ 头像路径；没有就走首字纹章 */
  avatarPath?: string;
}

/** 卡面顶上一行小字 */
const TOP_LABEL = '诡 秘 之 主';

/** 立绘缺失时卡面不会空着 —— 渲染器用名字首字画纹章，这里不造占位数据。 */

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * 卡面上的数值一律取整。
 *
 * 为什么必须有这一步：`dig` 是**浮点**（`computeDigNext` 按权重累加 0.6/0.3/0.1/0.5），
 * 真实库里的值长这样：8.5999999、12.300000000000001。直接印上去，
 * 卡面就会出现「消化 8.5999999」——**这不是玩家的数值，是浮点误差**。
 * 状态卡（`renderStatus`）一直是取整显示的，卡面必须同口径，否则同一份数据两个数。
 */
function whole(value: number): number {
  return Math.round(value);
}

function footnotes(facts: CardFacts): string | undefined {
  const parts: string[] = [];
  if (facts.promotionSuccess !== undefined) parts.push(`晋升成功率 ${percent(facts.promotionSuccess)}`);
  if (facts.lossGate) parts.push(`失控闸门 MAD ${facts.lossGate.mad} / COR ${facts.lossGate.cor}`);
  return parts.length > 0 ? parts.join('　·　') : undefined;
}

function identityLine(state: CharacterState, facts: CardFacts): string | undefined {
  const parts: string[] = [];
  // 城市不在这里拼：卡面上它有自己的位置（名字下方 + 定位图标），挤在这一行会看不出是"位置"
  if (facts.churchName) {
    const devotion = state.churchContribution ?? 0;
    parts.push(`☩ ${facts.churchName} · 虔诚 ${devotion}`);
  }
  return parts.length > 0 ? parts.join('　') : undefined;
}

/**
 * 角色卡数据。
 *
 * 普通人（未入途径）走单独一条分支：卡面写「还没有途径」，
 * **不写序列、不写序列徽章**（M2.7.6 口径：`序列 null` 不许出现在任何玩家可见的地方）。
 */
export function characterCardData(state: CharacterState, facts: CardFacts = {}): CharacterCardData {
  const base: CharacterCardData = {
    topLabel: TOP_LABEL,
    avatarPath: facts.avatarPath,
    pathway: state.pathway ?? 'mortal',
    name: state.name,
    genderTag: state.gender === 'male' ? '男' : '女',
    pathwayLine: '还没有途径',
    bars: [
      { label: '† 生命', value: whole(state.hp), max: 100 },
      // 普通人的灵性上限是 50（renderStatus 同口径）
      /*
       * 上限必须与"当前值"同口径截断：普通人 mp 上限 50，而库里可能存着 100
       * （早期建号或跨版本数据），直接画就是"100/50 + 满格溢出"。
       * 取 min 而不是只截显示值 —— 进度条与数字要指向同一个事实。
       */
      { label: '◈ 灵性', value: Math.min(whole(state.mp), isInitiated(state) ? 100 : 50), max: isInitiated(state) ? 100 : 50 },
      { label: '☾ 理智', value: whole(100 - state.mad), max: 100 },
    ],
    costs: [
      { label: '✜ 疯狂', value: String(whole(state.mad)) },
      { label: '✠ 污染', value: String(whole(state.cor)) },
      { label: '⚗ 消化', value: String(whole(state.dig)) },
    ],
    fields: [
      { label: '❖ 命运', value: `${state.dp}/10` },
    ],
    city: facts.cityName,
    identity: identityLine(state, facts),
    footnote: footnotes(facts),
  };
  if (!isInitiated(state)) return base;

  const label = PATHWAY_LABELS[state.pathway];
  const title = sequenceTitle(state.pathway, state.sequence);
  const reachable = playableSequence(state.sequence);
  return {
    ...base,
    title,
    pathwayLine: `${label}途径 · 序列 ${state.sequence}`,
    seqLabel: `序列 ${state.sequence}`,
    seqNote: reachable ? undefined : `本版不可达（最高 ${PLAYER_REACHABLE_SEQUENCE}）`,
  };
}
