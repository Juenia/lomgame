/**
 * 管理后台（M2.49）：守住三件容易悄悄坏掉的事。
 *
 * 1. **页面那段内联 JS 的语法**。它是字符串拼出来的，拼错一个引号 TS 照样编译通过，
 *    只有浏览器打开时才白屏 —— 本轮就踩了一次（改一处 catch，整段 JS 变成语法错误，
 *    连带 20 多个测试文件因为模块加载失败而红）。所以这里 new Function 一遍。
 * 2. **未登录必须挡住 API**。后台能改玩家数值、能改 AppSecret。
 * 3. **.env 的行级读写**：改一个 key 不能把注释和顺序冲掉。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { envGet, envSet, maskSecret, readEnv, writeEnv } from '../src/admin/env.ts';
import { openDatabase } from '../src/infra/db/sqlite.ts';
import { adminPage } from '../src/admin/page.ts';
import type { FieldSpec } from '../src/admin/schema.ts';

test('后台不抢别人的路由：/admin/tick 是 M2.39 的时间旅行端点', async () => {
  const { handleAdmin } = await import('../src/admin/index.ts');
  const req = { method: 'POST', url: '/admin/tick', headers: {}, on: () => undefined };
  const res = { writeHead: () => undefined, end: () => undefined };
  const ctx = {
    envPath: '/nonexistent/.env', log: () => undefined, startedAt: '',
    root: process.cwd(), db: openDatabase(':memory:'),
  };
  for (const u of ['/admin/tick', '/admin/tick?days=30', '/administrator', '/health', '/cards/x.png']) {
    assert.equal(
      await handleAdmin(req as never, res as never, u, ctx),
      false,
      u + ' 不该被后台接管',
    );
  }
  // 自己的三条路必须接
  for (const u of ['/admin', '/admin/', '/admin/api/adapter']) {
    assert.equal(await handleAdmin(req as never, res as never, u, ctx), true, u + ' 该被后台接管');
  }
});

test('后台页面：内联脚本语法合法（拼错一个引号就会整页白屏）', () => {
  const html = adminPage();
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, '页面里找不到内联脚本');
  assert.doesNotThrow(() => new Function(m![1]), '内联脚本有语法错误');
  assert.ok(m![1]!.length > 800, '脚本太短，可能被截断');
});

test('后台页面：登录框初始不显示错误条', () => {
  const html = adminPage();
  // class="msg err" 会命中 .msg.err{display:block}，让一条空提示条一直挂在按钮下面
  assert.ok(!html.includes('class="msg err" id="loginErr"'), '登录错误条初始就该是隐藏的');
  assert.match(html, /class="msg" id="loginErr"/);
});

test('后台页面：网络错误与口令错误分开提示', () => {
  const html = adminPage();
  // fetch 抛的是网络层错误；混着说会让人一直重输口令
  assert.match(html, /Failed to fetch/);
  assert.match(html, /连不上服务/);
  assert.match(html, /口令不对/);
});

test('GM 路由：没登录一律 401，而且不能顺手把别人的路径圈进来', async () => {
  const { handleAdmin } = await import('../src/admin/index.ts');
  const ctx = {
    envPath: '/nonexistent/.env', log: () => undefined, startedAt: '',
    root: process.cwd(), db: openDatabase(':memory:'),
  };
  let code = 0;
  const res = { writeHead: (c: number) => { code = c; }, end: () => undefined };
  const req = (method: string, url: string) => ({
    method, url, headers: {},
    on: (event: string, cb: () => void) => { if (event === 'end') cb(); },
  });

  // GM 能改玩家数值，未登录必须挡住
  for (const url of [
    '/admin/api/gm/options',
    '/admin/api/gm/players',
    '/admin/api/gm/players/c1',
    '/admin/api/gm/players/c1/stats',
    '/admin/api/gm/players/c1/reset-daily',
  ]) {
    code = 0;
    assert.equal(await handleAdmin(req('GET', url) as never, res as never, url, ctx), true, url + ' 该被后台接管');
    assert.equal(code, 401, url + ' 没登录时必须 401');
  }

  // 圈地必须精确。M2.39 的 /admin/tick 就是被前缀匹配吃掉过一次
  for (const url of ['/admin/gm', '/admin/gm.js.map', '/administrator']) {
    assert.equal(await handleAdmin(req('GET', url) as never, res as never, url, ctx), false, url + ' 不该被后台接管');
  }
});

test('适配器面板：脚本是独立文件、语法合法、页面确实引用它，且轮询不重画正在编辑的控件', async () => {
  const { readFileSync } = await import('node:fs');
  const js = readFileSync('src/admin/adapter.js', 'utf8');
  assert.doesNotThrow(() => new Function(js), 'adapter.js 有语法错误');
  const html = adminPage();
  assert.match(html, /<script src="\/admin\/adapter\.js"><\/script>/, '页面没有引用 adapter.js');
  assert.ok(!html.includes('function renderStatus'), '适配器逻辑又被拼回 page.ts 了');
  // 控件必须用运行中的值初始化：不填的话界面显示默认值，
  // 而这时点一下保存就会把 AppID 提交成空串、把开关全关掉
  assert.ok(js.includes('adFillForm'), '没有把运行中的值填回表单');
  // 轮询只刷数字，不能重画白名单/表单（否则每 2 秒冲掉一次正在编辑的内容）
  assert.ok(js.includes("adRefresh('poll')"), '轮询没有走只刷数字的那条路');
});

test('GM 面板：脚本是独立文件、语法合法、页面确实引用它', async () => {
  const { readFileSync } = await import('node:fs');
  const js = readFileSync('src/admin/gm.js', 'utf8');
  // 与 editor.js 同一个理由：不经过 TS 编译，语法错只会在浏览器里白屏
  assert.doesNotThrow(() => new Function(js), 'gm.js 有语法错误');
  assert.ok(js.length > 3000, 'gm.js 太短，可能被截断');

  const html = adminPage();
  assert.match(html, /<script src="\/admin\/gm\.js"><\/script>/, '页面没有引用 gm.js');
  assert.ok(html.includes('id="gmList"') && html.includes('id="gmDetail"'), 'GM 面板的容器不在页面上');
  assert.ok(!html.includes('建设中'), 'GM 面板还是占位符');
  // 统计数字是 d.counts（服务端把 gmOptions().stats 覆盖过一次，前端当场崩）
  assert.ok(js.includes('d.counts'), 'gm.js 没读统计数');
  // 只查调用点：文件里那句解释这个坑的注释本身就含 "d.stats"，用正则会被自己的注释绊倒
  assert.ok(!js.includes('gmStatsBar(d.stats)'), 'gm.js 又把统计数当成 d.stats 用了');
});

test('后台框架：导航由注册表画，面板链接不再写死在三个地方', async () => {
  const { readFileSync } = await import('node:fs');
  const js = readFileSync('src/admin/console.js', 'utf8');
  assert.doesNotThrow(() => new Function(js), 'console.js 有语法错误');
  // M2.74：markdown 渲染器也是独立的客户端脚本，语法错同样只会在浏览器里白屏
  //（它比别的脚本更险：console.js 的面板渲染直接依赖它）
  const md = readFileSync('src/admin/md.js', 'utf8');
  assert.doesNotThrow(() => new Function(md), 'md.js 有语法错误');
  const html = adminPage();
  assert.match(html, /<script src="\/admin\/console\.js"><\/script>/, '页面没有引用 console.js');
  assert.ok(html.includes('<aside id="nav"></aside>'), 'nav 容器不在');
  // 以前加一个面板要同时改 aside、<section>、显隐开关，漏一处就是「点了没反应」且不会报错
  assert.ok(!html.includes('data-tab='), '面板链接又被写死在页面里了');
});

test('后台框架：每个 ready 面板在页面上都有容器（漏一个点开就是空白）', async () => {
  const { PANELS } = await import('../src/admin/nav.ts');
  const html = adminPage();
  for (const p of PANELS.filter((x) => x.state === 'ready')) {
    assert.ok(html.includes('id="tab-' + p.id + '"'), p.id + ' 没有容器 —— 点开会是空白');
  }
  // 未实现的共用一个说明页，内容按注册表现画
  assert.ok(html.includes('id="tab-planned"'), '未实现的说明页容器不在');
});

test('后台框架：未实现的功能必须显式登记，而且写清楚卡在哪、做出来什么样', async () => {
  const { PANELS, groupedPanels } = await import('../src/admin/nav.ts');
  const planned = PANELS.filter((p) => p.state === 'planned');
  /*
   * 这条测试守的是这一份注册表存在的理由：「没做」和「坏了」在界面上长得一样，
   * 只有把未实现的功能显式登记、并写清具体卡点，人才能区分这两件事。
   * 所以 blockedBy 不许写「开发中」这种废话 —— 写不出具体原因，要么是没想清楚，
   * 要么是其实可以做。
   */
  // 不断言 planned 的数量：M2.53 把登记过的都实现完了，这一份现在是空的，
  // 而「空」是正确状态。这条测试守的是**凡是写进来的 planned 都必须站得住**。
  assert.ok(Array.isArray(planned));
  for (const p of planned) {
    assert.ok((p.summary ?? '').length > 6, p.id + ' 没有一句像样的说明');
    assert.ok((p.blockedBy ?? []).length > 0, p.id + ' 没写卡在哪');
    for (const b of p.blockedBy ?? []) {
      assert.ok(b.trim().length > 10, p.id + ' 的 blockedBy 太笼统：' + b);
      assert.ok(!/^(开发中|待定|TODO|以后再说)$/.test(b.trim()), p.id + ' 的 blockedBy 是废话');
    }
    assert.ok((p.plan ?? []).length > 0, p.id + ' 没写做出来是什么样');
  }
  // 分组要稳定：同一组的条目必须连着出现，否则导航会来回跳
  const groups = groupedPanels().map((g) => g.group);
  assert.deepEqual(groups, [...new Set(groups)], '同一组被打散了');
  assert.equal(groupedPanels().reduce((n, g) => n + g.items.length, 0), PANELS.length);
});

