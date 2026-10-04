/**
 * **QQ 官方通道：私聊「只收到消息、没有任何响应」的第二次修复（M2.99）**
 *
 * 现场（用户真机日志，2026-10-02 16:17）：
 *
 * ```
 * INFO  收到事件 {"t":"C2C_MESSAGE_CREATE","s":2}
 * （然后什么都没有 —— 没有报错、没有「消息已发出」）
 * ```
 *
 * 玩家私聊发 `.状态` / `.探索` 全部无响应，群里一切正常。
 *
 * 根因：真机 C2C payload 里 `author.union_openid` 是**空串**，
 * 而 M2.92 把取值写成了 `union_openid ?? member_openid ?? user_openid` ——
 * `??` 只跳过 `null`/`undefined`，遇到 `""` 就停下 ⇒ userId 是空串 ⇒
 * `mapQQC2CMessage` 返回 null ⇒ 消息在适配器层被丢掉，**不报错、不打日志**。
 *
 * 这份测试守六件事：
 *   ① 真机形状（`union_openid` 为空串）必须能映射出私聊消息；
 *   ② 群里出现同一形状时也不许丢（同一个坑的另一半）；
 *   ③ 私聊与群消息**映射失败都必须留下日志** —— 静默失败比报错贵得多（M2.44 的教训）；
 *   ④ 私聊的「身份键」与「发信地址」不同时，回复仍要发到 `user_openid` 那一路；
 *   ⑤ 协议层（按钮互动事件）的取值链同样要跳过空串；
 *   ⑥ `firstNonEmpty` 的边界：跳过空串、全空才回空串、顺序即优先级。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_BASE_PROD, type GatewayStats } from '../src/adapter/qq-official/gateway.ts';
import {
  QQOfficialAdapter,
  firstNonEmpty,
  mapQQC2CMessage,
  mapQQGroupAtMessage,
} from '../src/adapter/qq-official/index.ts';
import { mapOfficialInteraction } from '../src/adapter/official.ts';
import type { InternalMessage } from '../src/adapter/types.ts';
import type { Logger } from '../src/infra/logger.ts';

/**
 * 真机 C2C payload（照抄日志，只截短了 msg id）。
 *
 * ⚠️ 关键就一个字段：`union_openid: ''` —— **字段在、值为空**。
 * 第一版测试只造了「union 有值」和「union 字段不存在」两种 payload，
 * 于是这个形状在测试里从没出现过，而它才是真机。
 */
const REAL_C2C = {
  id: 'ROBOT1.0_7e85OBsJmCYi1OIe1Q1gb2AzJmkt',
  content: '.状态',
  author: {
    bot: false,
    id: '7A347424BB7C5F38142714E1A0E3E2CA',
    union_openid: '',
    user_openid: '7A347424BB7C5F38142714E1A0E3E2CA',
    username: '',
  },
  timestamp: '2026-10-02T16:17:41+08:00',
};

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

function makeAdapter(captured: string[], logger?: Logger): QQOfficialAdapter {
  return new QQOfficialAdapter(
    { appId: '1020', clientSecret: 's', apiBase: API_BASE_PROD, ...(logger ? { logger } : {}) } as never,
    {
      fetch: fakeApi(captured),
      gateway: { stats: emptyStats(), ready: true, async connect() {}, close() {}, async waitReady() {} } as never,
    },
  );
}

test('M2.99 真机形状：union_openid 是空串，私聊消息也必须映射出来', () => {
  const msg = mapQQC2CMessage(REAL_C2C as never);
  assert.ok(msg, '空串 union_openid 不能把私聊消息吃掉 —— 这就是「发什么都没反应」的根因');
  assert.equal(msg!.scene, 'private');
  assert.equal(msg!.userId, '7A347424BB7C5F38142714E1A0E3E2CA', '空串要被跳过，退回 user_openid 当身份');
  assert.equal(msg!.sceneId, '7A347424BB7C5F38142714E1A0E3E2CA', '发信地址取 user_openid');
  assert.equal(msg!.rawText, '.状态');

  // 三个 openid 全空（畸形 payload）仍然返回 null —— 放宽的是「空串截断」，不是「谁都能进」
  assert.equal(
    mapQQC2CMessage({ id: 'c', content: '.状态', author: { user_openid: '', union_openid: '', id: '' } } as never),
    null,
  );
});

test('M2.99 群消息出现同一形状（union_openid 空串）时也不许丢', () => {
  const inGroup = mapQQGroupAtMessage({
    id: 'g1', group_openid: 'G1', content: '.状态',
    author: { member_openid: 'M1', union_openid: '', username: '甲' }, timestamp: Date.now(),
  } as never);
  assert.ok(inGroup, '群里带了空的 union_openid 时同样会被 ?? 链截断 —— 这是同一个坑的另一半');
  assert.equal(inGroup!.userId, 'M1', '空串要跳过，退回 member_openid');
  assert.equal(inGroup!.sceneId, 'G1');
});

test('M2.99 firstNonEmpty：跳过空串，全空才返回空串', () => {
  assert.equal(firstNonEmpty(undefined, '', 'UO'), 'UO');
  assert.equal(firstNonEmpty('', ''), '');
  assert.equal(firstNonEmpty(undefined, undefined), '');
  assert.equal(firstNonEmpty('UN', 'UO'), 'UN', '顺序即优先级');
});

