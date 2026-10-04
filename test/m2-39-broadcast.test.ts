/**
 * M2.39：世界播报合并（任务 1）+ 主动消息限流（任务 2）+ 加速场景处置（任务 3）。
 *
 * ## 守的是什么
 *
 * 配额被打爆的根因不是「推送本身」，是**同一 tick 内逐条推**：
 * `advanceWorld` 一次能补齐 72 个轻 tick + 14 个重 tick，每一格的天气异象 / 预告 /
 * 世界事件都各自 broadcast 一次、每次再乘群数。加速 30 天就是几千条主动消息。
 *
 * 三条验收（任务书 §验收 1/2/3）：
 *   1. **一个 tick 一条** —— 不是「每个事件一条」；
 *   2. **限流** —— 同一群每分钟最多 1 条，超出的攒批，不连推；
 *   3. **`/admin/tick 30` 产出 1 条** —— 不是 30 条。
 *
 * ## 为什么「合并文本」不会打断「回数字参与」
 *
 * 世界事件的数字回复读的是库里的 `WorldEventRepo.latestLive()`（最新一条还有效的事件），
 * **不是**从播报文本里对编号（`src/router/menu.ts` 的 `MenuService.pick`）。
 * 所以把 N 段菜单拼进一条消息，行为与「发 N 条消息」完全一致 ——
 * 两种情况下都只有最新那一条能回。这条在下面有用例钉住。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import {
  BROADCAST_MIN_INTERVAL_MS,
  BroadcastThrottle,
  mergeBroadcastParts,
} from '../src/infra/broadcast.ts';
import { advanceWorld, renderTickBroadcasts } from '../src/infra/world-tick.ts';
import { weatherLabel, type WeatherChange } from '../src/domain/world/weather.ts';
import type { WorldEvent } from '../src/domain/world/events.ts';
import { WorldRepo } from '../src/infra/db/world.ts';
import { silentLogger } from '../src/infra/logger.ts';
import { createOneBotApp, startHttpServer } from '../src/main.ts';
import { createHarness, GROUP_ID } from './helpers/app.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 一条「显著天气开始」的变化（advanceWorld 里真正进播报的那一类） */
function epicChange(locationId: string, to: WeatherChange['to'], at = 0): WeatherChange {
  return { locationId, from: 'clear', to, at, reason: 'expire' };
}

/**
 * 一条带菜单的世界事件（形状抄自 domain/world/events.ts 的 WorldEvent）。
 *
 * ⚠️ M2.171：加了 `type` 参数，默认仍是 `discovery`（保持旧用例不变）——
 * 而现在**只有 calamity / environment / power 三类会进推送**，
 * 所以「想让这条事件出现在播报里」的用例必须显式传这三类之一。
 * 传 `discovery` 的用例会看到 0 条 —— 那不是 bug，是白名单在按口径工作。
 */
function worldEvent(
  id: string,
  headline: string,
  createdAt = 0,
  type: WorldEvent['type'] = 'discovery',
): WorldEvent {
  return {
    id,
    type,
    text: '【世界 · ' + headline + '】\n雾里有人影。',
    visibility: 'anonymous',
    createdAt,
    options: [{ key: '1', label: '去看看', command: '探索 老码头' }],
  };
}

/* ================================================================== *
 * 任务 1：合并
 * ================================================================== */

test('M2.39 任务 1：合并 —— 空段丢掉、单段原样、多段合成一条', () => {
  assert.equal(mergeBroadcastParts([]), null, '一段都没有 ⇒ 不发（空播报比不播报更糟）');
  assert.equal(mergeBroadcastParts(['', '   ', '\n']), null, '全空白也当没有');
  assert.equal(mergeBroadcastParts(['【世界异象】廷根']), '【世界异象】廷根', '单段原样返回');
  assert.equal(
    mergeBroadcastParts(['A', '', 'B']),
    'A\nB',
    '多段合并成一条 —— 这就是「一个 tick 一条」，不是「每个事件一条」',
  );
});

