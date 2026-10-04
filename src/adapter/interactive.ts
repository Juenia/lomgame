/**
 * 按钮交互抽象（M2.7 前置项）。
 *
 * 为什么先做这一层：战斗（M2.9）、移动、探索、仪式都需要"让玩家挑一个动作"。
 * 如果每条链路各自拼按钮，就会出现两套输入语义 —— 按钮一套、数字回复一套，
 * 迟早对不上。这里把**选项**抽成纯数据，由 Adapter 决定怎么渲染：
 *
 *   | 通道 | 渲染 |
 *   |---|---|
 *   | 官方 QQ 机器人 | 原生按钮（keyboard，action.data = 选项 id） |
 *   | OneBot / NapCat / 内存通道 | 降级为文本菜单（`1. xxx`），走 M2.3 的数字回复 |
 *
 * 两条路的**语义完全一致**：按钮点下去回传的就是选项 id（数字），
 * 服务端收到后走的是同一条 pending_menus.pick 路径（见 src/router/index.ts 的 MENU_REPLY）。
 * 所以"同一份 InteractiveMessage 在两种 Adapter 下行为一致"不是靠对齐文案，
 * 而是靠**同一条执行路径**保证的。
 *
 * 硬约束：本文件是纯函数（不读库、不看时钟），业务层只产出 InteractiveMessage。
 */
import { BUTTON } from '../config/numeric.ts';
import { FREEFORM_KEY, type Menu, type MenuOption } from '../domain/menu/types.ts';

export interface InteractiveOption {
  /** 选项 id：就是菜单的数字 key（'1' | '2' | … | '0'）。按钮 action.data 回传它 */
  id: string;
  /** 按钮/菜单上显示的文字 */
  label: string;
  /** 对应的完整指令原文（不含前导点号）；诊断与审计用，按钮本身不传它 */
  command: string;
  disabled?: boolean;
  disabledReason?: string;
  /**
   * 降级文本里跟在 label 后面的括号说明（如「危险 ×1.32 · 今日 0/3 次」）。
   * 有它，OneBot 的文本菜单才能与 M2.3 的 renderMenu **逐字一致**；
   * 支持按钮的通道可以忽略它（按钮放不下这么多字）。
   */
  preview?: string;
}

/**
 * M2.86：**固定指令按钮** —— 点了等于手打那条指令。
 *
 * 与 `InteractiveOption` 的区别是语义上的，两者别混：
 *   · `InteractiveOption` 是**选项**：点了平台回传它的 id，走后端 `MENU_REPLY` 那条判定路径
 *     （「你在问一个问题，等一个回答」）；
 *   · `QuickButton` 是**快捷入口**：平台只把指令插进输入框，**没有任何待答状态**
 *     —— 所以它不参与 `foldOptions` / `cutMenuOptions` 那一套（那些是给选项清单用的）。
 */
export interface QuickButton {
  /** 按钮文字（官方对中文标签有显示宽度限制，通道侧会按宽度截断） */
  label: string;
  /** 点击后插入输入框的**完整指令原文**（含点号），例如 `.状态` */
  command: string;
}

export interface InteractiveMessage {
  /** 正文：**不含**选项列表。支持按钮的通道直接发它 */
  text: string;
  options: InteractiveOption[];
  layout?: 'row' | 'grid' | 'menu';
  /**
   * 降级文本里末尾的「0. 自己写一个行为」。
   * null = 不显示（业务层显式关闭）；不填 = 用 M2.3 的固定文案。
   */
  freeformLabel?: string | null;
  /**
   * M2.86：固定指令按钮。有它时 `options` 可以为空 ——
   * 这条消息就是「一张图 + 几个常用指令」，**没有菜单语义**
   * （`.角色` 的最终形态，见 docs/角色卡-卡面规范.md §4.2.1）。
   */
  quickButtons?: QuickButton[];
  /**
   * M2.86：这条消息**不要信息头**（头像 + 昵称 + 途径/序列那一行）。
   *
   * 为什么必须是**消息级开关**、而不能由调用方「少传个参数」：
   * 头像是通道自己从**被动回复凭证**里取的（`ticket.userId` → `q.qlogo.cn`），
   * 调用方根本没有那个入参 —— 只有通道知道该不该画。
   */
  noHeader?: boolean;
}

/** 菜单渲染的固定行（与 src/domain/menu/render.ts 保持同一份口径） */
export const MENU_REPLY_HINT = '回复数字。';

/** 一行里最多放几个按钮（超过就换行） */
export function chunkOptions(
  options: readonly InteractiveOption[],
  maxPerRow: number = BUTTON.maxPerRow,
): InteractiveOption[][] {
  const size = Math.max(1, maxPerRow);
  const rows: InteractiveOption[][] = [];
  for (let index = 0; index < options.length; index += size) {
    rows.push(options.slice(index, index + size));
  }
  return rows;
}

export interface FoldResult {
  /** 真正可以摆成按钮的选项（最多 BUTTON.maxTotal 个） */
  shown: InteractiveOption[];
  /** 放不下、只能靠文本菜单里的数字选的那些 */
  folded: InteractiveOption[];
}

