#! /usr/bin/env node
/**
 * M2.21 任务 5：断言扫描工具 —— 输入一个字段名或函数名，输出全仓**哪些断言会受它影响**。
 *
 * 来源：K10（Record 的键存在 != switch 的分支存在）与 test/w4-command.test.ts 的漏改。
 * 那一轮的教训不是「忘了改某一处」，而是**没有任何工具能在改之前告诉你「有哪几处」**。
 *
 * 用法（位置参数就是符号名，字段名 / 函数名一样）：
 *
 *   node scripts/scan-assertions.ts failMaterialLoss
 *   node scripts/scan-assertions.ts materialLossOf
 *   node scripts/scan-assertions.ts failMaterialLoss --limit 5      # 每节最多列几条
 *   node scripts/scan-assertions.ts failMaterialLoss --all          # 不截断
 *
 * 扫描范围：test/ 与 src/ 下的全部 .ts（不含 docs / 脚本 / 快照目录）。
 *
 * **实现是 grep 级的，不做 AST 分析**（任务书原话：目标是「不漏」，不是「零误报」）。
 * 它给出的三节各有分工：
 *
 *   §1 直接引用   —— 文件里出现了这个符号的行（含断言与非断言）。
 *   §2 命中用例块 —— **这一节才是防漏扫的那一节**：同一个 test() 块里只要出现过符号，
 *                   就把该块内**全部**断言列出来。因为「同一条用例里的其它断言」
 *                   即使字面不含符号，也几乎一定受它影响 ——
 *                   test/promotion.test.ts:162 的 materialLossOf(need, 1) 就是这种：
 *                   它一个字都没提 failMaterialLoss，却是最该跟着一起改的那一条。
 *   §3 间接依赖   —— 导入了「直接引用文件」、自身含断言、却**不含**符号的文件。
 *                   典型形状：通过被测函数间接吃到了这个参数（K10 的形状）。
 *
 * 退出码：命中 0 条时非零退出（方便当门槛用）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = process.cwd();
const ROOTS = ['src', 'test'];

interface Line {
  no: number;
  text: string;
}
interface FileScan {
  path: string;
  lines: Line[];
  imports: string[];
  /**
   * 断言覆盖的行号。**跨行断言要整段算进去** ——
   * `assert.deepEqual(` 后面跟着三行实参，那三行本身不含 `assert.`，
   * 只认字符串包含的话会把它们漏掉（第一版就是这么漏的）。
   */
  asserts: Set<number>;
  /** test() / it() 的起始行号（升序） */
  blocks: number[];
}

const isAssertLine = (text: string): boolean => text.includes('assert.') || text.includes('assert(');
const isBlockStart = (text: string): boolean => {
  const t = text.trimStart();
  return t.startsWith('test(') || t.startsWith('it(') || t.startsWith('await test(');
};
const isCommentLine = (text: string): boolean => {
  const t = text.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
};

function quoteOf(text: string): string {
  if (text.includes("'")) return "'";
  if (text.includes('"')) return '"';
  return '';
}

