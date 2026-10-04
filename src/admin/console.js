/*
 * 管理后台的框架（M2.52）—— **独立文件**，理由同 editor.js / gm.js / adapter.js。
 *
 * ## 它负责什么
 *
 *   · 按服务端的注册表（nav.ts）画导航 —— 加一个面板只改注册表一处
 *   · hash 路由：#overview / #gm / …，刷新之后还停在原处，链接也能直接发给人
 *   · 每个面板的装载钩子
 *   · **未实现的功能**的说明页：能点开，点开说清楚它是干什么的、为什么还没有
 *
 * ## 为什么未实现的功能也要有页面
 *
 * 「没做」和「坏了」在界面上长得一样（都是点不动），但处理方式完全不同。
 * 一个只写「开发中」的占位符等于没说 —— 所以计划里的每一项都要写清楚
 * 卡在什么地方（具体到缺哪个接口 / 哪个前提），以及做出来是什么样。
 */
var NAV = null;
var CUR = null;
var STARTED = {};

function esc2(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// M2.74：把 markdown 渲染出来，但**绝不因为渲染器不在就丢内容**。
// md.js 没加载成功（脚本顺序被改坏、浏览器拿了旧缓存）时退化成原文纯文本块：
// 观感差一点，但面板照常出得来 —— 比 'renderMarkdownHtml is not defined' 把整块面板炸成空白强得多。
function mdView(src) {
  var text = String(src == null ? '' : src);
  if (typeof renderMarkdownHtml === 'function') return renderMarkdownHtml(text);
  return '<pre class="md">' + esc2(text) + '</pre>';
}

const TIMEOFDAY = { dawn: '黎明', day: '白天', dusk: '黄昏', night: '夜晚' };

function bytes(n) {
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n > 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

function when(ms) {
  return ms ? new Date(ms).toLocaleString() : '—';
}

function cells(list) {
  return list.map(function (c) {
    return '<div class="gmstat"><b>' + esc2(String(c[1])) + '</b><span>' + esc2(c[0]) + '</span></div>';
  }).join('');
}

/* ---------------- 导航 ---------------- */

/** 某个面板的子面板（导航里缩进在它下面的那些） */
function navChildrenOf(id) {
  return allPanels().filter(function (p) { return p.parent === id; });
}

/** 展开 / 收起一个分类（点父项、或进入子页时调用） */
function navSetExpanded(parentId, open) {
  var box = document.querySelector('.navsub[data-of="' + parentId + '"]');
  if (!box) return;
  box.classList.toggle('hide', !open);
  var head = box.previousElementSibling;
  var caret = head ? head.querySelector('.navcaret') : null;
  if (caret) caret.textContent = open ? '▾' : '▸';
  if (head) head.classList.toggle('open', open);
}

function renderNav() {
  var nav = document.querySelector('#nav');
  var html = '<h1>后 台</h1>';
  NAV.panels.forEach(function (g) {
    html += '<div class="navgroup">' + esc2(g.group) + '</div>';
    /*
     * M2.83：**分类默认收起，点它才展开**。
     * 之前子项是常显的 —— 一直摊在导航里，看着像一堆平级项，
     * 而用户要的是「点开适配器，才看到里面是两个适配器」。
     */
    g.items.filter(function (p) { return !p.parent; }).forEach(function (p) {
      var kids = navChildrenOf(p.id);
      html += '<a class="navitem' + (p.state === 'planned' ? ' planned' : '') +
        '" data-p="' + esc2(p.id) + '">' +
        esc2(p.label) + (p.state === 'planned' ? '<em>未实现</em>' : '') +
        (kids.length ? '<i class="navcaret">▸</i>' : '') + '</a>';
      if (kids.length) {
        html += '<div class="navsub hide" data-of="' + esc2(p.id) + '">' +
          kids.map(function (k) {
            return '<a class="navitem sub" data-p="' + esc2(k.id) + '">' + esc2(k.label) + '</a>';
          }).join('') + '</div>';
      }
    });
  });
  html += '<div class="navfoot">已实现 ' + countReady() + ' / ' + total() + ' 个面板</div>';
  nav.innerHTML = html;
  Array.prototype.forEach.call(nav.querySelectorAll('.navitem'), function (a) {
    a.onclick = function () {
      // 点分类：切换展开 / 收起（同时也会进入它自己的页面，见 go）
      if (navChildrenOf(a.dataset.p).length > 0) {
        navSetExpanded(a.dataset.p, !a.classList.contains('open'));
      }
      go(a.dataset.p);
    };
  });
}

function allPanels() {
  var out = [];
  NAV.panels.forEach(function (g) { g.items.forEach(function (p) { out.push(p); }); });
  return out;
}
function total() { return allPanels().length; }
function countReady() { return allPanels().filter(function (p) { return p.state === 'ready'; }).length; }
function specOf(id) {
  return allPanels().filter(function (p) { return p.id === id; })[0] || null;
}

/* ---------------- 路由 ---------------- */

function sectionOf(id) { return document.querySelector('#tab-' + id); }

function go(id) {
  var p = specOf(id);
  if (!p) { id = 'overview'; p = specOf('overview'); }
  if (!p) return Promise.resolve();

  Array.prototype.forEach.call(document.querySelectorAll('.navitem'), function (a) {
    a.classList.toggle('on', a.dataset.p === id);
  });
  // 进入子页时把它的分类展开 —— 否则刷新后停在子页，导航里却看不到自己在哪
  if (p.parent) navSetExpanded(p.parent, true);

  /*
   * 可见性按**注册表**推导，不写死名单。
   * 写死过一版：加了新面板却忘了往那个数组里补名字，面板就永远藏着 ——
   * 而它「点了没反应」的样子和没做一模一样。
   */
  var visible = p.state === 'planned' ? 'planned' : id;
  allPanels().forEach(function (x) {
    if (x.state !== 'ready') return;
    var s = sectionOf(x.id);
    if (s) s.classList.toggle('hide', x.id !== visible);
  });
  var plannedSection = sectionOf('planned');
  if (plannedSection) plannedSection.classList.toggle('hide', visible !== 'planned');
  if (CUR !== id) STARTED[id] = false;
  CUR = id;
  if (location.hash !== '#' + id) location.hash = id;

  if (p.state === 'planned') { renderPlanned(p); return Promise.resolve(); }
  var hook = HOOKS[id];
  if (hook) return Promise.resolve(hook()).catch(function () { /* 面板自己会显示错误 */ });
  return Promise.resolve();
}

/* ---------------- 未实现的说明页 ---------------- */

function renderPlanned(p) {
  var out = ['<h2>' + esc2(p.label) + ' <span class="tag">未实现</span></h2>'];
  out.push('<p class="sub">' + esc2(p.summary) + '</p>');
  out.push('<div class="warn">这不是坏了 —— 是这个功能还没有做。下面是它卡在什么地方。</div>');
  out.push('<fieldset><legend>为什么现在还没有</legend><ul class="plain">' +
    (p.blockedBy || []).map(function (b) { return '<li>' + esc2(b) + '</li>'; }).join('') + '</ul></fieldset>');
  out.push('<fieldset><legend>做出来是什么样</legend><ol class="plain">' +
    (p.plan || []).map(function (x) { return '<li>' + esc2(x) + '</li>'; }).join('') + '</ol></fieldset>');
  out.push('<div class="hint">这一页本身也是框架的一部分：未实现的功能在导航里有位置、点得开、' +
    '说得清，人就不必去猜是没做还是坏了。</div>');
  document.querySelector('#tab-planned').innerHTML = out.join('');
}

/* ---------------- 总览 ---------------- */

function loadOverview() {
  return api('/overview').then(function (d) {
    var out = [];
    out.push('<h2>总览</h2>');
    out.push('<p class="sub">快照取自 /health 的同一份数据（不另算一份口径）。</p>');

    out.push('<fieldset><legend>进程</legend><dl class="kv">' +
      '<dt>PID</dt><dd>' + d.process.pid + '</dd>' +
      '<dt>启动于</dt><dd>' + esc2(d.process.startedAt) + '</dd>' +
      '<dt>数据库</dt><dd><code>' + esc2(d.process.dbPath) + '</code></dd>' +
      '<dt>时间旅行</dt><dd>' + (d.process.timeTravelDays ? d.process.timeTravelDays + ' 天' : '未启用') + '</dd>' +
      '</dl></fieldset>');

    out.push('<fieldset><legend>规模</legend><div class="gmstats">' + cells(d.scale.map(function (s) {
      return [s.label, s.value];
    })) + '</div></fieldset>');

    var w = d.world;
    out.push('<fieldset><legend>世界</legend><div class="gmstats">' + cells([
      ['时段', TIMEOFDAY[w.timeOfDay] || w.timeOfDay],
      ['月相', w.moonPhase + ' / 30' + (w.moonPhase === 15 ? '（月圆）' : '')],
      ['雾日', w.foggy ? '是' : '否'],
      ['有天气的地点', w.locations],
      ['轻度 tick', w.lightTicks],
      ['重度 tick', w.heavyTicks],
    ]) + '</div><div class="hint">上次轻度结算 ' + when(w.lastLightAt) +
      '　上次重度结算 ' + when(w.lastHeavyAt) + '</div></fieldset>');

    out.push('<fieldset><legend>告警（' + d.ops.alerts.length + '）</legend>' + alertHtml(d.ops.alerts) + '</fieldset>');

    out.push('<fieldset><legend>留档</legend><div class="gmstats">' + cells([
      ['累计失控次数', d.ops.lostControlEvents],
      ['最近每日结算', d.ops.lastTick ? d.ops.lastTick.date : '—'],
      ['审计热表', d.audit.hotRemaining],
      ['审计已归档', d.audit.archivedTotal],
    ]) + '</div><div class="hint">备份：' +
      (d.backup ? esc2(d.backup.file) + '（' + bytes(d.backup.bytes) + '，共 ' + d.backup.count + ' 份）' : '还没有备份') +
      '　<a href="#backup">去备份面板 →</a></div></fieldset>');

    document.querySelector('#tab-overview').innerHTML = out.join('');
  });
}

function alertHtml(alerts) {
  if (!alerts.length) return '<div class="hint">没有告警。</div>';
  return alerts.map(function (a) {
    return '<div class="alert ' + (a.level === 'P0' ? 'p0' : 'p1') + '">' +
      '<b>' + esc2(a.level) + '</b> ' + esc2(a.message) +
      '<div class="hint">当前 ' + a.value + '，阈值 ' + a.threshold + '　→ ' + esc2(a.hint) + '</div></div>';
  }).join('');
}

/* ---------------- 运营指标 ---------------- */

function loadOps() {
  return api('/ops').then(function (d) {
    var out = ['<h2>运营指标</h2>', '<p class="sub">口径来自 ops/stats 与 ops/alerts，与每日日报同一套。</p>'];
    out.push('<fieldset><legend>告警（' + d.alerts.length + '）</legend>' + alertHtml(d.alerts) + '</fieldset>');

    var g = d.gameplay;
    out.push('<fieldset><legend>玩法（' + d.date + '）</legend><div class="gmstats">' + cells([
      ['角色', g.characters],
      ['每角色日卡触发', g.cardTriggerRate.toFixed(3)],
      ['每角色日失控', g.lostControlRate.toFixed(3)],
      ['死循环比例', g.deadlockRate.toFixed(3)],
      ['晋升成功', g.promotionSuccess],
      ['晋升总数', g.promotions],
      ['净化', g.purifies],
      ['占卜', g.divinations],
      ['已成交交易', g.tradesCompleted],
      ['待确认交易', g.tradesPending],
      ['队伍', g.parties],
      ['队伍任务', g.partyTasks],
    ]) + '</div></fieldset>');

    var b = d.beta;
    out.push('<fieldset><legend>封测</legend><div class="gmstats">' + cells([
      ['总用户', b.totalUsers],
      ['新手完成率', (b.onboardingRate * 100).toFixed(1) + '%'],
      ['反馈', b.feedback.total],
      ['投诉', b.feedback.complaints],
      ['投诉率', (b.feedback.complaintRate * 100).toFixed(2) + '%'],
    ]) + '</div></fieldset>');

    if (b.retention.length) {
      out.push('<fieldset><legend>留存</legend><table class="gmtb">' +
        '<tr><th>批次</th><th>人数</th><th>次日</th><th>7 日</th></tr>' +
        b.retention.map(function (r) {
          return '<tr><td>' + esc2(r.cohort) + '</td><td>' + r.size + '</td><td>' +
            (r.d1 === null ? '—' : (r.d1 * 100).toFixed(1) + '%') + '</td><td>' +
            (r.d7 === null ? '—' : (r.d7 * 100).toFixed(1) + '%') + '</td></tr>';
        }).join('') + '</table></fieldset>');
    }

    if (b.dauByDate.length) {
      out.push('<fieldset><legend>按日活跃</legend><table class="gmtb">' +
        '<tr><th>日期</th><th>DAU</th><th>新增</th><th>指令</th></tr>' +
        b.dauByDate.map(function (r) {
          return '<tr><td>' + esc2(r.date) + '</td><td>' + r.dau + '</td><td>' + r.newUsers +
            '</td><td>' + r.commands + '</td></tr>';
        }).join('') + '</table></fieldset>');
    }

    var ref = b.simulatorReference;
    out.push('<fieldset><legend>与模拟器的对照</legend><dl class="kv">' +
      '<dt>失控触发率</dt><dd>' + esc2(ref.lostControlRate) + '</dd>' +
      '<dt>晋升成功率</dt><dd>' + esc2(ref.promotionSuccessRate) + '</dd>' +
      '<dt>死循环比例</dt><dd>' + esc2(ref.deadlockRate) + '</dd>' +
      '<dt>材料比</dt><dd>' + esc2(ref.materialRatio) + '</dd>' +
      '</dl><div class="hint">这是模拟器给出的参考区间，用来判断真机数据偏没偏 —— 不是目标值。</div></fieldset>');

    // M2.74：日报是一份真正的 markdown（标题 / 表格 / 列表），先渲染成人看的样子；
    //    **原文一个字都不丢**，折叠在下面 —— 复制 markdown 按钮取的就是原文，
    //    渲染视图只负责好读，不负责当数据源。
    out.push('<fieldset><legend>今日日报（' + esc2(d.date) + '）</legend>' +
      '<div class="mdview">' + mdView(d.reportMarkdown) + '</div>' +
      '<details><summary>原文（markdown）</summary>' +
      '<pre class="md" id="opsReport">' + esc2(d.reportMarkdown) + '</pre></details>' +
      '<div class="row"><button class="ghost" id="opsCopy">复制 markdown</button></div>' +
      '<div class="hint">这份 markdown 由 ops/daily-report 生成，与归档进 beta_daily 的是同一份；' +
      '上面是渲染结果，折叠里是原文。</div></fieldset>');

    document.querySelector('#tab-ops').innerHTML = out.join('');
    var copy = document.querySelector('#opsCopy');
    if (copy) {
      copy.onclick = function () {
        navigator.clipboard.writeText(d.reportMarkdown).then(function () {
          copy.textContent = '已复制';
        }).catch(function () { copy.textContent = '复制失败（浏览器不给权限）'; });
      };
    }
  });
}

/* ---------------- 备份 ---------------- */

function loadBackup() {
  return api('/backup').then(renderBackup);
}

function renderBackup(d) {
  var out = ['<h2>备份</h2>',
    '<p class="sub">数据库快照。按日期命名，每天只留一份 —— 同一天再点一次不会重复写。</p>'];
  out.push('<fieldset><legend>操作</legend><div class="row">' +
    '<button id="bkDo">立即备份</button>' +
    '<input type="number" id="bkDays" value="7" min="1" max="365" style="width:70px">' +
    '<button class="ghost" id="bkPrune">清理更早的</button>' +
    '<span class="hint" style="margin:0">保留天数</span></div>' +
    '<div class="msg" id="bkMsg"></div>' +
    '<div class="hint">目录：<code>' + esc2(d.dir) + '</code>　共 ' + d.entries.length +
    ' 份，合计 ' + bytes(d.totalBytes) + '</div></fieldset>');
  out.push('<fieldset><legend>已有的备份</legend>' +
    (d.entries.length
      ? '<table class="gmtb"><tr><th>文件</th><th>大小</th><th>时间</th></tr>' + d.entries.map(function (e) {
          return '<tr><td><code>' + esc2(e.file) + '</code></td><td>' + bytes(e.bytes) +
            '</td><td>' + when(e.mtime) + '</td></tr>';
        }).join('') + '</table>'
      : '<div class="hint">还没有备份。点「立即备份」。</div>') +
    '</fieldset>');
  document.querySelector('#tab-backup').innerHTML = out.join('');

  function post(path, body) {
    var msgEl = document.querySelector('#bkMsg');
    msgEl.className = 'msg';
    msgEl.textContent = '处理中…';
    api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { msgEl.className = 'msg ok'; msgEl.textContent = r.message; renderBackup(r.view); })
      .catch(function (e) { msgEl.className = 'msg err'; msgEl.textContent = e.message; });
  }
  document.querySelector('#bkDo').onclick = function () { post('/backup', {}); };
  document.querySelector('#bkPrune').onclick = function () {
    post('/backup/prune', { retainDays: Number(document.querySelector('#bkDays').value) });
  };
}

/* ---------------- 玩家反馈 ---------------- */

function loadFeedback() {
  return api('/feedback').then(function (d) {
    var out = ['<h2>玩家反馈</h2>',
      '<p class="sub">.反馈 收到的东西。原文照发 —— 任何「摘要」都可能把关键信息抹掉。</p>'];
    out.push('<div class="gmstats">' + cells([
      ['反馈总数', d.total], ['其中投诉', d.complaints], ['本页显示', d.rows.length],
    ]) + '</div>');
    out.push('<div class="msg" id="fbMsg"></div>');

    if (!d.rows.length) {
      out.push('<fieldset><legend>反馈</legend><div class="hint">还没有人反馈过。</div></fieldset>');
      document.querySelector('#tab-feedback').innerHTML = out.join('');
      return;
    }

    out.push('<fieldset><legend>反馈（最近 ' + d.rows.length + ' 条）</legend><table class="gmtb">' +
      '<tr><th>#</th><th>时间</th><th>内容</th><th>分类</th><th>状态</th><th></th></tr>' +
      d.rows.map(function (r) {
        return '<tr data-fb="' + r.id + '">' +
          '<td>' + r.id + '</td>' +
          '<td>' + when(r.createdAt) + '</td>' +
          '<td class="fbtext">' + esc2(r.content) + '</td>' +
          '<td>' + selectHtml('cat', d.categoryLabels, r.category) + '</td>' +
          '<td>' + selectHtml('st', d.statusLabels, r.status) + '</td>' +
          '<td><button class="ghost" data-fbsave="' + r.id + '">保存</button></td>' +
          '</tr>';
      }).join('') + '</table></fieldset>');

    document.querySelector('#tab-feedback').innerHTML = out.join('');
    Array.prototype.forEach.call(document.querySelectorAll('[data-fbsave]'), function (b) {
      b.onclick = function () {
        var tr = b.closest('tr');
        var id = b.dataset.fbsave;
        var msgEl = document.querySelector('#fbMsg');
        api('/feedback/' + id, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            category: tr.querySelector('[data-cat]').value,
            status: tr.querySelector('[data-st]').value,
          }),
        }).then(function (r) { msgEl.className = 'msg ok'; msgEl.textContent = r.message; })
          .catch(function (e) { msgEl.className = 'msg err'; msgEl.textContent = e.message; });
      };
    });
  });
}

