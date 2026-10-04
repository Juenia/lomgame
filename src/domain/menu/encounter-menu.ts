/**
 * 遭遇菜单（M2.8）：把一次遭遇摆成可点的选项。
 *
 * 与其它菜单同一口径（domain/menu/types.ts 的三条硬约束）：
 *   1. 纯函数 —— (character, sighting) → Menu，不读库、不掷骰、不看时钟；
 *   2. 每个选项的 command 是**完整指令原文**（'遭遇 观察'），菜单只是入口；
 *   3. '0. 自己写一个行为' 由渲染层统一补。
 *
 * ⚠️ 这里**没有攻击选项**。M2.8 不做战斗，遭遇只有四个动作
 * （外加普通人专属的「站着不动」）—— 战斗是 M2.9 的活。
 */
import { BATTLE as CREATURE_BATTLE, CREATURE } from '../../config/numeric.ts';
import { sequenceGapHint } from '../battle/state.ts';
import { actionLabel } from '../creature/perception.ts';
import type { PerceptionLayer, SightingAction } from '../creature/types.ts';
import type { Menu } from './types.ts';

export interface EncounterMenuView {
  /** 地点显示名 */
  locationName: string;
  /** 天气 / 时段的氛围词，例如「雾天」「夜晚」 */
  weatherLabel: string;
  /**
   * M2.70：**标题里那一句氛围**（物种的 `flavor`；空则退回物种名，不可见时留空）。
   *
   * 它是 `creature.flavor` 的落点 —— 那个字段从 M2.8 起就写在 11 个物种上
   * （「雾比刚才厚了一点。」「你听见自己刚才说过的一句话。」），
   * 而 `creatures.ts` 把它存进库之后再没有任何地方读过（台账 B2-4）。
   * 不传 = 标题与加这一层之前逐字相同。
   */
  flavor?: string;
  /** 玩家在**这一层**看到的文本 */
  text: string;
  layer: PerceptionLayer;
  /** 这一层允许的动作 */
  allowedActions: readonly SightingAction[];
  /** 行为旁白（可能没有） */
  behaviorText?: string | null;
  /** 玩家是不是普通人 —— 决定「站着不动」在不在 */
  mortal: boolean;
  /**
   * M2.10 前置 2：**序列差**（`玩家序列 − 生物序列`，**正数 = 玩家更弱**）。
   *
   * 只用来在「动手」那一项上写一句风险提示 —— **不改任何判定**。
   * 为什么要给这一句：M2.9 实测 33 场战斗里玩家胜 4 / 败 12 / 逃 12，
   * 而玩家在按下「动手」之前**看不到**自己在冒什么险（感知分层只告诉他
   * 「看得清 / 看不清」，不告诉他打不打得过）。真人连续被打败会劝退。
   *
   * 不给就是「未知」（M2.8 的既有调用点不用改）。
   */
  sequenceGap?: number;
}

/** 动作 → 一行说明（预览列）。只给「能感到」的定性描述，不给精确数值。 */
function previewOf(action: SightingAction): string {
  const a = CREATURE.actions;
  switch (action) {
    case 'observe':
      return a.observe.madGain > 0 ? '免费 · 会想得多一点' : '免费';
    case 'confront':
      return '逼它先动 · 精神压力';
    case 'retreat':
      return '一定走得掉';
    case 'interact':
      return `花 ${a.interact.mpCost} 灵力`;
    case 'hold':
      return '不动';
    default:
      return '';
  }
}

/**
 * M2.10 前置 2：「动手」那一项的风险提示。
 *
 * **这不是平衡调整，是显示层。** 一个数值都没动 —— 只把「你比它弱几个序列」
 * 这件事在玩家按下按钮之前说出来。
 *
 * 四种说法对应四种真实处境（倍率来自 M2.6.1 的 `sequenceGating`，这里只是转成人话）：
 *   弱 3 级及以上  你根本近不了它的身（打起来就是白挨）
 *   弱 1—2 级      命中与伤害都被大幅压制
 *   同序列         势均力敌
 *   强 1 级及以上  你比它强（打得动）
 */
function fightPreview(gap: number | undefined): string {
  const rounds = `最多 ${CREATURE_BATTLE.maxRounds} 回合`;
  if (gap === undefined) return `进入战斗 · ${rounds}`;
  // 与战斗回执**共用同一句人话**（sequenceGapHint）—— 两处说法不一致是最容易出的错
  return `${sequenceGapHint(gap)} · ${rounds}`;
}

/**
 * 生成遭遇菜单。
 *
 * 三种形态，差别只在**选项集**（文本早在判定层就按层次选好了）：
 *   普通人      退回去 / 站着不动
 *   弱 3 级及以上 撤退（没得选）
 *   其余        观察 / 对峙 / 互动 的子集
 */
