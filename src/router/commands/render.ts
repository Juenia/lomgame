import type { DomainEvent } from '../../domain/character/types.ts';
import { hlMark } from '../../adapter/highlight.ts';

const FIELD_LABELS: Record<string, string> = {
  dig: '消化',
  mad: '疯狂',
  cor: '污染',
  hp: '生命',
  mp: '灵性',
  ap: '行动点',
  dp: '命运点',
  sequence: '序列',
};

/** 显示层收敛：0.8999999999999999 → 0.9，2.50 → 2.5，整数原样输出 */
export function formatNumber(value: number, digits = 2): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(digits)));
}

function signed(value: number, digits = 2): string {
  const text = formatNumber(Math.abs(value), digits);
  return value >= 0 ? `+${text}` : `-${text}`;
}

/** 把领域事件渲染成玩家能看懂的增减清单（只读，不改数值） */
/**
 * 数值变化摘要（`.探索` / `.移动` 的「变化」块用它）。
 *
 * M2.86：**按方向配色**（用户：「用颜色的三角块，提升就是绿色的三角块，
 * 降低就是红色的倒三角块」）。
 *
 * 涨 → 绿 `▲`、跌 → 红 `▼`。颜色由 `hlMark` 统一给出，这里只负责判方向 ——
 * 于是全站每一处「变化」都自动是同一个形态。
 *
 * ⚠️ `supportsColor` 默认 false：老调用方不传时**只出文字**，
 * 与改动前逐字一致（回退路径）。
 */
export function renderDeltaSummary(
  events: readonly DomainEvent[],
  supportsColor = false,
  /*
   * id → 展示名。**必须注入，不能在这里查表** ——
   * 这个文件是纯渲染层，不该认识物品仓库。
   *
   * 默认原样返回 id：老调用方不传时行为与改动前一致（也是回退路径）。
   */
  nameOf: (itemId: string) => string = (itemId) => itemId,
): string[] {
  const lines: string[] = [];
  for (const event of events) {
    if (event.type.endsWith('_delta') && event.type !== 'item_delta') {
      const field = event.type.slice(0, -'_delta'.length);
      const label = FIELD_LABELS[field] ?? field;
      const before = Number(event.payload.before ?? 0);
      const after = Number(event.payload.after ?? 0);
      const delta = Number(event.payload.delta ?? 0);
      if (before === after) {
        lines.push(`${label} ${formatNumber(before)}（已到边界，${signed(delta)} 未生效）`);
      } else {
        const rose = after > before;
        lines.push(
          hlMark(
            `${label} ${formatNumber(before)} → ${formatNumber(after)}（${signed(after - before)}）`,
            rose ? 'up' : 'down',
            supportsColor,
          ),
        );
      }
      continue;
    }
    if (event.type === 'item_delta') {
      const itemId = String(event.payload.itemId ?? '');
      const quantity = Number(event.payload.quantity ?? 0);
      /*
       * M2.86：**转成人话**。
       *
       * 用户实机截图：用了驱邪符之后回执里写着
       *
       *     charm_exorcism × -1
       *
       * —— 而同一屏上面一行刚写着「你使用了 驱邪符」。同一个东西，两种写法。
       * 查过物品表：`charm_exorcism` 的名字就是「驱邪符」，数据没问题，
       * 是**这里直接把 id 打了出来**。
       */
      lines.push(nameOf(itemId) + ' × ' + quantity);
    }
  }
  return lines;
}
