/**
 * M2.85：**带按钮的通道也要拿到正文**。
 *
 * 现场：官方通道（支持按钮）下，.状态 的回复只有一个小菜单（「【下一步 · 还没有途径】」），
 * 状态详情（HP/MP/SAN、城市、教会、背包件数）**一个字都没发出去**。
 *
 * 根因在 sendReplies：走 sendInteractive 时把 reply.text 丢了 —— 而**测试用的是内存适配器**
 * （supportsButtons 为假），它走的是下面那行 sendPrivate(reply.text)，所以永远测不出来。
 * 这条用例用一个「支持按钮」的假适配器把这个缺口钉住。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendReplies } from '../src/router/index.ts';
import type { Adapter, InternalMessage } from '../src/adapter/types.ts';

function recordingAdapter(): { adapter: Adapter; seen: string[] } {
  const seen: string[] = [];
  const adapter = {
    supportsButtons: true,
    supportsImages: false,
    onMessage(_h: (msg: InternalMessage) => void): void { /* 用不到 */ },
    async sendPrivate(): Promise<void> { /* 用不到 */ },
    async sendGroup(): Promise<void> { /* 用不到 */ },
    async sendChannel(): Promise<void> { /* 用不到 */ },
    async sendInteractive(_scene: unknown, _target: string, message: { text: string }): Promise<boolean> {
      seen.push(message.text);
      return true;
    },
  } as unknown as Adapter;
  return { adapter, seen };
}

test('回复：支持按钮的通道，正文与菜单要一起发（正文不许被菜单顶掉）', async () => {
  const { adapter, seen } = recordingAdapter();
  await sendReplies(adapter, [
    {
      scene: 'group', targetId: 'F066',
      text: '**HP** 100/100  **MP** 50/50 · 序列 9 · 途径：愚者',
      interactive: { text: '【下一步 · 还没有途径】', options: [{ id: '1', label: '去找他交涉', command: '去找他交涉' }] },
    },
  ]);
  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /HP\*\* 100\/100/, '正文必须发出去 —— 这正是真机上丢掉的那一段');
  assert.match(seen[0]!, /【下一步 · 还没有途径】/, '菜单也要在');
  assert.ok(seen[0]!.indexOf('HP') < seen[0]!.indexOf('【下一步'), '正文在前、菜单在后');
});

test('回复：正文与菜单相同（或菜单已含在正文里）时不重复发', async () => {
  const { adapter, seen } = recordingAdapter();
  await sendReplies(adapter, [
    {
      scene: 'group', targetId: 'F066',
      text: '正文里有【下一步】这句话',
      interactive: { text: '【下一步】', options: [{ id: '1', label: 'a', command: 'a' }] },
    },
  ]);
  assert.equal(seen[0], '正文里有【下一步】这句话', '不重复拼接');
});