/** 选项按 label 排好；当前值一定在里面（不在就补进去，免得一保存就被改掉） */
function selectHtml(kind, labels, cur) {
  var keys = Object.keys(labels);
  if (keys.indexOf(cur) < 0) keys.unshift(cur);
  return '<select data-' + kind + '>' + keys.map(function (k) {
    return '<option value="' + esc2(k) + '"' + (k === cur ? ' selected' : '') + '>' +
      esc2(labels[k] || k) + '</option>';
  }).join('') + '</select>';
}

/* ---------------- 服务与访问（M2.82） ---------------- */

var AC = null;

function loadAccess() {
  return api('/access').then(renderAccess);
}

function renderAccess(d) {
  AC = d;
  var out = ['<h2>服务与访问</h2>',
    '<p class="sub">改的是 .env。每一行都分开列「磁盘上写的」与「进程在用的」——',
    '两者不一样时，保存成功的绿字**不代表已经生效**。</p>'];

  /*
   * 警告放最上面：绑到本机以外时，下面那张配置表会让人以为「只是多了几个选项」，
   * 而这几句说的才是真正的代价。
   */
  if (d.warnings.length) {
    out.push('<fieldset><legend>绑在本机以外时必须知道的事</legend><div class="warn">' +
      d.warnings.map(function (w) { return '· ' + esc2(w); }).join('<br>') + '</div></fieldset>');
  }

  out.push('<fieldset><legend>现在从哪些地址进得来</legend>' +
    '<table class="gmtb"><tr><th>范围</th><th>地址</th><th>说明</th></tr>' +
    d.reach.map(function (r) {
      return '<tr><td>' + esc2(r.scope) + '</td><td><code>' + esc2(r.url) + '</code></td><td>' +
        esc2(r.note) + '</td></tr>';
    }).join('') + '</table></fieldset>');

  out.push('<fieldset><legend>配置</legend>' +
    '<table class="gmtb"><tr><th>项目</th><th>.env 里写的</th><th>进程在用的</th><th>生效</th><th></th></tr>' +
    d.fields.map(function (f) {
      // 两边不一致时把磁盘那一列加粗 —— 那正是「改了但还没生效」的样子
      return '<tr><td>' + esc2(f.label) + '<div class="hint">' + esc2(f.hint) + '</div></td>' +
        '<td>' + (f.same ? '' : '<b>') + esc2(f.disk) + (f.same ? '' : '</b>') + '</td>' +
        '<td>' + esc2(f.running) + '</td>' +
        '<td>' + (f.apply === 'now' ? '立刻' : '<b>要重启</b>') + '</td>' +
        '<td><button class="ghost" data-akedit="' + esc2(f.key) + '">改</button></td></tr>';
    }).join('') + '</table><div id="akForm"></div></fieldset>');

  if (d.loginFails.length) {
    out.push('<fieldset><legend>正在被登录限流挡着的来源</legend>' +
      '<table class="gmtb"><tr><th>来源</th><th>失败次数</th><th>还要等</th></tr>' +
      d.loginFails.map(function (x) {
        return '<tr><td><code>' + esc2(x.ip) + '</code></td><td>' + x.fails + '</td><td>' +
          Math.ceil(x.retryAfterMs / 1000) + ' 秒</td></tr>';
      }).join('') + '</table>' +
      '<div class="hint">口令连错太多次会被指数退避挡一会儿 —— 不是锁死。' +
      '锁死会让别人故意打错几次就把你关在门外。</div></fieldset>');
  }

  document.querySelector('#tab-access').innerHTML = out.join('');
  Array.prototype.forEach.call(document.querySelectorAll('[data-akedit]'), function (b) {
    b.onclick = function () { openAccessEdit(b.dataset.akedit); };
  });
}

