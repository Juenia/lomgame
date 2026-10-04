/**
 * M2.85：**未识别指令不再刷屏**。
 *
 * 用户的原话：「如果是未知指令 直接无视 不要回复 形成骚扰」——
 * 群里有人手滑打个句号、或者聊天里出现「.xxx」这种写法，
 * 机器人每一条都回一长串「未识别指令：… 可用指令：.创建 .状态 …」，那是实打实的刷屏。
 *
 * 取舍：**群里静默**（骚扰就发生在这里）；**私聊回一句极简** ——
 * 一对一不打扰任何人，而完全静默会让人以为机器人坏了
 * （「打错了」和「机器人挂了」在玩家那边长得一样，这一句是用来分开它们的）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/app.ts';

const A = '20001';

test('未知指令：群里一个字都不回，私聊给一句极简提示', async () => {
  const h = createHarness();
  await h.createCharacter(A, '克莱恩');

  // 私聊：一句极简（且是「没有 .xxx 这条指令」这种一眼能懂的说法）
  h.advance(11_000);
  const priv = await h.send({ rawText: '.绝涩', userId: A });
  assert.equal(priv.length, 1, '私聊要回一条 —— 否则玩家分不清"打错了"和"机器人挂了"');
  assert.match(priv[0]?.text ?? '', /没有 \.绝涩 这条指令/);
  assert.ok(!/可用指令/.test(priv[0]?.text ?? ''), '不再把全量指令表糊到玩家脸上');

  // 群聊：静默（这才是"骚扰"发生的地方）
  h.advance(11_000);
  const group = await h.send({ rawText: '.绝涩', userId: A, scene: 'group' });
  assert.equal(group.length, 0, '群里未知指令必须一个字都不回');

  // 已知指令不受影响（别把闸门做过头）
  h.advance(11_000);
  const known = await h.send({ rawText: '.状态', userId: A, scene: 'group' });
  assert.ok(known.length > 0, '.状态 在群里仍然要有回复');
  h.app.close();
});
