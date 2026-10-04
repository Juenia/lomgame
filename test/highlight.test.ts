/**
 * M2.86：**正文高亮**（用户拍板）。
 *
 * > 「正文信息也不能过于精简，起码的信息量要凸显出来，还有重要信息要高亮显示，
 * >   尝试置入字体颜色，我在手机端发现了是存在 MD 消息的字体颜色的」
 *
 * ⚠️ 项目里有一份**旧**实测说手机端不支持颜色（`docs/QQ-markdown-能力实测.md`），
 * 而用户在手机端亲眼看到了。这里的立场是：**以真机观察为准、留开关、颜色只做增强**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HL_COLORS, HL_MARKS, hl, hlMark, hlStat } from '../src/adapter/highlight.ts';

test('高亮：开着才带 font，关掉逐字回到原文', () => {
  /*
   * ⚠️ M2.86：实现从 `<font color>` 换成了 **LaTeX**。
   *
   * 用户从那个机器人消息里复制出来的原始文本是 `\small{\textcolor{#FF6B6B}{…}}`，
   * 而它显示出来**是彩色的** ⇒ 官方 markdown 渲染 LaTeX；
   * 而 `<font color>` 在手机端**显示成原始标签**（用户实测）。
   * 所以断言跟着换成 LaTeX 的形态。
   */
  /*
   * ⚠️ **定界符 `$…$` 是必需的**（用户实机对照过）：
   *   `\textcolor{...}{红}`    → 裸文本 ✗
   *   `$\textcolor{...}{红}$`  → 红色 ✅
   * 而那个机器人的「复制文本」里没有 `$` —— QQ 复制富文本时会吃掉定界符，
   * 照它推断就会写反（我写反过一次）。
   */
  assert.equal(hl('危险', 'danger', true), '$\\textcolor{' + HL_COLORS.danger + '}{危险}$');
  assert.equal(hl('危险', 'danger', false), '危险', '关掉时不能留下任何标签');
  // 默认**开**：用户要颜色（真机观察），而「关」由调用方显式传 ——
  // 纯文本通道的默认关在**场景层**（renderScene 的 options.supportsColor === true）
  assert.equal(hl('危险', 'danger'), '$\\textcolor{' + HL_COLORS.danger + '}{危险}$');
});

test('高亮：**符号在颜色之外** —— 颜色失效时信息不丢', () => {
  const on = hlMark('生命 -12', 'danger', true);
  const off = hlMark('生命 -12', 'danger', false);
  assert.ok(on.includes(HL_MARKS.danger), '开着要有符号');
  assert.ok(off.includes(HL_MARKS.danger), '**关掉也要有符号** —— 这是降级的底线');
  assert.ok(!off.includes('textcolor'), '关掉不该有 LaTeX 颜色');
  assert.ok(on.includes('生命 -12') && off.includes('生命 -12'));
});

test('高亮：**十二类**颜色都在，且两两不同（同色就分不出信息差）', () => {
  /*
   * 清单**派生**、数量**写死**（AGENTS §3.1 / §3.5 这两条方向相反，别搞混）：
   *
   *   · `kinds` 从 `HL_COLORS` 派生 —— 手抄一份会安静地少读；
   *   · `length === 7` 写死 —— 它就是 G 表，**加一种颜色这条会红，提醒来看一眼**。
   *
   * 本轮 `ok`（健康绿）就是从 6 变 7 的那一次 —— 这条用例当场红了，
   * 于是确认了新色确实进了色板。
   */
  const kinds = Object.keys(HL_COLORS) as Array<keyof typeof HL_COLORS>;
  // M2.86 加了一对「数值升降」：up（绿 ▲）/ down（红 ▼）—— 见 highlight.ts 的说明
  assert.equal(kinds.length, 12, '色板数量变了：现在是 ' + kinds.join('/'));
  /*
   * M2.86：**允许两对刻意共用的颜色**。
   *
   * 原来的判据是「所有颜色两两不同」。加了 `up` / `down`（数值升降）之后它红了 ——
   * 因为它们与 `ok` / `danger` **同色**。
   *
   * 那个重复不是疏忽，是设计：
   *   · `up`   = 绿 ▲ 涨  ≡ `ok`     = 健康绿
   *   · `down` = 红 ▼ 跌  ≡ `danger` = 危险红
   * 「涨」与「健康」在视觉上本来就该是同一个绿 —— 给它们不同的绿反而更难认。
   *
   * 所以判据收紧成：**除了这两对，其余仍不许撞色**。
   * 这样既保住了「同色就分不出信息差」这条本意，又不会把有意的共用判成错。
   */
  const SHARED: ReadonlyArray<readonly [string, string]> = [
    ['ok', 'up'],
    ['danger', 'down'],
  ];
  const byColor = new Map<string, string[]>();
  for (const k of kinds) {
    const list = byColor.get(HL_COLORS[k]) ?? [];
    list.push(String(k));
    byColor.set(HL_COLORS[k], list);
  }
  const bad: string[] = [];
  for (const [color, names] of byColor) {
    if (names.length <= 1) continue;
    const allowed = SHARED.some(
      ([a, b]) => names.length === 2 && names.includes(a) && names.includes(b),
    );
    if (!allowed) bad.push(color + ' ← ' + names.join(' / '));
  }
  assert.deepEqual(bad, [], '这些颜色撞了，且不是刻意共用的那两对：' + bad.join('；'));
  for (const k of kinds) assert.ok(HL_MARKS[k] !== undefined, k + ' 缺符号定义');
});

test('高亮：hlStat 的标签走加粗，数值走符号 + 颜色（颜色失效也有两个层次）', () => {
  const on = hlStat('生命', '94/100', 'gain', true);
  const off = hlStat('生命', '94/100', 'gain', false);
  assert.ok(on.includes('**生命**'), '标签该加粗');
  assert.ok(off.includes('**生命**'), '关掉颜色时加粗还在');
  assert.ok(off.includes(HL_MARKS.gain));
  assert.ok(!off.includes('font'));
});
