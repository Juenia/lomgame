/**
 * **QQ 官方通道的单聊（C2C）**（M2.92）。
 *
 * 用户实测：「QQ 官方适配器，私聊发送 .状态，没有任何反应」。
 *
 * 根因是**一个字段取错了**：C2C 事件的发信人写在 `author.user_openid`，
 * 而映射取的是 `member_openid ?? union_openid ?? id` —— 单聊事件里根本没有 member_openid。
 * 于是（payload 也没带 union_openid / id 时）userId 是空串 ⇒ 映射返回 null
 * ⇒ **消息在适配器层就被丢掉**：不报错、不打日志、玩家看到的就是「没有任何反应」。
 *
 * 这份测试守三件事：
 *   ① C2C payload 真的能映射出消息（原来这里是 null）；
 *   ② **同一个人在群聊与单聊里是同一个玩家**——身份键都取 union_openid。
 *      取 member_openid 的话，群里建的角色到私聊就找不到了；
 *   ③ 回复真的发到 `/v2/users/{user_openid}/messages`——
 *      **发信地址（user_openid）与身份（union_openid）是两件事**，不能混。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_BASE_PROD, type GatewayStats } from '../src/adapter/qq-official/gateway.ts';
import { QQOfficialAdapter, mapQQC2CMessage, mapQQGroupAtMessage } from '../src/adapter/qq-official/index.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function emptyStats(): GatewayStats {
  return {
    hellos: 0, identifies: 0, resumes: 0, heartbeats: 0, heartbeatAcks: 0,
    dispatches: 0, reconnects: 0, lastError: null, lastClose: null, fatalStops: 0,
    resumedFromDisk: false, quotaBlocked: 0,
  };
}

/** 假官方 API：换 token 一律成功，其余路由按捕获列表返回 */
function fakeApi(captured: string[]): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    captured.push(url);
    if (/getAppAccessToken/.test(url)) {
      return jsonResponse({ access_token: 'tk-0123456789abcdef', expires_in: '7200' });
    }
    return jsonResponse({ id: 'msg-sent', timestamp: Date.now() });
  }) as unknown as typeof fetch;
}

function makeAdapter(captured: string[]): QQOfficialAdapter {
  return new QQOfficialAdapter(
    { appId: '1020', clientSecret: 's', apiBase: API_BASE_PROD } as never,
    {
      fetch: fakeApi(captured),
      gateway: { stats: emptyStats(), ready: true, async connect() {}, close() {}, async waitReady() {} } as never,
    },
  );
}

test('M2.92 C2C 映射：真机 payload 取得到人（改之前这里是 null）', () => {
  /*
   * 真机 C2C_MESSAGE_CREATE 的人写在 `author.user_openid`，
   * 同时可能带 `union_openid`（同一开发者主体下唯一）。
   */
  const msg = mapQQC2CMessage({
    id: 'c1', content: '.状态',
    author: { user_openid: 'UO', union_openid: 'UN', username: '克莱恩' },
    timestamp: Date.now(),
  });
  assert.ok(msg, 'C2C 事件必须能映射出消息 —— 返回 null 就是「没有任何反应」');
  assert.equal(msg!.scene, 'private');
  assert.equal(msg!.userId, 'UN', '身份键取 union_openid（跨群与私聊一致）');
  assert.equal(msg!.sceneId, 'UO', '发信地址取 user_openid（官方接口认它）');
  assert.equal(msg!.rawText, '.状态');

  // 只带 user_openid（没有 union）也要能认出人来 —— 不能因此丢消息
  const only = mapQQC2CMessage({ id: 'c2', content: '.状态', author: { user_openid: 'UO2' }, timestamp: Date.now() });
  assert.ok(only, '只有 user_openid 时也要能映射');
  assert.equal(only!.userId, 'UO2');
  assert.equal(only!.sceneId, 'UO2');

  // 没有 author 的畸形 payload：返回 null，但**不许抛**
  assert.equal(mapQQC2CMessage({ id: 'c3', content: '.状态' }), null);
  assert.equal(mapQQC2CMessage({}), null);
});

test('M2.92 同一个人在群聊与单聊里是同一个玩家（身份键统一取 union_openid）', () => {
  /*
   * 这是这一批改动里**最容易漏**的一条：
   *   · 群里的事件给的是 `member_openid`（同一个人换个群就换一个 id）
   *   · 单聊的事件给的是 `user_openid`
   * 两边各取各的，玩家在群里建的角色，私聊里就找不到 ——
   * 表现是「私聊发 .状态 回你还没有角色」，而人明明刚在群里创建过。
   *
   * `union_openid` 在同一开发者主体下唯一 ⇒ 两边都用它，才是同一个人。
   */
  const inGroup = mapQQGroupAtMessage({
    id: 'g1', group_openid: 'G1', content: '.状态',
    author: { member_openid: 'M1', union_openid: 'UN', username: '克莱恩' },
    timestamp: Date.now(),
  });
  const inPrivate = mapQQC2CMessage({
    id: 'c1', content: '.状态',
    author: { user_openid: 'UO', union_openid: 'UN', username: '克莱恩' },
    timestamp: Date.now(),
  });
  assert.ok(inGroup && inPrivate);
  assert.equal(inGroup!.userId, inPrivate!.userId, '同一个人在两个场景必须是同一个 userId');
  assert.equal(inGroup!.sceneId, 'G1', '群聊的发信地址仍然是 group_openid');

  // 老 payload（只有 member_openid）行为不变 —— 既有测试与既有数据都建立在这上面
  const legacy = mapQQGroupAtMessage({
    id: 'g2', group_openid: 'G1', content: '.状态',
    author: { member_openid: 'M1', username: '甲' }, timestamp: Date.now(),
  });
  assert.equal(legacy!.userId, 'M1', '没有 union_openid 时退回 member_openid');
});

test('M2.92 端到端：私聊回复发到 /v2/users/{user_openid}/messages', async () => {
  const captured: string[] = [];
  const adapter = makeAdapter(captured);
  const msg = await adapter.handleDispatch('C2C_MESSAGE_CREATE', {
    id: 'c9', content: '.状态',
    author: { user_openid: 'UO9', union_openid: 'UN9', username: '克莱恩' },
    timestamp: Date.now(),
  });
  assert.ok(msg, '私聊事件必须被适配器接住');

  // 路由就是拿 sceneId 当 targetId 发的（router: targetId = msg.scene === private ? msg.userId : msg.sceneId）
  await adapter.sendPrivate(msg!.sceneId, '你还没有角色。');
  const sent = captured.filter((u) => u.includes('/messages'));
  assert.equal(sent.length, 1, '应当只发一条：' + sent.join('、'));
  assert.match(sent[0]!, /\/v2\/users\/UO9\/messages/, '私聊必须发到 user_openid 那一路：' + sent[0]);
  assert.equal(adapter.stats.repliesSent, 1);
});
