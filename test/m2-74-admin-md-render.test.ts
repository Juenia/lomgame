/**
 * M2.74：后台的 md 显示区要**渲染**，不能只是原样吐源码。
 *
 * 背景：后台曾有三处 <pre class="md">（运营面板的封测日报、压测的完整报告、
 * 压测每次运行的一行摘要），全都是 esc2() 之后的纯文本 —— 一份「有标题、有表格、
 * 有列表」的日报进了后台，出来还是一屏井号和竖线，得靠人脑把竖线还原成表格。
 *
 * 这个文件守四件事：
 *   1. 渲染器认得日报 / 压测报告**实际用到**的那几种语法（多一种都不承诺）；
 *   2. 内容里的 HTML 只会变成文本，不会变成标签 —— 日报的内容来自数据库
 *      （玩家昵称、指令名都在里面），那是外部输入；
 *   3. 不认识的语法降级成段落 —— 不抛错、不丢内容；
 *   4. 接线是真的：页面引了 md.js、顺序排在 console.js 之前、渲染器缺席时退化成纯文本。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { buildDailyReport } from '../src/ops/daily-report.ts';
import { UserActivityRepo } from '../src/infra/db/user-activity.ts';
import { createHarness } from './helpers/app.ts';

// md.js 是给浏览器用的普通脚本（没有 export），这里用 new Function 把函数取出来 ——
// 与 test/admin.test.ts 检查语法同一套路，但更进一步：真的调用它。
const mdSource = readFileSync('src/admin/md.js', 'utf8');
const { renderMarkdownHtml } = new Function(mdSource + '; return { renderMarkdownHtml };')() as {
  renderMarkdownHtml: (src: string) => string;
};
const render = (src: string): string => renderMarkdownHtml(src);

/** 表格分隔行的口径与 md.js 的 isTableRule 一致：只由 | - : 空格组成，且至少一个 - */
function countTables(markdown: string): number {
  return markdown
    .split('\n')
    .filter((line) => /^\s*\|?[\s:|-]*\|[\s:|-]*$/.test(line) && line.includes('-')).length;
}

test('后台 md 渲染：标题 / 表格 / 列表 / 段落各归各位', () => {
  const html = render(
    [
      '# 封测日报',
      '',
      '## 一、当日概况',
      '',
      '| 指标 | 数值 |',
      '|---|---|',
      '| 活跃用户 | 12 |',
      '| 新增 | 3 |',
      '',
      '- seed：`vplayer-ci`',
      '- 策略：稳健型',
      '',
      '普通段落。',
    ].join('\n'),
  );
  // # → h2（页面里 h1 是站点标题）、## → h3、### → h4
  assert.match(html, /<h2 class="mdh">封测日报<\/h2>/);
  assert.match(html, /<h3 class="mdh">一、当日概况<\/h3>/);
  assert.match(html, /<table class="gmtb"><tr><th>指标<\/th><th>数值<\/th><\/tr>/);
  assert.match(html, /<tr><td>活跃用户<\/td><td>12<\/td><\/tr>/);
  assert.match(html, /<ul class="mdul"><li>seed：<code>vplayer-ci<\/code><\/li>/);
  assert.match(html, /<p class="mdp">普通段落。<\/p>/);
  // 记号不许漏出来：漏了就等于「渲染」这件事没做
  assert.ok(!html.includes('|'), '渲染后还留着竖线');
  assert.ok(!html.includes('##'), '渲染后还留着井号');
  // 表格用的是后台既有的 gmtb 样式 —— 复用它，M2.73 给它的窄屏横向滚动才跟着生效
  assert.ok(html.includes('<table class="gmtb">'), '表格没有复用 .gmtb');
});

test('后台 md 渲染：行内代码与加粗互不嵌套', () => {
  assert.match(render('这里是 `**x**` 的写法'), /这里是 <code>\*\*x\*\*<\/code> 的写法/);
  assert.ok(!render('`**x**`').includes('<b>'), '代码里的星号被当成加粗解析了');
  assert.match(render('**粗**'), /<b>粗<\/b>/);
  // 一段里两种都有，各按各的来
  const both = render('- 用 `.探索` 时 **注意** 消化度');
  assert.ok(both.includes('<code>.探索</code>') && both.includes('<b>注意</b>'), '两种行内标记没有同时生效');
});

test('后台 md 渲染：内容里的 HTML 只会变成文本，不会变成标签', () => {
  const html = render(
    [
      '# <script>alert(1)</script>',
      '',
      '| <img src=x onerror=alert(1)> | 1 |',
      '|---|---|',
      '| <b>粗</b> | 2 |',
    ].join('\n'),
  );
  assert.ok(!html.includes('<script'), 'script 标签漏进来了');
  assert.ok(!html.includes('<img'), 'img 标签漏进来了');
  assert.ok(!html.includes('<b>'), '内容里的 <b> 被当成了标签');
  assert.ok(html.includes('&lt;script&gt;'), '尖括号没被转义');
  assert.ok(html.includes('&lt;img'), 'img 的尖括号没被转义');
  // 转义不影响结构：表格照样成表
  assert.match(html, /<table class="gmtb"><tr><th>&lt;img[\s\S]*?<\/table>/);
  // 也不能因为「看着像标签」就把内容删掉
  assert.ok(html.includes('alert(1)'), '内容被丢掉了');
});

