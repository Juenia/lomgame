/**
 * M2.45 状态卡版式：紧凑、成列、不霸屏。
 *
 * 用户口径（四条原话，一路收窄）
 *   ① 「不要一个正文三四个表格，影响观看」
 *   ② 「QQ 消息里很难居中，那么对齐就很重要」
 *   ③ 「正文没做好格式化显示，一旦没有分割，就会一堆文字信息塞在一起」
 *   ④ 「手机端霸屏，又不好看」（附真机截图：八行表格吃掉大半屏）
 *
 * 收口成三条判据：
 *   A. **状态卡里一个表格都不留** —— QQ 把表格渲染成撑满气泡宽度的大格子，
 *      每行高度约是普通文字行的 1.5 倍；八项数值做成八行表格＝半屏，
 *      而它承载的信息量与八行文字**完全相同**；
 *   B. **对齐靠等宽的字**，不靠客户端排版：名称一律两个字 + 8 格 `▰▱` + 全角空格；
 *      行首不放装饰符号（`†◈☾⚗` 是 East Asian Ambiguous 宽度，`⚗` 还会被渲染成 emoji）；
 *   C. **七项数值一条不少**（M2.85：行动值下线后从八项减为七项），行囊也在（减的是格子，不是内容）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { avatarUrlOf, toQQMarkdown } from '../src/adapter/official.ts';
import { characterCardData } from '../src/card/contract.ts';
import { pathwayLineOf } from '../src/router/index.ts';
import { renderStatus } from '../src/router/commands/status.ts';
import type { CharacterState } from '../src/domain/character/types.ts';
import { createHarness } from './helpers/app.ts';

const A = '20001';

/**
 * 正文里有几个表格：数**表格分隔行**（`| :-- | --: |` 这种）。
 * 一个表格恰好有一行分隔行，所以这个数就是表格数。
 */
function tableCount(text: string): number {
  return (text.match(/^\|\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|$/gm) ?? []).length;
}

function state(over: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'c1', userId: 'u1', name: '克莱恩', pathway: 'seer', sequence: 8, pathwayStatus: 'initiated',
    gender: 'male', hp: 61, mp: 40, mad: 12, cor: 11, dig: 9, dp: 3,
    status: 'active', promotionFails: 0, createdAt: 0, updatedAt: 0,
    ...over,
  };
}

/** 三条命那三行（判定层正文里的原始行） */
function vitalityRows(text: string): string[] {
  return text.split('\n').filter((line) => line.startsWith('**'));
}

test('M2.45 第十版：.状态 里一个表格都没有（表格在手机上撑满宽度、行高 1.5 倍）', async () => {
  const h = createHarness();
  await h.createCharacter(A, '克莱恩');
  h.advance(6000);
  const text = (await h.send({ rawText: '.状态', userId: A }))[0]?.text ?? '';
  assert.equal(tableCount(text), 0, `状态卡不该有表格：\n${text}`);
});

test('M2.45 第十版：三条命成列 —— 刻度条与数值必须从同一列开始', () => {
  /*
   * 这一条是「对齐」的判据（用户第二条）：QQ 里没法居中，能靠的只有**等宽的字**。
   * 名称都是两个字、条都是 8 格、分隔都是全角空格 ⇒ 三行的条与数值起点必然相同。
   * 哪天有人往行首塞一个装饰符号，这条就会红 —— 那正是会让三行整体错位的写法。
   */
  const rows = vitalityRows(renderStatus(state()));
  assert.equal(rows.length, 3, `三条命各占一行：${JSON.stringify(rows)}`);
  assert.equal(new Set(rows.map((row) => row.indexOf('▰'))).size, 1, `条的起点要一致：${JSON.stringify(rows)}`);
  assert.equal(
    new Set(rows.map((row) => row.search(/\d+\/\d+/))).size,
    1,
    `数值的起点要一致：${JSON.stringify(rows)}`,
  );
});

test('M2.45 第十版：行首不许出现宽度不可控的装饰符号', () => {
  /*
   * `†◈☾✜✠⚗✦❖` 全是 East Asian Ambiguous 宽度，其中 `⚗☾✦` 在手机上会 emoji 化
   * （用户截图里 `⚗` 就是个彩色图标）—— 宽度随字体回退而变。
   * 它们**单独占一行**时无害（地点行、行囊行），放在需要成列的行首就会毁掉对齐。
   */
  for (const line of renderStatus(state()).split('\n')) {
    assert.ok(!/^[†◈☾✜✠⚗✦❖]/.test(line), `行首出现了装饰符号，三行会整体错位：${line}`);
  }
});