test('后台页面：cookie 还有效就直接进去，不再让人重输口令', () => {
  const html = adminPage();
  // 未登录访问就该看见登录框，所以它默认是显示的
  assert.match(html, /<div id="login">/);
  /*
   * 初始化必须探一次 /adapter，通了就把 #login 收掉。
   * 少了这一步，登录框（position:fixed;inset:0;z-index:50）会一直盖在后台上面，
   * 签名 cookie 的 12 小时有效期、重启不失效就全白做了 —— 实测就是这样：
   * DOM 里数据编辑器已经渲染好了，截图看到的却还是登录页。
   */
  assert.ok(
    html.includes('api("/adapter").then(function(){$("#login").classList.add("hide");'),
    '初始化没有在 cookie 有效时收起登录框',
  );
});

test('.env：改一个 key 原地改值，注释与顺序原样保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'admin-env-'));
  const file = join(dir, '.env');
  try {
    writeFileSync(file, [
      '# 分组注释',
      'QQ_BOT_APPID=1',
      '',
      '# 另一段注释',
      'QQ_BOT_SANDBOX=0',
    ].join('\n'), 'utf8');

    const env = readEnv(file);
    envSet(env, 'QQ_BOT_SANDBOX', '1');
    envSet(env, 'ADMIN_PASSWORD', 'x');   // 新 key 追加
    writeEnv(file, env);

    const after = readFileSync(file, 'utf8').split('\n');
    assert.equal(after[0], '# 分组注释', '注释被冲掉了');
    assert.equal(after[3], '# 另一段注释', '注释被冲掉了');
    assert.equal(after[1], 'QQ_BOT_APPID=1', '没动过的行被改了');
    assert.equal(after[4], 'QQ_BOT_SANDBOX=1', '没有原地改值');
    assert.ok(after.some((l) => l === 'ADMIN_PASSWORD=x'), '新 key 没有追加');
    assert.ok(readFileSync(file, 'utf8').endsWith('\n'), '末尾缺换行');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('.env：读不存在的文件不抛错（CI / 生产用环境变量注入）', () => {
  const env = readEnv(join(tmpdir(), 'definitely-not-here-' + Date.now(), '.env'));
  assert.deepEqual(env.lines, []);
  assert.equal(envGet(env, 'ANY'), undefined);
});

test('密钥打码：够确认是哪一个，不够还原', () => {
  assert.equal(maskSecret(undefined), '');
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret('short'), '*****', '短密钥应整段打码');
  const masked = maskSecret('abcdefghijklmnopqrstuvwx');
  assert.ok(masked.startsWith('abcd') && masked.endsWith('uvwx'));
  assert.ok(!masked.includes('efghijkl'), '中间段不该出现');
  assert.ok(masked.length < 26);
});
test('数据写入不重排整个文件：lineWidth 默认值会把流式条目折成块式', async () => {
  const { readFileSync } = await import('node:fs');
  const { parseDocument } = await import('yaml');
  // 拿真实文件测：手工造的长行未必触发折行，而 items.yaml 里几乎每条都超 80 字符
  const src = readFileSync('src/data/items.yaml', 'utf8');
  const doc = parseDocument(src);
  const wide = doc.toString();
  const kept = doc.toString({ lineWidth: 0 });
  /*
   * M2.76：判据从「折行后 > 原文 × 2」改成「折行后 > 原文」。
   *
   * 原来那个倍数是在**条目都很长**的前提下成立的（加内容前 items.yaml 几乎每条超 80 字符，
   * 折一次就翻一倍）。M2.76 往 items.yaml 加了 798 条**短条目**（材料与成品魔药），
   * 它们本来就在一行以内、不会折 ⇒ 整体倍数掉到 2 以下。
   *
   * 这条用例真正要守的是「**默认 lineWidth 会折行**，所以 data.ts 必须显式传 0」，
   * 而那个判据只需要「折行后的行数严格多于原文」——倍数不是它要守的东西。
   */
  assert.ok(
    wide.split('\n').length > src.split('\n').length,
    '前提变了：默认输出居然没折行，data.ts 的 lineWidth:0 需要重新评估',
  );
  // toString 不加末尾换行（writeEntity 负责补），所以比原文少一个元素
  /*
   * M2.76：判据从「恰好等于 src 行数 − 1」改成「**不增加行数**」。
   *
   * 原来那个等号依赖「原文末尾恰好一个换行、toString 不加末尾换行」这对细节，
   * 而 items.yaml 在 M2.76 加了 798 条条目之后末尾形态变了（差 1 行）。
   * 这条用例要守的是「lineWidth:0 **不重排**」—— 不重排的判据就是行数不涨；
   * 而「内容一个字都不丢」由下面那条 deepEqual 守着（那才是真正的判据）。
   */
  assert.ok(
    kept.split('\n').length <= src.split('\n').length,
    'lineWidth:0 不该增加行数（不重排）',
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(await import('yaml').then((m) => m.parse(kept)))),
    JSON.parse(JSON.stringify(await import('yaml').then((m) => m.parse(src)))),
    '重排不能丢内容',
  );
});
test('编辑器脚本是独立文件、语法合法、页面确实引用它', async () => {
  const { readFileSync } = await import('node:fs');
  const js = readFileSync('src/admin/editor.js', 'utf8');
  // 这段 JS 不经过 TS 编译，语法错只会在浏览器里白屏 —— 必须在这里挡一次
  assert.doesNotThrow(() => new Function(js), 'editor.js 有语法错误');
  assert.ok(js.length > 3000, 'editor.js 太短，可能被截断');
  const html = adminPage();
  assert.match(html, /<script src="\/admin\/editor\.js"><\/script>/, '页面没有引用 editor.js');
  // 编辑器逻辑不该再回到 page.ts 的字符串数组里 —— 那正是这一轮三次转义事故的来源
  assert.ok(!html.includes('function saveRow'), '编辑器逻辑又被拼回 page.ts 了');
});

