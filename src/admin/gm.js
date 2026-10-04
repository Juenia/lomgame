/*
 * GM 管理前端（M2.50）—— **独立文件**，理由与 editor.js 完全相同：
 * 拼在 page.ts 的字符串数组里，每行 JS 都要在单引号里再写引号，转义一深就必错。
 *
 * 复用 page.ts 内联脚本里的 $ / api / msg（它们是全局的，且本文件在其之后加载）。
 */
var GO = null;   // /gm/options 的返回：下拉选项 + 统计
var CUR = null;  // 当前选中的角色 id
var DET = null;  // 当前角色的详情

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 操作回执：成功/失败主线 + 需要人看见的警告 */
function gmMsg(ok, text, warnings) {
  var el = document.querySelector('#gmMsg');
  if (!el) return;
  el.className = 'msg ' + (ok ? 'ok' : 'err');
  el.innerHTML = esc(text) + (!warnings || !warnings.length ? ''
    : '<div class="warn">⚠ ' + warnings.map(esc).join('<br>⚠ ') + '</div>');
}

function kv(label, value) {
  return '<dt>' + esc(label) + '</dt><dd>' + value + '</dd>';
}

/* ---------------- 列表 ---------------- */

function gmLoadOptions() {
  return api('/gm/options').then(function (d) {
    GO = d;
    // 统计数是 counts；d.stats 是属性的定义数组，两者名字撞过一次，见 admin/index.ts 的注释
    gmStatsBar(d.counts);
  });
}

function gmStatsBar(s) {
  if (!s) return;
  var cells = [
    ['角色', s.characters], ['QQ', s.users], ['正常', s.active],
    ['重伤', s.injured], ['失控中', s.lostControl], ['封禁', s.banned],
    ['普通人', s.mortal], ['已入途径', s.initiated], ['今日失控', s.lostControlToday],
  ];
  document.querySelector('#gmStats').innerHTML = cells.map(function (c) {
    return '<div class="gmstat"><b>' + esc(String(c[1])) + '</b><span>' + esc(c[0]) + '</span></div>';
  }).join('');
}

function gmLoadList(q) {
  var el = document.querySelector('#gmList');
  el.innerHTML = '<fieldset><legend>玩家</legend><div class="hint">加载中…</div></fieldset>';
  return api('/gm/players?q=' + encodeURIComponent(q || '')).then(function (d) {
    gmStatsBar(d.counts);
    if (!d.players.length) {
      el.innerHTML = '<fieldset><legend>玩家</legend><div class="hint">没搜到。换个关键词，或点「全部」。</div></fieldset>';
      return;
    }
    el.innerHTML = '<fieldset><legend>玩家（' + d.players.length + '）</legend>' +
      d.players.map(function (p) {
        return '<a class="drow" data-id="' + esc(p.characterId) + '">' +
          '<b>' + esc(p.name) + '　<span class="tag">' + esc(p.statusLabel) + '</span></b>' +
          '<i>' + esc(p.pathwayLabel) +
            (p.sequence !== null ? ' · 序列 ' + p.sequence + ' ' + esc(p.sequenceLabel) : '') +
            ' · ' + esc(p.cityName) + '</i>' +
          '<i>HP ' + p.hp + ' / MAD ' + p.mad + '　QQ ' + esc(p.qqId) + '</i>' +
          '</a>';
      }).join('') + '</fieldset>';
    Array.prototype.forEach.call(el.querySelectorAll('.drow'), function (a) {
      a.onclick = function () {
        Array.prototype.forEach.call(el.querySelectorAll('.drow'), function (x) { x.classList.remove('on'); });
        a.classList.add('on');
        gmOpen(a.dataset.id);
      };
    });
  }).catch(function (e) {
    el.innerHTML = '<fieldset><legend>玩家</legend><div class="hint">' + esc(e.message) + '</div></fieldset>';
  });
}

/* ---------------- 详情 ---------------- */

