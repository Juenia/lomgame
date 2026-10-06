/**
 * **管理员指令说明表**（M2.172）—— 管理员卡片菜单的唯一数据源。
 *
 * 与 `command-groups.ts` 同一条纪律：**清单从注册表派生，说明才是数据**。
 * `test/m2-171-admin.test.ts` 拿 `router.commands` 与这里的表对账 ——
 * 漏写说明、或写了说明却没有这条指令，测试直接红。
 *
 * ⚠️ 这张表**不进玩家菜单**（`COMMAND_GROUPS`），它是给 .管理 用的。
 * 两条理由：玩家看到「封禁」只会困惑；而管理员名单本身不该从菜单里泄露出去。
 */

export interface AdminCommandDoc {
  name: string;
  brief: string;
  usage?: string;
}

export interface AdminCommandGroup {
  id: string;
  title: string;
  hint: string;
  commands: readonly AdminCommandDoc[];
}

export const ADMIN_COMMAND_GROUPS: readonly AdminCommandGroup[] = [
  {
    id: 'players',
    title: '玩家处置 · 开关游戏',
    hint: '封一个人、或者把游戏整体停下来。',
    commands: [
      { name: '封禁', brief: '封掉一个玩家：他之后发什么都进不来', usage: '.封禁 @玩家' },
      { name: '解禁', brief: '解除封禁，恢复他的角色', usage: '.解禁 @玩家' },
      { name: '关闭游戏', brief: '全服停止响应（管理员指令仍然可用）' },
      { name: '开启游戏', brief: '全服恢复响应' },
      { name: '关闭本群游戏', brief: '只停这个群（在哪个群发就作用在哪个群）' },
      { name: '开启本群游戏', brief: '这个群恢复 —— 也会清掉本群的单独设定，重新跟随全局' },
    ],
  },
  {
    id: 'push',
    title: '主动推送开关',
    hint: '机器人主动开口的两条路：世界自己在说话，和与玩家相关的事件通知。',
    commands: [
      { name: '关闭主动推送', brief: '全服停掉世界播报（天气异象、世界事件）' },
      { name: '开启主动推送', brief: '恢复世界播报' },
      { name: '关闭本群主动推送', brief: '只停这个群的世界播报' },
      { name: '开启本群主动推送', brief: '这个群恢复，并重新跟随全局' },
      { name: '关闭主动事件推送', brief: '全服停掉与玩家相关的事件通知（失控、结算提醒）' },
      { name: '开启主动事件推送', brief: '恢复事件通知' },
      { name: '关闭本群主动事件推送', brief: '只停这个群的事件通知' },
      { name: '开启本群主动事件推送', brief: '这个群恢复，并重新跟随全局' },
    ],
  },
  {
    id: 'status',
    title: '运行状态',
    hint: '出问题时先看这三条，它们回答的是「谁被关了、世界几点了、机器人还活着吗」。',
    commands: [
      { name: '游戏状态', brief: '三个开关的全局值与本群值 + 在线人数' },
      { name: '世界状态', brief: '世界时间、月相、当前天气与公共事件' },
      { name: '机器人状态', brief: '通道、进程运行时长、数据库大小、队列积压' },
      { name: '管理', brief: '把这套管理员指令画成图片菜单', usage: '.管理 [编号]' },
    ],
  },
];

/** 管理员菜单共有几张 */
export function adminMenuPageCount(): number {
  return ADMIN_COMMAND_GROUPS.length;
}
