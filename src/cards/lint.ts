import { COND_STATUSES, isValidCond, parseCond } from '../domain/event/trigger.ts';
import type { EventCard } from './schema.ts';

/** 内容注册表：策划在 registry.yaml 维护，lint 用它判定引用是否存在 */
export interface ContentRegistry {
  items: Set<string>;
  flags: Set<string>;
  locations: Set<string>;
}

export interface LintIssue {
  cardId: string;
  level: 'error' | 'warn';
  message: string;
}

export function loadRegistry(raw: unknown): ContentRegistry {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const toSet = (value: unknown): Set<string> =>
    new Set(Array.isArray(value) ? value.map((v) => String(v)) : []);
  return {
    items: toSet(obj.items),
    flags: toSet(obj.flags),
    locations: toSet(obj.locations),
  };
}

/**
 * 卡片 id 的约定：小写字母开头，**至少要有一个下划线分段**（`daily_001` / `path_seer_9`）。
 *
 * 导出是给后台的「新建」用的（M2.84）：那里的 id 输入框要能在**建之前**就说清这一条，
 * 而不是让人建完一张卡、热重载失败之后才知道 id 不合规。
 */
export const ID_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

/** 单卡体检：引用完整性 + 明显设计错误。CI 里对 error 级直接失败 */
export function lintCard(card: EventCard, registry: ContentRegistry): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (level: LintIssue['level'], message: string): void => {
    issues.push({ cardId: card.id, level, message });
  };

  if (!ID_PATTERN.test(card.id)) {
    add('warn', `id 命名建议 <类型>_<三位序号>，当前为 ${card.id}`);
  }
  if (card.trigger.weight <= 0) {
    add('error', 'trigger.weight 必须大于 0');
  }
  // W3 规则：random 池是「暴露/遭遇」内容，必须绑定地点或状态条件，否则会到处乱窜
  if (card.trigger.type === 'random') {
    const hasLocation = (card.trigger.location?.length ?? 0) > 0;
    const hasCond = card.trigger.cond.length > 0;
    if (!hasLocation && !hasCond) {
      add('error', 'random 卡必须至少有一个 location 或状态 cond（W3 硬性规则）');
    }
  }
  const { min_seq: minSeq, max_seq: maxSeq } = card.trigger;
  if (minSeq !== undefined && maxSeq !== undefined && minSeq > maxSeq) {
    add('error', `min_seq(${minSeq}) 不能大于 max_seq(${maxSeq})`);
  }
  if (minSeq !== undefined && (minSeq < 0 || minSeq > 9)) add('error', 'min_seq 必须在 0—9');
  if (maxSeq !== undefined && (maxSeq < 0 || maxSeq > 9)) add('error', 'max_seq 必须在 0—9');
  /*
   * M2.69：`daily_limit` 现在真的被读了（domain/event/engine.ts 的 eligible()），
   * 所以这里只剩「负数是错的」这一条。0 是**合法**的：读作「今天不许出这张卡」，
   * 给内容同学一个不必删卡就能关掉它的开关（删卡会打断 locations.yaml 对它的引用）。
   */
  if (card.daily_limit < 0) add('error', 'daily_limit 不能为负（0 = 今天不许出这张卡）');

  /*
   * M2.69：**写出来的卡永远抽不到** —— 本版四个抽取入口的 types 分别是
   *   explore: ['daily','random','hidden']   .事件: ['daily','hidden']
   *   .扮演 / 模拟器: ['random']
   * 也就是说 main / org 这两个类型**没有任何入口**。
   * 内容里目前 0 张这样的卡（所以这条是 warn 不是 error，且现在是恒不触发的对照侧），
   * 但下一个写卡片的人不该靠自己读四个调用点才发现这件事。
   */
  if (card.trigger.type === 'main' || card.trigger.type === 'org') {
    add(
      'warn',
      `trigger.type = ${card.trigger.type} 目前**没有任何抽取入口**：本版只会抽 daily / random / hidden` +
        '（见 router/commands 的四处 eligible/pick 调用）。这张卡写出来也不会触发 —— ' +
        '要启用这两个类型，得先给它们一个入口（并想清楚它由谁在什么时候推）。',
    );
  }

  // 条件校验与运行期共用同一个解析器，避免「lint 通过但跑起来不触发」
  for (const cond of card.trigger.cond) {
    const parsed = parseCond(cond);
    if (!parsed) {
      add('error', `条件写法未识别（只支持 flag: / location: / 字段比较）：${cond}`);
      continue;
    }
    if (!isValidCond(cond)) add('error', `条件无法解析：${cond}`);
    if (parsed.kind === 'flag' && !registry.flags.has(parsed.flag)) {
      add('error', `引用了未登记 flag：${parsed.flag}`);
    }
    if (parsed.kind === 'location' && !registry.locations.has(parsed.location)) {
      add('error', `引用了未登记地点：${parsed.location}`);
    }
    if (parsed.kind === 'status' && !COND_STATUSES.includes(parsed.status)) {
      add('error', `status 条件取值非法：${parsed.status}`);
    }
    /*
     * M2.76：`pathway:` 的合法性**完全由 parseCond 保证** —— 它接受两个来源：
     * COND_PATHWAYS（mortal / initiated）与 PATHWAY_LABELS 的键（具体途径）。
     * 这里不再抄第三份白名单（K16）：抄了就会在「加一条途径」时漏改一处，
     * 症状是「lint 说这张卡非法，运行期却解析得出来」—— 最难查的那种不一致。
     */
  }

  for (const location of card.trigger.location ?? []) {
    if (!registry.locations.has(location)) add('error', `引用了未登记地点：${location}`);
  }
  if ((card.trigger.location?.length ?? 0) > 0 && card.trigger.cond.some((c) => c.startsWith('location:'))) {
    add('warn', 'trigger.location 与 cond 里的 location: 重复表达同一件事，建议只留一处');
  }
  if (card.trigger.cooldown_days < 0) add('error', 'cooldown_days 不能为负');
  if (card.trigger.cooldown_days > 30) add('warn', `cooldown_days=${card.trigger.cooldown_days} 超过 30 天，玩家几乎见不到这张卡`);

  if (card.effects.length === 0) {
    add('warn', '没有任何 effects，玩家会觉得这张卡是空的');
  }

  card.effects.forEach((effect, index) => {
    const at = `effects[${index}]`;
    if (effect.item !== undefined) {
      if (!registry.items.has(effect.item)) add('error', `${at} 引用了未登记物品：${effect.item}`);
      if (effect.n === undefined) add('warn', `${at} 指定了 item 但没写 n，按 1 处理`);
      if (effect.n !== undefined && effect.n <= 0) add('error', `${at} 的 n 必须为正`);
    } else if (effect.n !== undefined) {
      add('warn', `${at} 写了 n 却没有 item，n 会被忽略`);
    }
    if (effect.flag !== undefined && !registry.flags.has(effect.flag)) {
      add('error', `${at} 授予了未登记 flag：${effect.flag}`);
    }
    // M2.85：'ap' 随行动值机制移除
    const numeric = ['dig', 'cor', 'mad', 'hp', 'mp', 'dp'] as const;
    const present = numeric.filter((key) => effect[key] !== undefined);
    if (present.length === 0 && effect.item === undefined && effect.flag === undefined) {
      add('warn', `${at} 是空效果`);
    }
    if (Math.abs(effect.dig ?? 0) > 20) add('warn', `${at} 单卡 dig 变动超过 20，注意平衡`);
    if (Math.abs(effect.cor ?? 0) > 15) add('warn', `${at} 单卡 cor 变动超过 15，注意平衡`);
  });

  if (card.texts.priv.trim().length < 8) add('warn', 'texts.priv 太短，缺少氛围文本');
  if (!card.texts.group) add('warn', '缺少 texts.group，群聊播报会回落到私聊文本');

  return issues;
}
