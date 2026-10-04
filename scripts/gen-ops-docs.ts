/**
 * 运营物料生成（W6）：docs 下的公告 / FAQ / 群规则都由 src/data/*.yaml 生成，
 * 保证「游戏内 .帮助」与「群公告文档」永远一致。
 *   node scripts/gen-ops-docs.ts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCommunity } from '../src/data/community.ts';

const community = loadCommunity();
if (community.issues.length > 0) {
  console.error('运营物料有问题：');
  for (const issue of community.issues) console.error(`  ${issue}`);
  process.exit(1);
}

const docs = join(process.cwd(), 'docs');
const today = new Date().toISOString().slice(0, 10);

// FAQ.md
const faqLines: string[] = ['# 封测 FAQ', '', `> 本文件由 \`src/data/faq.yaml\` 生成，与游戏内 \`.帮助 faq\` 内容一致（生成日期 ${today}）。`, ''];
community.faq.forEach((item, index) => {
  faqLines.push(`## ${index + 1}. ${item.q}`, '', item.a, '');
});
writeFileSync(join(docs, 'FAQ.md'), faqLines.join('\n'), 'utf8');

// 群规则.md
const ruleLines: string[] = ['# 群规则', '', `> 本文件由 \`src/data/community-rules.yaml\` 生成，与游戏内 \`.帮助 规则\` 内容一致（生成日期 ${today}）。`, ''];
for (const rule of community.rules.rules) ruleLines.push(`- ${rule}`);
if (community.rules.punishment.length > 0) {
  ruleLines.push('', '## 处理方式', '');
  for (const item of community.rules.punishment) ruleLines.push(`- ${item}`);
}
if (community.rules.forbidden_words_note) {
  ruleLines.push('', `> ${community.rules.forbidden_words_note}`);
}
ruleLines.push('');
writeFileSync(join(docs, '群规则.md'), ruleLines.join('\n'), 'utf8');

// 封测公告.md
const beta = community.beta;
const betaLines: string[] = [
  `# 封测公告 · ${beta.phase}`,
  '',
  `> 本文件由 \`src/data/beta-info.yaml\` 生成，与游戏内 \`.帮助 公告\` 内容一致（生成日期 ${today}）。`,
  '',
];
const section = (title: string, items: readonly string[]): void => {
  if (items.length === 0) return;
  betaLines.push(`## ${title}`, '');
  for (const item of items) betaLines.push(`- ${item}`);
  betaLines.push('');
};
section('时间安排', beta.schedule);
section('开放范围', beta.scope);
section('本次不做', beta.not_included);
section('服务与反馈', beta.service);
section('已知问题', beta.known_issues);
writeFileSync(join(docs, '封测公告.md'), betaLines.join('\n'), 'utf8');

console.log(`运营物料已生成：docs/FAQ.md（${community.faq.length} 条）、docs/群规则.md（${community.rules.rules.length} 条）、docs/封测公告.md`);
