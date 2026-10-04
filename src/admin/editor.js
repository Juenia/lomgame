/*
 * 数据编辑的前端脚本（M2.49）——**独立文件，不是拼出来的字符串**。
 *
 * ## 为什么从 page.ts 里搬出来
 *
 * 原来它是 page.ts 里的一个字符串数组（'...', '...'），每行 JS 都要在单引号里
 * 再写引号。转义层数一深就必错，这一轮我在这里栽了三次：
 *   1. '">";   单引号开、双引号收       → 整段 JS 崩，浏览器白屏
 *   2. 批量替换 data-k 时匹配串少个反斜杠 → 0 处替换，静默没改
 *   3. 脚本里再嵌一层引号                → 脚本自己都编译不过
 *
 * 挪成真正的 .js 之后：内容里的引号全是普通字符、node --check 能直接查、
 * 浏览器里还能直接打断点调试。唯一约束是**不要用模板字符串**（本项目用拼接）。
 *
 * 页面用 <script src="/admin/editor.js"> 引它，路由见 index.ts。
 */

var ENT = null, OPT = {}, CUR = null, ROW = null, CO = null, CREATING = false;
/* M2.90：列表页的分类筛选 —— ROWS 是当前实体的全部行，TAGF 是选中的分类（'' = 全部） */
var ROWS = [], TAGF = '';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 从控件往上找它属于哪个字段（容器带 data-fk） */
function fieldOfStatic(node) {
  var box = node.closest ? node.closest('[data-fk]') : null;
  if (!box) return null;
  return CUR.fields.filter(function (x) { return x.key === box.dataset.fk; })[0] || null;
}

