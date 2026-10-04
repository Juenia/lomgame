/**
 * M2.45：`.mdprobe` —— 真机 markdown / HTML 能力探测。
 *
 * 用户口径：「腾讯的 markdown 消息好像是支持一部分 html 标签的，例如文字颜色什么的，
 * 你可以制作一个独立的测试模板，进行多项测试。」
 *
 * 这一条的价值是**把猜测换成实测**：前面十几轮的版式决策（空行怎么算、缩进怎么凑、
 * 外链行不行、表格会不会吞行）全靠猜平台行为，猜错了要用户拿真机截图来纠正。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROBES, mdProbeEnabled, probeById } from '../src/router/commands/mdprobe.ts';
import { createHarness } from './helpers/app.ts';

const A = '20001';

/**
 * 端到端：**证明路由真的通**。
 *
 * 这一条是冲着一次现场加的：第一版把开关写成「配了 MD_PROBE=1 才注册」，
 * 而我给用户的 .env 里写的是 0 —— 用户发指令**毫无反应**，而症状与「指令名打错」
 * 「没重启」「被别的规则拦了」完全一样，只能靠猜。
 * 从今往后，「.探针 到底能不能路由到」是一条**可执行的断言**，不靠猜。
 */
test('端到端：私聊与群里都能拿到分组清单（用户平时就在群里用机器人）', async () => {
  const h = createHarness();
  await h.createCharacter(A, '测试者');

  const priv = await h.send({ rawText: '.探针', userId: A });
  assert.equal(priv.length, 1, `私聊要有回执，实际 ${priv.length} 条`);
  assert.match(priv[0]!.text, /mdprobe/, '清单里要有指令名');
  for (const id of ['html', 'block', 'table', 'img', 'size', 'size2', 'layout', 'misc']) {
    assert.ok(priv[0]!.text.includes(id), `清单里要列出 ${id} 这一组`);
  }

  const one = await h.send({ rawText: '.探针 layout', userId: A });
  assert.equal(one.length, 1);
  assert.match(one[0]!.text, /<br>/, 'layout 组要真的带探测内容');

  /*
   * ⚠️ 群里**也要回**：第一版限制成「只在私聊响应」，而用户平时就在群里用机器人 ——
   * 结果是他发指令毫无反应（正是这一条现场）。另外那一版的群分支返回空字符串，
   * router 照样发一条**空消息**，看着像机器人抽了。
   */
  const group = await h.send({ rawText: '.探针', userId: A, scene: 'group' });
  assert.equal(group.length, 1, '群里也要有回执');
  assert.ok((group[0]!.text ?? '').length > 0, '回执不能是空字符串');
  assert.match(group[0]!.text, /mdprobe/, '内容与私聊同一份');
  h.app.close();
});

test('探测组：十组齐全，每组都有 id / 说明 / 内容', () => {
  /*
   * 这是写死的 G 表：加一组要在这里显式改一次（内容变了自己会红，提醒去看一眼）。
   *
   * ⚠️ M2.90：这里原来写 8 组，而 PROBES 已经有 10 组 —— `latex`（行内公式）
   * 与 `color2`（第二种上色写法）是后来加的，加的人没回来改这张表，
   * 于是这条用例一直红着。补上，并把它当成「加探测组 = 顺手改这里」的提醒。
   */
  assert.deepEqual(
    PROBES.map((probe) => probe.id),
    ['html', 'latex', 'color2', 'block', 'table', 'img', 'size', 'size2', 'layout', 'misc'],
  );
  for (const probe of PROBES) {
    assert.ok(probe.what.length > 0, `${probe.id} 要有说明`);
    assert.ok(probe.build().length > 0, `${probe.id} 要有内容`);
  }
});

test('html 组：把要验的标签都覆盖到（漏一个就白测一次真机）', () => {
  const text = probeById('html')!.build();
  for (const tag of [
    '<b>', '<i>', '<u>', '<s>', '<code>',
    '<font color=', '<span style=', '<big>', '<small>', '<mark>', '<strong>', '<em>',
  ]) {
    assert.ok(text.includes(tag), `html 组少了 ${tag}`);
  }
});

