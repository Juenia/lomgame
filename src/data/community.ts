/**
 * 运营物料加载（W6）：FAQ / 群规则 / 封测公告只有一份来源（src/data/*.yaml），
 * 游戏内 .帮助 与 docs/ 下的文档都由它生成，避免两处内容漂移。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const COMMUNITY_DIR = fileURLToPath(new URL('.', import.meta.url));
export const FAQ_FILE = join(COMMUNITY_DIR, 'faq.yaml');
export const RULES_FILE = join(COMMUNITY_DIR, 'community-rules.yaml');
export const BETA_INFO_FILE = join(COMMUNITY_DIR, 'beta-info.yaml');
export const MIN_FAQ_ITEMS = 10;

const FaqSchema = z.object({
  faq: z.array(z.object({ q: z.string().min(1), a: z.string().min(1) })).min(1),
});

const RulesSchema = z.object({
  rules: z.array(z.string().min(1)).min(3),
  forbidden_words_note: z.string().default(''),
  punishment: z.array(z.string().min(1)).default([]),
});

const BetaInfoSchema = z.object({
  phase: z.string().min(1),
  schedule: z.array(z.string().min(1)).default([]),
  scope: z.array(z.string().min(1)).default([]),
  not_included: z.array(z.string().min(1)).default([]),
  service: z.array(z.string().min(1)).default([]),
  known_issues: z.array(z.string().min(1)).default([]),
});

export type FaqItem = z.infer<typeof FaqSchema>['faq'][number];
export type CommunityRules = z.infer<typeof RulesSchema>;
export type BetaInfo = z.infer<typeof BetaInfoSchema>;

export interface CommunityBundle {
  faq: FaqItem[];
  rules: CommunityRules;
  beta: BetaInfo;
  issues: string[];
}

export function loadCommunity(): CommunityBundle {
  const issues: string[] = [];
  const faqParsed = FaqSchema.safeParse(parseYaml(readFileSync(FAQ_FILE, 'utf8')));
  const rulesParsed = RulesSchema.safeParse(parseYaml(readFileSync(RULES_FILE, 'utf8')));
  const betaParsed = BetaInfoSchema.safeParse(parseYaml(readFileSync(BETA_INFO_FILE, 'utf8')));

  if (!faqParsed.success) issues.push(`faq.yaml: ${faqParsed.error.issues.map((i) => i.message).join('; ')}`);
  if (!rulesParsed.success) issues.push(`community-rules.yaml: ${rulesParsed.error.issues.map((i) => i.message).join('; ')}`);
  if (!betaParsed.success) issues.push(`beta-info.yaml: ${betaParsed.error.issues.map((i) => i.message).join('; ')}`);

  const faq = faqParsed.success ? faqParsed.data.faq : [];
  if (faq.length > 0 && faq.length < MIN_FAQ_ITEMS) {
    issues.push(`FAQ 至少 ${MIN_FAQ_ITEMS} 条，当前 ${faq.length} 条`);
  }

  return {
    faq,
    rules: rulesParsed.success
      ? rulesParsed.data
      : { rules: [], forbidden_words_note: '', punishment: [] },
    beta: betaParsed.success
      ? betaParsed.data
      : { phase: '', schedule: [], scope: [], not_included: [], service: [], known_issues: [] },
    issues,
  };
}

export function renderFaqText(items: readonly FaqItem[]): string {
  return items.map((item, index) => `${index + 1}. ${item.q}\n   ${item.a}`).join('\n');
}

export function renderRulesText(rules: CommunityRules): string {
  const lines = rules.rules.map((rule) => `· ${rule}`);
  if (rules.punishment.length > 0) lines.push('', '处理方式：', ...rules.punishment.map((p) => `· ${p}`));
  return lines.join('\n');
}

export function renderBetaText(beta: BetaInfo): string {
  const section = (title: string, items: readonly string[]): string[] =>
    items.length === 0 ? [] : [`${title}`, ...items.map((item) => `· ${item}`), ''];
  return [
    `【${beta.phase}】`,
    '',
    ...section('时间安排', beta.schedule),
    ...section('开放范围', beta.scope),
    ...section('本次不做', beta.not_included),
    ...section('服务与反馈', beta.service),
    ...section('已知问题', beta.known_issues),
  ]
    .join('\n')
    .trim();
}