function loadEntities() {
  api('/data').then(function (d) {
    ENT = d.entities; OPT = d.options || {};
    // M2.83：触发条件的候选。服务端只在「真的有条件字段」时才给，没有就是 null
    CO = d.condOptions || null;
    var html = '';
    d.groups.forEach(function (g) {
      html += '<div class="catgroup">' + esc(g.group) + '</div>';
      g.items.forEach(function (it) {
        html += '<div class="cat" data-e="' + it.id + '">' + esc(it.label) + '</div>';
      });
    });
    document.querySelector('#catTree').innerHTML = html;
    Array.prototype.forEach.call(document.querySelectorAll('.cat'), function (b) {
      b.onclick = function () {
        Array.prototype.forEach.call(document.querySelectorAll('.cat'), function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        document.querySelector('#dataForm').innerHTML = '';
        pickEnt(b.dataset.e);
      };
    });
    if (document.querySelector('.cat')) document.querySelector('.cat').click();
  }).catch(function () {});
}

/* ---- 列表页的分类筛选（M2.90） -------------------------------------------
 *
 * 用户的原话是「物品类别顶部的分类栏」：948 件物品 / 5 个类别，而列表页
 * 只能从头翻到尾（服务端的 filter 全是数组过滤，界面上一个控件都没有）。
 *
 * ⚠️ 分类字段**不是写死的**：服务端 entityMeta 只给一个 tagKey，而那个 key 本身
 * 是从字段表里派生的（key 恰好是 kind 的那个枚举字段）。于是往后加一张带分类的
 * 内容表，这里不用改一个字 —— 反过来，把「哪些实体有筛选栏」抄一份到这里，
 * 加了新表却忘了登记时**不会报错**，只会「列表能翻到 948 条、却没有筛选」。
 *
 * ⚠️ 过滤写成**纯函数**（rowsForTag）：这段 JS 不经过 TS 编译，只有 new Function
 * 查得了语法 —— 把判据留在 DOM 上的话，「点了筛选没反应」就只能靠人去点。
 */
function rowsForTag(rows, tag) {
  if (!tag) return rows;
  return rows.filter(function (r) { return String(r.tag == null ? '' : r.tag) === tag; });
}

/** 当前实体的分类字段（服务端给的 tagKey → 字段元数据） */
function tagFieldOfCur() {
  if (!CUR || !CUR.tagKey) return null;
  var list = CUR.fields || [];
  for (var i = 0; i < list.length; i += 1) {
    if (list[i].key === CUR.tagKey) return list[i];
  }
  return null;
}

/**
 * 分类的中文名。
 *
 * 枚举映射优先（items.kind 就是它）；其次是引用表里那个实体自己的显示名 ——
 * 与列表行、详情页下拉**读同一份元数据**，不在这里抄第二份中文表。
 */
function tagLabelOf(f, v) {
  if (f && f.enumMap && f.enumMap[v]) return f.enumMap[v];
  if (f && f.ref) {
    var opts = OPT[f.ref] || [];
    for (var i = 0; i < opts.length; i += 1) {
      if (opts[i].id === v) return opts[i].title;
    }
  }
  return v;
}

/**
 * 顶部那排 chips：一个分类一个，各带条数。
 *
 * 只有一类时不画 —— 那时候点它等于什么都不做，而一个点了没反应的按钮
 * 比不画更糟（M2.51 的同一条教训）。
 */
function tagChipsHtml(f, rows, cur) {
  var counts = {}, order = [];
  rows.forEach(function (r) {
    var t = r.tag == null ? '' : String(r.tag);
    if (t === '') return;
    if (counts[t] === undefined) { counts[t] = 0; order.push(t); }
    counts[t] += 1;
  });
  if (order.length < 2) return '';
  var html = '<div class="chips" id="tagChips">';
  html += '<a class="chip' + (cur ? '' : ' on') + '" data-tag="">全部（' + rows.length + '）</a>';
  order.forEach(function (t) {
    html += '<a class="chip' + (cur === t ? ' on' : '') + '" data-tag="' + esc(t) + '">' +
      esc(tagLabelOf(f, t)) + '（' + counts[t] + '）</a>';
  });
  return html + '</div>';
}

/** 列表里的一行 */
function rowHtmlOf(r) {
  /*
   * 列表那一列显示「中文名（id）」（M2.64）。
   *
   * 只给中文名不行：内容同学要拿 id 去别处引用它（填写掉落表、
   * 指定地点归属），而他在这里看不到 id 就只能去翻 YAML。
   * 只给 id 也不行：一屏 old_dock / fish_market 谁是谁看不出来。
   *
   * 两边相同时（routes 那种 titleKey 就是 id 的表）只显示一次，
   * 否则会变成 tingen-backlund（tingen-backlund）。
   */
  var sameName = (String(r.title) === String(r.id));
  var nameCell = esc(r.title) +
    (sameName ? '' : '<em class="idtag">' + esc(r.id) + '</em>');
  return '<a class="drow" data-id="' + encodeURIComponent(r.id) + '" data-tag="' +
    esc(r.tag == null ? '' : r.tag) + '"><b>' + nameCell +
    '</b><i>' + esc(r.summary) + '</i></a>';
}

/** 画列表（新建成功后的回执也走这里 —— 见 done） */
function renderDataList(done) {
  var field = tagFieldOfCur();
  var shown = rowsForTag(ROWS, TAGF);
  var head = '<fieldset><legend>' + esc(CUR.label) + '（' + ROWS.length + ' 条）</legend>';
  if (CUR.canCreate === true) {
    head += '<div class="row" style="margin-bottom:10px">' +
      '<button id="newRow">＋ 新建一条</button></div>';
  }
  head += tagChipsHtml(field, ROWS, TAGF);
  document.querySelector('#dataList').innerHTML = head +
    shown.map(rowHtmlOf).join('') + '</fieldset>';
  Array.prototype.forEach.call(document.querySelectorAll('#tagChips .chip'), function (c) {
    c.onclick = function () {
      var t = c.dataset.tag || '';
      // 再点同一个 = 取消筛选（判据：点某类别只剩那类；再点取消）
      TAGF = (TAGF === t) ? '' : t;
      renderDataList();
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll('.drow'), function (a) {
    a.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('.drow'), function (x) { x.classList.remove('on'); });
      a.classList.add('on');
      pickRow(decodeURIComponent(a.dataset.id));
    };
  });
  var nb = document.querySelector('#newRow');
  if (nb) nb.onclick = newRow;
  if (typeof done === 'function') done();
}

/**
 * 打开一个实体。`done` 是渲染完之后的回调（新建成功后要把回执贴回列表上方）。
 */
function pickEnt(id, done) {
  CUR = ENT.filter(function (e) { return e.id === id; })[0];
  CREATING = false;
  // 换一个实体 = 换一套分类，筛选状态跟着清掉（否则会带着上一张表的 chip 值）
  TAGF = '';
  document.querySelector('#dataForm').innerHTML = '';
  api('/data/' + encodeURIComponent(id)).then(function (d) {
    /*
     * M2.90：列表**整块交给 renderDataList** 画。
     *
     * 点一下 chip 就要重画一遍列表，而「＋ 新建一条」的按钮与筛选栏是同一层的东西 ——
     * 留在外面的话，筛选一次按钮就没了（而那种缺失不报错，只是有人少点了一次新建）。
     */
    ROWS = d.rows || [];
    renderDataList(done);
  });
}

/*
 * ---- map（键值表）的三个零件 ------------------------------------------------
 *
 * 抽出来是因为「渲染已有行」和「点加一条」必须用同一份逻辑，各写一遍就会漂移。
 *
 * ⚠️ 键**不能一律画成下拉**。churches.relations 没有 mapKeys（它的键是教会 id，
 * 不是封闭集合），画成下拉就是一个没有选项的空框：界面看着正常，保存时读到空值，
 * 整个 relations 被写成 {} —— 静默清空。三态：
 *   mapKeys → 封闭集合，下拉
 *   mapRef  → 键是某实体的 id，下拉（排除自己，免得写出自反关系）
 *   都没有  → 开放键，文本输入
 */
function mapKeyCtl(f, cur) {
  var opts = null;
  if (f.mapKeys) {
    opts = Object.keys(f.mapKeys).map(function (k) { return [k, f.mapKeys[k]]; });
  } else if (f.mapRef) {
    opts = refOpts(f.mapRef);
  }
  if (!opts) return '<input type="text" data-mk="1" value="' + esc(cur == null ? '' : cur) + '">';
  // 旧值不在候选里（教会改名、数据手改过）也要显示出来，否则一保存就被悄悄改掉
  if (cur && !opts.some(function (p) { return p[0] === cur; })) opts.unshift([cur, cur + '（已不在候选里）']);
  return '<select data-mk="1">' + opts.map(function (p) {
    return '<option value="' + esc(p[0]) + '"' + (String(cur) === p[0] ? ' selected' : '') + '>' +
      esc(p[1]) + '（' + esc(p[0]) + '）</option>';
  }).join('') + '</select>';
}

/** 某实体的候选 [id, 标题]，自反的排除掉 */
function refOpts(entId) {
  return (OPT[entId] || []).filter(function (o) {
    return !(entId === CUR.id && o.id === ROW);
  }).map(function (o) { return [o.id, o.title]; });
}

/** 这个键的值是**文本**而不是数字吗（effects 的 item / flag） */
function isTextKey(f, key) { return (f.textKeys || []).indexOf(key) >= 0; }

/* ================================================================== *
 * 触发条件（M2.83）：结构化编辑，不让运营手打一段 DSL
 * ================================================================== */

/**
 * 把一条条件（`seq<=8` / `flag:xxx` / `location:xxx` …）拆成「种类 + 值」。
 *
 * ⚠️ 这是**渲染用的弱解析**，不是判定逻辑 —— 判定那边认不认由
 * src/domain/event/trigger.ts 说了算，服务端保存时会拿它逐条验。
 *
 * 认不出来的一律返回 kind='raw'：界面上**原样显示一个文本框**。
 * 认不出就丢掉的话，「打开一次编辑器」会静默吃掉别人写的条件 ——
 * 那比「显示得不好看」严重得多。
 */
function condParts(text) {
  var t = (text == null ? '' : String(text)).trim();
  if (t === '') return { kind: 'num', field: 'seq', op: '<=', value: '' };
  var ci = t.indexOf(':');
  if (ci > 0) {
    var head = t.slice(0, ci);
    var rest = t.slice(ci + 1).trim();
    if (head === 'flag' || head === 'location' || head === 'pathway' || head === 'status') {
      return { kind: head, value: rest };
    }
    if (head === 'party') {
      var pm = /^size\s*(>=|<=|==|!=|>|<)\s*(\d+)$/.exec(rest);
      if (pm) return { kind: 'party', op: pm[1], value: pm[2] };
    }
    return { kind: 'raw', value: t };
  }
  var cm = /^(seq|dig|mad|cor|hp|mp|ap|dp)\s*(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(t);
  if (cm) return { kind: 'num', field: cm[1], op: cm[2], value: cm[3] };
  return { kind: 'raw', value: t };
}

/** 一列 {id,title} → 下拉的 option 串（值不在候选里也照原样显示出来） */
function optsHtml(list, cur, attr) {
  var has = false;
  var html = (list || []).map(function (o) {
    if (o.id === cur) has = true;
    return '<option value="' + esc(o.id) + '"' + (o.id === cur ? ' selected' : '') + '>' +
      esc(o.title) + '</option>';
  }).join('');
  if (!has && cur) {
    html += '<option value="' + esc(cur) + '" selected>' + esc(cur) + '（不在候选里）</option>';
  }
  return '<select ' + attr + '>' + html + '</select>';
}

/** 一条条件的值控件 —— 由**种类**决定长什么样 */
function condValHtml(p) {
  if (!CO) return '<input type="text" data-cv="1" value="' + esc(p.value) + '">';
  if (p.kind === 'num') {
    return optsHtml(CO.fields, p.field, 'data-cf="1"') +
      optsHtml(CO.operators, p.op, 'data-cop="1"') +
      '<input type="number" data-cn="1" value="' + esc(p.value) + '">';
  }
  if (p.kind === 'party') {
    return optsHtml(CO.operators, p.op, 'data-cop="1"') +
      '<input type="number" data-cn="1" min="1" value="' + esc(p.value) + '">';
  }
  if (p.kind === 'flag') return optsHtml(CO.flags, p.value, 'data-cv="1"');
  if (p.kind === 'pathway') return optsHtml(CO.pathways, p.value, 'data-cv="1"');
  if (p.kind === 'status') return optsHtml(CO.statuses, p.value, 'data-cv="1"');
  if (p.kind === 'location') return optsHtml(OPT['locations'] || [], p.value, 'data-cv="1"');
  // raw：认不出来的写法原样放着让人去改（服务端会拒绝它，并说清认得哪些）
  return '<input type="text" data-cv="1" value="' + esc(p.value) + '">';
}

function condRowHtml(text) {
  var p = condParts(text);
  var ks = CO
    ? CO.kinds.map(function (k) {
        return '<option value="' + k.id + '"' + (k.id === p.kind ? ' selected' : '') + '>' +
          esc(k.title) + '</option>';
      }).join('') + '<option value="raw"' + (p.kind === 'raw' ? ' selected' : '') + '>（原样保留）</option>'
    : '';
  return '<div class="clrow"><select data-ck="1">' + ks + '</select>' +
    '<span class="clval">' + condValHtml(p) + '</span>' +
    '<button class="ghost" data-del="1">删</button></div>';
}

/** 一排条件控件 → 一条条件字符串（空的不写进文件） */
function readCondRow(row) {
  var kindEl = row.querySelector('[data-ck]');
  var kind = kindEl ? kindEl.value : 'raw';
  var v = row.querySelector('[data-cv]');
  if (kind === 'num') {
    var fld = row.querySelector('[data-cf]'), op = row.querySelector('[data-cop]'), n = row.querySelector('[data-cn]');
    var num = n ? n.value.trim() : '';
    return num === '' ? '' : (fld ? fld.value : '') + (op ? op.value : '') + num;
  }
  if (kind === 'party') {
    var op2 = row.querySelector('[data-cop]'), n2 = row.querySelector('[data-cn]');
    var num2 = n2 ? n2.value.trim() : '';
    return num2 === '' ? '' : 'party:size' + (op2 ? op2.value : '') + num2;
  }
  var raw = v ? v.value.trim() : '';
  if (raw === '') return '';
  return kind === 'raw' ? raw : kind + ':' + raw;
}

/**
 * 种类变了 → 值控件整块换掉（数值要三个控件，flag 只要一个下拉）。
 *
 * 换了种类就是换了语义，所以值一并重置：把 `seq<=8` 里的 8 留着当 flag 名，
 * 只会得到一条谁也不认的条件。
 */
function bindCondChange(scope) {
  Array.prototype.forEach.call(scope.querySelectorAll('.clrow'), function (row) {
    var s = row.querySelector('[data-ck]');
    if (!s || s.dataset.ckBound === '1') return;
    s.dataset.ckBound = '1';
    s.onchange = function () {
      var holder = document.createElement('span');
      holder.className = 'clval';
      holder.innerHTML = condValHtml({ kind: s.value, value: '' });
      var old = row.querySelector('.clval');
      if (old) row.replaceChild(holder, old);
    };
  });
}

/** 造一排条件控件（新建与渲染共用） */
function condRowOf(text) {
  var holder = document.createElement('div');
  holder.innerHTML = condRowHtml(text);
  return holder.firstChild;
}

/**
 * 值控件 —— 类型由**当前这个键**决定：
 *   textKeys 里的键 → 文本框（`item: 夜香草`）
 *   有 mapValues    → 枚举下拉
 *   其余            → 数字框（`dig: 2`）
 *
 * ⚠️ 不能只看字段、不看键：同一张 effects 列表里 `dig` 是数字、`item` 是物品名，
 * 一律给数字框的话运营**根本打不进「夜香草」**（number 输入框不收字母），
 * 而写进去的是一个空值 —— 这条效果就静默失效了。
 */
function mapValCtl(f, cur, key) {
  if (key !== undefined && isTextKey(f, key)) {
    return '<input type="text" data-mv="1" value="' + esc(cur == null ? '' : cur) + '">';
  }
  if (!f.mapValues) return '<input type="number" data-mv="1" value="' + esc(cur == null ? 0 : cur) + '">';
  return '<select data-mv="1">' + Object.keys(f.mapValues).map(function (vv) {
    return '<option value="' + vv + '"' + (String(cur) === vv ? ' selected' : '') + '>' +
      esc(f.mapValues[vv]) + '（' + vv + '）</option>';
  }).join('') + '</select>';
}

function mapRowHtml(f, k, v) {
  return '<div class="kvrow">' + mapKeyCtl(f, k) + mapValCtl(f, v, k) +
    '<button class="ghost" data-del="1">删</button></div>';
}

/** 新行的默认键 */
function mapDefaultVal(f, key) {
  if (key !== undefined && isTextKey(f, key)) return '';
  return f.mapValues ? Object.keys(f.mapValues)[0] : 0;
}

/**
 * 新组 / 新行的默认键：**第一个还没被占用的**。
 *
 * 为什么不能永远是第一个候选键：那是最安静的一种丢数据 ——
 * 新加的一行和老行同键，保存时后者覆盖前者，界面上两行都在、文件里只剩一行。
 * （map 的「＋ 加一条」原来写死 selectedIndex = 0，就是这个毛病。）
 *
 * 候选全被占满时退回第一个：宁可撞键让人看见，也不要给一个空键被静默丢掉。
 */
function freeKeyOf(f, box) {
  if (!f.mapKeys) return '';
  var used = {};
  Array.prototype.forEach.call(box.querySelectorAll('[data-mk]'), function (e) { used[e.value] = 1; });
  var ks = Object.keys(f.mapKeys);
  for (var i = 0; i < ks.length; i++) { if (!used[ks[i]]) return ks[i]; }
  return ks[0];
}

/**
 * 键变了 → 值控件可能要换类型（数字 ↔ 文本），当场重画那一格。
 *
 * 不重画的后果不是「难看」：把 `dig` 改成 `item` 之后值那格还是数字框，
 * 运营**根本打不进「夜香草」**；而原来那个 5 会以数字的身份留在 item 上 ——
 * 文件里写的是 `item: 5`，判定层拿它当物品名去查、查不到，这条效果静默什么都没做。
 *
 * 重画时值重置成新键的默认值（数字 0 / 文本空）：换了键就是换了语义，
 * 沿用旧值只会制造上面那种错。
 */
function bindKeyChange(scope) {
  Array.prototype.forEach.call(scope.querySelectorAll('[data-mk]'), function (s) {
    if (s.tagName !== 'SELECT' || s.dataset.mkBound === '1') return;
    s.dataset.mkBound = '1';
    s.onchange = function () {
      var kv = s.parentNode, ve = kv.querySelector('[data-mv]');
      if (!ve) return;
      var f = fieldOfStatic(kv);
      if (!f) return;
      var holder = document.createElement('div');
      holder.innerHTML = mapValCtl(f, mapDefaultVal(f, s.value), s.value);
      kv.replaceChild(holder.firstChild, ve);
    };
  });
}


/**
 * 一个字段 → 一个控件。
 * rowMode 时属性名用 data-rk，行内控件就不会和外层字段撞键。
 */
/**
 * strlist 一行的输入控件（M2.64）。
 *
 * 有 itemRef 时渲染成**下拉**，选项来自那个实体的中文显示名；
 * 没有就还是纯文本框（历史上所有 strlist 字段的默认行为，逐位不变）。
 *
 * 值始终是 id —— 只有显示是中文。与 ref / mapRef 同一条口径。
 */
/**
 * strlist 一项的候选 [值, 中文名]；没有候选就返回 null（纯文本框）。
 *
 * 三种来源（M2.77）：
 *   itemRefs —— 值是**好几个**实体里的 id，取它们的并集。
 *               事件卡按目录分成了三个实体，而地点的「事件池」三类都有 ——
 *               只指一个的话，另外两类会显示成生 id。
 *   itemRef  —— 值是**一个**实体的 id，去那张表里查中文名；
 *   valueMap —— 值是**一个封闭枚举**，中文名就在字段自己身上（途径 / 输入类型 / 习性）。
 *
 * 三个都没有就是纯文本框 —— 历史上所有 strlist 字段的默认行为，逐位不变。
 */
function slOpts(f) {
  if (f.itemRefs) return f.itemRefs.reduce(function (a, id) { return a.concat(refOpts(id)); }, []);
  if (f.itemRef) return refOpts(f.itemRef);
  if (f.valueMap) return Object.keys(f.valueMap).map(function (k) { return [k, f.valueMap[k]]; });
  return null;
}

function slCtl(f, cur) {
  var opts = slOpts(f);
  if (!opts) return '<input type="text" value="' + esc(cur) + '">';
  var has = false;
  var html = '<select>';
  if (cur === undefined || cur === null || cur === '') {
    html += '<option value="">（未选）</option>';
  }
  opts.forEach(function (o) {
    if (o[0] === cur) { has = true; }
    html += '<option value="' + esc(o[0]) + '"' +
      (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) +
      '（' + esc(o[0]) + '）</option>';
  });
  /*
   * 值不在选项里（引用目标被删了 / 内容表里根本没有它）：**仍然显示出来**。
   * 否则一打开编辑器那一项就静默消失了 —— 那是「看一眼就改坏文件」，
   * 比显示一个生 id 糟得多。
   */
  if (!has && cur) {
    html += '<option value="' + esc(cur) + '" selected>' + esc(cur) + '（找不到这个 id）</option>';
  }
  html += '</select>';
  return html;
}

function ctl(f, val, rowMode) {
  var KA = rowMode ? 'data-rk' : 'data-k';
  if (f.readOnly) {
    return '<div class="ro">' + esc(f.type === 'readonly' ? JSON.stringify(val, null, 1) : val) + '</div>';
  }
  if (f.type === 'enum') {
    return '<select ' + KA + '="' + f.key + '">' + Object.keys(f.enumMap).map(function (k) {
      return '<option value="' + k + '"' + (String(val) === k ? ' selected' : '') + '>' +
        esc(f.enumMap[k]) + '（' + k + '）</option>';
    }).join('') + '</select>';
  }
  if (f.type === 'ref') {
    var list = OPT[f.ref] || [];
    /*
     * M2.65：optional 的引用多一个「（无）」。
     * 没有它的话，留空的那一格在保存时会**自动变成列表里的第一项** ——
     * 一个「我没填」被静默改写成「它指向 X」的坑。
     */
    var head = f.optional === true
      ? '<option value=""' + (val === undefined || val === null || val === '' ? ' selected' : '') + '>（无）</option>'
      : '';
    return '<select ' + KA + '="' + f.key + '">' + head + list.map(function (o) {
      return '<option value="' + esc(o.id) + '"' + (String(val) === o.id ? ' selected' : '') + '>' +
        esc(o.title) + '（' + esc(o.id) + '）</option>';
    }).join('') + '</select>';
  }
  if (f.type === 'bool') {
    /*
     * 可选布尔是**三态**：是 / 否 / 没写过。
     *
     * 少了第三态就会出这种事：原记录根本没有 cleanse 这个键，界面显示「否」，
     * 一保存就把它写成 `cleanse: false` —— 内容没变，文件却多了一行。
     * 更糟的是「不写」和「写 false」在判定层未必是同一件事。
     */
    var unset = f.optional === true
      ? '<option value=""' + (val === undefined || val === null ? ' selected' : '') + '>（未设置）</option>'
      : '';
    return '<select ' + KA + '="' + f.key + '">' + unset +
      '<option value="true"' + (val === true ? ' selected' : '') + '>是</option>' +
      '<option value="false"' + (val === false ? ' selected' : '') + '>否</option></select>';
  }
  if (f.type === 'strlist') {
    var arr = Array.isArray(val) ? val : [];
    /*
     * multiline：整组文本装进**一个**多行框（一行一条）。
     *
     * 高度跟着条数走但限幅：3 条时不要占掉半屏，60 条时也不要只露三行
     * （看不到全貌就没法通读一遍 —— 通读是改文案前的第一步）。
     */
    /*
     * 多行外观有两种场合：
     *   1. 字段自己声明了 multiline（失控文本、卡片片段这种长文案）；
     *   2. rowMode —— 它长在 object 里面，而 object 的子字段只能是**单个控件**。
     *
     * rowMode 时不套容器 div、也不带 hint：外面由 object 负责排版，
     * 再套一层 data-fk 会让 fieldOfStatic 认错人。
     */
    if (rowMode === true) {
      var mo = slOpts(f);
      if (mo) {
        /*
         * 嵌套对象里的列表用**原生多选下拉**：外面已经有 object 负责排版，
         * 再套一层「一排单行框 + 加一条按钮」会挤成一团，而且那一层不负责增删行。
         *
         * 数据里有候选表里没有的 id 时，照样补一个选项出来 —— 一打开就静默
         * 少一项，比显示一个生 id 糟得多（那正是「看一眼就改坏文件」）。
         */
        var known = {};
        mo.forEach(function (p) { known[p[0]] = 1; });
        var all = mo.concat(arr.filter(function (x) { return !known[x]; })
          .map(function (x) { return [x, x + '（找不到）']; }));
        return '<select data-rk="' + f.key + '" multiple size="' +
          Math.max(2, Math.min(6, all.length)) + '">' + all.map(function (p) {
            return '<option value="' + esc(p[0]) + '"' +
              (arr.indexOf(p[0]) >= 0 ? ' selected' : '') + '>' + esc(p[1]) + '</option>';
          }).join('') + '</select>';
      }
      return '<textarea data-rk="' + f.key + '" rows="' +
        Math.max(2, Math.min(10, arr.length)) + '">' +
        esc(arr.join(String.fromCharCode(10))) + '</textarea>';
    }
    if (f.multiline === true) {
      return '<div class="sl" data-fk="' + f.key + '" data-ml="1">' +
        '<textarea rows="' + Math.max(4, Math.min(20, arr.length)) + '">' +
        esc(arr.join(String.fromCharCode(10))) + '</textarea>' +
        '<em class="hint">一行一条，当前 ' + arr.length + ' 条（空行会被丢掉）</em></div>';
    }
    var o1 = ['<div class="sl" data-fk="' + f.key + '">'];
    arr.forEach(function (x) {
      o1.push('<div class="slrow">' + slCtl(f, x) +
        '<button class="ghost" data-del="1">删</button></div>');
    });
    o1.push('<button class="ghost" data-addsl="1">＋ 加一条</button></div>');
    return o1.join('');
  }
  if (f.type === 'rows') {
    var cols = f.rowFields || [], rs = Array.isArray(val) ? val : [];
    var o2 = ['<div class="tb" data-fk="' + f.key + '"><table>'];
    o2.push('<tr>' + cols.map(function (c) { return '<th>' + esc(c.label) + '</th>'; }).join('') + '<th></th></tr>');
    rs.forEach(function (row) {
      o2.push('<tr>' + cols.map(function (c) {
        return '<td>' + ctl(c, row[c.key], true) + '</td>';
      }).join('') + '<td><button class="ghost" data-del="1">删</button></td></tr>');
    });
    // 同上：没有列定义时加出来的是一行空对象
    if (cols.length) o2.push('</table><button class="ghost" data-addrow="1">＋ 加一行</button></div>');
    else o2.push('</table></div>');
    return o2.join('');
  }
  if (f.type === 'map') {
    var o3 = ['<div class="kvmap" data-fk="' + f.key + '">'];
    Object.keys(val || {}).forEach(function (k) { o3.push(mapRowHtml(f, k, val[k])); });
    // 三种键形态都能加（开放键手打就是了），所以这里不设条件
    o3.push('<button class="ghost" data-addkv="1">＋ 加一条</button></div>');
    return o3.join('');
  }

  if (f.type === 'object') {
    var oc = f.objectFields || [], ov = (val && typeof val === 'object' && !Array.isArray(val)) ? val : {};
    return '<div class="obj" data-fk="' + f.key + '">' + oc.map(function (c) {
      return '<label><span>' + esc(c.label) + '</span>' + ctl(c, ov[c.key], true) + '</label>' +
        (c.hint ? '<em class="hint">' + esc(c.hint) + '</em>' : '');
    }).join('') + '</div>';
  }
  if (f.type === 'maplist') {
    var ml = Array.isArray(val) ? val : [];
    var o5 = ['<div class="ml" data-fk="' + f.key + '">'];
    ml.forEach(function (m) { o5.push(mlRowHtml(f, m)); });
    o5.push('<button class="ghost" data-addml="1">＋ 加一条</button></div>');
    return o5.join('');
  }
  if (f.type === 'condlist') {
    var cd = Array.isArray(val) ? val : [];
    var o7 = ['<div class="cl" data-fk="' + f.key + '">'];
    cd.forEach(function (s) { o7.push(condRowHtml(s)); });
    o7.push('<button class="ghost" data-addcl="1">＋ 加一条条件</button>');
    if (CO) o7.push('<div class="hint">认得的写法：' + esc(CO.syntax) + '</div>');
    o7.push('</div>');
    return o7.join('');
  }
  if (f.type === 'number') return '<input type="number" ' + KA + '="' + f.key + '" value="' + esc(val) + '">';
  /*
   * 多行文本（卡片正文 priv / group）。**这个分支不能省** ——
   * <input> 的 value 装不下换行，浏览器会把它规范化掉：
   * 保存一次，正文的分段就没了，而且不报任何错。
   */
  if (f.multiline === true) {
    var s = val == null ? '' : String(val);
    return '<textarea ' + KA + '="' + f.key + '" rows="' +
      Math.max(3, Math.min(16, s.split(String.fromCharCode(10)).length)) + '">' + esc(s) + '</textarea>';
  }
  return '<input type="text" ' + KA + '="' + f.key + '" value="' + esc(val) + '">';
}

/**
 * maplist 的一条：一到几组「键 + 值」，整条可删（卡片的 effects 就是它）。
 *
 * 为什么一条里能有**多组**键值：`- { item: 夜香草, n: 1 }` 是一个整体 ——
 * 「给夜香草」和「给 1 个」必须一起出现。拆成两条的话，判定层会先执行
 * 「给夜香草」、再执行「给 1 个」，而第二条没有主语。
 *
 * 两个「删」按钮各删各的 parentNode：删键删的是那一组，删这条删的是整行。
 */
function mlRowHtml(f, m) {
  var o = (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
  var ks = Object.keys(o);
  if (!ks.length) ks = [''];
  return '<div class="mlrow">' + ks.map(function (k) {
    return '<div class="kvrow">' + mapKeyCtl(f, k) + mapValCtl(f, o[k], k) +
      '<button class="ghost" data-del="1">删键</button></div>';
  }).join('') + '<button class="ghost" data-addmlk="1">＋ 键</button>' +
    '<button class="ghost" data-del="1">删这条</button></div>';
}

/**
 * 一条记录的表单 —— **改一条与新建一条共用**（M2.84）。
 *
 * 为什么共用：字段列表、只读标记、提示、可选字段的渲染规则必须完全一致。
 * 各写一遍的下场是「新建时少了某一栏」，而那种缺法**不报错** ——
 * 它只是让人以为那个字段根本不存在。
 *
 * `isNew` 时有两处不同：
 *   1. id 渲染成**可填的输入框**（它是新记录的名字，不是在字段表里改的）；
 *   2. **所有字段都渲染** —— 新记录什么值都没有，按「有值才渲染」的规则会一栏都不出。
 */
function formHtml(title, values, isNew) {
  var v = values || {};
  var out = ['<fieldset><legend>' + esc(title) + '</legend>'];
  if (isNew) {
    out.push('<label><span>ID（这条记录的名字）</span>' +
      '<input type="text" data-newid="1" value="" placeholder="例如 my_new_item">' +
      '<em class="hint">只能用字母、数字、下划线、点、连字符，且要以字母/数字/下划线开头。' +
      '填错会被当场拦住，不会写进文件。</em></label>');
  }
  CUR.fields.forEach(function (f) {
    // 新建时 id 已经在上面单独填过，字段表里那个只读的 id 不再画第二遍
    if (isNew && f.readOnly === true) return;
    /*
     * 记录里没有这个键、又不是容器类字段时，默认不渲染这一栏。
     *
     * ⚠️ 但**可选字段必须渲染**：items.pathway 只有 176 / 948 条物品有它，
     * 不渲染的话，其余 772 条在界面上根本没有那一栏 —— 运营想给某件物品挂上途径
     * 都无从下手，只能去改文件。留空 = 不写这个键（见 schema 的 optional）。
     */
    if (!isNew && v[f.key] === undefined && f.type !== 'map' && f.type !== 'strlist' &&
      f.type !== 'rows' && f.optional !== true) return;
    out.push('<label><span>' + esc(f.label) + (f.readOnly ? '（只读）' : '') + '</span>' + ctl(f, v[f.key]));
    if (f.hint) out.push('<em class="hint">' + esc(f.hint) + '</em>');
    out.push('</label>');
  });
  out.push('<div class="row"><button id="saveRow">' + (isNew ? '新建' : '保存') + '</button>' +
    '<button class="ghost" id="cancelRow">取消</button></div>');
  out.push('<div class="msg" id="rowMsg"></div></fieldset>');
  return out.join('\n');
}

/**
 * 新建一条（M2.84）。
 *
 * 在此之前编辑器只能改已有的记录 —— 加一件物品、加一张事件卡、加一个地点，
 * 都得去改文件再重启。而 AGENTS.md §3.4 要求的是「让运营能自己**加**、自己改」：
 * 「改」这一半一直在，「加」这一半直到这里才补上。
 */
function newRow() {
  ROW = null;
  CREATING = true;
  document.querySelector('#dataForm').innerHTML = formHtml('新建一条：' + CUR.label, {}, true);
  bindForm();
}

function pickRow(id) {
  api('/data/' + encodeURIComponent(CUR.id) + '/' + encodeURIComponent(id)).then(function (d) {
    ROW = id;
    CREATING = false;
    var v = d.row;
    document.querySelector('#dataForm').innerHTML =
      formHtml('编辑：' + (v.name || v.title || id), v, false);
    bindForm();
  }).catch(function (e) {
    document.querySelector('#dataForm').innerHTML =
      '<div class="msg err" style="display:block">' + esc(e.message) + '</div>';
  });
}

function bindForm() {
  function bindDel(scope) {
    Array.prototype.forEach.call(scope.querySelectorAll('[data-del]'), function (b) {
      b.onclick = function () { b.parentNode.remove(); };
    });
  }
  bindDel(document);
  bindKeyChange(document);
  bindCondChange(document);
  Array.prototype.forEach.call(document.querySelectorAll('[data-addsl]'), function (b) {
    b.onclick = function () {
      var box = b.parentNode;
      var div = document.createElement('div');
      div.className = 'slrow';
      var ff = fieldOfStatic(box);
      div.innerHTML = (ff ? slCtl(ff, '') : '<input type="text" value="">') +
        '<button class="ghost" data-del="1">删</button>';
      box.insertBefore(div, b);
      bindDel(div);
      bindKeyChange(div);
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-addrow]'), function (b) {
    b.onclick = function () {
      var box = b.parentNode, f = fieldOfStatic(box), cols = (f && f.rowFields) || [];
      if (!cols.length) return;
      var tr = document.createElement('tr');
      cols.forEach(function (c) {
        var td = document.createElement('td');
        td.innerHTML = ctl(c, c.type === 'number' ? 0 : '', true);
        tr.appendChild(td);
      });
      var last = document.createElement('td');
      last.innerHTML = '<button class="ghost" data-del="1">删</button>';
      tr.appendChild(last);
      box.querySelector('table').appendChild(tr);
      bindDel(tr);
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-addkv]'), function (b) {
    b.onclick = function () {
      var box = b.parentNode, f = fieldOfStatic(box);
      if (!f) return;
      var holder = document.createElement('div');
      holder.innerHTML = mapRowHtml(f, '', mapDefaultVal(f, ''));
      var row = holder.firstChild;
      box.insertBefore(row, b);
      bindDel(row);
      bindKeyChange(row);
      // 新行默认落在**第一个空闲的**候选键上，省得一堆空键被保存时丢掉、
      // 或者两行撞同一个键被后者覆盖（见 freeKeyOf 的注释）
      var ke = row.querySelector('[data-mk]');
      if (ke && ke.tagName === 'SELECT' && ke.options.length) {
        var want = freeKeyOf(f, box);
        for (var i = 0; i < ke.options.length; i++) {
          if (ke.options[i].value === want) { ke.selectedIndex = i; break; }
        }
      }
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-addml]'), function (b) {
    b.onclick = function () {
      var box = b.parentNode, f = fieldOfStatic(box);
      if (!f) return;
      var holder = document.createElement('div');
      holder.innerHTML = mlRowHtml(f, {});
      var row = holder.firstChild;
      box.insertBefore(row, b);
      bindDel(row);
      bindKeyChange(row);
      // 新条默认落在第一个空闲键上，省得连点几次出来一堆同键的条
      var ke = row.querySelector('[data-mk]');
      if (ke && ke.tagName === 'SELECT' && ke.options.length) {
        var want = freeKeyOf(f, box);
        for (var i = 0; i < ke.options.length; i++) {
          if (ke.options[i].value === want) { ke.selectedIndex = i; break; }
        }
      }
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-addmlk]'), function (b) {
    b.onclick = function () {
      var row = b.parentNode, box = row.parentNode, f = fieldOfStatic(box);
      if (!f) return;
      /*
       * 新键的范围限定在**这一条里**（而不是整个 effects）：
       * 同一条里出现两个相同的键，收集时后者会覆盖前者 —— 界面上两组值都在，
       * 文件里只剩一组。跨条同键是合法的（- {cor:2} 和 - {cor:1} 各自成条）。
       */
      var nk = freeKeyOf(f, row);
      var holder = document.createElement('div');
      holder.innerHTML = '<div class="kvrow">' + mapKeyCtl(f, nk) +
        mapValCtl(f, mapDefaultVal(f, nk), nk) + '<button class="ghost" data-del="1">删键</button></div>';
      var kv = holder.firstChild;
      row.insertBefore(kv, b);
      bindDel(kv);
      bindKeyChange(kv);
    };
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-addcl]'), function (b) {
    b.onclick = function () {
      var box = b.parentNode;
      var row = condRowOf('');
      box.insertBefore(row, b);
      bindDel(row);
      bindCondChange(row);
    };
  });

  document.querySelector('#cancelRow').onclick = function () {
    document.querySelector('#dataForm').innerHTML = '';
  };
  document.querySelector('#saveRow').onclick = saveRow;
}

function readCtl(el, f) {
  // 空串 = 「未设置」（可选布尔的第三态）→ undefined，写回时删键而不是写 false
  if (f.type === 'bool') return el.value === '' ? undefined : el.value === 'true';
  if (f.type === 'number') {
    /*
     * 空 = 没填，**不能**变成 0。
     * `<input type="number">` 在非法输入（粘贴了字母）时 value 就是空串，
     * 而 Number('') 是 0 —— 于是「这一格我清空了」会变成「把它设成 0」，
     * 保存之后界面上显示一个理直气壮的 0，看不出是被系统填的。
     * 交给可选字段那一套：undefined = 不写这个键。
     */
    var num = el.value.trim();
    return num === '' ? undefined : Number(num);
  }
  return el.value;
}

function saveRow() {
  var patch = {};
  /*
   * 顶层字段：只认 data-k，行内控件用的是 data-rk —— 两套属性名天然不会串。
   * 表格 / 键值 / 字符串列表各自成组收集，见下。
   */
  Array.prototype.forEach.call(document.querySelector('#dataForm').querySelectorAll('[data-k]'), function (el) {
    var f = CUR.fields.filter(function (x) { return x.key === el.dataset.k; })[0];
    if (!f || f.readOnly) return;
    patch[f.key] = readCtl(el, f);
  });
  /*
   * object：一组固定子字段，每个子字段是**单个控件**（卡片的 trigger / texts）。
   *
   * 子控件用 data-rk —— 与 rows 行内同一套属性名，天生不会和外层 data-k 串。
   *
   * 留空的**可选**子字段不写这个键：卡片 schema 里 location / max_seq / group
   * 都是可选的，写一个空串进去过不了 zod（min(1)），而报错要等下一次内容校验。
   */
  Array.prototype.forEach.call(document.querySelector('#dataForm').querySelectorAll('.obj'), function (box) {
    var f = fieldOfStatic(box);
    if (!f) return;
    var o = {};
    (f.objectFields || []).forEach(function (c) {
      var el = box.querySelector('[data-rk="' + c.key + '"]');
      if (!el) return;
      var v = readCtl(el, c);
      if (c.type === 'strlist') {
        /*
        * 两种控件，读法不同：有候选时是多选下拉（selectedOptions），
        * 没有候选时是多行文本框（一行一条）。
        */
        var arr = el.tagName === 'SELECT'
          ? Array.prototype.map.call(el.selectedOptions, function (x) { return x.value; })
            .filter(function (x) { return x !== ''; })
          : String(v == null ? '' : v).split(String.fromCharCode(10))
            .map(function (s) { return s.trim(); })
            .filter(function (s) { return s !== ''; });
        if (arr.length || c.optional !== true) o[c.key] = arr;
        return;
      }
      // undefined = 可选布尔的「未设置」那一档，不写这个键（而不是写 false）
      if (c.optional === true && (v === '' || v === null || v === undefined)) return;
      o[c.key] = v;
    });
    patch[f.key] = o;
  });
  /*
   * maplist：每条是一组键值（卡片的 effects）。
   *
   * 没有任何键的行**整行丢掉**：一条没有键的效果在判定层是「什么都不做」，
   * 但它会占着一个位置，让人以为这张卡有那么多条效果。
   */
  Array.prototype.forEach.call(document.querySelector('#dataForm').querySelectorAll('.ml'), function (box) {
    var f = fieldOfStatic(box);
    if (!f) return;
    var arr = [];
    Array.prototype.forEach.call(box.querySelectorAll('.mlrow'), function (row) {
      var o = {};
      Array.prototype.forEach.call(row.querySelectorAll('.kvrow'), function (kv) {
        var ke = kv.querySelector('[data-mk]'), ve = kv.querySelector('[data-mv]');
        if (!ke || !ve) return;
        var k = ke.value.trim();
        if (!k) return;
        o[k] = (ve.tagName === 'SELECT' || isTextKey(f, k)) ? ve.value : Number(ve.value);
      });
      if (Object.keys(o).length) arr.push(o);
    });
    patch[f.key] = arr;
  });
  /*
   * condlist：一排一排的条件控件，每排拼回一条字符串。
   *
   * 整排空着（数值那条没填数字）就丢掉 —— 一个空字符串在条件层等价于
   * 「永远不成立」，它会让这张卡再也不出，而且看不出是哪一条干的。
   */
  Array.prototype.forEach.call(document.querySelector('#dataForm').querySelectorAll('.cl'), function (box) {
    var f = fieldOfStatic(box);
    if (!f) return;
    var arr = [];
    Array.prototype.forEach.call(box.querySelectorAll('.clrow'), function (row) {
      var s = readCondRow(row);
      if (s !== '') arr.push(s);
    });
    patch[f.key] = arr;
  });
  Array.prototype.forEach.call(document.querySelector('#dataForm').querySelectorAll('.sl'), function (box) {
    var f = fieldOfStatic(box);
    if (!f) return;
    /*
     * multiline：整组文本在一个 textarea 里，一行一条。
     *
     * 空行**丢掉**，而不是留成空字符串 —— 一个空字符串在内容层就是一条
     * 「什么都没有的文本」，它会被抽中并原样发给玩家：文案没了，但不报错。
     * 顺带 trim：从别处贴进来的文本常带尾随空格，而尾随空格会让同一条文本
     * 在去重 / 比对时看起来是两条。
     */
    if (f.multiline === true) {
      var ta = box.querySelector('textarea');
      patch[f.key] = (ta ? ta.value : '').split(String.fromCharCode(10))
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s !== ''; });
      return;
    }
    // input 与 select 都要读 —— strlist 有 itemRef 时渲染的是下拉（M2.64）
    patch[f.key] = Array.prototype.map.call(box.querySelectorAll('input, select'), function (x) { return x.value; })
      .filter(function (v) { return v !== ''; });
  });
  Array.prototype.forEach.call(document.querySelector('#dataForm').querySelectorAll('.tb'), function (box) {
    var f = fieldOfStatic(box);
    if (!f) return;
    var out = [];
    Array.prototype.forEach.call(box.querySelectorAll('tr'), function (tr) {
      if (tr.querySelector('th')) return;
      var row = {}, cells = tr.querySelectorAll('td');
      Array.prototype.forEach.call(cells, function (td, ci) {
        var col = (f.rowFields || [])[ci];
        if (!col) return;
        var el = td.querySelector('[data-rk]');
        if (!el) return;
        row[col.key] = readCtl(el, col);
      });
      out.push(row);
    });
    patch[f.key] = out;
  });
  Array.prototype.forEach.call(document.querySelector('#dataForm').querySelectorAll('.kvmap'), function (box) {
    var f = fieldOfStatic(box);
    if (!f) return;
    var m = {};
    Array.prototype.forEach.call(box.querySelectorAll('.kvrow'), function (r) {
      // 行里可能有两个 select（键 + 枚举值），所以不能靠 tag 去猜，按标记读
      var ke = r.querySelector('[data-mk]'), ve = r.querySelector('[data-mv]');
      if (!ke || !ve) return;
      if (!ke.value) return;
      m[ke.value] = (f.mapValues || isTextKey(f, ke.value)) ? ve.value : Number(ve.value);
    });
    patch[f.key] = m;
  });
  var b = document.querySelector('#saveRow');
  b.disabled = true;
  /*
   * 新建还是改一条 —— 差别只在 URL 带不带 rowId，以及 body 里多一个 id。
   * 后端两条路的校验完全一样（值域 + 跨表 + 必填），所以这里不需要分支处理。
   */
  var isNew = CREATING === true;
  var newIdEl = document.querySelector('[data-newid]');
  var newId = newIdEl ? newIdEl.value.trim() : '';
  api('/data/' + encodeURIComponent(CUR.id) + (isNew ? '' : '/' + encodeURIComponent(ROW)), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(isNew ? { id: newId, patch: patch } : patch),
  })
    .then(function (d) {
      msg(document.querySelector('#rowMsg'), true, d.message);
      if (!isNew) return;
      /*
       * 新建成功后刷新列表 —— 不刷的话人看到的是旧列表，会以为没建成、
       * 再点一次，然后撞上「已经有一条 id 叫…」。
       *
       * 回执要**重新贴到列表上方**：刷新会把右边那张表单连同回执一起冲掉，
       * 而「到底成没成」正是这一刻唯一想知道的事。
       */
      var text = d.message;
      pickEnt(CUR.id, function () {
        var box = document.querySelector('#dataList');
        if (box) {
          box.insertAdjacentHTML('afterbegin',
            '<div class="msg ok" style="display:block">' + esc(text) + '</div>');
        }
      });
    })
    .catch(function (e) { msg(document.querySelector('#rowMsg'), false, e.message); })
    .then(function () { b.disabled = false; });
}