function openAccessEdit(key) {
  var f = (AC.fields || []).filter(function (x) { return x.key === key; })[0];
  if (!f) return;
  var box = document.querySelector('#akForm');
  box.innerHTML = '<fieldset><legend>改：' + esc2(f.label) + '</legend>' +
    '<label><span>新值</span><input type="' + (f.secret ? 'password' : 'text') +
    '" id="akVal" style="width:100%"></label>' +
    (f.secret
      ? '<div class="warn">口令改完**立刻**生效：包括你在内的所有人都会掉线，要重新登录。</div>'
      : '') +
    '<label><span>当前口令（确认是你本人）</span><input type="password" id="akPw" style="width:100%"></label>' +
    '<div class="row"><button id="akGo">保存</button>' +
    '<button class="ghost" id="akCancel">取消</button></div>' +
    '<div class="msg" id="akMsg"></div></fieldset>';
  document.querySelector('#akVal').focus();
  document.querySelector('#akCancel').onclick = function () { box.innerHTML = ''; };
  document.querySelector('#akGo').onclick = function () {
    var btn = this;
    btn.disabled = true;
    var msgEl = document.querySelector('#akMsg');
    msgEl.className = 'msg';
    msgEl.textContent = '保存中…';
    api('/access', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: key,
        value: document.querySelector('#akVal').value,
        password: document.querySelector('#akPw').value,
      }),
    }).then(function (r) {
      msgEl.className = 'msg ok';
      /*
       * 生效方式照抄服务端给的那一句，**不在这里重写一遍** ——
       * 「已保存」和「已生效」是两件事，而这个区别正是这一屏存在的理由。
       */
      msgEl.textContent = r.message;
      if (key === 'ADMIN_PASSWORD') {
        /*
         * 不自动刷新：刷新会立刻打到 401、弹出登录框，而人还没读完这句话。
         * 让「你现在要重新登录」变成一个他知道的、自己触发的动作。
         */
        msgEl.textContent += '　这一次登录态已经作废 —— 下次点击会要求重新登录。';
        return;
      }
      loadAccess();
    }).catch(function (e) {
      msgEl.className = 'msg err';
      msgEl.textContent = e.message;
      btn.disabled = false;
    });
  };
}


