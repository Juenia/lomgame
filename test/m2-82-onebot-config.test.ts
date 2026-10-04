/**
 * M2.82：OneBot 子页的**配置读写**（把适配器做完整）。
 *
 * 在此之前 OneBot 那一页只有连接状态与两个按钮 —— 改地址、改白名单都得手编 .env 再重启。
 * 现在两条通道的后台能力是对称的：都能看「磁盘 vs 运行中」、都能在运行期改。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { compareOneBot, onebotPatchFromForm, type OneBotConfigView } from '../src/admin/adapter.ts';
import { OneBotAdapter } from '../src/adapter/onebot.ts';

test('OneBot 配置：白名单三种写法与启动读 .env 的口径一致', () => {
  assert.deepEqual(onebotPatchFromForm({ allowedCommands: '*' }).allowedCommands, ['*']);
  assert.deepEqual(onebotPatchFromForm({ allowedCommands: '' }).allowedCommands, []);
  assert.deepEqual(onebotPatchFromForm({ allowedCommands: '创建, 状态' }).allowedCommands, ['创建', '状态']);
  // 留空 = 不改：页面不回显 token，没有这条规则一保存就把协议端口令清了
  assert.equal(onebotPatchFromForm({ token: '' }).accessToken, undefined);
  assert.equal(onebotPatchFromForm({ token: ' abc ' }).accessToken, 'abc');
});

test('OneBot 配置：磁盘 vs 运行中对照（白名单立刻生效、地址要重连）', () => {
  const running = (over: Partial<OneBotConfigView> = {}): OneBotConfigView => ({
    apiBase: 'ws://127.0.0.1:3001', hasToken: false, allowedCommands: ['创建'],
    handled: 0, filteredByWhitelist: 0,
    transport: 'websocket', url: 'ws://127.0.0.1:3001', pendingReconnect: [],
    ...over,
  });
  const disk = { ONEBOT_WS_URL: 'ws://127.0.0.1:3001', ONEBOT_ALLOWED_COMMANDS: '创建' };
  const rows = compareOneBot(disk, running());
  const by = (k: string) => rows.find((r) => r.key === k)!;
  assert.equal(by('ONEBOT_WS_URL').same, true);
  assert.equal(by('ONEBOT_WS_URL').needsReconnect, true, '地址改了要重连协议端');
  assert.equal(by('ONEBOT_ALLOWED_COMMANDS').needsReconnect, false, '白名单每条消息都读，立刻生效');
  assert.equal(by('ONEBOT_ALLOWED_COMMANDS').same, true);

  // 进程里其实是全放行，而磁盘上写了白名单 —— 必须标成「不一样」
  const mismatch = compareOneBot(disk, running({ allowedCommands: [] }));
  assert.equal(mismatch.find((r) => r.key === 'ONEBOT_ALLOWED_COMMANDS')!.same, false);
  // HTTP 上报模式下没有「协议端地址」，要如实说出来（而不是显示一个空的地址）
  // 这个 case 要模拟「.env 全没写、进程全用默认」—— 所以白名单也得是全放行
  const http = compareOneBot({}, running({
    transport: 'http', url: 'http://127.0.0.1:3000', apiBase: 'http://127.0.0.1:3000',
    allowedCommands: [],
  }));
  assert.match(http.find((r) => r.key === 'ONEBOT_WS_URL')!.running, /HTTP 上报模式/);

  /*
   * ⚠️ 假的「不一样」和真的「不一样」一样有害 —— 它让人去查一个不存在的不一致。
   * 这三行在真机截图里就误报过（字面不同、语义相同）。
   */
  assert.equal(http.find((r) => r.key === 'ONEBOT_WS_URL')!.same, true,
    '「.env 没写」+「进程走 HTTP 上报」= 一致');
  assert.equal(http.find((r) => r.key === 'ONEBOT_API_BASE')!.same, true,
    '「.env 没写」+「进程用默认基址」= 一致');
  assert.equal(http.find((r) => r.key === 'ONEBOT_ALLOWED_COMMANDS')!.same, true,
    '「.env 没写」+「进程全放行」= 一致');
});

