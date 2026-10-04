import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadItems, loadLocations } from '../data/loader.ts';
import { loadFragments } from './fragments.ts';
import { lintCard, loadRegistry, type ContentRegistry, type LintIssue } from './lint.ts';
import { CARD_DIRS, DAILY_DIR, MORTAL_DIR, REGISTRY_FILE } from './paths.ts';
import { parseCard, type EventCard } from './schema.ts';
import { RUNTIME_FRAGMENT_KEYS, lintTemplate, templateKeys, type FragmentPools } from './template.ts';

export { CARDS_DIR, CARD_DIRS, DAILY_DIR, FRAGMENTS_FILE, MORTAL_DIR, REGISTRY_FILE } from './paths.ts';

/**
 * 注册表 = flags（registry.yaml）+ 物品（data/items.yaml）+ 地点（data/locations.yaml）。
 * 后两者直接取权威数据文件，避免「卡片 lint 清单」和「运行时数据」两份漂移。
 */
export function loadRegistryFile(file: string = REGISTRY_FILE): ContentRegistry {
  const base = loadRegistry(parseYaml(readFileSync(file, 'utf8')));
  const { items } = loadItems();
  const { locations } = loadLocations();
  return {
    items: new Set([...base.items, ...items.map((item) => item.id)]),
    flags: base.flags,
    locations: new Set([...base.locations, ...locations.map((location) => location.name)]),
  };
}

export interface LoadResult {
  cards: EventCard[];
  fragments: FragmentPools;
  issues: LintIssue[];
}

/**
 * 读全部事件卡 + 片段池并体检。
 * issues 里带 error 时调用方应拒绝启动（内容错误不该带到线上）。
 */
/**
 * 读事件卡并体检。
 *
 * M2.7.6 起目录是**多个**：daily/（原有）与 mortal/（普通人专属池）。
 * 参数仍接受单个目录字符串（老调用点与测试不受影响）。
 */
export function loadCards(
  dirs: string | readonly string[] = CARD_DIRS,
  registry: ContentRegistry = loadRegistryFile(),
  fragments: FragmentPools = loadFragments().pools,
): LoadResult {
  const dirList = typeof dirs === 'string' ? [dirs] : dirs;
  const cards: EventCard[] = [];
  const issues: LintIssue[] = [];
  const fragmentResult = loadFragments();
  for (const issue of fragmentResult.issues) {
    issues.push({ cardId: 'fragments.yaml', level: issue.level, message: issue.message });
  }

  for (const dir of dirList) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();

  for (const file of files) {
    let raw: unknown;
    try {
      raw = parseYaml(readFileSync(join(dir, file), 'utf8'));
    } catch (error) {
      issues.push({ cardId: file, level: 'error', message: `YAML 解析失败：${(error as Error).message}` });
      continue;
    }
    const parsed = parseCard(raw);
    if (!parsed.ok) {
      for (const issue of parsed.issues) issues.push({ cardId: file, level: 'error', message: issue });
      continue;
    }
    const card = parsed.card;
    cards.push(card);
    issues.push(...lintCard(card, registry));

    // 文本模板：用到的片段键必须存在，否则运行期会把 {{x}} 原样发给玩家
    const texts: Array<[string, string]> = [['texts.priv', card.texts.priv]];
    if (card.texts.group) texts.push(['texts.group', card.texts.group]);
    for (const [where, text] of texts) {
      for (const issue of lintTemplate(text, fragments, `${card.id}.${where}`)) {
        issues.push({ cardId: card.id, level: issue.level, message: issue.message });
      }
    }
  }
  }

  const seen = new Set<string>();
  for (const card of cards) {
    if (seen.has(card.id)) issues.push({ cardId: card.id, level: 'error', message: '事件卡 id 重复' });
    seen.add(card.id);
  }

  // 片段池闲置告警：写了一大堆片段却没人用，等于没写
  const usedKeys = new Set<string>();
  for (const card of cards) {
    for (const key of templateKeys(`${card.texts.priv}\n${card.texts.group ?? ''}`)) usedKeys.add(key);
  }
  for (const key of Object.keys(fragments)) {
    if (RUNTIME_FRAGMENT_KEYS.includes(key)) continue;
    if (!usedKeys.has(key)) {
      issues.push({ cardId: 'fragments.yaml', level: 'warn', message: `片段 {{${key}}} 没有被任何卡片使用` });
    }
  }

  return { cards, fragments, issues };
}

/** 启动时用：有 error 直接抛，避免坏内容进线上 */
export function loadCardsOrThrow(
  dir: string | readonly string[] = CARD_DIRS,
): { cards: EventCard[]; fragments: FragmentPools } {
  const { cards, fragments, issues } = loadCards(dir);
  const errors = issues.filter((issue) => issue.level === 'error');
  if (errors.length > 0) {
    const detail = errors.map((issue) => `  ${issue.cardId}: ${issue.message}`).join('\n');
    throw new Error(`事件卡存在 ${errors.length} 个 error，拒绝启动：\n${detail}`);
  }
  return { cards, fragments };
}
