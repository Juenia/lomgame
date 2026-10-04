/**
 * **模板字符串里不许出现没有插值的 `??`（M2.91）** —— 玩家看到的会是 JS 源码。
 *
 * 现场标本（第九十六批抓到的，一共 5 处）：
 *
 *   preview: `危险 ×${...} · 今日已探 view.usedToday ?? 0 次`
 *   //                              ^^^^^^^^^^^^^^^^^^^^^ 漏了 ${}
 *
 * 玩家在 `.探索` / `.今日` / 「下一步」菜单里看到的就是那串源码。
 * 它不报错、不影响判定、只在菜单的 preview 里 —— 而 preview 恰好是点开才看的地方。
 *
 * ## 判据
 *
 * 用 TypeScript 的解析器遍历 `src` 下的全部源码，取出**模板字面量的静态片段**
 * （`head.text` 与每个 `templateSpans[].literal.text`），凡是含 `??` 的一律报出来 ——
 * 在 `${}` 里面的 `??` 是正常写法，不算。
 *
 * ⚠️ 为什么不用更宽的判据（`.length` / `&&` / 方法调用）：
 * 真数据里有一处**合法**命中 —— `src/vplayer/session.ts` 的多行 SQL 模板字符串。
 * 判据宽到会误报，人就会开始忽略它（K14：抓不住故障的判据是装饰，
 * 而老是误报的判据会被当成噪声）。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
// 类型走 import type（值走 createRequire —— 测试跑的是 Node ESM，CJS 的 default 不稳）
import type * as TS from 'typescript';

const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof import('typescript');

/** 扫一段源码，返回「模板静态片段里含 ??」的位置（file:line 片段） */
function scanSource(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
  const hits: string[] = [];
  const report = (frag: string, pos: number): void => {
    if (!frag.includes('??')) return;
    const lc = sf.getLineAndCharacterOfPosition(pos);
    hits.push(file + ':' + (lc.line + 1) + ' 「' + frag.trim().slice(0, 80) + '」');
  };
  const visit = (node: TS.Node): void => {
    if (ts.isTemplateExpression(node)) {
      report(node.head.text, node.head.getStart(sf));
      for (const span of node.templateSpans) report(span.literal.text, span.literal.getStart(sf));
    } else if (ts.isNoSubstitutionTemplateLiteral(node)) {
      report(node.text, node.getStart(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** src 下的全部 .ts / .js */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|js)$/.test(entry.name)) out.push(p);
  }
  return out;
}

test('M2.91 判据自检：能抓到漏了 ${} 的那种写法，也不会误伤正常的插值', () => {
  // 坏样例：整段是字面量（第九十六批那 5 处就是这个形状）
  assert.equal(
    scanSource('bad.ts', 'const s = `今日已探 view.usedToday ?? 0 次`;').length,
    1,
    '判据抓不住构造出来的坏样例 —— 那就是条装饰',
  );
  // 好样例：`??` 在 ${} 里面，是正常写法
  assert.deepEqual(
    scanSource('good.ts', 'const s = `今日已探 ${view.usedToday ?? 0} 次`;'),
    [],
  );
});

test('M2.91 全库扫描：没有任何模板把 JS 表达式当文本印出去', () => {
  const files = sourceFiles('src');
  assert.ok(files.length > 300, '源码文件数不对：' + files.length);
  const hits: string[] = [];
  for (const file of files) hits.push(...scanSource(file, readFileSync(file, 'utf8')));
  assert.deepEqual(hits, [],
    '这些模板字符串把 JS 表达式当文本印出去了 —— 玩家看到的会是源码：' +
    String.fromCharCode(10) + hits.join(String.fromCharCode(10)));
});
