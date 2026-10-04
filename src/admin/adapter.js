/*
 * 适配器面板前端（M2.51）—— **独立文件**，理由与 editor.js / gm.js 相同：
 * 拼在 page.ts 的字符串数组里，每行 JS 都要在单引号里再写引号，转义一深就必错。
 *
 * 复用 page.ts 内联脚本里的 $ / api / msg 与页面上的控件。
 */
var AD = null;      // /adapter/live 的返回
var AD_TIMER = null;

function adEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* M2.78：两块区域各有一条消息栏（QQ 区 / OneBot 区），所以选择器参数化 */
function adMsgTo(selector, ok, text) {
  var el = document.querySelector(selector);
  if (el) { el.className = 'msg ' + (ok ? 'ok' : 'err'); el.textContent = text; }
}

function adMsg(ok, text) {
  adMsgTo('#adapterMsg', ok, text);
}

/*
 * M2.81：**界面不再按通道互斥切换**。
 *
 * 每条通道现在有自己的页面（导航里「适配器」下面的子项），页面里的内容天然只属于它自己 ——
 * 「哪一块该显示」这个问题从根上消失了。这里只剩两件事：
 *   1. 总览页画两张入口卡（点进去进子页）；
 *   2. 子页在这条通道没启用时给一条明确提示，而不是一页空白。
 * ⚠️ 空白页会被读成「坏了」，而真实原因是「这条通道没开、.env 里差一个值」。
 */
function adApplyChannel() {
  adRenderCards();
  adRenderOffNotes();
}

/**
 * **重新拉一次通道清单并重画卡片**（M2.86）。
 *
 * ## 为什么需要它（用户报的 bug）
 *
 * > 「适配器选停用或启用后要重新启动才能看到更新」
 *
 * 原因：卡片上的「已启用 / 未启用」和那个启用按钮，都画在 `adRenderCards()` 里，
 * 而它读的是 **`/adapter`** 的 `available`；
 * 启停之后调用的 `adRefresh()` 读的却是**另一个接口** `/adapter/live`，
 * 并且只重画 live / diff / 表单 —— **`adRenderCards()` 一次都没被调用过**。
 * 于是服务端两件事（写 .env、热装）都做对了，界面却停在旧状态上。
 *
 * 所以：**状态变过之后，必须重拉画它的那一份数据**（而不是「顺手刷新一下页面」）。
 */
function adReloadCards() {
  if (!document.querySelector('#adCards')) return Promise.resolve();
  return api('/adapter').then(function (d) {
    AD = d;
    adRenderCards();
    adRenderChannels();
    return d;
  }).catch(function () { /* 拉失败就保持原样，不要弹错盖住回执 */ });
}

/** 总览页的两张入口卡：点一下进对应适配器的页面 */
function adRenderCards() {
  var box = document.querySelector('#adCards');
  if (!box) return;
  var list = (AD && AD.available) || [];
  if (!list.length) {
    box.innerHTML = '<div class="hint">这个后台版本没有返回通道清单。</div>';
    return;
  }
  box.innerHTML = list.map(function (c) {
    var on = c.enabled === true;
    var tag = on ? ('已启用' + (c.mode ? ' · ' + adEsc(c.mode) : '')) : '未启用';
    /*
     * M2.83：卡片从 button 改成 div —— 里面要放「进入」和「启用/停用」两个按钮，
     * 而 HTML 不允许 button 套 button（套了浏览器会自己拆开，事件全乱）。
     */
    /* 已启用的说「它是什么」，未启用的说「怎么开」—— 两种信息各有用处 */
      var action = c.needsSetup === true
        ? '<button class="ghost" data-go="adapter-' + adEsc(c.id) + '">去填凭证</button>'
        : '<button class="ghost" data-ch="' + adEsc(c.id) + '" data-en="' + (on ? '0' : '1') + '">' +
            (on ? '停用' : '启用') + '</button>';
      return '<div class="adcard' + (on ? '' : ' off') + '">' +
        '<b>' + adEsc(c.label || c.id) + ' <span class="tag' + (on ? ' ok' : '') + '">' + tag + '</span></b>' +
        '<span>' + adEsc(on ? (c.note || '') : (c.how || '')) + '</span>' +
        '<div class="row">' +
          '<button class="ghost" data-go="adapter-' + adEsc(c.id) + '">进入</button>' +
          action +
        '</div></div>';
  }).join('');
  Array.prototype.forEach.call(box.querySelectorAll('[data-go]'), function (btn) {
    btn.onclick = function () {
      if (typeof go === 'function') go(btn.dataset.go);
      else location.hash = btn.dataset.go;
    };
  });
  /*
   * 「启用 / 停用」：.env 由服务端写，运行期由 channelControl 热装 —— 
   * 用户不该为了开一条通道去手编文件，也不该为此重启进程。
   */
  Array.prototype.forEach.call(box.querySelectorAll('[data-ch]'), function (btn) {
    btn.onclick = function () {
      var enabling = btn.dataset.en === '1';
      btn.disabled = true;
      adMsgTo('#adChanMsg', true, '正在' + (enabling ? '启用' : '停用') + '…');
      api('/adapter/channel', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: btn.dataset.ch, enabled: enabling }),
      }).then(function (d) {
        adMsgTo('#adChanMsg', d.ok !== false, d.message);
        // M2.86：卡片的状态要重画 —— 否则「点了没反应」，得重启才看得到
        return adReloadCards().then(function () { return adRefresh('full'); });
      }).catch(function (e) { adMsgTo('#adChanMsg', false, e.message); })
        .then(function () { btn.disabled = false; });
    };
  });
}

