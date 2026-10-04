/**
 * M2.73：**管理后台的自适应**。
 *
 * ## 这一份守什么
 *
 * 后台的布局原本全是**桌面尺寸**写死的：`aside{width:190px}`、`body{display:flex}`、
 * `.split{172px 292px 1fr}`（三栏合计 464px 起）。在手机上打开就是：
 * 侧栏吃掉一半屏宽、三栏各剩几十像素、整页横向溢出。
 *
 * 这一轮加了三档媒体查询把窄屏接过来。**判据分三层**：
 *
 * | 层 | 判据 |
 * | --- | --- |
 * | ① 前提 | 页面有 `viewport` meta —— 没有它手机浏览器按 980px 渲染，媒体查询全部失效 |
 * | ② 契约 | 三档断点存在，且各自必须包含那几条**改动布局**的规则 |
 * | ③ **兼容** | 桌面基线的写法**一条都没被改**（适配只发生在媒体查询里） |
 *
 * 第 ③ 层是这一轮最要紧的一条：改自适应最容易的翻车方式是顺手把桌面样式也改了，
 * 而那种改动**在窄屏上根本看不出来**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { adminPage } from '../src/admin/page.ts';

const HTML = adminPage();
/** 只取 <style> 里的那段 CSS（页面里还有内联脚本，混进来会误判） */
const CSS = /<style>([\s\S]*?)<\/style>/.exec(HTML)?.[1] ?? '';
/** 媒体查询之前的**基础（桌面）**规则区 */
const BASE = CSS.split('@media')[0] ?? '';

test('M2.73 前提：页面声明了 viewport，否则媒体查询在手机上根本不会生效', () => {
  assert.match(
    HTML,
    /<meta name="viewport" content="width=device-width,initial-scale=1">/,
    '没有 viewport meta 时手机浏览器按 980px 视口渲染，@media (max-width:900px) 永远不成立',
  );
});

test('M2.73 契约：三档断点都在（改断点要同时改这条与交付说明）', () => {
  for (const width of [1180, 900, 560]) {
    assert.ok(
      CSS.includes('@media (max-width:' + width + 'px)'),
      width + 'px 那一档不见了 —— 断点是契约，删它要说明白为什么',
    );
  }
});

test('M2.73 契约：窄屏那一档必须真的把「写死的宽度」解开', () => {
  const narrow = /@media \(max-width:900px\)\{([\s\S]*?)\n@?\}/.exec(CSS.replace(/\n'\+\s*'/g, ''))?.[1] ?? '';
  const block = narrow === '' ? CSS.slice(CSS.indexOf('@media (max-width:900px)')) : narrow;
  /** 一条条点名：每一条都是「不改就溢出 / 就没法用」的那种 */
  const must: Array<[string, string]> = [
    ['body{display:block}', '侧栏必须从「并排」变成「上下」'],
    ['.split,.split2{grid-template-columns:1fr}', '三栏 / 两栏必须堆成一栏'],
    ['.gmtb{display:block;overflow-x:auto}', '宽表格要自己滚，而不是把整页撑破'],
    ['fieldset{min-width:0}', 'fieldset 默认 min-content，不解除就顶住父级不肯收缩'],
    ['#catTree{display:flex', '分类栏在窄屏上要变成横向可滚的一条'],
  ];
  for (const [needle, why] of must) {
    assert.ok(block.includes(needle), '窄屏档里缺了 ' + needle + '（' + why + '）');
  }
});

test('M2.73 兼容：桌面基线一条都没动（适配只发生在媒体查询里）', () => {
  /*
   * 判据是**冻结桌面那几条**：它们仍在基础区里，而且仍然是原样。
   * 谁把 `.split` 的基础列宽改成 1fr（"顺手统一一下"），这里就红。
   */
  assert.match(BASE, /body\{[^}]*display:flex/, '桌面仍然是「侧栏 + 主区」并排');
  assert.match(BASE, /aside\{width:190px;flex:0 0 190px/, '桌面侧栏仍是 190px');
  assert.match(BASE, /\.split\{display:grid;grid-template-columns:172px 292px minmax\(0,1fr\)/, '数据编辑器桌面仍是三栏');
  assert.match(BASE, /\.split2\{display:grid;grid-template-columns:320px minmax\(0,1fr\)/, 'GM 桌面仍是两栏');
  // 反向：这些覆盖**不该**出现在基础区（出现了就等于顺手改了桌面）
  assert.ok(!BASE.includes('body{display:block}'), '基础区里不该有窄屏那一条');
  assert.ok(!BASE.includes('grid-template-columns:1fr}'), '基础区里不该有「一栏」的覆盖');
});

test('M2.73 量尺：截图脚本用**真实布局视口**量溢出，且溢出会让它失败', async () => {
  /*
   * 真正量溢出要一个跑着的服务 + 一个浏览器，进不了 `npm test` ——
   * 所以这里钉住**那把尺子**，因为尺子本身错过一次：
   *
   * ⚠️ 第一版把 `Emulation.setDeviceMetricsOverride` 的 `mobile` 设成了 true，
   * 于是 Chrome 对「内容比视口宽」的页面做 **shrink-to-fit**：它不是让页面横向溢出，
   * 而是**把视口本身撑宽**（实测 `--size=390x844` 的世界面板报出 `window.innerWidth = 551`）。
   * 结果「超出 0」是个**假绿** —— 页面确实没溢出，因为它偷偷把尺子换了。
   * 关掉之后视口恒等于 `--size`，数字才可信。
   */
  const { readFile } = await import('node:fs/promises');
  const src = await readFile('scripts/admin-shot.mjs', 'utf8');
  assert.match(src, /mobile: false/, 'mobile 必须是 false —— 开了它会 shrink-to-fit，溢出数字变成假绿');
  assert.match(src, /arg\('size'/, '要能指定视口尺寸（否则只能看桌面）');
  assert.match(src, /process\.exitCode = 2/, '溢出要让脚本以非 0 退出 —— 否则「看一眼」永远只是看一眼');
});
