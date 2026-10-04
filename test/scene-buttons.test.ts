/**
 * M2.86：**尾巴按钮按场景给**（用户拍板）。
 *
 * > 「尾巴按钮需要按模板场景显示对应的按钮」
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCENE_BUTTONS, buttonsForScene, type SceneKind } from '../src/domain/menu/scene-buttons.ts';
import { createHarness } from './helpers/app.ts';

test('场景按钮：每种场景都有，且都是**完整指令原文**（点击就能用）', () => {
  const kinds = Object.keys(SCENE_BUTTONS) as SceneKind[];
  assert.ok(kinds.length >= 5, '场景种类太少：' + kinds.length);
  for (const kind of kinds) {
    const buttons = SCENE_BUTTONS[kind];
    assert.ok(buttons.length > 0, kind + ' 一个按钮都没有');
    for (const b of buttons) {
      assert.ok(b.label.length > 0 && b.label.length <= 6, kind + ' 的按钮文字过长：' + b.label);
      assert.ok(b.command.startsWith('.'), kind + ' 的 command 必须以点号开头（那才是指令）：' + b.command);
    }
  }
});

test('场景按钮：每套最多 4 个（手机上一行放不下更多）', () => {
  for (const kind of Object.keys(SCENE_BUTTONS) as SceneKind[]) {
    assert.ok(buttonsForScene(kind).length <= 4, kind + ' 超过 4 个');
  }
});

test('场景按钮：**不同场景给的按钮不同**（否则「按场景」是句空话）', () => {
  const battle = buttonsForScene('battle').map((b) => b.command).join(',');
  const scene = buttonsForScene('scene').map((b) => b.command).join(',');
  const trade = buttonsForScene('trade').map((b) => b.command).join(',');
  assert.notEqual(battle, scene);
  assert.notEqual(scene, trade);
  assert.ok(battle.includes('.战斗'), '战斗场景该给战斗指令：' + battle);
  assert.ok(trade.includes('.确认') && trade.includes('.取消'), '交易场景该给确认与取消：' + trade);
  assert.ok(!battle.includes('.战斗') || !scene.includes('.战斗'), '站街上不该给战斗指令');
});

test('场景按钮：`.看` 能正常跑完（按钮挂在 interactive 上，由真实通道发出去）', async () => {
  /*
   * ⚠️ 这里**不**断言「回执里能看到按钮」。
   *
   * 原因：`interactive` 只有真实通道（官方 QQ 且 buttons 打开）才会写进 SentMessage；
   * memory 通道走的是 sendPrivate，只记正文。所以在测试环境里断言它会**恒假** ——
   * 而一条恒假的断言比没有断言更坏（会诱使人去改一个没坏的东西）。
   *
   * 按钮本身的行为由上面三条用例覆盖；「真机上点得到」由实机调试确认。
   */
  const h = createHarness();
  try {
    await h.createCharacter('51000', '克莱恩', 'seer');
    const reply = await h.send({ rawText: '.看', userId: '51000', messageId: 'b1' });
    assert.ok(reply.length > 0, '`.看` 要有回执');
    assert.ok(reply[0]!.text.includes('廷根市'), '正文该在（按钮不该挤掉正文）：' + reply[0]!.text.slice(0, 80));
  } finally { h.app.close(); }
});