/** 子页在通道未启用时的提示（空白页会被读成「坏了」） */
function adRenderOffNotes() {
  var list = (AD && AD.available) || [];
  var pick = function (id) {
    return list.filter(function (c) { return c.id === id; })[0] || null;
  };
  var pairs = [['#adQqOff', 'qq', '这条 QQ 官方通道'], ['#adObOff', 'onebot', '这条 OneBot 通道']];
  pairs.forEach(function (pair) {
    var el = document.querySelector(pair[0]);
    if (!el) return;
    var info = pick(pair[1]);
    var off = info !== null && info.enabled !== true;
    el.classList.toggle('hide', !off);
    if (off) {
      el.innerHTML = '<div class="warn">⚠ ' + adEsc(pair[2]) + '<b>没有启用</b>，下面这些控件点了也不会生效。<br>' +
        '启用方式：' + adEsc(info.how || '') + '<br>' +
        '（改完 .env 要<b>重启进程</b>；两条一起开就把 ADAPTER 设成 both。）</div>';
    }
  });
}

/*
 * 通道总览：把**能用**的通道都列出来，包括还没启用的。
 *
 * 只显示「已启用」的通道，等于把选择权藏起来 —— 跑 OneBot 模式的人
 * 在这一页看不到还有一条 QQ 官方通道可以开（用户就是这么问的）。
 */
/* 总览页顶部那一行：这个进程是按什么模式起来的。细节（状态 / 怎么开）交给入口卡片 */
function adRenderChannels() {
  var box = document.querySelector('#adChannels');
  if (!box) return;
  var mode = (AD && AD.adapterMode) || '?';
  var list = (AD && AD.available) || [];
  var on = list.filter(function (c) { return c.enabled === true; })
    .map(function (c) { return c.label || c.id; });
  box.innerHTML = '<div class="hint">当前模式：<code>' + adEsc(mode) + '</code>' +
    (on.length ? ' · 已启用：' + adEsc(on.join('、'))
      : ' · <b>还没有启用任何通道</b>（去 .env 里配，下面的卡片写了怎么开）') +
    '</div>';
}

/** OneBot 的一屏格子：连接、账号、事件、心跳、发送与重连 */
function adOnebotCells(ob) {
  var conn = ob.connected === null ? '不适用' : (ob.connected ? '已连接' : '未连接');
  var who = ob.selfId ? (ob.nickname ? ob.nickname + '（' + ob.selfId + '）' : ob.selfId) : '—';
  var cells = [
    ['传输方式', ob.transport === 'websocket' ? '内置 WS' : 'HTTP 上报'],
    ['连接', conn],
    ['机器人账号', who],
    ['收到事件', ob.events || 0],
    ['已处理', ob.handled || 0],
    ['心跳', ob.heartbeats || 0],
    ['发送调用', ob.apiCalls || 0],
    ['发送失败', ob.apiErrors || 0],
    ['重连', ob.reconnects || 0],
  ];
  return cells.map(function (c) {
    return '<div class="gmstat"><b>' + adEsc(String(c[1])) + '</b><span>' + adEsc(c[0]) + '</span></div>';
  }).join('');
}