/**
 * 「一次最多 6 个按钮，超过折叠为子菜单」（任务书 §6.2）。
 *
 * 这里的折叠策略是**有意的保守做法**：超出的选项不生成二级按钮，
 * 而是留在文本正文里 —— 玩家照样能回数字选中它们。
 * 理由：二级键盘要额外一轮往返（点「更多」→ 服务端再推一张键盘），
 * 而服务端本来就随消息发了完整文本菜单；为了 1—2 个尾巴选项多一次往返不划算。
 * 折叠掉的项数会写进正文（见 foldNote），所以玩家不会以为选项丢了。
 */
export function foldOptions(
  options: readonly InteractiveOption[],
  maxTotal: number = BUTTON.maxTotal,
): FoldResult {
  if (options.length <= maxTotal) return { shown: [...options], folded: [] };
  return { shown: options.slice(0, maxTotal), folded: options.slice(maxTotal) };
}

/** 折叠提示：告诉玩家还有几项只能回数字选 */
export function foldNote(folded: readonly InteractiveOption[]): string | null {
  if (folded.length === 0) return null;
  return `（按钮放不下，另有 ${folded.length} 项可以回数字选：${folded.map((o) => o.id).join('、')}）`;
}

function renderOptionLine(option: InteractiveOption): string {
  const preview = option.preview ? `（${option.preview}）` : '';
  const disabled = option.disabled ? `　〔不可选：${option.disabledReason ?? '暂不可选'}〕` : '';
  return `${option.id}. ${option.label}${preview}${disabled}`;
}

/**
 * 降级渲染：InteractiveMessage → 玩家看到的文本菜单。
 *
 * 排版与 src/domain/menu/render.ts 的 renderMenu **逐字一致** ——
 * 这是硬要求：OneBot 通道从 M2.3 起就长这样，M2.7 不许让老通道的文案变一个字
 *（改了就会连带影响 playground、行为日志、以及基于文本断言的一大批测试）。
 */
/**
 * 从菜单文本里**切掉选项清单**，只留标题与环境行（M2.45 第二十版）。
 *
 * 用户原话：
 *
 * > 信息尾太墨迹了，他太长了，他应该放置在按钮里。
 *
 * 按钮通道下选项已经在按钮上列全了，正文再列一遍 `1. / 2. / 3.` 就是纯冗余。
 * 但**标题行与环境行要留着**（`【下一步 · …】`、`晴 · 夜晚 · HP 100 · MAD 0`）——
 * 它们不是选项，而是这一屏的上下文：玩家扫一眼就知道"现在什么时辰、状态怎么样"。
 * （M2.85：环境行里的 `AP 5` 随行动值机制一并移除。）
 *
 * ⚠️ 认不出选项（结构变了）就**原样返回**。这一层的职责是"少说一句"，
 * 绝不能因为切错而吃掉正文 —— 那比啰嗦严重得多。
 */
export function cutMenuOptions(text: string): string {
  const lines = text.split('\n');
  const first = lines.findIndex((line) => /^\s*\d+[.、]\s*\S/.test(line));
  if (first <= 0) return text;
  return lines.slice(0, first).join('\n').replace(/\n+$/, '');
}

export function renderInteractiveText(message: InteractiveMessage): string {
  const lines: string[] = [message.text, ''];
  for (const option of message.options) lines.push(renderOptionLine(option));
  if (message.freeformLabel !== null) {
    lines.push(`${FREEFORM_KEY}. ${message.freeformLabel ?? '自己写一个行为'}`);
  }
  lines.push('');
  lines.push(MENU_REPLY_HINT);
  return lines.join('\n');
}

/** 降级文本里的选项行（不含正文与结尾提示）；渲染层与测试共用 */
export { renderOptionLine };

/** 把 M2.3 的 Menu 转成通道无关的 InteractiveMessage */
export function menuToInteractive(menu: Menu): InteractiveMessage {
  const options: InteractiveOption[] = menu.options.map((option: MenuOption) => ({
    id: option.key,
    label: option.label,
    command: option.command,
    ...(option.preview ? { preview: option.preview } : {}),
    ...(option.disabled ? { disabled: true, disabledReason: option.disabled } : {}),
  }));
  return {
    text: [menu.title, ...menu.context].join('\n'),
    options,
    layout: options.length > BUTTON.maxPerRow ? 'grid' : 'row',
    // allowFreeform=false 时**显式**写 null（不显示那一行）；
    // 允许自由输入时留空（undefined），渲染层用 M2.3 的固定文案
    ...(menu.allowFreeform ? {} : { freeformLabel: null }),
  };
}

/**
 * 这条消息能不能真正摆成按钮：
 *   - Adapter 声明支持（官方机器人）；
 *   - 且至少有一个可点的选项。
 * 全灰的菜单（比如 AP 不足）仍然发按钮，但按钮是禁用态 —— 玩家需要看到"为什么不能点"。
 */
export function canUseButtons(
  message: InteractiveMessage,
  supportsButtons: boolean | undefined,
): boolean {
  if (!supportsButtons) return false;
  if (!BUTTON.fallbackToText && message.options.length === 0) return false;
  return message.options.length > 0;
}