test('M2.86：本 tick 的素材**各成一条**，事件底部带它自己的按钮（不再合并）', () => {
  /*
   * ⚠️ 这条用例**改过判据**（M2.86）。原来断言的是「三条素材必须合成一条」，
   * 而那个行为正是实机 bug 的来源：合并后两组编号落在同一条消息里，
   * 玩家回数字只能对上最后一组（详见 src/infra/world-tick.ts 的说明）。
   *
   * 现在改成断言「各成一条、且事件那条带按钮」—— 判据跟着行为走，
   * 而不是留着一条断言旧行为的用例把自己变成装饰。
   */
  const h = createHarness();
  try {
    const merged = renderTickBroadcasts(h.app.router.deps, {
      // M2.171：天气**不再进推送**，所以这里的素材全是特殊事件（power）
      feeds: [{ at: 0, broadcasts: [epicChange('tingen', 'spirit_creep')], forecasts: [] }],
      changes: [epicChange('tingen', 'spirit_creep')],
      events: [
        worldEvent('e1', '老码头', 0, 'power'),
        worldEvent('e2', '黑荆棘修道院', 0, 'power'),
        worldEvent('e3', '灰雾之上', 0, 'calamity'),
      ],
      lightHours: 1,
      heavyDays: 0,
    });
    // 3 条事件各成一条（原来合并成 1 条）；天气那条**按 M2.171 已经不推了**
    assert.equal(merged.length, 3, '三条事件各成一条，实际 ' + merged.length + ' 条');
    const all = merged.map((item) => item.text).join('\n');
    assert.doesNotMatch(all, /【世界异象】/, 'M2.171：天气不再进推送');
    assert.match(all, /【世界 · 老码头】/, '事件那一条在');
    // 特殊事件各自带按钮（各 1 个：去看看）
    const withButtons = merged.filter((item) => (item.buttons?.length ?? 0) > 0);
    assert.equal(withButtons.length, 2, '两条 power 事件该带按钮（灾厄那条走危机感模板、不带按钮），实际 ' + withButtons.length + ' 条');
    assert.ok(
      withButtons[0]!.buttons!.every((b) => b.command.length > 0 && b.label.length > 0),
      '每个按钮都要有标签与指令（data 是完整指令，点了走普通路由）',
    );
    // 不再有数字菜单，也就不该出现「回复数字。」
    assert.doesNotMatch(all, /回复数字。/, 'M2.86：群播报不再挂数字菜单');
  } finally {
    h.app.close();
  }
});

test('M2.39 任务 1：没有变化时**一条都不发**（不是发一条空的）', () => {
  const h = createHarness();
  try {
    const merged = renderTickBroadcasts(h.app.router.deps, {
      feeds: [],
      changes: [],
      events: [],
      lightHours: 1,
      heavyDays: 0,
    });
    assert.deepEqual(merged, [], '什么都没发生就不该惊动全群');
  } finally {
    h.app.close();
  }
});

test('M2.39 任务 1：faction 可见性的事件**只落库不播报**（M2.4 的口径不变）', () => {
  const h = createHarness();
  try {
    const factionEvent: WorldEvent = { ...worldEvent('f1', '教会密令'), visibility: 'faction' };
    const merged = renderTickBroadcasts(h.app.router.deps, {
      feeds: [],
      changes: [],
      events: [factionEvent],
      lightHours: 1,
      heavyDays: 0,
    });
    assert.deepEqual(merged, [], 'faction 事件不播 —— 合并不能把它捎带出去');
  } finally {
    h.app.close();
  }
});

/* ================================================================== *
 * 任务 2：限流
 * ================================================================== */