test('M2.45 第十版：减格子不许减信息 —— 七项数值一个都不能少（M2.85 起无行动值）', async () => {
  const h = createHarness();
  await h.createCharacter(A, '克莱恩');
  h.advance(6000);
  const text = (await h.send({ rawText: '.状态', userId: A }))[0]?.text ?? '';
  for (const label of ['**生命**', '**灵性**', '**理智**']) {
    assert.ok(text.includes(label), `状态卡少了 ${label}：\n${text}`);
  }
  // M2.85：「行动」随行动值一并下线
  for (const label of ['疯狂', '污染', '消化', '命运']) {
    assert.ok(text.includes(label), `状态卡少了 ${label}：\n${text}`);
  }
  // 行囊那行只在命令层查得到（renderStatus 是纯函数），所以它必须在这里守着
  assert.match(text, /▣ 行囊 \d+ 种 \/ \d+ 件/, `行囊还在：\n${text}`);
});

test('M2.45 第十版：代价与资源各占一行紧凑文本（条只留给需要看趋势的那三条）', () => {
  const text = renderStatus(state());
  // M2.45 第二十三版：同类字段用「名字:值 | 名字:值」排（借鉴用户给的那批机器人截图）
  // M2.90：消化前面会带一个 ▲（M2.45 第二十三版加的趋势标记），断言跟着补上
  assert.match(text, /疯狂:12 \| 污染:11 \| 消化:▲ 9/);
  // M2.85：原来这里还有「行动:4/5」—— 随行动值一并删除
  // M2.90：命运前面也带了一个 ✦ 标记（同上一行的 ▲）
  assert.match(text, /命运:✦ 3\/10/);
});

test('M2.45：浮点消化度不许印成 8.5999999（与角色卡同口径）', async () => {
  const h = createHarness();
  const character = await h.createCharacter(A, '克莱恩');
  h.repos.characters.update({
    ...h.repos.characters.findById(character.id)!,
    dig: 8.5999999,
    updatedAt: h.now(),
  });
  h.advance(6000);
  const text = (await h.send({ rawText: '.状态', userId: A }))[0]?.text ?? '';
  // M2.90：.状态 走 QQ markdown，数字外面套了上色标记 ⇒ 只要求「消化那一行里有 9」
  assert.match(text, /消化:.*9/, `取整显示：\n${text}`);
  assert.ok(!text.includes('8.5999999'), '浮点误差不许出现在玩家看得见的地方');

  const card = characterCardData(h.repos.characters.findById(character.id)!);
  assert.equal(card.costs?.find((c) => c.label.includes('消化'))?.value, '9');
});

test('M2.45 第十八版：头像 + 昵称一行，次要信息走引用块（用户拍板）', () => {
  /*
   * 官方 markdown 文档「支持格式」一节列的是：标题 / 文字样式 / 链接 / 图片 /
   * 有序列表 / 无序列表 / 列表嵌套 / 块引用 / 水平分割线 / 换多行 ——
   * **没有**「图片旁边放多行文字」这种写法。能用的只有「宽度写成像素」的元素，也就是图片自己。
   *
   * 于是第二行开头放一张**同一头像的 56×1 副本**：它把文字推到头像右边，
   * 而且 56px 是像素值，**不随字号漂**（全角空格那条路第十三版已经证明会歪）。
   * ⚠️ 用的是 `q.qlogo.cn`（腾讯自家域名），不引入任何外部图床 —— 不会像卡面外链那样裂。
   */
  const body = renderStatus(state(), { cityName: '特里尔' });
  const lines = toQQMarkdown(body, {
    header: { nickname: 'の', genderTag: '男', pathwayLine: '愚者 · 序列 8' },
    avatarUrl: avatarUrlOf('1905686871', 'ABC'),
    /*
     * ⚠️ M2.90：显式用 `keep` 档。这条用例守的是**版式**（头像 + 昵称一行），
     * 而 M2.86 之后默认的 `plain` 档会把 `**` 去掉（手机端不认加粗），
     * 于是它一直在断言一个已经不存在的加粗标记。
     */
    mdStyle: 'keep',
  }).split('\n');

  /*
   * 第十九版：**表格名片**。探测（.探针 table）证实 markdown 表格单元格里的 br 会真的换行，
   * 而 layout 组同时证明"行内图片右边多行文字"做不到 —— 表格是唯一出路。
   */
  /*
   * ⚠️ 表格名片撤了（第十九版做过，被真机打回来）：表格里的 <br> 在**手机与电脑上
   * 都是把表格撑成两行**（第二行左格空着），而 markdown 表格没有 rowspan ——
   * "头像跨两行 + 右边两行文字"根本做不到。现在回到第十八版的形态。
   */
  assert.equal(
    lines[0],
    `![头像 #56px #56px](${avatarUrlOf('1905686871', 'ABC')}) **の**　男\u200B`,
    `第一行：头像 56px + 昵称 + 性别`,
  );
  assert.equal(lines[1], '> 愚者 · 序列 8　◉ 特里尔\u200B', '第二行：引用块装次要信息（来历 + 所在）');
  assert.equal(lines[2], '***', '分割线收住消息头');
  assert.equal(
    lines.filter((line) => line.includes('◉ 特里尔')).length,
    1,
    '城市只能说一次（搬进名片之后正文里不该再有）',
  );
});