/*
 * M2.85：协议端检测结果的渲染。
 *
 * 三段：进程 / 端口 / 下一步。前两段是**证据**，第三段是**动作** ——
 * 只报「没检测到」而不说下一步做什么，等于把问题原样丢回给用户。
 */
function adRenderEnv(d) {
  var box = document.querySelector('#adObEnv');
  if (!box || !d) return;
  var procs = d.processes || [];
  var listening = (d.ports || []).filter(function (p) { return p.listening === true; });
  var head = procs.length
    ? '<div class="adverdict ok">检测到协议端进程：' + adEsc(procs.join('、')) + '</div>'
    : '<div class="adverdict err">没有检测到协议端进程（NapCat / Lagrange / LLOneBot）</div>';
  var portLine = listening.length
    ? '<div class="adstep ok">✓ 这些端口有服务在监听：' +
      adEsc(listening.map(function (p) { return p.port; }).join('、')) + '</div>'
    : '<div class="adstep fail">✗ 常见端口（3000 / 3001 / 8080）都没有服务在监听</div>';
  var next = (procs.length > 0 || listening.length > 0)
    ? '<div class="warn">协议端在跑 —— 去<b>它自己的界面</b>完成扫码登录，' +
      '然后回这里点「重连协议端」。若它没开「正向 WebSocket 服务器」，还要在它那边开一下。</div>'
    : '<div class="warn">还没跑起来。下面两个都是<b>官方仓库</b>，别从第三方站下载：<br>' +
      (d.options || []).map(function (o) {
        return '· <a href="' + adEsc(o.repo) + '" target="_blank" rel="noopener">' +
          adEsc(o.name) + '</a> —— ' + adEsc(o.how);
      }).join('<br>') + '</div>';
  box.innerHTML = head + portLine + next;
}

function adRenderOnebot() {
  var box = document.querySelector('#adObLive');
  if (!box) return;
  var ob = AD && AD.onebot;
  if (!ob) {
    box.innerHTML = '<div class="hint">这个进程不是 OneBot 通道。</div>';
    return;
  }
  var warns = [];
  if (ob.transport === 'websocket' && ob.connected === false) {
    warns.push('内置 WS 没连上协议端 ' + (ob.url || '') +
      ' —— 去协议端确认「正向 WebSocket 服务器」开着、地址与端口一致。');
  }
  if (ob.lastError) warns.push('最近错误：' + ob.lastError);
  if (ob.lastClose && ob.lastClose.code !== 1000) {
    warns.push('最近一次断开：code ' + ob.lastClose.code +
      (ob.lastClose.reason ? '（' + ob.lastClose.reason + '）' : ''));
  }
  box.innerHTML = adOnebotCells(ob) +
    (warns.length ? '<div class="warn">⚠ ' + warns.map(adEsc).join('<br>⚠ ') + '</div>'
      : '<div class="hint">没有错误记录。</div>');
}

/* ---------------- 实时状态 ---------------- */

/*
 * 这几项是「机器人为什么不回话」的直接答案，所以放在最前面：
 *   · 白名单拦截 —— 指令发出去了但被灰度开关挡掉（症状：完全没反应）
 *   · Markdown 降级 —— 平台拒了 MD 语法，已回退纯文本（症状：图片没了）
 *   · 令牌剩余 —— 快到期时每一条回复都在等刷新
 */
