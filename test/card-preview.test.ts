import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ALL_PATHWAYS, ALL_SEQUENCES, sequenceTitle } from '../src/card/titles.ts';

const previewFile = new URL('../docs/card-preview.html', import.meta.url);

function html(): string {
  return readFileSync(previewFile, 'utf8');
}

/** 取出内联脚本（H5 是自包含单文件，没有外部 js） */
function script(): string {
  const match = html().match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'card-preview.html 里找不到内联脚本');
  return match![1];
}

test('H5 预览：脚本语法合法（浏览器里不会因解析错误整页空掉）', () => {
  const js = script();
  assert.ok(js.length > 500, '脚本太短，可能被截断');
  // new Function 会做完整解析；语法错在这里就抛
  assert.doesNotThrow(() => new Function(js));
});

/** H5 里那份 TITLES 的下标即序列号 —— 与 titles.ts 是同一份数据的两种写法 */
function previewTitles(): Record<string, string[]> {
  const block = script().match(/const TITLES = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'H5 里找不到 TITLES 表');
  const out: Record<string, string[]> = {};
  for (const pathway of ALL_PATHWAYS) {
    const row = block![1].match(new RegExp(pathway + ':\\s*\\[([^\\]]*)\\]'));
    assert.ok(row, `H5 的 TITLES 缺途径 ${pathway}`);
    out[pathway] = row![1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  }
  return out;
}

test('H5 预览：称号表与 titles.ts 逐格一致（220 格，改表必须两边一起改）', () => {
  const titles = previewTitles();
  const drift: string[] = [];
  for (const pathway of ALL_PATHWAYS) {
    for (const sequence of ALL_SEQUENCES) {
      const expected = sequenceTitle(pathway, sequence);
      const actual = titles[pathway]![sequence];
      if (actual !== expected) {
        drift.push(`${pathway} 序列 ${sequence}：H5「${actual}」≠ titles.ts「${expected}」`);
      }
    }
  }
  assert.deepEqual(drift, []);
});

test('H5 预览：途径主题齐全，且可达性阈值与称号表同口径', () => {
  const js = script();
  for (const pathway of ALL_PATHWAYS) {
    assert.match(js, new RegExp(`${pathway}:\\s*\\{ bg:`), `H5 的 THEMES 缺途径 ${pathway}`);
  }
  assert.match(js, /const REACHABLE = 2;/);
});

test('H5 预览：卡面上不许出现没有字段来源的装饰数字（幸运 / 神秘 / 灰雾回响）', () => {
  const js = script();
  /*
   * ⚠️ M2.76：判据必须是**独立出现的那个词**，不能是子串包含 ——
   * 「幸运儿」是**怪物途径序列 7 的正当原作称号**（数据集 `序列名称全表.yaml` 逐字），
   * 而 `js.includes('幸运')` 会把它一起判成违规。
   * 改后的模式要求那个词后面紧跟引号或冒号（即它自己是一个标签/键），
   * 于是 `'幸运儿'` 不再命中，而 `'幸运'` 仍然命中。
   */
  for (const ghost of ['幸运', '神秘', '灰雾回响']) {
    const asOwnWord = new RegExp(ghost + "['\"：:]", 'u');
    assert.ok(!asOwnWord.test(js), `H5 里还留着无来源的字段：${ghost}`);
  }
});