test('M2.45 第十二版：地点行紧跟消息头，且不再自占一条分割线（省下的那一行）', () => {
  /*
   * 用户原话：「所在地直接放在昵称下面，这样又节省一行」。
   *
   * 上一版是「◉ 城市 + ***」，而消息头收尾已经有一条分割线 —— 城市被两条线夹着，白占一行。
   * 现在它直接接数值行；正文里**一条分割线都不留**（那条线归消息头）。
   */
  const text = renderStatus(state(), { cityName: '特里尔' });
  const lines = text.split('\n');
  assert.equal(lines[0], '◉ 特里尔', '地点行是正文第一行');
  assert.ok(!lines.includes('***'), `正文里不该再有分割线：\n${text}`);
  assert.match(lines[1] ?? '', /^\*\*生命\*\*/, `地点行下面直接是数值行：\n${text}`);

  // 没有地点行时同样干净：正文首行就是数值行
  const bare = renderStatus(state(), {});
  assert.ok(!bare.startsWith('***'), `正文首行不该是分割线：\n${bare}`);
  assert.match(bare, /^\*\*生命\*\*/);
});

test('M2.105：.背包 在 markdown 通道下**不是表格**（因为表格单元格里的可点标签平台不解析）', async () => {
  const h = createHarness();
  const character = await h.createCharacter(A, '克莱恩');
  h.repos.inventory.add(character.id, '主材料·灰雾结晶', 2, 'unbound', h.now());
  h.advance(6000);
  const text = (await h.send({ rawText: '.背包', userId: A }))[0]?.text ?? '';
  assert.ok(text.includes('灰雾结晶'), '物品还在（这一条没变）');
  /*
   * ⚠️ M2.105 推翻了 M2.45 的口径，理由是**实机截图**：
   *
   * 上一版把 `<qqbot-cmd-input>` 放进表格单元格，真机上原样显示源码 ——
   * 平台不解析表格里的标签。所以 markdown 通道改成「一行一件」。
   *
   * 不支持 markdown 的通道（OneBot / 内存）仍然走表格：那边标签无效，表格是更好的读物。
   */
  assert.equal(tableCount(text), 0, 'markdown 通道不该再有表格：\n' + text);
});



test('M2.45 第九版：正文忘了补空行时，通道层要自动补（表格不许吃掉下一行）', () => {
  /*
   * 真机事故：表格只认**空行**（与块级结构）作为终止 —— 少了它，表格会把下面那行吞进格子。
   * `bag.ts` 的「发送 .背包 2 查看下一页」当时就漏了空行，所以这一层在出口统一兜底。
   */
  const lines = toQQMarkdown('| 属性 | 数值 |\n| :-- | --: |\n| 生命 | 61 |\n▣ 行囊 3 种 / 8 件', {}).split('\n');
  const lastRow = lines.findIndex((line) => line.startsWith('| 生命'));
  assert.equal(lines[lastRow + 1], '', `表格后要自动空一行：${JSON.stringify(lines)}`);
  assert.match(lines[lastRow + 2] ?? '', /▣ 行囊/, `正文要被留在表格外面：${JSON.stringify(lines)}`);
  /*
   * 表格后面**本来就写了空行**时也一样：那个空行在 `mdLine` 里会变成零宽空格行
   * （官方文档「换多行」一节里的空行写法），而表格要的是**真空行**（解析层的终止符）。
   * 两者职责不同，所以这里仍旧补一个 —— 这不是重复，是各管一层。
   */
  const already = toQQMarkdown('| 属性 | 数值 |\n| :-- | --: |\n| 生命 | 61 |\n\n▣ 行囊', {}).split('\n');
  const at = already.findIndex((line) => line.startsWith('| 生命'));
  assert.equal(already[at + 1], '', '紧跟表格的是**真空行**（表格只认它作终止）');
  assert.ok(
    already.some((line) => line.includes('▣ 行囊')),
    `正文还在（没被表格吞掉）：${JSON.stringify(already)}`,
  );
});

test('M2.45 第十版：未入途径时消息头不写「还没有途径」（正文里已经有一句，别写两遍）', () => {
  const mortal = state({ pathway: null, sequence: null, pathwayStatus: 'mortal' });
  assert.equal(pathwayLineOf(mortal), '', '未入途径：头上那一行不写 —— 正文里那句才是唯一的一份');
  assert.equal(pathwayLineOf(state()), '愚者 · 序列 8', '入途径之后这一行才有新信息（途径 · 序列）');
});