function adCells(rt) {
  var st = rt.stats || {};
  var gw = st.gateway || {};
  /*
   * M2.75：前三格换成「登录」相关的答案。
   * 原来的第一格只有「网关 已连接 / 未连接」—— 而「未连接」底下可能是四类完全不同的原因
   * （凭证错 / 配额烧光 / 被拒 / 网络不通），面板上根本看不出来。
   */
  var lg = rt.login || null;
  var cells = [
    ['网关', rt.connected ? '已连接' : '未连接'],
    ['机器人', lg && lg.identity ? lg.identity.username : '未体检'],
    ['会话配额', lg && lg.sessionLimit ? lg.sessionLimit.remaining + '/' + lg.sessionLimit.total : '—'],
    ['令牌剩余', rt.token && rt.token.remainingSec != null ? rt.token.remainingSec + ' 秒' : '—'],
    ['令牌续期', rt.token && rt.token.autoRefresh ? '开' : '关'],
    ['identify/resume', (gw.identifies || 0) + '/' + (gw.resumes || 0)],
    ['重启续接', gw.resumedFromDisk ? '已续接' : '—'],
    ['致命停连', gw.fatalStops || 0],
    ['收到事件', st.events || 0],
    ['群消息', st.groupMessages || 0],
    ['白名单拦截', st.filteredByWhitelist || 0],
    ['已回复', st.repliesSent || 0],
    ['回复被拒', st.repliesRefused || 0],
    ['按钮', st.buttonsSent || 0],
    ['图片', st.imagesSent || 0],
    ['MD 降级', st.markdownFallbacks || 0],
    ['按钮点击', st.interactions || 0],
    ['网关重连', gw.reconnects || 0],
  ];
  return cells.map(function (c) {
    return '<div class="gmstat"><b>' + adEsc(String(c[1])) + '</b><span>' + adEsc(c[0]) + '</span></div>';
  }).join('');
}

function adRenderLive() {
  var rt = AD && AD.running;
  var box = document.querySelector('#adLive');
  if (!box) return;
  adApplyChannel();
  adRenderChannels();
  adRenderOnebot();
  if (!rt) {
    /*
     * M2.78：这里原来只有一句「当前通道没有热改接口」。
     * 对接着 OneBot 的部署来说那等于「这一页什么都没有」——
     * 现在 OneBot 的连接状态在它自己的专区里（见 adRenderOnebot）。
     */
    /*
     * ⚠️ 这句原来写的是「OneBot 通道的连接状态在下面的专区里」—— 那是两块挤在一页时的说法。
     * 现在每条通道有自己的页面，所以只能说「这一页对应的通道没启用」，
     * 而且不能再说「下面」（下面确实没有别的东西了）。
     */
    box.innerHTML = '<div class="hint">' +
      '这条通道当前没有启用，所以没有实时数字可看（启用方式见页面顶部的提示）。' +
      '</div>';
    var rec = document.querySelector('#adReconnect');
    var ver = document.querySelector('#adVerify');
    if (rec) rec.disabled = true;
    if (ver) ver.disabled = true;
    return;
  }
  var errs = [];
  if (rt.stats.lastError) errs.push('适配器最近错误：' + rt.stats.lastError);
  if (rt.stats.gateway.lastError) errs.push('网关最近错误：' + rt.stats.gateway.lastError);
  /*
   * 致命停连与「网关未连接」不是一回事，必须单独说：
   * 前者是**本进程已经不再重连**（4004 鉴权失败、4014 无权限、4914 已下架），
   * 不管等多久都不会好；后者通常一会儿自己就回来了。
   */
  if (rt.stats.gateway.fatalStops > 0) {
    var lc = rt.stats.gateway.lastClose;
    errs.push('网关已停止重连（致命错误）' + (lc ? '：close ' + lc.code : '') +
      '。重连不会好 —— 先按下面体检结论里的建议处理。');
  }
  if (rt.token && rt.token.autoRefresh === false) {
    errs.push('token 主动续期没开：长时间没人用之后，第一条消息会多等一次换 token 的往返。');
  }
  box.innerHTML = adCells(rt) +
    (errs.length ? '<div class="warn">⚠ ' + errs.map(adEsc).join('<br>⚠ ') + '</div>'
      : '<div class="hint">没有错误记录。</div>') +
    (rt.pendingReconnect && rt.pendingReconnect.length
      ? '<div class="warn">⚠ 这几项改了但还没生效（要重连网关）：' + rt.pendingReconnect.map(adEsc).join('、') + '</div>'
      : '');
  var lgBox = document.querySelector('#adLogin');
  if (lgBox) lgBox.innerHTML = adLoginBlock(rt);
}

/*
 * 登录体检结果。三段式：结论 → 每一步 → 接下来做什么。
 * 没跑过时给一句「点上面那个按钮」，而不是留一片空白 —— 空白会被当成「一切正常」。
 */