var LOG_LEVELS = { '': '全部', info: '信息', warn: '警告', error: '错误' };

/* ---------------- 日志 ---------------- */

function loadLogs() {
  var level = document.querySelector('#logLevel') ? document.querySelector('#logLevel').value : '';
  var q = document.querySelector('#logQ') ? document.querySelector('#logQ').value : '';
  return api('/logs?level=' + encodeURIComponent(level) + '&q=' + encodeURIComponent(q) + '&limit=300')
    .then(function (d) {
      var out = ['<h2>日志</h2>',
        '<p class="sub">进程内环形缓冲（固定容量 ' + d.capacity + ' 条，重启清空）。' +
        '终端上照旧能看到同一批 —— 这里只是让后台也能看。</p>'];

      out.push('<div class="gmstats">' + cells([
        ['信息', d.counts.info], ['警告', d.counts.warn], ['错误', d.counts.error],
        ['缓冲内', d.counts.total], ['已挤出', d.dropped],
      ]) + '</div>');

      out.push('<fieldset><legend>过滤</legend><div class="row">' +
        '<select id="logLevel">' + Object.keys(LOG_LEVELS).map(function (k) {
          return '<option value="' + k + '"' + (k === level ? ' selected' : '') + '>' + LOG_LEVELS[k] + '</option>';
        }).join('') + '</select>' +
        '<input type="text" id="logQ" placeholder="关键词（消息与 meta 都找）" value="' + esc2(q) + '" style="flex:1;min-width:200px">' +
        '<button id="logGo">查询</button>' +
        '<button class="ghost" id="logErr">只看错误</button></div>' +
        '<div class="hint">缓冲只有 ' + d.capacity + ' 条，' +
        (d.dropped > 0 ? '已经挤出 ' + d.dropped + ' 条 —— 这个窗口比你想的短。' : '目前还没挤出过。') +
        '</div></fieldset>');

      out.push('<fieldset><legend>最近 ' + d.entries.length + ' 条</legend>' +
        (d.entries.length === 0
          ? '<div class="hint">没有匹配的日志。</div>'
          : '<table class="gmtb"><tr><th>时间</th><th>级别</th><th>消息</th><th>附加</th></tr>' +
            d.entries.map(function (e) {
              return '<tr class="lv-' + e.level + '"><td>' + when(e.at) + '</td><td>' + e.level +
                '</td><td class="fbtext">' + esc2(e.message) + '</td><td class="fbtext"><code>' +
                esc2(e.meta || '') + '</code></td></tr>';
            }).join('') + '</table>') +
        '</fieldset>');

      document.querySelector('#tab-logs').innerHTML = out.join('');
      document.querySelector('#logGo').onclick = function () { loadLogs(); };
      document.querySelector('#logErr').onclick = function () {
        document.querySelector('#logLevel').value = 'error';
        document.querySelector('#logQ').value = '';
        loadLogs();
      };
      document.querySelector('#logLevel').onchange = function () { loadLogs(); };
    });
}

/* ---------------- 审计检索 ---------------- */

function loadAudit(params) {
  var q = params || {};
  if (!params) {
    var box = document.querySelector('#tab-audit');
    if (box && box.dataset.filled === '1') {
      q = {
        userId: document.querySelector('#auUser').value,
        command: document.querySelector('#auCmd').value,
        text: document.querySelector('#auText').value,
        from: document.querySelector('#auFrom').value,
        to: document.querySelector('#auTo').value,
      };
    }
  }
  var qs = [];
  ['userId', 'command', 'text'].forEach(function (k) {
    if (q[k]) qs.push(k + '=' + encodeURIComponent(q[k]));
  });
  if (q.from) qs.push('from=' + new Date(q.from).getTime());
  if (q.to) qs.push('to=' + new Date(q.to).getTime());
  return api('/audit?' + qs.join('&')).then(function (d) {
    var out = ['<h2>审计检索</h2>',
      '<p class="sub">玩家的每次指令都在这里，GM 的每一次改动也写进来（指令名以 gm. 开头）。' +
      '热表与归档表一起查。</p>'];
    out.push('<div class="gmstats">' + cells([
      ['命中', d.total], ['热表', d.hot], ['已归档', d.archived], ['本页', d.hits.length],
    ]) + (d.truncated ? '<div class="warn">结果被截断了，只显示最新的 ' + d.hits.length + ' 条。缩窄条件再查。</div>' : '') + '</div>');

    out.push('<fieldset><legend>条件</legend><div class="row">' +
      '<input type="text" id="auUser" placeholder="QQ / 用户 id" value="' + esc2(q.userId || '') + '" style="width:200px">' +
      '<input type="text" id="auCmd" placeholder="指令名（如 gm.stats）" value="' + esc2(q.command || '') + '" style="width:180px">' +
      '<input type="text" id="auText" placeholder="输入 / 输出里含" value="' + esc2(q.text || '') + '" style="width:180px">' +
      '</div><div class="row">' +
      '<span class="hint" style="margin:0">从</span><input type="datetime-local" id="auFrom" value="' + esc2(q.from || '') + '">' +
      '<span class="hint" style="margin:0">到</span><input type="datetime-local" id="auTo" value="' + esc2(q.to || '') + '">' +
      '<button id="auGo">查询</button><button class="ghost" id="auClear">清空条件</button></div>' +
      (d.applied.length ? '<div class="hint">生效的条件：' + esc2(d.applied.join('，')) + '</div>'
        : '<div class="hint">没有条件 —— 这是全部记录里最新的 ' + d.hits.length + ' 条。</div>') +
      '</fieldset>');

    out.push('<fieldset><legend>记录</legend>' +
      (d.hits.length === 0 ? '<div class="hint">没有匹配的记录。</div>'
        : '<table class="gmtb"><tr><th>时间</th><th>玩家</th><th>指令</th><th>输入</th><th>输出</th><th>来源</th></tr>' +
          d.hits.map(function (h) {
            return '<tr><td>' + when(h.createdAt) + '</td><td><code>' + esc2(h.userId.slice(0, 12)) +
              '</code></td><td><code>' + esc2(h.command) + '</code></td><td class="fbtext">' + esc2(h.input) +
              '</td><td class="fbtext">' + esc2(h.output) + '</td><td>' + (h.archived ? '归档' : '热表') + '</td></tr>';
          }).join('') + '</table>') +
      '</fieldset>');

    var box2 = document.querySelector('#tab-audit');
    box2.innerHTML = out.join('');
    box2.dataset.filled = '1';
    document.querySelector('#auGo').onclick = function () { loadAudit(); };
    document.querySelector('#auClear').onclick = function () { loadAudit({}); };
  });
}

