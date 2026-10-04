import { fileURLToPath } from 'node:url';
import { loadCards, type LoadResult } from './loader.ts';
import type { LintIssue } from './lint.ts';

export function lintAll(): LintIssue[] {
  return loadCards().issues;
}

export type { LoadResult };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { cards, issues } = loadCards();
  const randomCards = cards.filter((card) => card.trigger.type === 'random');
  if (issues.length === 0) {
    console.log(`cards lint: 全部通过（${cards.length} 张卡，其中 random ${randomCards.length} 张）`);
  } else {
    for (const issue of issues) {
      console.log(`[${issue.level.toUpperCase()}] ${issue.cardId} — ${issue.message}`);
    }
    const errors = issues.filter((i) => i.level === 'error').length;
    console.log(
      `cards lint: ${cards.length} 张卡（random ${randomCards.length} 张），${errors} 个 error，${issues.length - errors} 个 warn`,
    );
    if (errors > 0) process.exitCode = 1;
  }
}