function adLoginBlock(rt) {
  var lg = rt.login;
  if (!lg) {
    return '<div class="hint">还没有跑过登录体检。点上面的按钮跑一次：' +
      '它会换一次 access_token、取机器人身份、查今天的会话配额，再翻一遍网关最近的关闭码。</div>';
  }
  var when = new Date(lg.at);
  var stamp = when.toLocaleTimeString('zh-CN', { hour12: false });
  var rows = (lg.steps || []).map(function (s) {
    var mark = s.status === 'ok' ? '✓' : (s.status === 'warn' ? '!' : '✗');
    return '<div class="adstep ' + s.status + '">' + mark + ' ' + adEsc(s.label) + '：' + adEsc(s.detail) + '</div>';
  }).join('');
  var advice = (lg.advice && lg.advice.length)
    ? '<div class="warn">接下来：<br>· ' + lg.advice.map(adEsc).join('<br>· ') + '</div>'
    : '';
  return '<div class="adverdict ' + (lg.ok ? 'ok' : 'err') + '">' + adEsc(lg.verdict) + '</div>' +
    rows + advice +
    '<div class="hint">体检时间 ' + adEsc(stamp) + '（用时 ' + lg.durationMs + ' 毫秒）。' +
    '体检只读，不会因为跑它而改变任何状态。</div>';
}

/* ---------------- 磁盘 vs 运行中 ---------------- */

/*
 * M2.82：对照表参数化 —— QQ 与 OneBot **共用同一个渲染函数**。
 * 两套渲染会各自演化，最后只剩一边被人记得维护（这一页已经吃过一次这个亏）。
 */
function adRenderDiffTable(sel, rows) {
  var box = document.querySelector(sel);
  if (!box) return;
  if (!rows || !rows.length) { box.innerHTML = ''; return; }
  var body = rows.map(function (d) {
    return '<tr class="' + (d.same ? '' : 'diff') + '">' +
      '<td>' + adEsc(d.label) + '</td>' +
      '<td>' + adEsc(d.disk) + '</td>' +
      '<td>' + adEsc(d.running) + (d.same ? '' : ' <span class="tag">不一样</span>') + '</td>' +
      '<td>' + (d.needsReconnect ? '重连' : '立刻') + '</td></tr>';
  }).join('');
  box.innerHTML = '<tr><th>配置项</th><th>.env 磁盘</th><th>进程在用</th><th>改了怎么生效</th></tr>' + body;
}

function adRenderDiff() {
  if (!AD) return;
  adRenderDiffTable('#adDiff', AD.diff);
  adRenderDiffTable('#adObDiff', AD.onebotDiff);
}

/* ---------------- 白名单 ---------------- */

/*
 * ⚠️ 一个都不勾 ≠ 全禁。适配器把空串、'*'、空数组**一律当作全放行**
 * （见 createQQOfficialAdapter）。所以「全不勾」这种状态不能让它存下去 ——
 * 那会变成「我以为我把指令全关了，其实是全开」。
 */
function adRenderCommands() {
  var box = document.querySelector('#adCmds');
  if (!box || !AD) return;
  var running = (AD.running && AD.running.allowedCommands) || [];
  var all = running.length === 0 || running.indexOf('*') >= 0;
  var on = {};
  running.forEach(function (n) { on[n] = true; });

  document.querySelector('#adAll').checked = all;
  box.innerHTML = AD.commands.map(function (c) {
    return '<label class="cmdbox"><input type="checkbox" data-cmd="' + adEsc(c.name) + '"' +
      (!all && on[c.name] ? ' checked' : '') + (all ? ' disabled' : '') + '>' +
      '<b>.' + adEsc(c.name) + '</b><i>' + adEsc(c.help || '（.帮助 里没有这一条）') + '</i></label>';
  }).join('');
  document.querySelector('#adAll').onchange = function () {
    var a = this.checked;
    Array.prototype.forEach.call(box.querySelectorAll('[data-cmd]'), function (i) {
      i.disabled = a;
    });
  };
}

function adReadCommands() {
  if (document.querySelector('#adAll').checked) return '*';
  var names = [];
  Array.prototype.forEach.call(document.querySelectorAll('#adCmds [data-cmd]'), function (i) {
    if (i.checked) names.push(i.dataset.cmd);
  });
  return names.join(',');
}