test('M2.99 端到端：真机那条 .状态 会被消费，回复发到 user_openid 那一路', async () => {
  const captured: string[] = [];
  const adapter = makeAdapter(captured);
  const received: InternalMessage[] = [];
  adapter.onMessage(async (m) => {
    received.push(m);
  });

  const msg = await adapter.handleDispatch('C2C_MESSAGE_CREATE', REAL_C2C);
  assert.ok(msg, '适配器必须接住真机那条私聊消息');
  assert.equal(received.length, 1, '接住之后必须真的交给业务层 —— 只映射不消费同样是「没反应」');

  // 路由层私聊就是拿 msg.userId 当 targetId 发的（src/router/index.ts:1147）
  await adapter.sendPrivate(msg!.userId, '你还没有角色，发送 .创建 开始。');
  const sent = captured.filter((u) => u.includes('/messages'));
  assert.equal(sent.length, 1, '应当只发一条：' + sent.join('、'));
  assert.match(sent[0]!, /\/v2\/users\/7A347424BB7C5F38142714E1A0E3E2CA\/messages/, '私聊回复必须发到 user_openid：' + sent[0]);
  assert.equal(adapter.stats.repliesRefused, 0, '票据必须命中（命中失败会抛 NoReplyTicketError）');
  assert.equal(adapter.stats.repliesSent, 1);
});

test('M2.99 union_openid 有值时：路由传身份键，回复仍发到 user_openid', async () => {
  const captured: string[] = [];
  const adapter = makeAdapter(captured);
  const received: InternalMessage[] = [];
  adapter.onMessage(async (m) => {
    received.push(m);
  });

  const msg = await adapter.handleDispatch('C2C_MESSAGE_CREATE', {
    ...REAL_C2C, author: { ...REAL_C2C.author, union_openid: 'UN-OF-SAME-PERSON' },
  });
  assert.ok(msg);
  assert.equal(msg!.userId, 'UN-OF-SAME-PERSON', '身份键取 union_openid（跨群与私聊同一个人）');
  assert.equal(msg!.sceneId, '7A347424BB7C5F38142714E1A0E3E2CA', '发信地址仍然是 user_openid');

  /*
   * 路由层不知道两个 openid 的区别，它照旧传 userId（身份）。
   * 适配器必须自己换算成地址 —— 否则：票据查不到、URL 也是错的（平台 404）。
   */
  await adapter.sendPrivate(msg!.userId, '正文');
  const sent = captured.filter((u) => u.includes('/messages'));
  assert.equal(sent.length, 1, '应当只发一条：' + sent.join('、'));
  assert.match(sent[0]!, /\/v2\/users\/7A347424BB7C5F38142714E1A0E3E2CA\/messages/, '必须换算成 user_openid：' + sent[0]);
  assert.ok(!sent[0]!.includes('UN-OF-SAME-PERSON'), '不许把身份键当发信地址：' + sent[0]);
  assert.equal(adapter.stats.repliesRefused, 0, '换算之后票据也必须命中');
});

test('M2.99 私聊映射失败必须留日志（不许再静默）', async () => {
  const captured: string[] = [];
  const lines: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const logger: Logger = {
    info: (message, meta) => lines.push({ message, ...(meta ? { meta } : {}) }),
    warn: () => undefined,
    error: () => undefined,
  };
  const adapter = makeAdapter(captured, logger);

  // 没有 author 的畸形 payload：映射必然失败
  const msg = await adapter.handleDispatch('C2C_MESSAGE_CREATE', { id: 'c-bad', content: '.状态' });
  assert.equal(msg, null);
  const line = lines.find((l) => l.message === '收到私聊消息');
  assert.ok(line, '映射失败时必须有「收到私聊消息」这一行，否则下次又要靠猜：' + JSON.stringify(lines));
  assert.equal(line!.meta?.mapped, false, 'mapped 字段要明确写出「没映射出来」');
});

test('M2.99 群消息映射失败也要留痕（不许再静默）', async () => {
  const captured: string[] = [];
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const logger: Logger = {
    info: () => undefined,
    warn: (message, meta) => warnings.push({ message, ...(meta ? { meta } : {}) }),
    error: () => undefined,
  };
  const adapter = makeAdapter(captured, logger);

  // 缺 group_openid 的群消息：映射必然失败
  const msg = await adapter.handleDispatch('GROUP_AT_MESSAGE_CREATE', {
    id: 'g-bad', content: '.状态', author: { member_openid: 'M1' },
  });
  assert.equal(msg, null);
  const line = warnings.find((w) => w.message === '群消息映射失败（消息被丢弃）');
  assert.ok(line, '群消息映射失败时必须有 warn，否则同样是静默丢弃：' + JSON.stringify(warnings));
  assert.equal(line!.meta?.groupOpenid, '', '把取到的字段一并记下来，排查时不用再猜');
});

test('M2.99 同一坑的另一半：协议层的互动事件也要跳过空串', () => {
  /*
   * `resolved.user_id ?? … ?? group_member_openid` 里，若 `user_id` 是**空串**，
   * 后面的群成员 id 永远轮不到 —— 表现是「点了按钮没反应」，
   * 与私聊静默同一个根因（真机 payload 里 union_openid 就是空串，官方确实会给空串）。
   *
   * 注意既有用例不受影响：`user_id` 有值时仍然优先（m2-7 那条真机群聊用例）。
   */
  const msg = mapOfficialInteraction({
    t: 'INTERACTION_CREATE',
    d: {
      id: 'evt-empty-user',
      type: 11,
      group_openid: 'G1',
      group_member_openid: 'M-REAL',
      data: { type: 11, resolved: { button_data: '3', user_id: '' } },
    },
  });
  assert.ok(msg, '空串 user_id 不能把按钮点击吃掉');
  assert.equal(msg!.userId, 'M-REAL', '空串要跳过，继续找群成员 openid');
  assert.equal(msg!.rawText, '3');
  assert.equal(msg!.sceneId, 'G1');
});
