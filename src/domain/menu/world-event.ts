/**
 * 世界事件 → M2.3 菜单（M2.4）。
 *
 * 世界播报和「.今日」「.扮演」递到玩家手里的东西**是同一个形状**（Menu）——
 * 这是任务书 §4「回数字走 M2.3 的菜单/数字回复体系」的字面落地：
 * 世界事件不需要另起一套按键系统，它就是一张带编号的菜单，只不过标题是世界的。
 *
 * 抬头从 `event.text` 的第一行拆出来（表里只有一个 text 列，见 domain/world/events.ts）。
 */
import type { WorldEvent } from '../world/events.ts';
import { worldEventBody, worldEventHeadline } from '../world/events.ts';
import type { Menu, MenuOption } from './types.ts';

/** 事件 → 玩家/群里看到的那张菜单（不落 pending_menus：它是全服共享的一张） */
export function worldEventMenu(event: WorldEvent): Menu {
  const options: MenuOption[] = (event.options ?? []).map((option) => ({
    key: option.key,
    label: option.label,
    command: option.command,
  }));
  const body = worldEventBody(event);
  return {
    title: worldEventHeadline(event),
    context: body ? body.split('\n') : [],
    options,
    // 世界事件不给「自己写一个行为」：群里那张播报没有输入框，私聊也只回数字。
    allowFreeform: false,
  };
}

/** 播报文本：抬头 + 正文 + 编号选项 + 「回复数字。」（任务书 §4 的样例格式） */
export function renderWorldEvent(event: WorldEvent, render: (menu: Menu) => string): string {
  return render(worldEventMenu(event));
}