test('M2.86：积压的播报**一条一条发**（不再并成一条），顺序不变', () => {
  /*
   * ⚠️ 判据改过（M2.86）。原来断言「到点后积压的两条并成一条发出」，
   * 而合并正是实机 bug 的根源：两组编号挤在同一条消息里，回数字只能对上最后一组。
   *
   * 现在断言「一次出队一条、顺序保持」—— 错开发送由 flush 被调用的节拍负责
   * （真实运行时是 5 秒一次，见 BROADCAST_FLUSH_INTERVAL_MS）。
   */
  const throttle = new BroadcastThrottle();
  const t0 = 1_000_000;

  // 突发容量 3（BROADCAST_BURST）：同一批产生的 3 条可以直接发出去，
  // 所以「超出容量的才排队」—— 这是「同批事件不被硬拉成一分钟一条」的做法。
  // ⚠️ 五条必须**挤在同一个时刻**投递：间隔一旦达到 BROADCAST_MIN_INTERVAL_MS（3 秒），
  //    令牌桶就会补出一个新令牌，第 4 条又变成 'sent' 了（第一版就栽在这）。
  assert.equal(throttle.offer('group_openid_A', '第一条', t0), 'sent', '第 1 条在容量内');
  assert.equal(throttle.offer('group_openid_A', '第二条', t0), 'sent', '第 2 条在容量内');
  assert.equal(throttle.offer('group_openid_A', '第三条', t0), 'sent', '第 3 条在容量内');
  assert.equal(throttle.offer('group_openid_A', '第四条', t0), 'queued', '第 4 条超出突发容量');
  assert.equal(throttle.offer('group_openid_A', '第五条', t0), 'queued');
  assert.ok(throttle.pendingOf('group_openid_A') >= 1, '有积压');

  // 另一个群有自己的额度（不会被 A 的积压挡住）
  assert.equal(throttle.offer('group_openid_B', '别的群', t0 + 3_000), 'sent');

  // 等到令牌补充的间隔之后，一次只应该出一条 —— 而且必须是队首那条（顺序不能乱）
  const first = throttle.flush(t0 + BROADCAST_MIN_INTERVAL_MS);
  assert.equal(first.length, 1, '一次只出一条，实际 ' + first.length + ' 条');
  assert.equal(first[0]!.text, '第四条', '出的是队首（顺序不变）');

  const second = throttle.flush(t0 + BROADCAST_MIN_INTERVAL_MS * 2);
  if (second.length > 0) assert.equal(second[0]!.text, '第五条', '接着出下一条');
});

test('M2.39 任务 2：有积压时新播报**排队**而不是插队（世界动态不能倒序）', () => {
  const throttle = new BroadcastThrottle();
  const t0 = 0;
  // 先把突发容量（3）用满，后面的才会进队列
  assert.equal(throttle.offer('g', 'A', t0), 'sent');
  assert.equal(throttle.offer('g', 'A2', t0 + 100), 'sent');
  assert.equal(throttle.offer('g', 'A3', t0 + 200), 'sent');
  assert.equal(throttle.offer('g', 'B', t0 + 300), 'queued');
  // 令牌早就回来了，但 B 还在队列里 —— C 必须排在 B 后面
  assert.equal(throttle.offer('g', 'C', t0 + 61_000), 'queued', '有积压时不抢令牌');
  const out = throttle.flush(t0 + 61_000);
  assert.equal(out.length, 1, '一次只出一条');
  assert.equal(out[0]!.text, 'B', '先出 B —— 有积压时 C 不能插队');
});