test('数据编辑：实体清单完整，主键与分类都不缺', async () => {
  const { ENTITIES, entityById } = await import('../src/admin/schema.ts');
  const kinds = entityById('items')!.fields.find((f) => f.key === 'kind')!.enumMap!;
  // 这几个取值是扫真实数据得来的，写错一个字母界面就会显示成英文原文
  for (const k of ['currency', 'material', 'consumable', 'potion', 'trinket']) {
    assert.ok(k in kinds, 'items.kind 缺了真实存在的取值：' + k);
  }
  for (const e of ENTITIES) {
    assert.ok(e.group.length > 0, e.id + ' 没有分类');
    /*
     * M2.76：主键断言只对 seq / map / dir 成立。
     *
     * single 模式的记录 id **就是实体 id**（文件里没有那个键），所以它的 idKey /
     * rootKey 本来就不填 —— 拿「字段里必须有主键」去要求它，是把一条只适用于
     * 「一个文件多条」的规则套到了「一份文件就是一条」上。
     *
     * 反过来，「不该有的东西确实没有」也要钉住：真给 single 填了 rootKey，
     * 它会去找一个不存在的根键，然后安静地列出 0 条。
     */
    if (e.rootMode === 'single') {
      assert.equal(e.idKey, undefined, e.id + ' 是 single 模式，不该有 idKey');
      assert.equal(e.rootKey, undefined, e.id + ' 是 single 模式，不该有 rootKey');
      continue;
    }
    // dir 模式的「根」是目录里每个文件的顶层，同样没有根键
    if (e.rootMode === 'dir') {
      assert.equal(e.rootKey, undefined, e.id + ' 是 dir 模式，不该有 rootKey');
    } else {
      assert.ok((e.rootKey ?? '').length > 0, e.id + ' 没有 rootKey');
    }
    assert.ok(e.fields.some((f) => f.key === e.idKey), e.id + ' 的字段里没有主键');
  }
  assert.ok(ENTITIES.length >= 11, '可编辑实体不该只有物品一个（曾经就是只有一个）');

  /*
   * 四种根形状每一种都得有实体在用。
   *
   * 为什么值得单独钉一条：一种根形状如果没有使用者，它就没有任何一条路径被真实数据
   * 跑过 —— 那么它坏掉的时候，测试会全绿。M2.76 加 map 模式时我第一版就写错了形状
   * （做成了「字段是键→数组」，而真实文件是「整份文件就是键→数组」），
   * 是靠拿真文件跑一遍才发现的。
   */
  for (const mode of ['seq', 'map', 'single', 'dir'] as const) {
    const users = ENTITIES.filter((e) => (e.rootMode ?? 'seq') === mode);
    assert.ok(users.length > 0, '没有任何实体在用 ' + mode + ' 这种根形状');
  }
});

