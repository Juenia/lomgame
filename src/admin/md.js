/*
 * 后台的极简 markdown 渲染器（M2.74）。
 *
 * ## 为什么需要它
 *
 * 后台有三处 `<pre class="md">`：运营面板的**封测日报**、模拟/压测的**完整报告**、
 * 以及压测每次运行的一行摘要。在那之前它们全都是 `esc2(...)` 之后**原样显示**的 ——
 * 也就是说，一份「有标题、有表格、有列表」的日报在后台长这样：
 *
 *     # 封测日报 · 2026-09-29
 *     ## 一、当日概况
 *     | 指标 | 数值 |
 *     |---|---|
 *     | 活跃用户（DAU） | 12 |
 *
 * 能读，但要靠人脑把竖线还原成表格。而这些文档本来就是生成给自己人看的，渲染出来更好读。
 *
 * ## 三条边界（都是刻意的）
 *
 * 1. **只支持这几种语法**：标题（# 到 ####）、表格、无序列表、行内代码、加粗、段落。
 *    这是 `ops/daily-report.ts` 与 `sim/report.ts` **实际用到**的全部 ——
 *    不追 CommonMark（写一个全的就要写一套引用/嵌套/转义/HTML 透传，而那些分支没人测）。
 *    遇到不认识的语法**不报错**：当作普通段落原样显示（下表那一条判据守着）。
 * 2. **先转义、再认标签**：整行先过 `mdEsc`（把 `< > & " ` 变成实体），
 *    之后才把 `**加粗**` / ``代码`` 换成受控标签。顺序反过来的话，
 *    替换进去的标签会被自己转义掉；而这个顺序也让**任何 `<script>` 都进不来** ——
 *    日报的内容来自数据库（玩家昵称、指令名），那是外部输入。
 * 3. **不改源文本**：渲染只是多一个视图。日报的用途之一是「复制 markdown」拿走去归档，
 *    所以原文仍然完整保留（放在 `<details>` 里）。
 *
 * ## 它是纯函数
 *
 * `renderMarkdownHtml(text) -> html`：不碰 DOM、不看全局状态，所以能直接在 Node 里测
 * （`test/m2-74-admin-md-render.test.ts` 用它）。
 */

/** HTML 转义：与 console.js 的 esc2 同一口径（这里自带一份，免得依赖加载顺序） */
function mdEsc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 行内：转义之后再把 行内代码 与 加粗 换成标签。
 *
 * 用**一趟**扫描而不是两次 replace：两次就有先后，先认代码会把 `**x**` 变成
 * <code><b>x</b></code>（代码里不该再解析），先认加粗则有一个对称的毛病。
 * 合并成一个正则就天然没有嵌套问题，也少一条要记的顺序规则。
 */
function mdInline(text) {
  var t = mdEsc(text);
  t = t.replace(/`([^`]+)`|\*\*([^*]+)\*\*/g, function (match, code, bold) {
    return code === undefined ? '<b>' + bold + '</b>' : '<code>' + code + '</code>';
  });
  return t;
}

/** 表格的分隔行：|---|---| 这种（只由 | - : 空格组成，且至少一个 -） */
function isTableRule(line) {
  if (!/^\s*\|?[\s:|-]*\|[\s:|-]*$/.test(line)) return false;
  return line.indexOf('-') >= 0;
}

/** 一行的单元格：去掉首尾的空段，再逐格去空白 */
function mdCells(line) {
  var parts = line.trim().split('|');
  if (parts.length > 0 && parts[0].trim() === '') parts.shift();
  if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop();
  return parts.map(function (cell) { return cell.trim(); });
}

/**
 * 把 markdown 渲染成 HTML 片段。
 * 不认识的语法原样当段落显示 —— **不抛错、不丢内容**。
 */
function renderMarkdownHtml(src) {
  var lines = String(src == null ? '' : src).split('\n');
  var out = [];
  var i = 0;

  while (i < lines.length) {
    var line = lines[i];

    /* ---- 空行：分段 ---- */
    if (line.trim() === '') { i += 1; continue; }

    /* ---- 表格：本行含 |，且下一行是分隔行 ---- */
    if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      var head = mdCells(line);
      i += 2;
      var body = [];
      while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim() !== '') {
        body.push(mdCells(lines[i]));
        i += 1;
      }
      out.push('<table class="gmtb"><tr>' + head.map(function (cell) {
        return '<th>' + mdInline(cell) + '</th>';
      }).join('') + '</tr>' + body.map(function (cells) {
        return '<tr>' + cells.map(function (cell) { return '<td>' + mdInline(cell) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</table>');
      continue;
    }

    /* ---- 标题：# ~ #### ---- */
    var heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      var level = heading[1].length + 1;   // # → h2（页面里 h1 是站点标题）
      out.push('<h' + level + ' class="mdh">' + mdInline(heading[2]) + '</h' + level + '>');
      i += 1;
      continue;
    }

    /* ---- 无序列表：连续的 - / * 项合成一个 ul ---- */
    if (/^\s*[-*]\s+/.test(line)) {
      var items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i += 1;
      }
      out.push('<ul class="mdul">' + items.map(function (item) {
        return '<li>' + mdInline(item) + '</li>';
      }).join('') + '</ul>');
      continue;
    }

    /* ---- 段落：连续的普通行合成一个 p ---- */
    var para = [];
    while (i < lines.length && lines[i].trim() !== '' &&
           !/^#{1,4}\s/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) &&
           !(lines[i].indexOf('|') >= 0 && i + 1 < lines.length && isTableRule(lines[i + 1]))) {
      para.push(lines[i]);
      i += 1;
    }
    out.push('<p class="mdp">' + para.map(mdInline).join('<br>') + '</p>');
  }

  return out.join('');
}
