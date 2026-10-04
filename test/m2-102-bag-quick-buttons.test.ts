/**
 * **背包表格里的「文字互动按钮」**（M2.103）。
 *
 * 用户给了官方文档（文本交互 · 参数指令）：
 * https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/text-chain.html
 *
 * ```
 * <qqbot-cmd-input text="xxx" show="xxx" reference="false" />
 *   text  点击后插入输入框的文本（必填，≤100 字符，urlencode）
 *   show  消息里看到的文本（选填，默认取 text，≤100 字符，urlencode）
 * ```
 *
 * 用户要的形态（原话）：「背包第一格表格显示的是驱邪符，他是可以使用的物品，
 * 那么文字互动按钮就设置成**驱邪符**，点击后自动输入指令」——
 * 也就是 `show = 物品名`、`text = 那条指令`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { canUseCmdTags, cmdInputTag } from '../src/domain/text-interaction.ts';
import { bagNavButtons, commandForSlot } from '../src/router/commands/bag.ts';

test('M2.103 标签的格式与 urlencode（官方两个字段都要求编码）', () => {
  const tag = cmdInputTag('.使用 驱邪符', '驱邪符');
  assert.match(tag, /^<qqbot-cmd-input text="[^"]+" show="[^"]+" \/>$/, tag);
  assert.ok(tag.includes(encodeURIComponent('.使用 驱邪符')), 'text 要 urlencode：' + tag);
  assert.ok(tag.includes(encodeURIComponent('驱邪符')), 'show 要 urlencode：' + tag);
  // ⚠️ 判的是**值内部**没有裸空格（标签本身的属性之间当然有空格 —— 第一版判错了自己）
  const values = [...tag.matchAll(/(?:text|show)="([^"]*)"/g)].map((m) => m[1]!);
  for (const value of values) assert.ok(!value.includes(' '), '值要 urlencode 干净：' + value);
  // 空格与中文都必须被编码
  assert.match(tag, /%20/, '空格要编成 %20');
});

test('M2.103 「对应的指令」按物品类型推：魔药 / 消耗品 / 武器，材料不给', () => {
  const items: Record<string, { name: string; kind: string }> = {
    '驱邪符': { name: '驱邪符', kind: 'charm' },
    'potion_seer_9': { name: '魔药·愚者·序列9', kind: 'potion' },
    '左轮手枪': { name: '左轮手枪', kind: 'weapon' },
    '主材料·灰雾结晶': { name: '主材料·灰雾结晶', kind: 'material' },
    '便士': { name: '便士', kind: 'currency' },
  };
  const of = (id: string) => items[id];
  assert.equal(commandForSlot(of, '驱邪符'), '.使用 驱邪符');
  assert.equal(commandForSlot(of, 'potion_seer_9'), '.服用 魔药·愚者·序列9');
  assert.equal(commandForSlot(of, '左轮手枪'), '.装备 左轮手枪');
  assert.equal(commandForSlot(of, '主材料·灰雾结晶'), null, '材料没有「用」这个动作');
  assert.equal(commandForSlot(of, '便士'), null, '货币也一样');
  assert.equal(commandForSlot(of, '不存在的东西'), null, '查不到就退回纯文字');
});

test('M2.103 标签只在 markdown 通道上用（其余通道退回纯文字）', () => {
  assert.equal(canUseCmdTags(true), true);
  assert.equal(canUseCmdTags(false), false);
  assert.equal(canUseCmdTags(undefined), false);
});

test('M2.104 底部翻页是 key 响应按钮：首页只给「下一页」，其余页「上一页 + 下一页」', () => {
  assert.deepEqual(bagNavButtons(1, 3), [{ label: '下一页', command: '背包 2' }]);
  assert.deepEqual(bagNavButtons(2, 3), [
    { label: '上一页', command: '背包 1' },
    { label: '下一页', command: '背包 3' },
  ]);
  assert.deepEqual(bagNavButtons(3, 3), [{ label: '上一页', command: '背包 2' }], '最后一页只有上一页');
  assert.deepEqual(bagNavButtons(1, 1), [], '只有一页时不给按钮');
});

test('M2.103 背包命令把物品名那一格换成标签，底部翻页走 quickButtons', () => {
  const src = readFileSync(new URL('../src/router/commands/bag.ts', import.meta.url), 'utf8');
  // M2.105：标签的 `show` 用短名（长了会折行，折行之后平台不再当它是标签）
  assert.match(src, /cmdInputTag\(command, short\)/, '物品那一行要用标签（show 用短名）');
  assert.match(src, /const markdown = canUseCmdTags\(c\)/, '按通道能力分流：markdown 用列表，其余用表格');
  // ⚠️ 夹具没有 `supportsColor` 开关，非 markdown 那条路只能做源码级判据
  assert.match(src, /if \(!markdown\) \{\n\s+lines\.push\('\| 物品 \| 数量 \| 状态 \|'\)/, '非 markdown 通道仍要发表格');
  // ⚠️ M2.104：底部翻页是 **key 响应按钮**（quickButtons），不是正文标签
  // ⚠️ M2.106：翻页走 `nextActions` ⇒ 菜单 options ⇒ **回调按钮（type=1，点击直接执行）**。
  // 用 `quickButtons`（type=2）会变成「把指令插进输入框」—— 那是用户报的「点下一页变成输入指令」。
  assert.match(src, /nextActions: navButtons/, '翻页要交 nextActions（响应式按钮）');
  // ⚠️ 只查**代码行** —— 注释里提到 quickButtons 是解释，不是实现（这条判据踩过一次）
  const code = src.split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//')).join('\n');
  assert.ok(!code.includes('quickButtons'), '翻页不该再走 quickButtons（那是插进输入框那条路）');
});