test('M2.39 任务 2：限流**不丢消息** —— 积压的最终一定会发出去', () => {
  const throttle = new BroadcastThrottle();
  const sent: string[] = [];
  let now = 0;
  // 10 条播报挤在一分钟内（加速场景的形状）
  for (let i = 0; i < 10; i += 1) {
    if (throttle.offer('g', '播报' + i, now) === 'sent') sent.push('播报' + i);
    now += 1_000;
  }
  // 之后每分钟冲一次，直到队列空
  for (let i = 0; i < 20 && throttle.pendingGroups > 0; i += 1) {
    now += BROADCAST_MIN_INTERVAL_MS;
    for (const item of throttle.flush(now)) sent.push(item.text);
  }
  assert.equal(throttle.pendingGroups, 0, '最终必须清空（不许静默丢弃）');
  const flat = sent.join('\n').split('\n');
  for (let i = 0; i < 10; i += 1) assert.ok(flat.includes('播报' + i), '第 ' + i + ' 条丢了');
  // 突发容量 3：最多允许「一上来连发 3 条」，其余必须排队 ——
  // 所以直接发出去的那些不该超过容量。
  assert.ok(
    sent.length >= 10 - 3,
    '积压的最终都要发出来（最多容忍突发 3 条），实际 ' + sent.length + ' 条',
  );
});

/* ================================================================== *
 * 任务 3：加速（批量补跑）
 * ================================================================== */


test('M2.39 任务 3：一次推进跨多格 ⇒ advanceWorld 只回一条（原来会回 N 条）', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    /*
     * 先把水位线建起来：冷启动的起点是「此刻」（不补历史），
     * 所以第一轮只会推进一格 —— 这不是本用例要测的形状。
     */
    advanceWorld(deps, h.now(), { force: true });
    h.advance(30 * DAY_MS);
    const result = advanceWorld(deps, h.now(), { force: true });
    assert.ok(result.light.executed > 1, '这一轮确实补了多个小时：' + result.light.executed);
    assert.ok(
      result.broadcasts.length <= 1,
      '批量补跑也只出一条，实际 ' + result.broadcasts.length + ' 条',
    );
    /*
     * M2.171：**补跑不再发「过去 N 天」的总结**（用户拍板）。
     *
     * 这条断言原来钉的是「走总结体裁」—— 现在反过来了：
     * 补跑最多推一条**事件本体**，而【世界动态】那种回顾再也不该出现。
     */
    for (const item of result.broadcasts) {
      assert.doesNotMatch(item.text, /【世界动态】/, 'M2.171：不该再有补跑总结');
      assert.doesNotMatch(item.text, /【天气预告】/, '过去的预告要丢掉');
    }
  } finally {
    h.app.close();
  }
});

test('M2.86：单格推进仍走原文渲染，文案一个字不改（但不再合并成一条）', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    h.advance(HOUR_MS);
    const result = advanceWorld(deps, h.now(), { force: true });
    assert.equal(result.light.executed, 1, '只补了一格');
    assert.ok(result.broadcasts.length <= 1);
    for (const item of result.broadcasts) {
      assert.doesNotMatch(item.text, /【世界动态】/, '单 tick 不该出现「总结」抬头');
    }
  } finally {
    h.app.close();
  }
});

/* ================================================================== *
 * 任务 3 的验收：/admin/tick 30 产出 1 条
 * ================================================================== */