/* ---------------- 世界状态 ---------------- */

function loadWorld() {
  return api('/world').then(function (d) {
    var out = ['<h2>世界状态</h2>',
      '<p class="sub">只读。世界状态是全服共享的，在没有「改动前快照 + 一键还原」之前，' +
      '后台只该看 —— 要手动推进请用时间旅行端点（它有 token 校验且会留档）。</p>'];

    out.push('<fieldset><legend>时钟</legend><div class="gmstats">' + cells([
      ['时段', TIMEOFDAY[d.clock.timeOfDay] || d.clock.timeOfDay],
      ['月相', d.clock.moonPhase + ' / 30' + (d.clock.moonPhase === 15 ? '（月圆）' : '')],
      ['雾日', d.clock.foggy ? '是' : '否'],
      ['世界种子', d.seed],
      ['天气时长', Math.round(d.weatherDurationMs / 3600000) + ' 小时'],
      ['群组', d.groups],
    ]) + '</div></fieldset>');

    out.push('<fieldset><legend>世界 tick 水位线</legend><div class="gmstats">' + cells([
      ['轻度累计', d.ticks.light], ['重度累计', d.ticks.heavy],
    ]) + '</div><div class="hint">上次轻度：' +
      (d.ticks.lastLight ? esc2(d.ticks.lastLight.tickKey) + '（' + when(d.ticks.lastLight.at) + '）' : '—') +
      '　上次重度：' +
      (d.ticks.lastHeavy ? esc2(d.ticks.lastHeavy.tickKey) + '（' + when(d.ticks.lastHeavy.at) + '）' : '—') +
      '</div></fieldset>');

    out.push('<fieldset><legend>天气分布</legend><div class="gmstats">' +
      d.weather.distribution.map(function (w) {
        return '<div class="gmstat"><b>' + w.count + '</b><span>' + esc2(w.label) + '</span></div>';
      }).join('') + '</div>' +
      (d.weather.pending > 0
        ? '<div class="hint">其中 ' + d.weather.pending + ' 个地点有邻居扩散过来、还没落地的天气。</div>'
        : '') + '</fieldset>');

    out.push('<fieldset><legend>各地天气（' + d.weather.rows.length + '）</legend>' +
      '<table class="gmtb"><tr><th>地点</th><th>天气</th><th>持续到</th><th>待落地</th></tr>' +
      d.weather.rows.map(function (w) {
        return '<tr><td>' + esc2(w.locationName) + ' <code>' + esc2(w.locationId) + '</code></td><td>' +
          esc2(w.weatherLabel) + '</td><td>' + when(w.until) + '</td><td>' +
          (w.pendingWeather ? esc2(w.pendingWeather) + ' @ ' + when(w.pendingAt) : '—') + '</td></tr>';
      }).join('') + '</table></fieldset>');

    out.push('<fieldset><legend>最近的天气与世界事件</legend><div class="gmstats">' +
      d.events.byType.map(function (t) {
        return '<div class="gmstat"><b>' + t.count + '</b><span>' + esc2(t.label) + '</span></div>';
      }).join('') + '</div>' +
      (d.events.latest.length === 0 ? '<div class="hint">还没有世界事件。</div>'
        : '<table class="gmtb"><tr><th>时间</th><th>类型</th><th>可见性</th><th>正文</th></tr>' +
          d.events.latest.map(function (e) {
            return '<tr><td>' + when(e.createdAt) + '</td><td>' +
              esc2(WORLDEVENT[e.type] || e.type) + '</td><td>' + esc2(e.visibility) +
              '</td><td class="fbtext">' + esc2(String(e.text).split('\n').slice(0, 2).join(' / ')) + '</td></tr>';
          }).join('') + '</table>') +
      '</fieldset>');

    /* ---- 生态（M2.8）---- */
    var eco = d.ecology;
    out.push('<h2 style="margin-top:26px">生态</h2>');
    out.push('<p class="sub">生物自己的节拍（每小时一次）。只读 —— 数据来自 creature_ticks 每次落下的 summary。</p>');
    out.push('<div class="gmstats">' + cells([
      ['物种', eco.species], ['生物', eco.creatures],
      ['分布地点', eco.locations], ['tick 次数', eco.tickCount],
    ]) + '</div>');

    /*
     * 累计行为：这是这个面板最该被看的一栏。
     * 全是 0 的项不是「还没到时候」，是那条链路根本没跑起来 ——
     * 实测第一次打开就是：只有迁移在动，捕食/进化/死亡累计全是 0。
     */
    var BEHAVIORS = [
      ['migrate', '迁移'], ['feed', '捕食'], ['evolve', '进化'],
      ['birth', '繁衍'], ['death', '死亡'], ['replenish', '补充'],
    ];
    var dead = BEHAVIORS.filter(function (b) { return eco.totals[b[0]] === 0; });
    out.push('<fieldset><legend>最近 ' + eco.ticks.length + ' 次 tick 的累计行为</legend>' +
      '<div class="gmstats">' + BEHAVIORS.map(function (b) {
        var n = eco.totals[b[0]];
        return '<div class="gmstat"' + (n === 0 ? ' style="border-color:rgba(181,96,63,.5)"' : '') +
          '><b' + (n === 0 ? ' style="color:#dda28c"' : '') + '>' + n + '</b><span>' + b[1] + '</span></div>';
      }).join('') + '</div>' +
      (dead.length
        ? '<div class="warn">⚠ ' + dead.map(function (b) { return b[1]; }).join('、') +
          ' 一次都没发生过。这不是「节奏不对」，是这几条链路根本没跑起来。</div>'
        : '<div class="hint">六种行为都发生过。</div>') +
      '</fieldset>');

    out.push('<fieldset><legend>物种分布（' + eco.bySpecies.length + '）</legend><div class="gmstats">' +
      eco.bySpecies.map(function (s) {
        return '<div class="gmstat"><b>' + s.count + '</b><span>' + esc2(s.name) + '</span></div>';
      }).join('') + '</div>' +
      (eco.byStatus.length ? '<div class="hint">状态：' + eco.byStatus.map(function (s) {
        return esc2(s.status) + ' ×' + s.count;
      }).join('　') + '</div>' : '') +
      '</fieldset>');

    out.push('<fieldset><legend>最近 ' + Math.min(eco.ticks.length, 8) + ' 次生态 tick</legend>' +
      (eco.ticks.length === 0 ? '<div class="hint">还没有跑过生态 tick。</div>'
        : '<table class="gmtb"><tr><th>tick</th><th>游戏时刻</th><th>落库时刻</th><th>发生的动作</th></tr>' +
          eco.ticks.slice(0, 8).map(function (t) {
            var acts = BEHAVIORS.filter(function (b) { return (t.summary[b[0]] || 0) > 0; })
              .map(function (b) { return b[1] + ' ×' + t.summary[b[0]]; });
            return '<tr><td><code>' + esc2(t.tickKey) + '</code></td><td>' + when(t.at) +
              '</td><td>' + when(t.executedAt) + '</td><td>' +
              (acts.length ? esc2(acts.join('，')) : '什么都没发生') + '</td></tr>';
          }).join('') + '</table>') +
      '</fieldset>');


    /* ============================================================== *
     * M2.63：M2.58—M2.62 的世界状态（只读）
     * ============================================================== *
     * 那五轮加进来的东西**会自己动**（域恐慌、势力警觉、边界张力、因果图），
     * 而在它们可见之前，「世界到底在不在动」只能靠读代码猜。
     */
    var zs = d.zones, pw = d.powers, bd = d.boundaries, cs = d.causal;

    if (zs) {
      out.push('<h2 style="margin-top:26px">生态域</h2>');
      out.push('<p class="sub">域参数是内容（这块地方的世界是什么脾气），恐慌是状态（此刻攒了多少）。' +
        '两栏并排才能看出「涨上去之后有没有回落」。</p>');
      out.push('<fieldset><legend>域（' + zs.declared.length + ' 个，覆盖 ' +
        zs.declared.reduce(function (n, z) { return n + z.locations; }, 0) + ' 个地点）</legend>' +
        (zs.rows.length === 0 ? '<div class="hint">还没有任何域有运行时状态 —— 域表有内容，' +
          '但还没有目击或边界输入积累恐慌。</div>'
          : '<table class="gmtb"><tr><th>域</th><th>恐慌基线</th><th>累积</th><th>实际生效</th>' +
            '<th>目击次数</th><th>灵性</th><th>污染</th><th>承载</th></tr>' +
            zs.rows.map(function (z) {
              return '<tr><td>' + esc2(z.name) + '</td><td>' + z.fearBaseline + '</td><td>' +
                z.fearAccumulated.toFixed(3) + '</td><td><b>' + z.fearEffective.toFixed(3) + '</b></td><td>' +
                z.sightings + '</td><td>' + (z.spirituality === null ? '—' : z.spirituality) + '</td><td>' +
                (z.pollution === null ? '—' : z.pollution) + '</td><td>' +
                (z.carryingCapacity === null ? '—' : z.carryingCapacity) + '</td></tr>';
            }).join('') + '</table>') +
        '</fieldset>');
      if (zs.scars && zs.scars.length > 0) {
        out.push('<fieldset><legend>历史留下的地点伤痕（' + zs.scars.length + ' 处）</legend>' +
          '<div class="hint">M2.61 的初始历史真的改了这些地方的参数与危险度 —— ' +
          '这一栏是「历史生成了现在」在后台的可见形式。</div>' +
          '<table class="gmtb"><tr><th>地点</th><th>危险度加成</th><th>参数偏移</th><th>来自</th></tr>' +
          zs.scars.map(function (sc) {
            var patch = Object.keys(sc.patch || {}).map(function (k) {
              return k + ' ' + (sc.patch[k] > 0 ? '+' : '') + sc.patch[k];
            }).join('，') || '—';
            return '<tr><td><code>' + esc2(sc.location) + '</code></td><td>' +
              (sc.dangerBonus > 0 ? '+' + sc.dangerBonus : '—') + '</td><td>' + esc2(patch) +
              '</td><td>' + esc2(sc.because) + '</td></tr>';
          }).join('') + '</table></fieldset>');
      }
    }

    if (pw) {
      out.push('<h2 style="margin-top:26px">文明势力</h2>');
      out.push('<p class="sub">警觉是状态：出了事就涨、没事就落。它是「这次会不会反应」的主输入。' +
        '累计反应 ' + pw.totalReactions + ' 次。</p>');
      out.push('<fieldset><legend>势力（' + pw.rows.length + ' 家）</legend>' +
        '<table class="gmtb"><tr><th>势力</th><th>类型</th><th>态度</th><th>主场</th>' +
        '<th>警觉</th><th>反应次数</th><th>最近反应</th><th>历史</th></tr>' +
        pw.rows.map(function (p) {
          return '<tr><td>' + esc2(p.name) + ' <code>' + esc2(p.id) + '</code></td><td>' +
            esc2(p.typeLabel) + '</td><td>' + esc2(p.stanceLabel) + '</td><td>' +
            (p.homeRegion ? esc2(p.homeRegion) : '无处不在') + '</td><td><b>' +
            p.alert.toFixed(3) + '</b></td><td>' + p.reactionCount + '</td><td>' +
            (p.lastReactionAt ? when(p.lastReactionAt) : '—') + '</td><td>' +
            (p.historyEvents.length ? esc2(p.historyEvents.join('、')) : '—') + '</td></tr>';
        }).join('') + '</table></fieldset>');
      /*
       * 关系表：它把 M2.59 的默认底图与 M2.61 的历史旧仇合并后的样子摆出来，
       * 所以这一栏能回答「那场战争到底有没有留下东西」。
       */
      out.push('<fieldset><legend>势力关系（运行时 ' + pw.relations.length + ' 条）</legend>' +
        (pw.relations.length === 0
          ? '<div class="hint">power_relations 表还是空的。它记的是运行时被改写过的关系' +
            '（谁跟谁翻脸了、谁欠谁），而 powers.yaml 的默认关系与历史旧仇走的是内容那一路。</div>'
          : '<table class="gmtb"><tr><th>从</th><th>到</th><th>关系</th><th>强度</th></tr>' +
            pw.relations.map(function (r) {
              return '<tr><td>' + esc2(r.fromName) + '</td><td>' + esc2(r.toName) + '</td><td>' +
                esc2(r.kindLabel) + '</td><td>' + r.weight + '</td></tr>';
            }).join('') + '</table>') +
        '</fieldset>');
    }

    if (bd) {
      out.push('<h2 style="margin-top:26px">边界</h2>');
      out.push('<p class="sub">世界从这里与外面接触。事件时刻由世界种子派生（不依赖库状态），' +
        '所以「下一次」是算得出来的。累计 ' + bd.totalEvents + ' 次输入。</p>');
      out.push('<fieldset><legend>边界（' + bd.rows.length + ' 条）</legend>' +
        (bd.rows.length === 0 ? '<div class="hint">没有边界 —— 这个世界是封闭的。</div>'
          : '<table class="gmtb"><tr><th>边界</th><th>类</th><th>本地地点</th><th>对面</th>' +
            '<th>关注度</th><th>输入</th><th>来过几次</th><th>上次</th><th>下一次</th></tr>' +
            bd.rows.map(function (b) {
              var last = b.lastEventAt
                ? when(b.lastEventAt) + (b.lastKind ? '（' + esc2(b.lastKind) + '）' : '')
                : '—';
              return '<tr><td>' + esc2(b.name) + '</td><td>' + esc2(b.kindLabel) + '</td><td>' +
                esc2(b.locationName) + '</td><td>' + esc2(b.foreignName) + '</td><td>' +
                b.attention + '</td><td>' + esc2(b.inputs.join('/')) + '</td><td>' +
                b.eventCount + '</td><td>' + last + '</td><td>' +
                (b.nextAt ? when(b.nextAt) : '—') + '</td></tr>';
            }).join('') + '</table>') +
        '</fieldset>');
      out.push('<fieldset><legend>外部势力（' + bd.foreignPowers.length + ' 个）</legend><div class="gmstats">' +
        bd.foreignPowers.map(function (f) {
          return '<div class="gmstat"><b>' + f.attention + '</b><span>' + esc2(f.name) +
            (f.fromRegion ? '（' + esc2(f.fromRegion) + '）' : '（无来路）') + '</span></div>';
        }).join('') + '</div></fieldset>');
    }

    if (cs) {
      out.push('<h2 style="margin-top:26px">因果与历史残留</h2>');
      out.push('<p class="sub">「谁导致了谁」的图。每个节点的 id 由来源拼出，' +
        '所以补跑重放不会把同一件事记两遍。</p>');
      out.push('<div class="gmstats">' + cells([
        ['节点', cs.nodes], ['因果边', cs.edges],
      ]) + cs.byRelation.map(function (r) {
        return '<div class="gmstat"><b>' + r.count + '</b><span>' + esc2(r.label) + '</span></div>';
      }).join('') + '</div>');
      out.push('<fieldset><legend>最近的因果节点（' + cs.recent.length + '）</legend>' +
        (cs.recent.length === 0 ? '<div class="hint">还没有任何因果节点 —— ' +
          '它们由目击与世界事件产生，所以世界不出事时这里是空的。</div>'
          : '<table class="gmtb"><tr><th>时间</th><th>类型</th><th>强度</th><th>摘要</th></tr>' +
            cs.recent.map(function (n) {
              return '<tr><td>' + when(n.createdAt) + '</td><td>' + esc2(n.kind) + '</td><td>' +
                n.intensity + '</td><td class="fbtext">' + esc2(n.summary) + '</td></tr>';
            }).join('') + '</table>') +
        '</fieldset>');
      if (cs.bySubject.length > 0) {
        out.push('<fieldset><legend>谁的账上记得多（按主体）</legend><div class="gmstats">' +
          cs.bySubject.map(function (su) {
            return '<div class="gmstat"><b>' + su.count + '</b><span>' + esc2(su.subject) + '</span></div>';
          }).join('') + '</div></fieldset>');
      }
      /*
       * 封印物：**M2.72 起接上判定了**（埋着东西的地点探索时能挖出来）。
       * 禁忌知识仍然是「只落数据」—— 那一半需要一个「谁知道」的玩家侧载体，见 M2.72 交付说明 §五。
       *
       * 摆出来的目的没变：让「还有多少东西没接」这件事是看得见的。
       */
      out.push('<fieldset><legend>封印物（' + cs.sealed.length + ' 件 · 已接判定）</legend>' +
        '<div class="hint">它们来自 M2.61 的初始历史。**M2.72 起**：埋着东西的地点在探索时' +
        '多掷一次骰（低 4% / 中 8% / 高 14%），挖出来的是一件真实的封印物。' +
        '仍然没做的是「势力来觊觎它」。</div>' +
        (cs.sealed.length === 0 ? ''
          : '<table class="gmtb"><tr><th>地点</th><th>是什么</th><th>危险</th><th>来自</th></tr>' +
            cs.sealed.map(function (se) {
              return '<tr><td><code>' + esc2(se.location) + '</code></td><td>' +
                esc2(se.what) + '</td><td>' + esc2(se.levelLabel) + '</td><td>' +
                esc2(se.because) + '</td></tr>';
            }).join('') + '</table>') +
        '</fieldset>');
      out.push('<fieldset><legend>禁忌知识（' + cs.taboos.length + ' 条 · 未接判定）</legend>' +
        '<div class="hint">官方的说法与真相的分叉还没做 —— 现在只有真相这一半。</div>' +
        (cs.taboos.length === 0 ? ''
          : '<table class="gmtb"><tr><th>关于</th><th>不该被知道的事</th><th>谁想埋掉</th><th>来自</th></tr>' +
            cs.taboos.map(function (t) {
              return '<tr><td><code>' + esc2(t.scope) + '</code></td><td>' +
                esc2(t.what) + '</td><td>' + esc2(t.holder) + '</td><td>' +
                esc2(t.because) + '</td></tr>';
            }).join('') + '</table>') +
        '</fieldset>');
    }

    document.querySelector('#tab-world').innerHTML = out.join('');
  });
}