test('layout 组：图文并排的四种写法都在（这一组决定消息头怎么做）', () => {
  const text = probeById('layout')!.build();
  assert.ok(text.includes('<br>'), '要测 br 折行');
  assert.ok(text.includes('<img src='), '要测 HTML 图片');
  assert.ok(text.includes('> ◉'), '要测引用块做第二行');
});

test('img 组：四个域名的图都放进去（一次看清哪个平台取得到）', () => {
  const text = probeById('img')!.build();
  for (const host of ['cdn.jsdelivr.net', 'raw.githubusercontent.com', 'q.qlogo.cn', 'n.uguu.se']) {
    assert.ok(text.includes(host), `img 组少了 ${host}`);
  }
});

test('size 组：四种尺寸标注都在（这一组决定卡面被裁怎么修）', () => {
  const text = probeById('size')!.build();
  /*
   * 四种标注必须各自独立可辨：
   *   · A 不标尺寸 —— 基准（原图铺开是什么样）
   *   · B 标 60×60 —— 标注生效吗
   *   · C 只标宽 —— 只给宽时高怎么算
   *   · D 正方形硬拉成 60×180 —— 平台会不会强制拉伸（决定「标注必须与真实比例一致」）
   * 少任何一个，那条判读就没有依据 —— 所以逐条钉住。
   */
  for (const marker of ['![A](', '![B #60px #60px](', '![C #60px](', '![D #60px #180px](']) {
    assert.ok(text.includes(marker), `size 组少了 ${marker}`);
  }
});

test('size2 组：四档高度都在（这一组决定卡面标注调多矮）', () => {
  const text = probeById('size2')!.build();
  /*
   * 宽度锁死 100、高度四档 —— 这是为了把「上限」夹在一个区间里：
   * 少了任何一档，读数就只剩一个点，无法判断上限在它之上还是之下。
   * 当前卡面标的是 300×484，所以四档必须**跨过 484**（450 在下方、600 在上方）。
   */
  for (const marker of ['#100px #300px', '#100px #450px', '#100px #600px', '#100px #800px']) {
    assert.ok(text.includes(marker), `size2 组少了 ${marker}`);
  }
  /*
   * I 档是这一组里**唯一带诊断结论**的一张：它与卡面标注逐字相同（300×484）、
   * 只换了图源（小图 vs 卡面 1240×2000）。
   * 缺了它，「尺寸问题」与「图源问题」就分不开 —— 而两者的修法完全不同。
   */
  assert.ok(text.includes('#300px #484px'), 'size2 少了与卡面同标注的 I 档（用来区分尺寸问题 / 图源问题）');
  assert.ok(text.includes('两端'), 'size2 的判读必须强调两端分别记（卡面就是手机好、电脑裁）');
});

test('table 组：三种表格写法都在（markdown + br / HTML 表格 / 零宽空格）', () => {
  const text = probeById('table')!.build();
  assert.ok(text.includes('| :-- | :-- |'), 'markdown 表格');
  assert.ok(text.includes('<table>'), 'HTML 表格');
  assert.ok(text.includes('第一行\u200B第二行'), '单元格里的零宽空格');
});

test('开关：**默认开**，写 0 才关（反过来会变成"配了才生效"，最难查）', () => {
  assert.equal(
    mdProbeEnabled({}),
    true,
    '默认开 —— 第一版是"配了 1 才开"，结果 .env 里写了 0，用户发指令毫无反应',
  );
  assert.equal(mdProbeEnabled({ MD_PROBE: '0' }), false);
  assert.equal(mdProbeEnabled({ MD_PROBE: '1' }), true);
  assert.equal(mdProbeEnabled({ MD_PROBE: ' 1 ' }), true, '环境变量要 trim（Windows 上带空格是常态）');
});