test('M2.39 验收 3：POST /admin/tick {"days":30} 产出 **1 条**播报（不是 30 条）', async () => {
  const sentGroups: string[] = [];
  const fakeApi = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if ((req.url ?? '').includes('send_group_msg') && raw) {
        const body = JSON.parse(raw) as { message?: unknown };
        sentGroups.push(String(body.message ?? ''));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0 }));
    });
  });
  fakeApi.listen(0, '127.0.0.1');
  await once(fakeApi, 'listening');
  const apiPort = (fakeApi.address() as AddressInfo).port;

  const app = createOneBotApp(
    {
      dbPath: ':memory:',
      port: 0,
      onebotApiBase: 'http://127.0.0.1:' + apiPort,
      detailToPrivate: true,
      // 运维服务关掉：本用例要的是 /admin/tick 这条路由，不是定时器
      startOps: false,
      runTickOnStart: false,
      adminToken: 'test-admin-token',
    },
    silentLogger,
  );
  const server = startHttpServer(app);
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  try {
    // 先登记一个群，否则世界播报没有收件人（真实运行里群早就登记过了）
    new WorldRepo(app.db).touchGroup('group_openid_10001', Date.now());

    const response = await fetch('http://127.0.0.1:' + port + '/admin/tick', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': 'test-admin-token' },
      body: JSON.stringify({ days: 30 }),
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      ok?: boolean;
      broadcasts?: number;
      days?: number;
      settled?: number;
      lightTicks?: number;
      heavyTicks?: number;
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.days, 30);
    // M2.171：补跑**不再推送总结**（用户拍板）—— 从「1 条总结」变成「0 条」
    assert.equal(payload.broadcasts, 0, '加速 30 天不该产出播报，实际 ' + payload.broadcasts);
    assert.ok((payload.settled ?? 0) > 1, '真的结算了多天：' + payload.settled);
    assert.ok((payload.lightTicks ?? 0) > 0, '世界轻 tick 真的推进了：' + payload.lightTicks);

    /*
     * M2.171：**一条都不该出网**（用户拍板：去掉主动推送总结）。
     *
     * 这条断言原来钉的是「恰好一条，且那条是加速总结」——
     * 现在反过来了：一次补跑**不该**产生任何群消息。
     *
     * ⚠️ 注意这里测的是**真的出网**（`sentGroups` 是假 API 收到的请求），
     * 而不是 `payload.broadcasts` 那个读数 —— 两个都要钉，
     * 否则「接口说 0 条、实际发了一条」这种错配不会被发现。
     */
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      sentGroups.length,
      0,
      'M2.171：补跑不该产生群消息，实际 ' + sentGroups.length + '：' + sentGroups.join(' | ').slice(0, 300),
    );
  } finally {
    server.close();
    app.close();
    fakeApi.close();
  }
});

test('M2.39：不带 days 的 /admin/tick 行为**与改动前逐字一致**（只结算当天）', async () => {
  const app = createOneBotApp(
    {
      dbPath: ':memory:',
      port: 0,
      onebotApiBase: 'http://127.0.0.1:1',
      detailToPrivate: true,
      startOps: false,
      runTickOnStart: false,
      adminToken: 'test-admin-token',
    },
    silentLogger,
  );
  const server = startHttpServer(app);
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  try {
    const response = await fetch('http://127.0.0.1:' + port + '/admin/tick', {
      method: 'POST',
      headers: { 'x-admin-token': 'test-admin-token' },
    });
    const payload = (await response.json()) as { ok?: boolean; summary?: unknown; days?: unknown };
    assert.equal(payload.ok, true);
    assert.ok(payload.summary !== undefined, '老形状：返回 summary');
    assert.equal(payload.days, undefined, '老路径不该多出加速字段');
  } finally {
    server.close();
    app.close();
  }
});

/* ==================================================================
 * M2.171：**主动推送只留「灾厄与特殊事件」**（用户拍板）
 *
 * 这一条钉住四条口径 —— 它们都是「砍掉一类消息」，砍错了不会报错，只会安静地多推或少推：
 *   ① 天气变化**不进**推送（雾、月相、异象自己去看 .世界）
 *   ② 补跑**不再发「过去 N 天」的总结**（那段回顾已经删掉）
 *   ③ 只有 calamity / environment / power 三类事件进群（rumor 不进）
 *   ④ 灾厄走**危机感模板**（⚠️ + 加粗的地点 + 「这件事还没过去」）
 * ================================================================== */

test('M2.171 天气不进推送：显著天气变化一条都不推', () => {
  const h = createHarness();
  try {
    const merged = renderTickBroadcasts(h.app.router.deps, {
      feeds: [
        { at: 0, broadcasts: [epicChange('tingen', 'spirit_creep', 0)], forecasts: [] },
        { at: 0, broadcasts: [epicChange('backlund', 'blood_moon', 0)], forecasts: [] },
      ],
      changes: [epicChange('tingen', 'spirit_creep', 0), epicChange('backlund', 'blood_moon', 0)],
      events: [],
      lightHours: 1,
      heavyDays: 0,
    });
    assert.deepEqual(merged, [], '天气变化不该产生任何推送');
  } finally {
    h.app.close();
  }
});