test('字段元数据整份发给前端：rowFields / mapValues 不能被序列化漏掉', async () => {
  const { ENTITIES, entityMeta } = await import('../src/admin/schema.ts');
  /*
   * 这里出过一次很难看的 bug：index.ts 手抄了一份白名单
   * （key/label/type/enumMap/mapKeys/ref/hint/readOnly），漏了 rowFields 和 mapValues。
   * 于是前端拿到的 rows 字段是「一列都没有的空表」、map 字段是「没有选项的空下拉」，
   * 而**哪里都不报错** —— 页面照常渲染，只是点「加一行」没有任何反应、保存还会把整张
   * 关系表写成 {}。手抄的白名单和 schema 一定会漂移，所以这里守的是"整份透传"这件事。
   */
  for (const e of ENTITIES) {
    const wire = JSON.parse(JSON.stringify(entityMeta(e))) as { fields: FieldSpec[] };
    assert.deepEqual(wire.fields, e.fields, e.id + ' 的字段元数据在发送途中被裁剪了');
  }
  const rowsFields = ENTITIES.flatMap((e) => e.fields.filter((f) => f.type === 'rows'));
  assert.ok(rowsFields.length > 0, '前提变了：一个 rows 字段都没有');
  for (const f of rowsFields) {
    assert.ok((f.rowFields ?? []).length > 0, f.key + ' 是 rows 却没有列定义，表格会渲染成空表');
  }
});

