import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OneBotAdapter, mapOneBotEvent, type HttpPost } from '../src/adapter/onebot.ts';
import { NotImplementedError, OfficialAdapter, mapOfficialEvent } from '../src/adapter/official.ts';
import { MemoryAdapter } from '../src/adapter/memory.ts';
import type { InternalMessage } from '../src/adapter/types.ts';

const privateEvent = {
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  message_id: 12345,
  user_id: 20001,
  raw_message: '.状态',
  time: 1789000000,
  sender: { nickname: '克莱恩' },
};

const groupEvent = {
  post_type: 'message',
  message_type: 'group',
  message_id: 999,
  user_id: 20001,
  group_id: 10001,
  raw_message: '.创建 克莱恩',
  time: 1789000000,
  sender: { card: '群名片', nickname: '克莱恩' },
};

test('OneBot 事件映射：私聊 / 群聊 / 非消息事件', () => {
  const priv = mapOneBotEvent(privateEvent);
  assert.equal(priv?.scene, 'private');
  assert.equal(priv?.sceneId, '20001');
  assert.equal(priv?.messageId, 'onebot:12345');
  assert.equal(priv?.nickname, '克莱恩');
  assert.equal(priv?.timestamp, 1789000000000);

  const group = mapOneBotEvent(groupEvent);
  assert.equal(group?.scene, 'group');
  assert.equal(group?.sceneId, '10001');
  assert.equal(group?.nickname, '群名片', '群名片优先于昵称');

  assert.equal(mapOneBotEvent({ post_type: 'notice' }), null);
  assert.equal(mapOneBotEvent(null), null);
  assert.equal(mapOneBotEvent({ post_type: 'message', message_type: 'private' }), null, '缺 message_id 直接丢弃');
});

test('OneBot 适配器：事件交给 handler，发送走 HTTP API', async () => {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const post: HttpPost = async (url, body, headers) => {
    calls.push({ url, body, headers });
    return { status: 'ok', retcode: 0 };
  };
  const adapter = new OneBotAdapter({ apiBase: 'http://127.0.0.1:3000/', accessToken: 'secret' }, post);

  const received: InternalMessage[] = [];
  adapter.onMessage((msg) => {
    received.push(msg);
  });

  await adapter.handleEvent(privateEvent);
  assert.equal(received.length, 1);
  assert.equal(received[0]?.rawText, '.状态');
  assert.equal(await adapter.handleEvent({ post_type: 'notice' }), null);

  await adapter.sendPrivate('20001', '你好');
  await adapter.sendGroup('10001', '群播报');
  await adapter.sendChannel('channel-1', '频道播报');

  assert.equal(calls[0]?.url, 'http://127.0.0.1:3000/send_private_msg');
  assert.deepEqual(calls[0]?.body, { user_id: 20001, message: '你好' });
  assert.equal(calls[0]?.headers.authorization, 'Bearer secret');
  assert.equal(calls[1]?.url, 'http://127.0.0.1:3000/send_group_msg');
  assert.deepEqual(calls[1]?.body, { group_id: 10001, message: '群播报' });
  assert.equal(calls[2]?.url, 'http://127.0.0.1:3000/send_guild_channel_msg');

  assert.equal(adapter.authorized('Bearer secret'), true);
  assert.equal(adapter.authorized('Bearer wrong'), false);
});

test('OneBot 适配器：retcode 非 0 必须抛出，不能静默吞掉', async () => {
  const post: HttpPost = async () => ({ status: 'failed', retcode: 1404, message: '群不存在' });
  const adapter = new OneBotAdapter({ apiBase: 'http://127.0.0.1:3000' }, post);
  await assert.rejects(() => adapter.sendGroup('10001', 'hi'), /retcode=1404/);
});

test('官方适配器：事件能映射，发送明确未实现', async () => {
  const msg = mapOfficialEvent({
    id: 'msg-1',
    content: ' .状态',
    timestamp: '1789000000000',
    group_openid: 'G1',
    author: { member_openid: 'U1', username: '克莱恩' },
  });
  assert.equal(msg?.platform, 'official');
  assert.equal(msg?.scene, 'group');
  assert.equal(msg?.sceneId, 'G1');
  assert.equal(msg?.rawText, '.状态');

  const adapter = new OfficialAdapter({ appId: '123' });
  await assert.rejects(() => adapter.sendPrivate('U1', 'hi'), NotImplementedError);
  await assert.rejects(() => adapter.sendGroup('G1', 'hi'), NotImplementedError);
  await assert.rejects(() => adapter.sendChannel('C1', 'hi'), NotImplementedError);
});

test('内存适配器：take 清空、按场景分流', async () => {
  const adapter = new MemoryAdapter();
  const seen: string[] = [];
  adapter.onMessage((msg) => {
    seen.push(msg.rawText);
  });
  await adapter.deliver({
    messageId: 'm1',
    platform: 'onebot',
    scene: 'private',
    sceneId: 'u1',
    userId: 'u1',
    nickname: 'n',
    rawText: '.帮助',
    timestamp: 0,
  });
  await adapter.sendGroup('g1', 'a');
  await adapter.sendPrivate('u1', 'b');
  assert.deepEqual(seen, ['.帮助']);
  assert.equal(adapter.take().length, 2);
  assert.equal(adapter.take().length, 0);
});