/* ---------------- 内容校验 ---------------- */

function loadContentPanel() {
  return api('/content').then(function (d) {
    var out = ['<h2>内容校验</h2>',
      '<p class="sub">结论来自内容层与卡片层**本来就在跑**的检查，这里只是把它们摆出来。' +
      'error 级的内容问题会让服务起不来 —— 所以服务在跑，就说明没有 error。</p>'];

    if (d.loadError) out.push('<div class="warn">⚠ ' + esc2(d.loadError) + '</div>');

    out.push('<div class="gmstats">' + cells([
      ['错误', d.counts.error], ['警告', d.counts.warn], ['事件卡', d.counts.cards],
    ]) + '</div>');

    out.push('<fieldset><legend>检查了什么</legend><div class="gmstats">' +
      d.checked.map(function (c) {
        return '<div class="gmstat"><b>' + c.value + '</b><span>' + esc2(c.label) + '</span></div>';
      }).join('') + '</div><div class="hint">条目数为 0 的不要当成通过 —— 那多半是没装载成功。</div></fieldset>');

    /*
     * **一键修复**（M2.86）。
     *
     * 用户的原话：「修复内容检验里的问题，同时新增一键修复功能 ——
     * **切记是一键修复，不是点了后一键修坏**」。
     *
     * 所以这个面板的主按钮**就是一个按钮**（一键），而「不修坏」靠服务端那三条保证：
     *   ① 只补缺（不编内容、不猜卡名，只从通用日常卡池里确定性抽）；
     *   ② 幂等（重复点不会有变化）；
     *   ③ 落盘前备份、且备份只写一次。
     * 「先看预览」是给不放心的时候用的 —— 先看清单再决定。
     */
    out.push('<fieldset><legend>一键修复</legend>' +
      '<p class="sub">只补「没有绑定事件卡」的地点。不编内容（只从通用日常卡里按地点名确定性抽）、' +
       '重复点不会有变化、落盘前自动备份。<b>「不属于任何城市」那类不修</b> —— ' +
       '山峰/内海/大河本来就不该属于城市，那是尺子不对，不是数据不对。</p>' +
      '<button id="fix-apply" class="btn">一键修复</button> ' +
      '<button id="fix-plan" class="btn">先看预览</button>' +
      '<div id="fix-out" class="hint" style="margin-top:8px"></div></fieldset>');

    out.push('<fieldset><legend>问题（' + d.issues.length + '）</legend>' +
      (d.issues.length === 0
        ? '<div class="hint">没有任何 error 或 warning。</div>'
        : '<table class="gmtb"><tr><th>级别</th><th>来源</th><th>位置</th><th>说明</th></tr>' +
          d.issues.map(function (i) {
            return '<tr class="lv-' + (i.level === 'error' ? 'error' : 'warn') + '"><td>' +
              (i.level === 'error' ? '错误' : '警告') + '</td><td>' +
              (i.source === 'cards' ? '事件卡' : '内容表') + '</td><td><code>' + esc2(i.where) +
              '</code></td><td class="fbtext">' + esc2(i.message) + '</td></tr>';
          }).join('') + '</table>') +
      '</fieldset>');

    document.querySelector('#tab-content').innerHTML = out.join('');

    // 绑定必须放在 innerHTML 之后（元素这时才存在）
    var fixOut = document.querySelector('#fix-out');
    var showFix = function (text) { if (fixOut) fixOut.innerHTML = text; };
    var fixPlanBtn = document.querySelector('#fix-plan');
    if (fixPlanBtn) fixPlanBtn.onclick = function () {
      showFix('正在预演…');
      fetch('/admin/api/content/fix/plan', { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (p) {
          showFix('计划 <b>' + p.changes.length + '</b> 处，跳过 ' + p.skipped + ' 个。<br>' + esc2(p.summary) +
            (p.changes.length > 0
              ? '<br><br>' + p.changes.slice(0, 8).map(function (c) {
                  return '第 ' + c.line + ' 行：<code>' + esc2(c.before.trim()) + '</code> → <code>' + esc2(c.after.trim()) + '</code>';
                }).join('<br>') + (p.changes.length > 8 ? '<br>…另有 ' + (p.changes.length - 8) + ' 处' : '')
              : ''));
        });
    };
    var fixApplyBtn = document.querySelector('#fix-apply');
    if (fixApplyBtn) fixApplyBtn.onclick = function () {
      fixApplyBtn.disabled = true;
      showFix('正在修复…');
      fetch('/admin/api/content/fix/apply', { method: 'POST', credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (p) {
          /*
           * M2.89：**计划为 0 时要说清「不是坏了」，而不是回一句「已修复 0 处」。**
           *
           * 用户报的「点击无效」就是这么来的 —— 功能一直在正常工作，
           * 只是它负责的那件事（给缺 events 的地点补一行）本来就没有待办。
           */
          if (p.planned === 0) {
            showFix('<b>没有需要修的东西。</b><br>' +
              '这个按钮只做一件事：给<strong>还没有 events 池的地点</strong>补一行（跳过 ' +
              esc2(String(p.skipped)) + ' 个已有池子的）。<br>' +
              '<span class="hint">内容层面的错（写错的 id、非法条件）它<strong>不修</strong> ——' +
              ' 那类问题只能人来判断，自动改就是「一键修坏」。</span>');
          } else {
            showFix('已修复 <b>' + p.written + '</b> 处（计划 ' + p.planned + ' 处）。备份：<code>' +
              esc2(String(p.backup)) + '</code>');
          }
          fixApplyBtn.disabled = false;
        });
    };
  });
}

/* ---------------- 模拟与压测 ---------------- */

function loadSim() {
  return api('/sim/limits').catch(function () { return null; }).then(function (limits) {
    // 上限来自服务端（admin/sim.ts 的 SIM_LIMITS），界面不自己写一份
    var L = limits || { maxCharacters: 300, maxDays: 30, maxStrategies: 2, strategies: [] };
    var out = ['<h2>模拟与压测</h2>',
      '<p class="sub">跑的是 <code>src/sim</code> 的模拟器：**纯函数**，自己装载内容、不碰数据库，' +
      '所以既不需要临时库，也不会污染真实数据。结论同时留档进 sim_reports。</p>'];

    out.push('<fieldset><legend>参数</legend><div class="row">' +
      '<span class="hint" style="margin:0">人数</span><input type="number" id="siN" value="200" min="1" max="' + L.maxCharacters + '" style="width:80px">' +
      '<span class="hint" style="margin:0">天数</span><input type="number" id="siD" value="30" min="1" max="' + L.maxDays + '" style="width:70px">' +
      '<span class="hint" style="margin:0">种子</span><input type="text" id="siSeed" value="admin" style="width:130px">' +
      '</div><div class="row" id="siStrat">' +
      // 策略表来自服务端（sim.ts 的 SIM_STRATEGY_CHOICES）—— 前端写死过一份，
      // 里面有个不存在的 'balanced'，勾了会被静默过滤掉，界面上看不出来
      L.strategies.map(function (s, i) {
        return '<label class="cmdall" title="' + esc2(s.description || '') + '">' +
          '<input type="checkbox" data-strat="' + esc2(s.id) + '"' +
          (i < L.maxStrategies ? ' checked' : '') + '> ' + esc2(s.name) + '</label>';
      }).join('') + '</div>' +
      '<div class="hint">上限：人数 ' + L.maxCharacters + '、天数 ' + L.maxDays +
        '、一次最多 ' + L.maxStrategies + ' 种策略。' +
      '这是在请求里**同步**跑的（200×30 约 1.3 秒），所以有硬上限 —— 超了会直接拒绝，' +
      '不会默默跑一个缩水版（那样结论就和参数不符了）。</div>' +
      '<div class="row"><button id="siGo">开始跑</button></div>' +
      '<div class="msg" id="siMsg"></div></fieldset>');

    out.push('<div id="siOut"></div>');
    document.querySelector('#tab-sim').innerHTML = out.join('');

    document.querySelector('#siGo').onclick = function () {
      var strategies = [];
      Array.prototype.forEach.call(document.querySelectorAll('[data-strat]'), function (i) {
        if (i.checked) strategies.push(i.dataset.strat);
      });
      var msgEl = document.querySelector('#siMsg');
      var btn = document.querySelector('#siGo');
      btn.disabled = true;
      msgEl.className = 'msg';
      msgEl.textContent = '跑着呢（同步执行，页面会卡住几秒，这是正常的）…';
      api('/sim', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          characters: Number(document.querySelector('#siN').value),
          days: Number(document.querySelector('#siD').value),
          seed: document.querySelector('#siSeed').value,
          strategies: strategies,
        }),
      }).then(function (r) {
        msgEl.className = 'msg ok';
        msgEl.textContent = '跑完了，共 ' + r.elapsedMs + ' 毫秒' + (r.savedId ? '，已留档 ' + r.savedId : '（留档失败）');
        renderSimResult(r);
      }).catch(function (e) {
        msgEl.className = 'msg err';
        msgEl.textContent = e.message;
      }).then(function () { btn.disabled = false; });
    };
    return limits;
  });
}