test('OneBot 白名单：挡住没放行的指令，放行自由文本，并留下计数', async () => {
  const adapter = new OneBotAdapter({ apiBase: 'http://127.0.0.1:3000', allowedCommands: ['创建'] });
  const got: string[] = [];
  adapter.onMessage((m) => { got.push(m.rawText); });
  const ev = (text: string) => ({
    post_type: 'message', message_type: 'group', group_id: '1', user_id: '2',
    message_id: '3', raw_message: text, time: 1,
  });

  await adapter.handleEvent(ev('.创建 甲'));     // 在白名单里 → 放行
  await adapter.handleEvent(ev('.状态'));        // 不在 → 挡住
  await adapter.handleEvent(ev('我看看四周'));    // 不是指令 → 放行（灰度只针对显式指令）
  await adapter.handleEvent(ev('2'));           // 数字回复 → 放行

  assert.deepEqual(got, ['.创建 甲', '我看看四周', '2']);
  assert.equal(adapter.filteredByWhitelist, 1, '挡下的条数要留下 —— 它和「机器人坏了」是两回事');
  assert.equal(adapter.handled, 3);

  // 空白名单 = 全放行（老行为不变：不配这个开关就什么都不挡）
  const open = new OneBotAdapter({ apiBase: 'http://x' });
  open.onMessage(() => {});
  await open.handleEvent(ev('.状态'));
  assert.equal(open.handled, 1);
  assert.equal(open.filteredByWhitelist, 0);

  // 热改：白名单立刻生效
  assert.deepEqual(adapter.reconfigure({ allowedCommands: ['*'] }).applied, ['allowedCommands']);
  await adapter.handleEvent(ev('.状态'));
  assert.equal(adapter.handled, 4, '改成全放行之后 .状态 要能进来');
  // 地址属于「要重连才生效」
  const rec = adapter.reconfigure({ apiBase: 'ws://new' });
  assert.deepEqual(rec.needsReconnect, ['apiBase']);
  assert.equal(adapter.runtimeStatus().apiBase, 'ws://new');
  assert.deepEqual([...adapter.pendingReconnect], ['apiBase']);
  adapter.clearPendingReconnect();
  assert.deepEqual([...adapter.pendingReconnect], []);
});

test('后台页面：OneBot 子页有配置区与保存按钮，且与 QQ 共用同一套渲染', async () => {
  const { adminPage } = await import('../src/admin/page.ts');
  const html = adminPage();
  for (const id of ['adObDiff', 'adObWsUrl', 'adObToken', 'adObCmdsText', 'adObSave']) {
    assert.ok(html.includes('id="' + id + '"'), '缺少 #' + id);
  }
  const js = readFileSync('src/admin/adapter.js', 'utf8');
  assert.ok(js.includes("channel: 'onebot'"), '保存时要带 channel=onebot（服务端据此分支）');
  assert.ok(js.includes('function adRenderDiffTable'), '对照表要参数化 —— 两页共用一份渲染');
  assert.ok(js.includes('function adFillOnebotForm'), 'OneBot 表单要回填（否则界面值与进程值不一致）');
  // 服务端：保存路由要认这个分支
  const routes = readFileSync('src/admin/index.ts', 'utf8');
  assert.ok(routes.includes("b.channel === 'onebot'"), 'POST /adapter 要有 OneBot 分支');
  assert.ok(routes.includes('onebotDiff'), 'live 要返回 OneBot 的对照表');
});

test('协议端引导：页面有检测入口，接口只给官方仓库', async () => {
  const { adminPage } = await import('../src/admin/page.ts');
  const html = adminPage();
  for (const id of ['adObDetect', 'adObEnv']) assert.ok(html.includes('id="' + id + '"'), '缺少 #' + id);
  const js = readFileSync('src/admin/adapter.js', 'utf8');
  assert.ok(js.includes('function adRenderEnv'), '缺少检测结果渲染');
  assert.ok(js.includes("api('/adapter/env')"), '要真的去打检测接口');
  const routes = readFileSync('src/admin/index.ts', 'utf8');
  assert.ok(routes.includes("'/admin/api/adapter/env'"), '服务端要有检测路由');
  assert.ok(routes.includes('tasklist'), '检测要走进程列表（实测，而不是猜路径）');
  // ⚠️ 只许给官方仓库 —— 让用户去下第三方打包的 QQ 协议端是最不该做的事
  assert.ok(routes.includes('github.com/NapNeko/NapCatQQ'));
  assert.ok(routes.includes('github.com/LagrangeDev/Lagrange.Core'));
  assert.ok(!/pan\.|lanzou|baidu\.com\/s\//.test(routes), '不许出现网盘/第三方转载链接');
});