/* ---------------- 拉取与提交 ---------------- */

/**
 * 把运行中的值填回表单。
 *
 * ⚠️ 这一步**必须有**。删掉旧的 load() 时漏了它，控件就停在 HTML 的默认值上：
 * 界面显示「调试日志 关」而进程里其实是开，更糟的是这时点一下「保存并生效」，
 * 会把 AppID 提交成空串、把三个开关全关掉 —— 一个只读的显示错误变成了一次真实破坏。
 */
/*
 * M2.82：OneBot 侧的表单回填。与 QQ 那份同样有「正在输入就别冲掉」的规则 ——
 * 轮询每 2 秒跑一次，冲掉正在敲的地址比不显示更让人恼火。
 */
function adFillOnebotForm(cfg) {
  if (!cfg) return;
  var url = document.querySelector('#adObWsUrl');
  // 只有内置 WS 模式才有「协议端地址」可填；HTTP 上报模式下留空表示不改
  if (url && document.activeElement !== url && cfg.transport === 'websocket' && cfg.url) url.value = cfg.url;
  var cmds = document.querySelector('#adObCmdsText');
  if (cmds && document.activeElement !== cmds) {
    var list = cfg.allowedCommands || [];
    cmds.value = (list.length === 0 || list.indexOf('*') >= 0) ? '' : list.join(',');
  }
}

function adFillForm(rt) {
  adFillOnebotForm(AD && AD.onebotConfig);
  if (!rt) return;
  var g = function (sel) { return document.querySelector(sel); };
  // 正在输入 AppID 的时候不要把它冲掉
  if (g('#appid') && document.activeElement !== g('#appid')) g('#appid').value = rt.appId || '';
  if (g('#sandbox')) g('#sandbox').value = rt.sandbox ? '1' : '0';
  if (g('#markdown')) g('#markdown').value = rt.markdown ? '1' : '0';
  if (g('#buttons')) g('#buttons').value = rt.buttons ? '1' : '0';
  if (g('#debug')) g('#debug').value = rt.debug ? '1' : '0';
}

/**
 * mode：
 *   'poll' —— 只刷新实时数字和对照表（每 2 秒一次）
 *   'full' —— 连表单与白名单一起重画（进面板、保存后、手动刷新）
 *
 * ⚠️ 轮询**不能**重画表单和白名单：那会每 2 秒把正在编辑的内容冲掉一次。
 * 人勾了一半白名单、数字跳一下全没了，是最让人不想再用这个后台的那种 bug。
 */
function adRefresh(mode) {
  return api('/adapter/live').then(function (d) {
    AD = d;
    adRenderLive();
    adRenderDiff();
    if (mode === 'full') {
      adFillForm(d.running);
      adRenderCommands();
      /*
       * M2.86：**同时重画通道卡片**。
       *
       * 卡片的「已启用 / 未启用」画在 `adRenderCards()` 里，数据来自 `/adapter` ——
       * 而这里刷的是 `/adapter/live`，**两个接口**。原来只刷后者，于是
       * 启停通道之后卡片纹丝不动（用户：「要重新启动才能看到更新」）。
       *
       * 放在 `full` 里而不是各自调用点：改通道的入口有五六处（启停 / 存凭证 /
       * 重连 / 表单保存…），一处一处补迟早会漏 —— 而漏掉的那次同样表现为「没反应」。
       */
      adReloadCards();
    }
    return d;
  }).catch(function () { /* 轮询失败不弹错，下一轮再说 */ });
}

/** 只在标签页可见时轮询 —— 后台开着不看时不该一直打请求 */
function adTick() {
  var sec = document.querySelector('#tab-adapter');
  if (!sec || sec.classList.contains('hide')) return;
  adRefresh('poll');
}