function renderSimResult(r) {
  var out = [];
  r.runs.forEach(function (run) {
    out.push('<fieldset><legend>' + esc2(run.strategyName) + '（' + run.elapsedMs + ' 毫秒）</legend>');
    // M2.74：这一行**故意不渲染**。oneLine 是一行摘要（「128 人 × 30 天：失控 3.1% …」），
    //    里面没有标题也没有表格，套一层渲染只会白走一遍解析，还可能吃掉它自带的符号。
    //    判定口径：是文档（多行、有结构）才渲染，是单行值就保持原文。
    out.push('<pre class="md">' + esc2(run.oneLine) + '</pre>');
    out.push('<table class="gmtb"><tr><th>目标</th><th>本次</th><th>区间</th><th>结论</th></tr>' +
      run.checks.map(function (c) {
        return '<tr class="' + (c.pass ? '' : 'diff') + '"><td>' + esc2(c.name) + '</td><td>' +
          esc2(c.actual) + '</td><td>' + esc2(c.target) + '</td><td>' +
          (c.pass ? '达标' : '<b>未达标</b>') + '</td></tr>';
      }).join('') + '</table>');
    // M2.74：完整报告同样渲染 + 原文折叠（原文在里层再折一次，两层细节各管各的）。
    out.push('<details open><summary>完整报告</summary>' +
      '<div class="mdview">' + mdView(run.markdown) + '</div>' +
      '<details><summary>原文（markdown）</summary><pre class="md">' +
      esc2(run.markdown) + '</pre></details></details>');
    out.push('</fieldset>');
  });
  if (r.history && r.history.length) {
    out.push('<fieldset><legend>留档（最近 ' + r.history.length + ' 次）</legend><table class="gmtb">' +
      '<tr><th>id</th><th>时间</th><th>参数</th><th>结论</th></tr>' +
      r.history.map(function (h) {
        var cfg = h.config || {};
        var sum = Array.isArray(h.summary) ? h.summary : [];
        return '<tr><td><code>' + esc2(h.id) + '</code></td><td>' + when(h.createdAt) + '</td><td>' +
          esc2((cfg.characters || '?') + '人 × ' + (cfg.days || '?') + '天 · ' + (cfg.seed || '')) + '</td><td>' +
          esc2(sum.map(function (s) { return s.strategy + ' ' + s.passed + '/' + s.total; }).join('，')) +
          '</td></tr>';
      }).join('') + '</table></fieldset>');
  }
  document.querySelector('#siOut').innerHTML = out.join('');
}

