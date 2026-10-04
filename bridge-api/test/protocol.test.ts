/**
 * 协议层测试：**字段名写错必须当场报错**。
 *
 * 这一条不是洁癖 —— 上游把 `userId` 写成 `userid` 时，若 schema 默认 strip 掉未知字段，
 * 服务端收到的就是一条没有 userId 的消息；它要么在更深处炸、要么更糟：
 * 一个空 id 被当成"另一个玩家"建号，而日志里一切正常。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BRIDGE_SCENES, DEFAULT_CAPABILITIES, capabilitiesSchema, inboundSchema } from '../src/protocol.ts';

const good = {
  platform: 'koishi',
  scene: 'group' as const,
  sceneId: '901',
  userId: '20001',
  nickname: '克莱恩',
  text: '.状态',
};

test('入站：一份合法报文通过，且不改写任何字段', () => {
  const parsed = inboundSchema.parse(good);
  assert.equal(parsed.platform, 'koishi');
  assert.equal(parsed.scene, 'group');
  assert.equal(parsed.userId, '20001');
  assert.equal(parsed.text, '.状态');
});

test('入站：字段名写错（userid）必须报错，不许静默丢掉', () => {
  const r = inboundSchema.safeParse({ ...good, userid: '20001' });
  assert.equal(r.success, false);
  if (r.success) return;
  // zod 对"多余的键"是把名字写在 message 里、path 为空 —— 两处都查一遍
  const text = r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(' | ');
  assert.ok(text.includes('userid'), '错误要指出是哪个键不认识：' + text);
});

test('入站：必填缺失（sceneId）必须报错', () => {
  const { sceneId: _drop, ...rest } = good;
  const r = inboundSchema.safeParse(rest);
  assert.equal(r.success, false);
});

test('入站：scene 只认那三个值（private / group / channel）', () => {
  assert.deepEqual([...BRIDGE_SCENES], ['private', 'group', 'channel']);
  assert.equal(inboundSchema.safeParse({ ...good, scene: 'dm' }).success, false);
  assert.equal(inboundSchema.safeParse({ ...good, scene: 'channel' }).success, true);
});

test('入站：空文本合法（图片/表情消息没有正文），但不许超长', () => {
  assert.equal(inboundSchema.safeParse({ ...good, text: '' }).success, true);
  assert.equal(inboundSchema.safeParse({ ...good, text: 'x'.repeat(4001) }).success, false);
});

test('能力：缺省一律取最保守的那一档', () => {
  // 没声明任何东西时，服务端内部按这个走（与 OneBot 通道的表现一致）
  assert.deepEqual(DEFAULT_CAPABILITIES, {
    buttons: false,
    images: true,
    inlineImages: false,
    // 反向通道（请上游换 URL）也要最保守：没声明就别去麻烦上游
    inlineUpload: false,
    richText: false,
  });
  const parsed = capabilitiesSchema.parse({ platform: 'bee' });
  assert.equal(parsed.buttons, undefined, '没声明的项不许被填成 true —— 那是替上游做主');
});

test('能力：不认识的键要报错（防拼错 inline 为 inlineImage）', () => {
  const r = capabilitiesSchema.safeParse({ platform: 'bee', inlineImage: true });
  assert.equal(r.success, false);
});