/**
 * M2.9：「动手」这个选项在不在。
 *
 * ⚠️ 它是一个**独立于四个遭遇动作**的选项，不是第五个 SightingAction。
 * 理由是 M2.8 的四动作集（观察 / 对峙 / 撤退 / 互动）是「遭遇的处置」，
 * 而战斗是**另一个状态机**（多回合、双方决策、落库）。
 * 把它塞进 SightingAction 会让 allowedActionsOf 同时承担「处置」与「开战」两种语义，
 * 于是 M2.8 那五条「这一层能做什么」的断言就不再是它原来守着的东西了。
 *
 * ## 门槛：**silhouette 及以上**（这是对任务书 §4.7 的一处实测修正）
 *
 * 任务书 §4.7 写的是「blur / silhouette 只撤退；**full 以上**进入战斗」。
 * 照此实现之后，50 人跑满 14 天的分片里**一场战斗都没有**（0 场）——
 * 因为全库 306 次遭遇里 `full` 只有 **5 次**（1.6%）：
 * 序列 9 的玩家要遇到同为序列 9 的灰雾游魂才是 `full`，而灰雾游魂是生态里最少的一档。
 *
 * 于是任务书自己打架了：§4.7 定的门槛让 §4.8 的验收（战斗次数 / 胜负分布 / 行为分布）无法成立。
 * 以**实测数据**为准把门槛降到 `silhouette`：
 *
 *   blur        连轮廓都没有（「雾里有什么东西在动」）→ 动手只是把自己送上去
 *   silhouette  看得到轮廓（大小、朝向）—— **你知道那是个活物，就可以先下手**
 *   full 及以上 看得清，当然可以动手
 *
 * 这不是放宽，是把门槛放回它该在的地方：**「能不能打」取决于你是否确认那是个活物**，
 * 而不是取决于你是否叫得出它的名字。
 * （`blur` 那一档的「只能撤退」是 M2.8 定的，这里一个字没动。）
 */
export function canStartBattle(layer: PerceptionLayer, mortal: boolean): boolean {
  if (mortal) return false;
  return layer === 'silhouette' || layer === 'full' || layer === 'advantage' || layer === 'essence';
}

export function buildEncounterMenu(view: EncounterMenuView): Menu {
  const context: string[] = [view.text];
  if (view.behaviorText) context.push(view.behaviorText);

  const options = view.allowedActions.map((action, index) => ({
    key: String(index + 1),
    label: actionLabel(action, view.layer),
    // 完整指令原文：真正干活的是 .遭遇，菜单只是入口
    command: `遭遇 ${actionLabel(action, view.layer)}`,
    preview: previewOf(action),
  }));

  /*
   * M2.9：看得见轮廓就可以动手（门槛见 canStartBattle 的说明）。
   * 摆在最后一位是有意的 —— 遭遇菜单的第一项永远是「看一眼 / 退开」这类不 irreversible 的选择，
   * 「动手」是唯一一个会把你拖进多回合的选项，它不该是手滑就能点到的那个。
   */
  if (canStartBattle(view.layer, view.mortal)) {
    options.push({
      key: String(options.length + 1),
      label: '动手',
      command: '战斗 开始',
      preview: fightPreview(view.sequenceGap),
    });
  }

  return {
    // 与探索 / 扮演 / 今日同一套括号（渲染层只输出 title，括号是生成器自己的事）
    title: encounterTitleOf(view),
    context,
    options,
    allowFreeform: true,
  };
}

/**
 * M2.70：**遭遇标题的唯一生成处**（K22）。
 *
 *     【遭遇 · 老码头 · 雾天】              没有 flavor 时（与 M2.8 逐字相同）
 *     【遭遇 · 老码头 · 雾天 · 雾比刚才厚了一点。】  有 flavor 时
 *
 * 为什么要抽成函数：这个格式原本在**三处**各写了一遍
 *（`domain/menu/encounter-menu.ts` 的菜单标题、`router/commands/creature-hooks.ts` 的 headline、
 * `router/commands/encounter.ts` 处置回执的抬头）—— 加一句氛围的话就要改三处，漏一处就长出两种标题。
 */
export function encounterTitleOf(view: {
  locationName: string;
  weatherLabel: string;
  flavor?: string;
}): string {
  const flavor = (view.flavor ?? '').trim();
  const tail = flavor === '' ? '' : ' · ' + flavor;
  return `【遭遇 · ${view.locationName} · ${view.weatherLabel}${tail}】`;
}

/**
 * M2.70：**标题里那一句氛围取什么**（一处定义，三个调用点共用）。
 *
 *   ① 物种写了 `flavor` → 用它（11 个物种全都有）；
 *   ② 没写 → 退回**物种名**，但**只在看得见的时候**
 *     （`visibleName` 为 null 就是不看不见）—— 感知分层存在的意义就是
 *     「看不清时你不知道那是什么」，把名字写进标题会把那一层设计当场作废；
 *   ③ 两者都没有 → 空串，标题退回 M2.8 的老格式。
 *
 * @param visibleName 看得见时的物种名；看不见传 null（**不是**"不知道就传空串"——
 *   空串与"没有名字"是两种状态，这一层要把它们分开）
 */
export function encounterFlavorOf(input: {
  flavor: string;
  visibleName: string | null;
}): string {
  const flavor = input.flavor.trim();
  if (flavor !== '') return flavor;
  return input.visibleName ?? '';
}
