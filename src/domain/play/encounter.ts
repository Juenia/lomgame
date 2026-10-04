/**
 * **日常遭遇**（M2.120）—— 取代 `.扮演` 的那条路。
 *
 * ## 用户的两句话
 *
 * > 「扮演应该取消　取而代之改为**途径专属事件卡**　每天随机让玩家遇到几次　
 * >  让他**做出相对应的选择**　然后涨消化度」
 *
 * > 「**扮演本来就是日常行为**，所以扮演指令没什么用」
 *
 * 第二句把方向说死了：`扮演` 不该是一个**玩家主动发的命令**，
 * 而应当是**每天自己找上门来的事**——玩家要做的只是**选择**。
 *
 * ## 形态
 *
 * ```
 * ① 每天 N 次（NUMERIC.play.dailyEncounters），在玩家**下一次发任何命令**时兑现
 *    —— 不做主动推送：QQ 的主动消息要接收方开着「允许主动发送」，靠不住；
 *       而「你发下一条指令时先遇到这件事」在体感上完全一样，还保证一定送得到。
 * ② 抽卡走既有的 `EventEngine.pick`（途径池 + 日常池，`cond: pathway:xxx` 已在卡里）
 * ③ 抽到的卡**带 `options`** ⇒ 开一份待答菜单（`encounter` 类型，与生物遭遇同一套）
 * ④ 玩家回数字 ⇒ 按那一支的 `effects` 与 `text` 结算 ⇒ **涨消化度**
 * ```
 *
 * ⚠️ 没有 `options` 的卡（663 张里的绝大多数）仍然走「遇到就自动生效」，
 * 与 `play.ts` 里那条老路逐字一致 —— 这个模块只负责**有选项的那一类**。
 */
import type { EventCard } from '../../cards/schema.ts';
import type { Menu } from '../menu/types.ts';

/** 一次待选的遭遇：卡 + 它的选项（选中之后按那一支结算） */
export interface PendingEncounter {
  card: EventCard;
  /** 今天这是第几次（1 起） */
  nth: number;
}

/**
 * 这张卡要不要**摆给玩家选**（而不是自动生效）。
 *
 * 判据只有一条：它有没有 `options`。663 张老卡一张都没有 ⇒ 行为逐字不变（回退路径）。
 */
export function needsChoice(card: EventCard): boolean {
  return (card.options?.length ?? 0) > 0;
}

/**
 * 把一张带选项的卡渲染成菜单。
 *
 * 卡自己的 `texts.priv` 是**引子**（「你把银链绕在指上…」），选项是**要做的事** ——
 * 两者合起来才是玩家看到的那一屏。
 *
 * ⚠️ `command` 用的是内部命令 `遇见 <cardId> <key>`：
 * 它不出现在 `.帮助` 里（玩家不该手打它），但必须是一条**能被路由解析**的真实指令 ——
 * 菜单的 `command` 会被当成玩家说的话再走一遍路由（M2.107 踩过：点按钮报「没有 .背包 这条指令」）。
 */
export function encounterMenuOf(pending: PendingEncounter): Menu {
  const { card } = pending;
  return {
    title: `【${card.name}】`,
    context: [],
    options: (card.options ?? []).map((option) => ({
      key: option.key,
      label: option.label,
      command: `遇见 ${card.id} ${option.key}`,
    })),
    allowFreeform: false,
  };
}

/**
 * 玩家选了哪一支（找不到就返回 null —— 调用方按「这张卡过期了」处理）。
 *
 * 刻意**不在这里应用效果**：结算是 `EventEngine.applyCard` 的事，
 * 而这个文件是纯函数（不碰数据库、不掷骰），便于单测。
 */
export function chosenOption(card: EventCard, key: string) {
  return (card.options ?? []).find((option) => option.key === key) ?? null;
}

/**
 * 今天还该遇到几次（用户要的「每天随机让玩家遇到几次」）。
 *
 * 「随机」体现在**抽到哪张**上（`EventEngine.pick` 按 weight），
 * 而**次数**是固定的 —— 次数也随机的话，玩家会遇到「今天一次都没有」的空白日，
 * 那对一个「日常行为」来说不是惊喜而是故障。
 */
export function remainingEncounters(seenToday: number, dailyEncounters: number): number {
  return Math.max(0, dailyEncounters - seenToday);
}