function gmOpen(id) {
  CUR = id;
  return api('/gm/players/' + encodeURIComponent(id)).then(function (d) {
    DET = d;
    gmRenderDetail(d);
  }).catch(function (e) {
    document.querySelector('#gmDetail').innerHTML =
      '<fieldset><legend>读取失败</legend><div class="hint">' + esc(e.message) + '</div></fieldset>';
  });
}

function gmRenderDetail(d) {
  var p = d.player;
  var out = [];

  out.push('<fieldset><legend>编辑：' + esc(p.name) + '</legend>');
  out.push('<dl class="kv">');
  out.push(kv('角色 ID', '<code>' + esc(p.characterId) + '</code>'));
  out.push(kv('QQ / 昵称', esc(p.qqId) + '　' + esc(p.nickname || '（无昵称）')));
  out.push(kv('途径', esc(p.pathwayLabel) +
    (p.sequence !== null ? '　序列 ' + p.sequence + '　' + esc(p.sequenceLabel) : '')));
  out.push(kv('状态', '<b>' + esc(p.statusLabel) + '</b>'));
  out.push(kv('所在城市', esc(p.cityName)));
  out.push(kv('教会', d.churchId ? esc(d.churchId) + '（贡献 ' + d.churchContribution + '）' : '（未入教）'));
  out.push(kv('性别', d.gender === 'female' ? '女' : '男'));
  out.push(kv('连续晋升失败', String(d.promotionFails)));
  out.push(kv('失控闸门', d.threshold
    ? 'MAD ≥ ' + d.threshold.mad + '　COR ≥ ' + d.threshold.cor
    : '（普通人：上限低于闸门，不可能失控）'));
  out.push(kv('进行中的旅途', d.travel
    ? '前往 ' + esc(d.travel.toCityName) + '　预计到达 ' + new Date(d.travel.arrivesAt).toLocaleString()
    : '无'));
  out.push('</dl>');

  /* 属性：每个都带 min/max，超界由服务端钳制并回一条警告 */
  out.push('<h3>属性</h3><div class="gmstats">');
  GO.stats.forEach(function (s) {
    out.push('<label class="statbox"><span>' + esc(s.label) + '</span>' +
      '<input type="number" data-stat="' + s.key + '" min="' + s.min + '" max="' + s.max +
      '" value="' + p[s.key] + '"><em>' + s.min + '—' + s.max + '</em></label>');
  });
  out.push('</div>');
  out.push('<div class="row"><button data-act="stats">保存属性</button></div>');

  /* 状态 / 途径 / 传送 */
  out.push('<h3>状态与归属</h3><div class="gmline">');
  out.push('<select data-sel="status">' + GO.statuses.map(function (s) {
    return '<option value="' + s.id + '"' + (s.id === p.status ? ' selected' : '') + '>' + esc(s.label) + '</option>';
  }).join('') + '</select><button data-act="status">应用状态</button>');
  out.push('</div>');
  out.push('<div class="hint">只给终态。晋升中 / 战斗中 / 交易中是过渡态，由玩法自己开始和结束 —— ' +
    '手写进去没有任何流程会来清它，那张卡就永久卡住了。</div>');

  out.push('<div class="gmline">');
  out.push('<select data-sel="pathway"><option value="">（普通人 / 清除途径）</option>' +
    GO.pathways.map(function (x) {
      return '<option value="' + x.id + '"' + (x.id === p.pathway ? ' selected' : '') + '>' + esc(x.label) + '</option>';
    }).join('') + '</select>');
  out.push('<select data-sel="sequence">' + GO.sequences.map(function (n) {
    return '<option value="' + n + '"' + (n === p.sequence ? ' selected' : '') + '>序列 ' + n + '</option>';
  }).join('') + '</select><button data-act="pathway">应用途径</button>');
  out.push('</div>');

  out.push('<div class="gmline">');
  out.push('<select data-sel="cityId">' + GO.cities.map(function (c) {
    return '<option value="' + esc(c.id) + '"' + (c.id === p.cityId ? ' selected' : '') + '>' + esc(c.name) + '</option>';
  }).join('') + '</select><button data-act="teleport">传送</button>');
  out.push('</div>');

  /* 物品 */
  out.push('<h3>物品</h3><div class="gmline">');
  out.push('<select data-sel="itemId">' + GO.items.map(function (i) {
    return '<option value="' + esc(i.id) + '">' + esc(i.name) + '（' + esc(i.id) + '）</option>';
  }).join('') + '</select>');
  out.push('<input type="number" data-sel="quantity" value="1" min="1" max="9999" style="width:80px">');
  out.push('<select data-sel="bindType">' + GO.bindTypes.map(function (b) {
    return '<option value="' + b.id + '">' + esc(b.label) + '</option>';
  }).join('') + '</select>');
  out.push('<button data-act="give">发放</button><button class="ghost" data-act="take">收回</button>');
  out.push('</div>');

  if (d.inventory.length) {
    out.push('<table class="gmtb"><tr><th>物品</th><th>绑定</th><th>数量</th></tr>' +
      d.inventory.map(function (i) {
        return '<tr><td>' + esc(i.name) + ' <code>' + esc(i.itemId) + '</code></td><td>' +
          esc(i.bindTypeLabel) + '</td><td>' + i.quantity + '</td></tr>';
      }).join('') + '</table>');
  } else {
    out.push('<div class="hint">背包是空的。</div>');
  }

  /* 日常 */
  out.push('<h3>今日计数</h3>');
  out.push(d.daily.length
    ? '<table class="gmtb"><tr><th>计数项</th><th>已用</th></tr>' + d.daily.map(function (x) {
        return '<tr><td>' + esc(x.key) + '</td><td>' + x.count + '</td></tr>';
      }).join('') + '</table>'
    : '<div class="hint">今天还没有任何计数。</div>');
  out.push('<div class="row"><button class="ghost" data-act="reset-daily">重置今日计数</button></div>');
  out.push('<div class="hint">一次清全五张表（daily_counters / daily_actions / explore_daily / ' +
    'daily_tag_usage / cooldowns）。少清一张就会出现「探索次数重置了但每日计数没清」这种半截状态。</div>');

  /* 留档 */
  if (d.lostControl.length) {
    out.push('<h3>最近失控</h3><table class="gmtb"><tr><th>日期</th><th>来源</th><th>文案</th></tr>' +
      d.lostControl.map(function (l) {
        return '<tr><td>' + esc(l.date) + '</td><td>' + esc(l.source) + '</td><td>' + esc(l.text.slice(0, 60)) + '</td></tr>';
      }).join('') + '</table>');
  }
  if (d.audit.length) {
    out.push('<h3>最近操作留档</h3><table class="gmtb"><tr><th>指令</th><th>内容</th><th>时间</th></tr>' +
      d.audit.map(function (a) {
        return '<tr><td><code>' + esc(a.command) + '</code></td><td>' + esc(a.output.slice(0, 70)) +
          '</td><td>' + new Date(a.createdAt).toLocaleTimeString() + '</td></tr>';
      }).join('') + '</table>');
  }

  out.push('<div class="msg" id="gmMsg"></div>');
  out.push('</fieldset>');

  document.querySelector('#gmDetail').innerHTML = out.join('');
  gmBind();
}

