/**
 * 内容校验（M2.53）。
 *
 * ## 不新写任何判据
 *
 * 内容层与卡片层的检查**本来就在跑**，而且跑在正确的位置：
 *
 *   · `data/loader.ts` 在装载内容时跑 schema / 交叉引用 / 三项链路检查
 *     （配方缺层、配置没有读取点、内容做完但跑批够不到）；
 *   · `cards/loader.ts` 在装载事件卡时跑卡面 lint。
 *
 * 而且 error 级的内容问题会让服务起不来（K17）。所以「服务在跑」这件事本身
 * 就已经说明内容层没有 error —— 这个面板要展示的是那些**warning**：
 * 它们不会拦住启动，只会安静地留在那儿。
 *
 * 于是这里做的是：把它们**结构化地摆出来**，而不是让人去翻命令行输出。
 */
import { loadCards } from '../cards/loader.ts';
import { loadContent } from '../data/loader.ts';

export interface ContentIssue {
  level: 'error' | 'warn';
  /** 来自哪一层：卡片 / 内容表 */
  source: 'cards' | 'content';
  /** 定位：卡 id、文件、或条目 id */
  where: string;
  message: string;
}

export interface ContentView {
  issues: ContentIssue[];
  counts: { error: number; warn: number; cards: number; content: number };
  checked: Array<{ label: string; value: number }>;
  /** 装载本身抛异常时记在这里（比如某个 yaml 语法坏了） */
  loadError: string | null;
}

export function contentView(): ContentView {
  const issues: ContentIssue[] = [];
  let loadError: string | null = null;
  let cards = 0;
  const checked: Array<{ label: string; value: number }> = [];

  try {
    const cardResult = loadCards();
    cards = cardResult.cards.length;
    for (const issue of cardResult.issues) {
      issues.push({
        level: issue.level,
        source: 'cards',
        where: (issue as { cardId?: string }).cardId ?? '（未指出卡片）',
        message: issue.message,
      });
    }
    checked.push({ label: '事件卡', value: cards });
  } catch (e) {
    loadError = '卡片装载失败：' + (e as Error).message;
  }

  try {
    const bundle = loadContent();
    for (const issue of bundle.issues) {
      issues.push({
        level: issue.level,
        source: 'content',
        where: (issue as { file?: string }).file ?? '（未指出文件）',
        message: issue.message,
      });
    }
    checked.push(
      { label: '物品', value: bundle.items.length },
      { label: '地点', value: bundle.locations.length },
      { label: '配方', value: bundle.recipes.length },
      { label: '能力', value: bundle.abilities.length },
      { label: '区域', value: bundle.regions.length },
      { label: '城市', value: bundle.cities.length },
      { label: '路线', value: bundle.routes.length },
      { label: '势力', value: bundle.factions.length },
      { label: '非凡生物', value: bundle.creatures.length },
      { label: '教会', value: bundle.churches.length },
    );
  } catch (e) {
    loadError = (loadError === null ? '' : loadError + '；') + '内容装载失败：' + (e as Error).message;
  }

  return {
    issues,
    counts: {
      error: issues.filter((i) => i.level === 'error').length,
      warn: issues.filter((i) => i.level === 'warn').length,
      cards,
      content: checked.reduce((n, c) => (c.label === '事件卡' ? n : n + c.value), 0),
    },
    checked,
    loadError,
  };
}