test('数据编辑：每个 ref / mapRef 都指向真实实体（指错就是永远空的下拉）', async () => {
  const { ENTITIES } = await import('../src/admin/schema.ts');
  const ids = new Set(ENTITIES.map((e) => e.id));
  const walk = (fs: FieldSpec[], owner: string): void => {
    for (const f of fs) {
      for (const [kind, target] of [['ref', f.ref], ['mapRef', f.mapRef]] as const) {
        if (target !== undefined) {
          assert.ok(ids.has(target), owner + '.' + f.key + ' 的 ' + kind + ' 指向不存在的实体：' + target);
        }
      }
      walk(f.rowFields ?? [], owner + '.' + f.key);
    }
  };
  for (const e of ENTITIES) walk(e.fields, e.id);
});

test('教会关系表：键是教会 id、值是三档枚举（两边都曾渲染成空下拉）', async () => {
  const { entityById } = await import('../src/admin/schema.ts');
  const rel = entityById('churches')!.fields.find((f) => f.key === 'relations')!;
  assert.equal(rel.type, 'map');
  // 键必须是能选到的教会列表：否则行里是一个空下拉，保存时读到空值，
  // 整个 relations 被写成 {} —— yaml 合法、无报错、数据没了
  assert.equal(rel.mapRef, 'churches', 'relations 的键没有来源，会被静默清空');
  assert.deepEqual(Object.keys(rel.mapValues ?? {}), ['ally', 'neutral', 'hostile']);
});
test('扮演文案：接进了数据编辑器，且声明了「文案必须含标签词」这条跨字段规则', async () => {
  const { entityById } = await import('../src/admin/schema.ts');
  const spec = entityById('tag-phrases');
  assert.ok(spec, '扮演文案没有接进数据编辑');
  assert.equal(spec.file, 'src/data/tag-phrases.yaml');
  assert.equal(spec.rootKey, 'phrases', '根键要与 YAML 里的顶层键一致');
  assert.equal(spec.idKey, 'id', 'id 是「途径.标签」—— 单用标签词会撞（mother.守夜 / perfect.守夜）');
  const text = spec.fields.find((f) => f.key === 'text');
  assert.ok(text, '少了 text 字段');
  assert.equal(text.mustContainField, 'tag', 'text 必须声明「要含 tag」这条规则');
  // 标签词本身是判定口径的一部分，改它等于改判定，提示里要说清楚
  assert.ok((spec.fields.find((f) => f.key === 'tag')?.hint ?? '').includes('判定'), '标签词的提示要说清它是判定口径');
});