/* ---------------- 绑定 ---------------- */

function sel(name) {
  var el = document.querySelector('#gmDetail').querySelector('[data-sel="' + name + '"]');
  return el ? el.value : '';
}

function gmPost(action, body) {
  var btns = document.querySelectorAll('#gmDetail button');
  Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
  return api('/gm/players/' + encodeURIComponent(CUR) + '/' + action, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(function (d) {
    gmMsg(true, d.message, d.warnings);
    return gmOpen(CUR).then(function () { return gmLoadList(document.querySelector('#gmQ').value); });
  }).catch(function (e) {
    gmMsg(false, e.message);
  }).then(function () {
    Array.prototype.forEach.call(btns, function (b) { b.disabled = false; });
  });
}

function gmBind() {
  var box = document.querySelector('#gmDetail');
  Array.prototype.forEach.call(box.querySelectorAll('[data-act]'), function (b) {
    b.onclick = function () {
      var act = b.dataset.act;
      if (act === 'stats') {
        var patch = {};
        Array.prototype.forEach.call(box.querySelectorAll('[data-stat]'), function (i) {
          patch[i.dataset.stat] = i.value;
        });
        return gmPost('stats', patch);
      }
      if (act === 'status') return gmPost('status', { status: sel('status') });
      if (act === 'pathway') {
        var pw = sel('pathway');
        return gmPost('pathway', { pathway: pw === '' ? null : pw, sequence: Number(sel('sequence')) });
      }
      if (act === 'teleport') return gmPost('teleport', { cityId: sel('cityId') });
      if (act === 'give') {
        return gmPost('inventory', {
          action: 'give', itemId: sel('itemId'),
          quantity: Number(sel('quantity')), bindType: sel('bindType'),
        });
      }
      if (act === 'take') {
        return gmPost('inventory', {
          action: 'take', itemId: sel('itemId'), quantity: Number(sel('quantity')),
        });
      }
      if (act === 'reset-daily') return gmPost('reset-daily', {});
    };
  });

  // 选「普通人」时序列没有意义，灰掉 —— 省得人选了序列却发现没生效
  var pwSel = box.querySelector('[data-sel="pathway"]');
  var seqSel = box.querySelector('[data-sel="sequence"]');
  if (pwSel && seqSel) {
    var sync = function () { seqSel.disabled = pwSel.value === ''; };
    pwSel.onchange = sync;
    sync();
  }
}

/* ---------------- M2.68：世界 · 势力关系 ---------------- */

/**
 * 世界级的那一栏（与玩家无关）。
 *
 * 为什么单独一个函数而不是并进 gmBind()：gmBind 绑的是**某个玩家详情里**的按钮，
 * 而势力关系不属于任何玩家 —— 把它塞进去会在「没选中角色」时整栏失灵。
 */
function gmBindWorld() {
  var fromSel = document.querySelector('#gmRelFrom');
  var toSel = document.querySelector('#gmRelTo');
  var kindSel = document.querySelector('#gmRelKind');
  var btn = document.querySelector('#gmRelSave');
  if (!fromSel || !toSel || !kindSel || !btn) return;

  fromSel.innerHTML = GO.powers.map(function (p) {
    return '<option value="' + esc(p.id) + '">' + esc(p.name) + '（' + esc(p.id) + '）</option>';
  }).join('');
  toSel.innerHTML = fromSel.innerHTML;
  if (GO.powers.length > 1) toSel.selectedIndex = 1;
  kindSel.innerHTML = GO.relationKinds.map(function (k) {
    return '<option value="' + esc(k.id) + '">' + esc(k.label) + '</option>';
  }).join('');

  btn.onclick = function () {
    var box = document.querySelector('#gmRelMsg');
    btn.disabled = true;
    // ⚠️ 这里用 api() 的裸路径：世界级接口不在 /gm/players/<id>/ 下面
    api('/gm/power-relations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: fromSel.value, to: toSel.value, kind: kindSel.value }),
    }).then(function (d) {
      box.className = 'msg ok';
      box.innerHTML = esc(d.message) + (!d.warnings || !d.warnings.length ? ''
        : '<div class="warn">⚠ ' + d.warnings.map(esc).join('<br>⚠ ') + '</div>');
    }).catch(function (e) {
      box.className = 'msg err';
      box.textContent = e.message;
    }).then(function () { btn.disabled = false; });
  };
}

function gmStart() {
  if (GO !== null) return Promise.resolve();
  document.querySelector('#gmSearchBtn').onclick = function () {
    gmLoadList(document.querySelector('#gmQ').value);
  };
  document.querySelector('#gmQ').onkeydown = function (e) {
    if (e.key === 'Enter') gmLoadList(document.querySelector('#gmQ').value);
  };
  document.querySelector('#gmReloadList').onclick = function () {
    document.querySelector('#gmQ').value = '';
    gmLoadList('');
  };
  return gmLoadOptions().then(function () {
    gmBindWorld();
    return gmLoadList('');
  });
}