function importPathsOf(text: string): string[] {
  const t = text.trim();
  if (!t.startsWith('import ')) return [];
  const quote = quoteOf(t);
  if (!quote) return [];
  const start = t.indexOf(quote);
  const end = t.indexOf(quote, start + 1);
  if (end < 0) return [];
  const spec = t.slice(start + 1, end);
  return spec.startsWith('.') ? [spec] : [];
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tsFilesUnder(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

function scan(path: string): FileScan {
  const source = readFileSync(path, 'utf8');
  const lines: Line[] = [];
  const imports: string[] = [];
  const asserts = new Set<number>();
  const blocks: number[] = [];
  let depth = 0;
  let open = -1;
  source.split('\n').forEach((text, index) => {
    const no = index + 1;
    lines.push({ no, text });
    imports.push(...importPathsOf(text));
    if (depth === 0 && isAssertLine(text) && !isCommentLine(text)) {
      open = no;
      depth = 0;
    }
    if (open >= 0) {
      for (const ch of text) {
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
      }
      asserts.add(no);
      if (depth <= 0) {
        depth = 0;
        open = -1;
      }
    }
    if (isBlockStart(text) && !isCommentLine(text)) blocks.push(no);
  });
  return { path, lines, imports, asserts, blocks };
}

/** 该行属于哪一个 test 块（最近的、在它之前或就是它的那个块起点） */
function blockOf(file: FileScan, no: number): number | null {
  let found: number | null = null;
  for (const start of file.blocks) {
    if (start <= no) found = start;
    else break;
  }
  return found;
}

function resolveImport(fromPath: string, spec: string): string {
  const base = resolve(dirname(fromPath), spec);
  return base;
}

// ---------------- 参数 ----------------
const argv = process.argv.slice(2);
const symbol = argv.find((a) => !a.startsWith('--'));
if (!symbol) {
  console.error('用法：node scripts/scan-assertions.ts <字段名或函数名> [--limit N] [--all]');
  process.exit(2);
}
const limitArg = argv.indexOf('--limit');
const LIMIT = argv.includes('--all') ? Number.POSITIVE_INFINITY : limitArg >= 0 ? Number(argv[limitArg + 1] ?? 10) : 6;

// ---------------- 扫描 ----------------
const files = ROOTS.flatMap((root) => tsFilesUnder(join(ROOT, root))).map(scan);
const rel = (path: string): string => relative(ROOT, path).split('\\').join('/');

const hits = files.filter((file) => file.lines.some((line) => line.text.includes(symbol)));

const show = (items: string[]): string[] =>
  items.length > LIMIT ? [...items.slice(0, LIMIT), '  ...（还有 ' + (items.length - LIMIT) + ' 条，加 --all 看全）'] : items;

console.log('=== 断言扫描：' + symbol + ' ===');
console.log('扫描范围：' + ROOTS.map((r) => r + '/').join(' + ') + '（' + files.length + ' 个 .ts 文件）');
console.log('');

// ---------------- §1 直接引用 ----------------
console.log('§1 直接引用（' + hits.length + ' 个文件）');
if (hits.length === 0) console.log('  （没有任何文件提到这个词 —— 先确认拼写，或者它还没进仓库）');
const directLines: string[] = [];
for (const file of hits) {
  for (const line of file.lines) {
    if (!line.text.includes(symbol)) continue;
    const kind = file.asserts.has(line.no) ? '断言' : isCommentLine(line.text) ? '注释' : '实现/配置';
    directLines.push('  ' + rel(file.path) + ':' + line.no + '  [' + kind + '] ' + line.text.trim());
  }
}
for (const line of directLines) console.log(line);
console.log('');

// ---------------- §2 命中用例块 ----------------
console.log('§2 命中用例块内的**全部**断言（防漏扫：同一条用例里的其它断言也会受影响）');
const blockReports: string[] = [];
for (const file of hits) {
  const blocks = new Set<number>();
  for (const line of file.lines) {
    if (!line.text.includes(symbol)) continue;
    const start = blockOf(file, line.no);
    if (start !== null) blocks.add(start);
  }
  for (const start of [...blocks].sort((a, b) => a - b)) {
    const title = file.lines[start - 1]!.text.trim().slice(0, 90);
    const inBlock: string[] = [];
    for (const line of file.lines) {
      if (line.no <= start) continue;
      // 下一个块起点就结束
      const next = file.blocks.find((s) => s > start);
      if (next !== undefined && line.no >= next) break;
      if (!file.asserts.has(line.no)) continue;
      const tagged = line.text.includes(symbol) ? '现算（引用了符号本身）' : '同块（未引用符号，可能是硬编码期望）';
      inBlock.push('    ' + rel(file.path) + ':' + line.no + '  [' + tagged + '] ' + line.text.trim().slice(0, 140));
    }
    blockReports.push('  · ' + rel(file.path) + ':' + start + '  ' + title);
    blockReports.push(...show(inBlock));
  }
}
if (blockReports.length === 0) console.log('  （命中处不在任何 test 块内 —— 这多半是 src/ 的实现文件）');
for (const line of blockReports) console.log(line);
console.log('');

// ---------------- §3 间接依赖 ----------------
console.log('§3 间接依赖（导入了直接引用文件、自身含断言、但**不含**符号的文件）');
const hitPaths = new Set(hits.map((file) => file.path.replace(/\.ts$/, '')));
const indirect: string[] = [];
for (const file of files) {
  if (hits.includes(file)) continue;
  if (file.asserts.size === 0) continue;
  const linked = file.imports.some((spec) => hitPaths.has(resolveImport(file.path, spec)));
  if (!linked) continue;
  indirect.push('  ' + rel(file.path) + '（' + file.asserts.size + ' 条断言）' + '  ← 导入自：' +
    file.imports.filter((spec) => hitPaths.has(resolveImport(file.path, spec))).join('、'));
}
if (indirect.length === 0) console.log('  （没有）');
for (const line of show(indirect)) console.log(line);
console.log('');

// ---------------- §4 小结 ----------------
const assertDirect = directLines.filter((line) => line.includes('[断言]')).length;
const assertInBlock = blockReports.filter((line) => line.includes('[现算') || line.includes('[同块')).length;
console.log('§4 小结');
console.log('  · 直接引用行 ' + directLines.length + ' 条（其中断言 ' + assertDirect + ' 条）');
console.log('  · 命中用例块内的断言 ' + assertInBlock + ' 条（**改参数前要逐条过一遍的就是这些**）');
console.log('  · 间接依赖文件 ' + indirect.length + ' 个');
console.log('  · 口径：grep 级静态扫描，不解析 AST —— **允许误报，目标是「不漏」**');
console.log('  · 判据补充（K10）：配置里"有键"不等于判定层"有分支"；本工具只回答"谁提到了它"，');
console.log('    回答不了"谁读了它"—— 后者要靠端到端用例（见 docs/架构铁律.md K10 的处置）。');

if (hits.length === 0) process.exitCode = 1;
