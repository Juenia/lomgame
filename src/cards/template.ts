import { z } from 'zod';
import type { Rng } from '../domain/character/types.ts';

/**
 * 卡片文本模板：骨架 + 变量片段（W3 要求「不要手写长文」）。
 * 语法 {{键}}；键要么来自 fragments.yaml 的片段池，要么是运行时上下文（地点/名字/途径）。
 * 片段选取同样由 seed 驱动 —— 同一 seed 复现同一段文本。
 */
export const CONTEXT_KEYS = ['地点', '名字', '途径'] as const;

/** 上下文没给值时的兜底文本（宁可含糊，也不能把 {{键}} 直接发给玩家） */
export const CONTEXT_DEFAULTS: Record<(typeof CONTEXT_KEYS)[number], string> = {
  地点: '某处',
  名字: '你',
  途径: '这条途径',
};

const FragmentPoolsSchema = z.record(z.string(), z.array(z.string().min(1)).min(1));

export interface FragmentPools {
  [key: string]: string[];
}

export function parseFragments(raw: unknown): { pools: FragmentPools; issues: string[] } {
  const issues: string[] = [];
  const container = (raw ?? {}) as { fragments?: unknown };
  const parsed = FragmentPoolsSchema.safeParse(container.fragments ?? {});
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(`${issue.path.join('.') || '<root>'}: ${issue.message}`);
    }
    return { pools: {}, issues };
  }
  for (const key of CONTEXT_KEYS) {
    if (key in parsed.data) {
      issues.push(`片段池不能使用保留键 ${key}（属于运行时上下文）`);
    }
  }
  return { pools: parsed.data, issues };
}

const TOKEN = /\{\{([^{}]+)\}\}/g;

export function templateKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const match of text.matchAll(TOKEN)) {
    const key = match[1]?.trim();
    if (key) keys.add(key);
  }
  return [...keys];
}

export interface TemplateIssue {
  level: 'error' | 'warn';
  message: string;
}

/** 校验卡片文本里用到的键都存在；未定义的键在运行期会原样留在文本里，所以必须拦在 lint */
export function lintTemplate(text: string, pools: FragmentPools, where: string): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  for (const key of templateKeys(text)) {
    if ((CONTEXT_KEYS as readonly string[]).includes(key)) continue;
    if (!(key in pools)) {
      issues.push({ level: 'error', message: `${where} 使用了未定义的片段 {{${key}}}（请写进 fragments.yaml 或改用上下文键）` });
    }
  }
  const used = new Set(issues.map(() => ''));
  void used;
  return issues;
}

/** 渲染：上下文键优先，其余按 seed 从片段池里取 */
export function renderTemplate(
  text: string,
  pools: FragmentPools,
  rng: Rng,
  context: Record<string, string> = {},
): string {
  return text.replace(TOKEN, (whole, rawKey: string) => {
    const key = rawKey.trim();
    if (key in context) return context[key] ?? whole;
    if ((CONTEXT_KEYS as readonly string[]).includes(key)) {
      return CONTEXT_DEFAULTS[key as (typeof CONTEXT_KEYS)[number]] ?? whole;
    }
    const pool = pools[key];
    if (!pool || pool.length === 0) return whole;
    const index = Math.min(pool.length - 1, Math.floor(rng.next() * pool.length));
    return pool[index] ?? whole;
  });
}

/** 片段池里长期没被任何卡引用的键（内容体检用） */
/** 只被运行期逻辑（不是卡片文本）使用的片段键，lint 不应报「闲置」 */
export const RUNTIME_FRAGMENT_KEYS: readonly string[] = ['卜象'];

export function unusedFragmentKeys(pools: FragmentPools, usedKeys: ReadonlySet<string>): string[] {
  return Object.keys(pools).filter((key) => !usedKeys.has(key));
}
