#! /usr/bin/env node
/**
 * M2.22 任务 4：**重试循环扫描器**（K13 的全仓排查工具）。
 *
 * K13 的形状是：用例写「失败了就重来」，但重试的是**带冷却的指令**，
 * 而 harness 的注入时钟在循环里不动 —— 于是第 3 次起全部回「冷却中」，
 * **重试根本没发生**，这个循环看起来却完全正常。
 *
 * 本工具把「病灶」逐个数出来（任务书原话：红点是症状，循环是病灶）：
 *
 *   1. 找出 test/ 下所有重试循环（for / while，条件是 attempt / tries 之类）；
 *   2. 数出循环体范围（按缩进）；
 *   3. 检查三件事：
 *      · **有没有推进注入时钟**（\`.advance(\`）—— 没有就是潜在的 K13；
 *      · **发了哪几条指令**（从 \`rawText: '...'\` 提）—— 带冷却的才有风险；
 *      · **有没有补状态**（\`inventory.add\` / \`makeReady\` / \`flags.set\` / \`characters.update\`）
 *        —— 阶段失败会损材料，不补的话循环会因「材料不足」空转。
 *
 * 用法：node scripts/scan-retry-loops.ts [--verbose]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const VERBOSE = process.argv.includes('--verbose');

interface Loop {
  path: string;
  line: number;
  condition: string;
  bodyLines: number;
  advances: string[];
  resets: string[];
  commands: string[];
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
/*
 * ⚠️ 第一版这里写的是 t.includes('tries') —— **误报源**：
 * Object.entries 里正好含 "tries"（e-n-**t-r-i-e-s**），
 * 于是 8 个「遍历对象」的 for 全部被当成重试循环，把真信号淹了。
 * 判据改成「attempt / tries / retry 必须是一个独立的标识符」（前面不能是字母）。
 */
const RETRY_WORD = /(^|[^A-Za-z])(attempt|tries|retry)/;
const isLoopStart = (text: string): boolean => {
  const t = text.trim();
  if (!t.startsWith('for (') && !t.startsWith('while (')) return false;
  return RETRY_WORD.test(t);
};

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tsFilesUnder(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

const loops: Loop[] = [];

for (const path of tsFilesUnder(join(ROOT, 'test'))) {
  const lines = readFileSync(path, 'utf8').split('\n');
  lines.forEach((text, index) => {
    if (!isLoopStart(text)) return;
    const base = indentOf(text);
    const body: string[] = [];
    for (let i = index + 1; i < lines.length; i += 1) {
      const current = lines[i]!;
      if (current.trim() === '') continue;
      if (indentOf(current) <= base) break;
      body.push(current);
    }
    const adv = body.filter((l) => l.includes('.advance('));
    const res = body.filter(
      (l) => l.includes('inventory.add') || l.includes('makeReady') || l.includes('flags.set') || l.includes('characters.update'),
    );
    const cmds: string[] = [];
    for (const l of body) {
      const at = l.indexOf("rawText: '");
      if (at < 0) continue;
      const rest = l.slice(at + 11);
      const end = rest.indexOf("'");
      if (end < 0) continue;
      const cmd = rest.slice(0, end);
      if (!cmds.includes(cmd)) cmds.push(cmd);
    }
    loops.push({
      path: relative(ROOT, path).split('\\').join('/'),
      line: index + 1,
      condition: text.trim(),
      bodyLines: body.length,
      advances: adv.map((l) => l.trim()),
      resets: res.map((l) => l.trim()),
      commands: cmds,
    });
  });
}

console.log('=== test/ 下的重试循环扫描（M2.22 任务 4 / K13）===');
console.log('共 ' + loops.length + ' 处。判据三条：**推进时钟 / 补状态 / 发的什么指令**。');
console.log('');
const risky: Loop[] = [];
const safe: Loop[] = [];
for (const loop of loops) (loop.advances.length > 0 ? safe : risky).push(loop);

const render = (loop: Loop, tag: string): void => {
  console.log(tag + ' ' + loop.path + ':' + loop.line + '　（循环体 ' + loop.bodyLines + ' 行）');
  console.log('    条件：' + loop.condition);
  console.log('    指令：' + (loop.commands.length ? loop.commands.join('　|　') : '（循环体里没有 rawText —— 多半是直接调 repo，无冷却风险）'));
  console.log('    推进时钟：' + (loop.advances.length ? loop.advances.join(' / ') : '**无**'));
  console.log('    补状态：' + (loop.resets.length ? loop.resets.length + ' 处' : '**无**'));
  if (VERBOSE && loop.resets.length) for (const r of loop.resets) console.log('      · ' + r.slice(0, 150));
  console.log('');
};

console.log('---- A. 循环体里**没有**推进时钟的（潜在 K13，逐处判）----');
for (const loop of risky) render(loop, '[?]');
console.log('---- B. 循环体里**有**推进时钟的（已按 K13 处置）----');
for (const loop of safe) render(loop, '[ok]');
console.log('=== 小结 ===');
console.log('  无推进时钟：' + risky.length + ' 处　有推进时钟：' + safe.length + ' 处');
console.log('  ⚠️ 「无推进时钟」不等于有雷：只有当循环体里**重复发同一条带冷却的指令**时才成立。');
console.log('     逐处的处置写在 docs/M2.22-flaky排查.md。');
