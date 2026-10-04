/**
 * M2.45 第二十版：**按钮通道下，正文里的文字菜单要切掉**。
 *
 * 用户原话：「信息尾太墨迹了，他太长了，他应该放置在按钮里。」
 *
 * 选项已经在按钮上列全了，正文再列一遍 `1./2./3.` 是纯冗余；
 * 但**标题行与环境行要留着**（`【下一步 · …】`、`晴 · 夜晚 · HP 100 · AP 5`）——
 * 它们不是选项，而是这一屏的上下文。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutMenuOptions } from '../src/adapter/interactive.ts';
import type { Adapter, InternalMessage } from '../src/adapter/types.ts';
import { sendReplies } from '../src/router/index.ts';

const MENU = [
  '【下一步 · 还没有途径】',
  '晴 · 夜晚 · HP 100 · AP 5',
  '你还不知道自己会变成什么。',
  '',
  '1. 去找他交涉（情报部 · 去外国人聚居区走一趟）',
  '2. 看引导进度（有没有人在注意你）',
  '3. 休息一下（恢复 HP 与 MAD · 每日 1 次）',
  '0. 自己写一个行为',
  '',
  '回复数字。',
].join('\n');

test('切掉选项清单，标题与环境行留着', () => {
  const slim = cutMenuOptions(MENU);
  assert.ok(slim.includes('【下一步 · 还没有途径】'), '标题要留');
  assert.ok(slim.includes('晴 · 夜晚 · HP 100 · AP 5'), '环境行要留（它是这一屏的上下文）');
  assert.ok(!/^\s*\d+[.、]/m.test(slim), `选项要被切掉：\n${slim}`);
  assert.ok(!slim.includes('回复数字'), '「回复数字」也属于选项区，一起切');
});

test('端到端：按钮通道发的正文里，选项清单要被切掉（现场：「还有尾巴你切哪了」）', async () => {
  /*
   * ⚠️ 这条是冲着一次真实返工加的：第一版把判断写成「body 里已含**精简**菜单 ⇒ 直接用 body」，
   * 而 body 里含的是**完整**菜单（选项还在）——于是等于什么都没切。
   * 正确的判断是「**完整菜单在 body 里出现过没有**」。
   */
  const seen: string[] = [];
  const adapter = {
    supportsButtons: true,
    supportsImages: false,
    onMessage(_handler: (msg: InternalMessage) => void): void {
      /* 用不到 */
    },
    async sendPrivate(): Promise<void> {
      /* 用不到 */
    },
    async sendGroup(): Promise<void> {
      /* 用不到 */
    },
    async sendChannel(): Promise<void> {
      /* 用不到 */
    },
    async sendInteractive(
      _scene: unknown,
      _target: string,
      message: { text: string },
    ): Promise<boolean> {
      seen.push(message.text);
      return true;
    },
  } as unknown as Adapter;

  await sendReplies(adapter, [
    {
      scene: 'group',
      targetId: 'G1',
      text: `状态卡正文\n\n${MENU}`,
      interactive: {
        text: MENU,
        options: [{ id: '1', label: '去找他交涉', command: '引导' }],
      },
    },
  ]);

  assert.equal(seen.length, 1);
  const sent = seen[0]!;
  assert.ok(sent.includes('状态卡正文'), `正文要留：\n${sent}`);
  /*
   * ⚠️ M2.112：**标题与环境行也不再留**（用户第三次报「信息尾依旧存在」）。
   *
   * 旧口径（M2.45 第二十版）只切选项、留标题 —— 而真机上那三行
   * （`【下一步 · …】` + 环境行 + 一句提示）就贴在按钮上方，说的正是按钮上那些事。
   * 现在按钮通道下**整段菜单文本都不进正文**；非按钮通道照旧（那边它是唯一的载体）。
   */
  assert.ok(!sent.includes('【下一步'), `标题不该再留：\n${sent}`);
  assert.ok(!sent.includes('晴 · 夜晚'), `环境行不该再留：\n${sent}`);
  assert.ok(!/^\s*\d+[.、]/m.test(sent), `选项要切掉：\n${sent}`);
  assert.ok(!sent.includes('回复数字'), `「回复数字」也要切：\n${sent}`);
});

test('认不出选项就原样返回（这一层只许"少说一句"，不许吃掉正文）', () => {
  const plain = '正文\n没有任何选项';
  assert.equal(cutMenuOptions(plain), plain);
  assert.equal(cutMenuOptions(''), '');
  // 第一行就是选项：不切 —— 否则会返回空串，把整段内容吃光
  assert.equal(cutMenuOptions('1. 只有一行选项'), '1. 只有一行选项');
});