function adapterStart() {
  document.querySelector('#save').onclick = function () {
    var cmds = adReadCommands();
    if (cmds === '') {
      adMsg(false, '一条指令都没勾。注意：空的 whitelist 在适配器里是「全放行」而不是「全禁」——' +
        '要全放行请勾上「全放行」，要限制就至少勾一条。');
      return;
    }
    document.querySelector('#save').disabled = true;
    api('/adapter', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appId: document.querySelector('#appid').value,
        secret: document.querySelector('#secret').value,
        sandbox: document.querySelector('#sandbox').value === '1',
        markdown: document.querySelector('#markdown').value === '1',
        buttons: document.querySelector('#buttons').value === '1',
        debug: document.querySelector('#debug').value === '1',
        allowedCommands: cmds,
      }),
    }).then(function (d) {
      adMsg(true, d.message);
      document.querySelector('#secret').value = '';
      return adRefresh('full');
    }).catch(function (e) {
      adMsg(false, e.message);
    }).then(function () {
      document.querySelector('#save').disabled = false;
    });
  };

  document.querySelector('#adReconnect').onclick = function () {
    document.querySelector('#adReconnect').disabled = true;
    adMsg(true, '正在重连网关…');
    api('/adapter/reconnect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(function (d) { adMsg(true, d.message); return adRefresh('poll'); })
      .catch(function (e) { adMsg(false, e.message); })
      .then(function () { document.querySelector('#adReconnect').disabled = false; });
  };

  document.querySelector('#adVerify').onclick = function () {
    document.querySelector('#adVerify').disabled = true;
    adMsg(true, '正在换 access_token…');
    api('/adapter/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(function (d) { adMsg(true, d.message); return adRefresh('poll'); })
      .catch(function (e) { adMsg(false, e.message); })
      .then(function () { document.querySelector('#adVerify').disabled = false; });
  };

  document.querySelector('#reload').onclick = function () { adRefresh('full'); };

  /*
   * M2.78：OneBot 专区的两个按钮。它们打的是**同一对路由**（/adapter/reconnect、/adapter/verify）——
   * 服务端按通道分支，所以界面这边不需要再多一套接口。
   */
  var obRec = document.querySelector('#adObReconnect');
  if (obRec) {
    obRec.onclick = function () {
      obRec.disabled = true;
      adMsgTo('#adObMsg', true, '正在重连协议端…');
      api('/adapter/reconnect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        .then(function (d) { adMsgTo('#adObMsg', true, d.message); return adRefresh('poll'); })
        .catch(function (e) { adMsgTo('#adObMsg', false, e.message); })
        .then(function () { obRec.disabled = false; });
    };
  }
  // M2.82：OneBot 的保存 —— 白名单立刻生效，地址/令牌由「重连协议端」生效
  var obSave = document.querySelector('#adObSave');
  if (obSave) {
    obSave.onclick = function () {
      obSave.disabled = true;
      adMsgTo('#adObMsg', true, '正在保存…');
      var val = function (sel) { var el = document.querySelector(sel); return el ? el.value : ''; };
      api('/adapter', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channel: 'onebot',
          wsUrl: val('#adObWsUrl'),
          token: val('#adObToken'),
          allowedCommands: val('#adObCmdsText'),
        }),
      }).then(function (d) {
        adMsgTo('#adObMsg', true, d.message);
        // 保存后清空密钥框：它不回显，留着只会让人以为「这里有个值」
        var t = document.querySelector('#adObToken');
        if (t) t.value = '';
        return adRefresh('full');
      }).catch(function (e) { adMsgTo('#adObMsg', false, e.message); })
        .then(function () { obSave.disabled = false; });
    };
  }
  var obDetect = document.querySelector('#adObDetect');
  if (obDetect) {
    obDetect.onclick = function () {
      obDetect.disabled = true;
      adMsgTo('#adObMsg', true, '正在检测本机的协议端…');
      api('/adapter/env').then(function (d) {
        adRenderEnv(d);
        adMsgTo('#adObMsg', true, '检测完成。');
      }).catch(function (e) { adMsgTo('#adObMsg', false, e.message); })
        .then(function () { obDetect.disabled = false; });
    };
  }
  var obVer = document.querySelector('#adObVerify');
  if (obVer) {
    obVer.onclick = function () {
      obVer.disabled = true;
      adMsgTo('#adObMsg', true, '正在问协议端…');
      api('/adapter/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        .then(function (d) { adMsgTo('#adObMsg', true, d.message); return adRefresh('poll'); })
        .catch(function (e) { adMsgTo('#adObMsg', false, e.message); })
        .then(function () { obVer.disabled = false; });
    };
  }

  if (AD_TIMER === null) AD_TIMER = setInterval(adTick, 2000);
  return adRefresh('full');
}