const WORLDEVENT = {
  environment: '环境', discovery: '发现', faction: '势力', calamity: '灾变', rumor: '流言',
};

/* ---------------- 装载钩子 ---------------- */

var HOOKS = {
  overview: loadOverview,
  adapter: function () { if (typeof adapterStart === 'function') return adapterStart(); },
  // M2.81：两个子页共用同一个装载函数（它在哪一页都只读同一份 /adapter/live）
  'adapter-onebot': function () { if (typeof adapterStart === 'function') return adapterStart(); },
  'adapter-qq': function () { if (typeof adapterStart === 'function') return adapterStart(); },
  gm: function () { if (typeof gmStart === 'function') return gmStart(); },
  data: function () { if (typeof loadEntities === 'function') return loadEntities(); },
  ops: loadOps,
  backup: loadBackup,
  feedback: loadFeedback,
  access: loadAccess,
  logs: loadLogs,
  audit: loadAudit,
  world: loadWorld,
  content: loadContentPanel,
  sim: loadSim,
};

function consoleStart() {
  if (NAV !== null) return go(CUR || 'overview');
  return api('/nav').then(function (d) {
    NAV = d;
    renderNav();
    window.addEventListener('hashchange', function () {
      var id = location.hash.replace('#', '');
      if (id !== CUR) go(id);
    });
    return go(location.hash.replace('#', '') || 'overview');
  });
}
