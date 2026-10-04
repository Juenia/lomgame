import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import {
  OneBotFingerprintProvider,
  StaticFingerprintProvider,
  nullFingerprintProvider,
} from '../src/infra/fingerprint.ts';
import type { InternalMessage } from '../src/adapter/types.ts';
import { createHarness } from './helpers/app.ts';

const msg: InternalMessage = {
  messageId: 'm1',
  platform: 'onebot',
  scene: 'private',
  sceneId: 'u1',
  userId: 'u1',
  nickname: 'n',
  rawText: '.交易',
  timestamp: 0,
};

test('指纹钩子：OneBot 与默认实现都返回 null（W4 不实现解析）', () => {
  assert.equal(nullFingerprintProvider.fingerprintOf(msg), null);
  assert.equal(new OneBotFingerprintProvider().fingerprintOf(msg), null);
  const fixed = new StaticFingerprintProvider('dev-1');
  assert.deepEqual(fixed.fingerprintOf(msg), { key: 'dev-1', source: 'static' });
  assert.equal(new StaticFingerprintProvider(null).fingerprintOf(msg), null);
});

test('交易：默认无指纹，device_key 为空，风控退回按账号', async () => {
  const h = createHarness();
  const a = await h.createCharacter('20001', '克莱恩');
  const b = await h.createCharacter('20002', '正义', 'warrior');
  h.repos.inventory.add(a.id, '辅助材料·银粉', 1, 'unbound', h.now());
  h.repos.inventory.add(b.id, '便士', 200, 'unbound', h.now());

  h.advance(11_000);
  const sent = await h.send({ rawText: '.交易 @20002 辅助材料·银粉 1 50', userId: '20001' });
  const id = /单号：([A-F0-9]{6})/.exec(sent[0]?.text ?? '')![1];
  assert.equal(h.repos.trades.getById(id)?.deviceKey, null);
  h.app.close();
});

test('交易：注入指纹后按「同设备」累计交易额，跨账号也会被拦', async () => {
  const h = createHarness({ fingerprint: new StaticFingerprintProvider('dev-1') });
  const a = await h.createCharacter('20001', '克莱恩');
  const b = await h.createCharacter('20002', '正义', 'warrior');
  const c = await h.createCharacter('20003', '阿尔杰', 'sleepless');
  h.repos.inventory.add(a.id, '辅助材料·银粉', 1, 'unbound', h.now());
  h.repos.inventory.add(c.id, '辅助材料·银粉', 1, 'unbound', h.now());
  h.repos.inventory.add(b.id, '便士', 9000, 'unbound', h.now());

  // 账号 A 卖掉一笔 3000
  h.advance(11_000);
  const first = await h.send({ rawText: '.交易 @20002 辅助材料·银粉 1 3000', userId: '20001' });
  const firstId = /单号：([A-F0-9]{6})/.exec(first[0]?.text ?? '')![1];
  h.advance(11_000);
  await h.send({ rawText: `.确认 ${firstId}`, userId: '20002' });
  assert.equal(h.repos.trades.getById(firstId)?.deviceKey, 'dev-1', '设备指纹要落库');

  // 同设备的另一个账号 C 再卖 2500：账号维度没超（0+2500），设备维度已超（3000+2500）
  h.advance(11_000);
  const second = await h.send({ rawText: '.交易 @20002 辅助材料·银粉 1 2500', userId: '20003' });
  assert.match(second[0]?.text ?? '', /本周交易额已达上限/);
  assert.equal(
    h.repos.trades.volumeSinceDevice('dev-1', h.now() - 7 * 24 * 60 * 60 * 1000),
    3000,
    '设备维度能看到第一笔',
  );
  assert.equal(
    h.repos.trades.volumeSince(c.id, h.now() - 7 * 24 * 60 * 60 * 1000),
    0,
    '账号维度看不到别人的交易',
  );
  assert.ok(NUMERIC.trade.weeklyVolumeCap < 3000 + 2500);
  h.app.close();
});
