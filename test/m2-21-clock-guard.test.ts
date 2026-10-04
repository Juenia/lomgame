/**
 * M2.21 任务 6：判定层不得有隐式时钟入口（铁律 1 的**形状守卫**）。
 *
 * 为什么要有这个文件：铁律 1 说「判定层纯函数，无 IO、无时钟硬编码」，
 * 而 docs/架构铁律.md 第三节把它列在「守门清单：现在是『无』」里 ——
 * 原话是「没有形状守卫，每次靠人读一遍」。M2.21 就是被它咬到的那一轮，
 * 所以按那一节的规矩（谁的轮次碰到哪条，就在那一轮补上守卫）在这里补上。
 *
 * 三个断言各守一件事：
 *   1. apply.ts 的源码里不出现 Date.now() —— 守「不要有人把默认值加回来」；
 *   2. apply / applyWithCaps 的 Function.length —— 它等于**必填参数个数**，
 *      默认参数不计入。有默认值的时候是 3，去掉之后是 4。
 *      这条是运行时守卫：即使有人绕开源码扫描（例如改成 now ?? Date.now()）也会红；
 *   3. 整个 src/domain 下不出现 Date.now()（注释除外）。
 *
 * 第 3 条的扫描是**文本级**的（不是 AST），与 scripts/scan-assertions.ts 同一个口径：
 * 目标是「不漏」，允许误报。注释先剥掉再扫，否则 apply.ts 自己那段讲默认参数的
 * 注释就会把它自己判红。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply, applyWithCaps } from '../src/domain/effect/apply.ts';

const DOMAIN = join(process.cwd(), 'src', 'domain');

/**
 * 把每一行还原成「只剩代码」的样子，**行号与原文件 1:1**（注释行留空行占位）。
 * 块注释按状态机跨行处理；整行注释（以 // 或 * 开头）整行丢弃；
 * **行尾注释保留** —— 宁可误报，不可漏报。
 */
function codeLines(source: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of source.split('\n')) {
    let text = line;
    if (inBlock) {
      const end = text.indexOf('*/');
      if (end < 0) {
        out.push('');
        continue;
      }
      text = text.slice(end + 2);
      inBlock = false;
    }
    const start = text.indexOf('/*');
    if (start >= 0) {
      const end = text.indexOf('*/', start + 2);
      if (end < 0) {
        inBlock = true;
        text = text.slice(0, start);
      } else {
        text = text.slice(0, start) + text.slice(end + 2);
      }
    }
    const trimmed = text.trimStart();
    out.push(trimmed.startsWith('//') || trimmed.startsWith('*') ? '' : text);
  }
  return out;
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tsFilesUnder(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

test('M2.21 守卫：apply.ts 的源码里没有 Date.now()（默认值是去掉的，不是靠人记住）', () => {
  const file = join(DOMAIN, 'effect', 'apply.ts');
  const offenders = codeLines(readFileSync(file, 'utf8'))
    .map((line, index) => (line.includes('Date.now()') ? index + 1 : 0))
    .filter((line) => line > 0);
  assert.deepEqual(
    offenders,
    [],
    'apply.ts 又出现了 Date.now()（第 ' + offenders.join('、') + ' 行）：唯一数值入口不得带隐式时钟（铁律 1 / M2.21 任务 6）',
  );
});

test('M2.21 守卫：apply / applyWithCaps 的 now 没有默认值（Function.length = 形参总数 5）', () => {
  /*
   * Function.length = **「第一个带默认值的参数」之前**的参数个数。
   *
   * apply(state, deltas, reason, now, seed?)：
   *   now 带默认值时 → 3（数到默认参数就停）
   *   now 去掉默认值后 → **5**（五个形参全部计入 —— seed 是无默认值的可选参数，也计入）
   * applyWithCaps 多一个 caps = {}（默认值在最后）→ 同样是 5。
   *
   * 判据：**length 必须等于形参总数**。任何人在中途插入一个默认参数，这个数就会掉下来。
   */
  assert.equal(apply.length, 5, 'apply 的 now 必须必填 —— 长度掉到 3 说明默认值被加回来了');
  assert.equal(applyWithCaps.length, 5, 'applyWithCaps 的 now 必须必填（caps 的默认值在末尾，不影响这个数）');
});

test('M2.21 守卫：src/domain 全文没有 Date.now()（注释不算）', () => {
  const offenders: string[] = [];
  for (const file of tsFilesUnder(DOMAIN)) {
    codeLines(readFileSync(file, 'utf8')).forEach((line, index) => {
      if (line.includes('Date.now()')) offenders.push(file + ':' + (index + 1));
    });
  }
  assert.deepEqual(offenders, [], '判定层出现时钟硬编码：' + offenders.join('、'));
});