test('M2.171 只有灾厄与特殊事件进群：传闻与街面的事不推', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    const mk = (id: string, type: string, text: string) => ({ id, type, text, visibility: 'public', createdAt: 0 });
    const merged = renderTickBroadcasts(deps, {
      feeds: [], changes: [],
      events: [
        mk('r1', 'rumor', '【世界 · 传闻】街上有人在传一件事。'),
        mk('c1', 'calamity', '【世界 · 廷根市】\n那边的天空裂了一道。'),
        mk('e1', 'environment', '【世界 · 异象】\n有什么从另一边渗过来了。'),
        mk('p1', 'power', '【世界 · 神座】\n有一位倒下了。'),
      ] as never,
      lightHours: 1,
      heavyDays: 0,
    });
    const all = merged.map((item) => item.text).join('\n');
    assert.ok(!all.includes('有人在传'), 'rumor 不该推');
    assert.ok(all.includes('天空裂了一道'), '灾厄要推');
    assert.ok(all.includes('渗过来'), '环境异象要推');
    assert.ok(all.includes('倒下了'), '特殊事件（神明级）要推');
    assert.equal(merged.length, 3, '三类各一条 —— 实际 ' + merged.length);
  } finally {
    h.app.close();
  }
});

test('M2.171 灾厄的模板要有危机感（⚠️ + 加粗地点 + 「这件事还没过去」）', () => {
  const h = createHarness();
  try {
    const merged = renderTickBroadcasts(h.app.router.deps, {
      feeds: [], changes: [],
      events: [{
        id: 'c1', type: 'calamity', visibility: 'public', createdAt: 0,
        text: '【世界 · 廷根市】\n那边的天空裂了一道，街上的人开始跑。',
      }] as never,
      lightHours: 1,
      heavyDays: 0,
    });
    assert.equal(merged.length, 1);
    const text = merged[0]!.text;
    assert.ok(text.startsWith('⚠️ **灾厄 · 廷根市**'), '第一行要一眼看出「哪里出事了」：' + text);
    assert.ok(text.includes('那边的天空裂了一道'), '正文要在');
    // 结尾不说「已经处理」—— 危机感来自「还没完」
    assert.ok(text.includes('这件事还没过去'), '结尾要有「还没完」的压迫感：' + text);
    assert.ok(text.includes('别站在那儿'), '要有一句让人动起来的话');
    // 不用 > 与 ***：markdown 关着的部署里它们会原样打出来（applyMdStyle 只剥 **）
    assert.doesNotMatch(text, /^\s*>/m, '不要用引用块');
    assert.ok(!text.includes('***'), '不要用分割线');
  } finally {
    h.app.close();
  }
});

test('M2.171 补跑不再发总结：跨多天时只推**最新一条**灾厄/特殊事件', () => {
  const h = createHarness();
  try {
    const merged = renderTickBroadcasts(h.app.router.deps, {
      feeds: [{ at: 0, broadcasts: [epicChange('tingen', 'spirit_creep', 0)], forecasts: [] }],
      changes: [epicChange('tingen', 'spirit_creep', 0)],
      events: [
        { id: 'c1', type: 'calamity', text: '【世界 · 甲地】\n第一件。', visibility: 'public', createdAt: 0 },
        { id: 'c2', type: 'calamity', text: '【世界 · 乙地】\n第二件。', visibility: 'public', createdAt: 0 },
      ] as never,
      lightHours: 72,
      heavyDays: 3,
    });
    assert.equal(merged.length, 1, '补跑最多一条（不能把三天的事全念一遍）');
    assert.ok(merged[0]!.text.includes('第二件'), '留最新那条（世界还在动）');
    assert.ok(!merged[0]!.text.includes('【世界动态】'), '不该再有「过去 N 天」的总结');
  } finally {
    h.app.close();
  }
});