test('后台保存扮演文案：文案里没有标签词就当场拒绝（不能等启动才发现）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'admin-tag-'));
  try {
    mkdirSync(join(dir, 'src', 'data'), { recursive: true });
    const file = join(dir, 'src', 'data', 'tag-phrases.yaml');
    writeFileSync(file, [
      'phrases:',
      "  - { id: seer.占卜, pathway: seer, tag: 占卜, text: '摊开牌占卜一件还没发生的事' }",
      "  - { id: seer.潜行, pathway: seer, tag: 潜行, text: '贴着墙根潜行，不出声' }",
      '',
    ].join('\n'), 'utf8');

    const { entityById } = await import('../src/admin/schema.ts');
    const { writeEntity } = await import('../src/admin/data.ts');
    const spec = entityById('tag-phrases')!;

    // 合法：文案里出现了标签词
    const ok = writeEntity(dir, spec, 'seer.占卜', { text: '再占卜一件还没发生的事' });
    assert.deepEqual(ok.changed, ['玩家看到的那句话']);

    /*
     * 不合法：把「占卜」改掉 —— 判定层按关键词匹配，玩家选了这条不会涨消化度，
     * 而这**不会报任何错**。所以必须在这里拦住，而不是等启动时 loadTagPhrases 报错
     * （那时内容已经写进文件了）。
     */
    assert.throws(
      () => writeEntity(dir, spec, 'seer.占卜', { text: '看看牌' }),
      /必须出现「占卜」/,
      '文案里没有标签词时必须当场拒绝',
    );

    // 只改标签词（不动文案）也要校验：两个字段的新值必须仍然相容
    assert.throws(
      () => writeEntity(dir, spec, 'seer.潜行', { tag: '疾走' }),
      /必须出现「疾走」/,
      '改标签词会让原文案失效，同样要拦',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
