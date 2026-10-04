/**
 * 菜单渲染（M2.3）：Menu（纯数据）→ 玩家看到的文本。
 *
 * 渲染层**不做任何状态判断** —— 任务书第十二节：「不要把状态判断写在路由层」。
 * 这里只负责排版：标题、上下文、编号选项、灰掉的原因、结尾提示。
 * 想让某个选项变灰，改生成器，不改这里。
 */
import { FREEFORM_KEY, type Menu, type MenuOption } from './types.ts';

/** 「0. 自己写一个行为」的固定文案（任务书 §5.3） */
export const FREEFORM_LABEL = '自己写一个行为';

export function renderOption(option: MenuOption): string {
  const preview = option.preview ? `（${option.preview}）` : '';
  const disabled = option.disabled ? `　〔不可选：${option.disabled}〕` : '';
  return `${option.key}. ${option.label}${preview}${disabled}`;
}

export function renderMenu(menu: Menu): string {
  const lines: string[] = [];
  lines.push(menu.title);
  for (const line of menu.context) lines.push(line);
  lines.push('');
  for (const option of menu.options) lines.push(renderOption(option));
  if (menu.allowFreeform) lines.push(`${FREEFORM_KEY}. ${FREEFORM_LABEL}`);
  lines.push('');
  lines.push('回复数字。');
  return lines.join('\n');
}

/**
 * 「执行完给下一步」的短菜单（任务书 §4）：3—4 个选项 + 自由输入，
 * 标题换成「【下一步】」，其余渲染一模一样。
 * 不另起一套渲染，是为了让两条路的键盘体验完全一致。
 */
export function renderNextMenu(menu: Menu): string {
  return renderMenu(menu);
}