test('后台 md 渲染：不认识的语法降级成段落，不抛错也不丢字', () => {
  const html = render(['> 引用不是支持的语法', '', '```', '代码块也不支持', '```'].join('\n'));
  assert.ok(html.includes('&gt; 引用不是支持的语法'), '引用那行没按普通段落显示');
  assert.ok(html.includes('代码块也不支持'), '代码块里的内容被丢了');
  assert.ok(!html.includes('<blockquote'), '渲染器不该承诺支持引用');
  assert.ok(!html.includes('<pre'), '渲染器不该承诺支持代码块');
  // 空行、空串、纯空白：不许炸
  assert.equal(render(''), '');
  assert.equal(render('\n\n  \n'), '');
  assert.doesNotThrow(() => render(undefined as unknown as string));
});

test('后台 md 渲染：连续普通行合成一段，段内换行变 br', () => {
  const html = render(['第一行', '第二行', '', '另起一段'].join('\n'));
  assert.match(html, /<p class="mdp">第一行<br>第二行<\/p><p class="mdp">另起一段<\/p>/);
});

test('封测日报：真实生成的 markdown 能渲染成标题 + 表格 + 列表', async () => {
  const h = createHarness();
  try {
    await h.createCharacter('20001', '克莱恩');
    h.advance(11_000);
    await h.send({ rawText: '.状态', userId: '20001' });

    const date = new UserActivityRepo(h.app.db).dates()[0]!;
    const report = buildDailyReport(h.app.db, date);

    // 先证明这份 markdown 真的带了要渲染的结构 —— 否则下面全是空转
    const tables = countTables(report.markdown);
    assert.ok(tables > 0, '日报里没有表格了，这个用例失去意义');
    assert.match(report.markdown, /^# /m, '日报没有一级标题了');
    assert.match(report.markdown, /^- /m, '日报没有列表项了');

    const html = render(report.markdown);
    assert.equal((html.match(/<table class="gmtb">/g) ?? []).length, tables, '渲染出的表格数与原文对不上');
    assert.ok((html.match(/<ul class="mdul">/g) ?? []).length > 0, '列表没渲染出来');
    assert.ok(html.includes('<h2 class="mdh">'), '一级标题没渲染出来');
    assert.ok(html.includes('<h3 class="mdh">') || html.includes('<h4 class="mdh">'), '小节标题没渲染出来');
    assert.ok(!html.includes('|---'), '渲染后还留着表格分隔行');
    assert.ok(!/^#{1,4} /m.test(html), '渲染后还留着标题记号');
    // 日报里有序列号、区间这类带 | 的表格单元格，渲染后不该再出现裸竖线
    assert.ok(!html.includes('|'), '渲染后还留着竖线');
  } finally {
    h.app.close();
  }
});

test('后台接线：页面引了 md.js，且必须排在 console.js 之前', async () => {
  const { adminPage } = await import('../src/admin/page.ts');
  const html = adminPage();
  assert.match(html, /<script src="\/admin\/md\.js"><\/script>/, '页面没有引用 md.js');
  // 顺序反了 = 面板整块渲染不出来（白屏级），这是最容易在重排 <script> 时踩掉的一条
  assert.ok(
    html.indexOf('/admin/md.js') < html.indexOf('/admin/console.js'),
    'md.js 必须排在 console.js 之前 —— console.js 渲染面板时要直接用 renderMarkdownHtml',
  );
  // 静态脚本是硬编码白名单，漏登记就是 404，而 404 只会在浏览器控制台里看见
  const routes = readFileSync('src/admin/index.ts', 'utf8');
  assert.ok(routes.includes("'/admin/md.js'"), 'CLIENT_SCRIPTS 白名单里没有 md.js —— 请求会 404');
});

test('后台接线：渲染视图有样式，且原文一个字都没丢', async () => {
  const { adminPage } = await import('../src/admin/page.ts');
  const html = adminPage();
  // 渲染视图的样式：没有它就是一堆裸标签，比不渲染还难读
  assert.ok(html.includes('.mdview{'), '渲染视图没有样式');
  assert.ok(html.includes('.mdview table'), '渲染视图里的表格没接后台表格样式');

  const js = readFileSync('src/admin/console.js', 'utf8');
  // 两处显示区走渲染
  assert.match(js, /'<div class="mdview">' \+ mdView\(d\.reportMarkdown\)/, '日报没有走渲染');
  assert.match(js, /'<div class="mdview">' \+ mdView\(run\.markdown\)/, '压测完整报告没有走渲染');
  // 原文必须还在（「复制 markdown」按的就是它）
  assert.ok(js.includes('id="opsReport"'), '日报原文块被删了 —— 复制 markdown 会拿到空');
  assert.ok(js.includes("esc2(d.reportMarkdown)"), '日报原文没保留');
  assert.ok(js.includes("esc2(run.markdown)"), '压测报告原文没保留');
  // 一行摘要故意不渲染：它不是文档
  assert.match(js, /<pre class="md">' \+ esc2\(run\.oneLine\)/, '一行摘要不该被当成文档渲染');
  // 渲染器缺席时退化成纯文本，而不是让整块面板炸成空白
  assert.match(js, /function mdView\(/, 'console.js 没有 mdView 入口');
  assert.match(js, /typeof renderMarkdownHtml === 'function'/, 'mdView 没有兜底分支');
});
