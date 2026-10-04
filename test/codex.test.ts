/**
 * M2.85 内容填充 P1 —— `.图鉴`（神明 / 塔罗的统一读取点）。
 *
 * 这份用例守的是「内容表真的被玩家读到了」：没有它，pantheon.yaml / tarot.yaml
 * 就只是后台里的一份 JSON（K19 的「只写着没人读」）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/app.ts';

const USER = '920001';

test('图鉴：不带参数给分类与条数', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '看书的人');
    const sent = await h.send({ rawText: '.图鉴', userId: USER });
    const text = sent.map((m) => m.text).join('\n');
    assert.match(text, /【图鉴】/);
    assert.match(text, /神明 27 位/);
    assert.match(text, /塔罗 22 张/);
  } finally { h.app.close(); }
});

test('图鉴：神明按原作分类分组（正神 7 / 支柱级旧日 4 / 隐秘存在与邪神 16）', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '看书的人');
    const text = (await h.send({ rawText: '.图鉴 神明', userId: USER })).map((m) => m.text).join('\n');
    assert.match(text, /【神明 · 27 位】/);
    assert.match(text, /— 正神（7）—/);
    assert.match(text, /— 支柱级旧日（4）—/);
    assert.match(text, /— 隐秘存在与邪神（16）—/);
    assert.match(text, /黑夜女神/, '正神名单里要有黑夜女神');
  } finally { h.app.close(); }
});

test('图鉴：神明详查带真名 / 途径 / 尊名 / 来源', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '看书的人');
    const text = (await h.send({ rawText: '.图鉴 神明 黑夜女神', userId: USER })).map((m) => m.text).join('\n');
    assert.match(text, /【黑夜女神】正神/);
    assert.match(text, /真名：阿曼妮西斯|真名：Amanises/);
    assert.match(text, /比星空更崇高/, '完整尊名要出现');
    assert.match(text, /来源：https?:\/\//, '每条都要能溯源');
  } finally { h.app.close(); }
});

test('图鉴：塔罗 22 张，详查带对应途径与象征', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '看书的人');
    const list = (await h.send({ rawText: '.图鉴 塔罗', userId: USER })).map((m) => m.text).join('\n');
    assert.match(list, /【塔罗 · 大阿卡那 22 张】/);
    assert.match(list, /0\. 愚者（The Fool）—— 愚者/);
    const detail = (await h.send({ rawText: '.图鉴 塔罗 愚者', userId: USER })).map((m) => m.text).join('\n');
    assert.match(detail, /【愚者】0 · The Fool/);
    assert.match(detail, /序列 0：愚者/);
    assert.match(detail, /象征：/);
  } finally { h.app.close(); }
});

test('图鉴：组织 49 条，按分类分组（鲁恩机构 / 军队 / 贵族家族 / 商会 / 地下势力 / 隐秘组织）', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '看书的人');
    const text = (await h.send({ rawText: '.图鉴 组织', userId: USER })).map((m) => m.text).join('\n');
    assert.match(text, /【组织与势力 · 49 个】/);
    assert.match(text, /— 隐秘组织（22）—/);
    assert.match(text, /— 贵族家族（14）—/);
    assert.match(text, /净光兄弟会/);
  } finally { h.app.close(); }
});

test('图鉴：组织详查带教义 / 成员 / 来源', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '看书的人');
    const text = (await h.send({ rawText: '.图鉴 组织 净光兄弟会', userId: USER })).map((m) => m.text).join('\n');
    assert.match(text, /【净光兄弟会】隐秘组织/);
    assert.match(text, /教义 \/ 主张：/);
    assert.match(text, /成员：/);
    assert.match(text, /来源：https?:\/\//, '要能溯源');
  } finally { h.app.close(); }
});

test('图鉴：人物 70 人，按分类分组（含主要角色 12 / 天使 10 / 古神 8）', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '看书的人');
    const text = (await h.send({ rawText: '.图鉴 人物', userId: USER })).map((m) => m.text).join('\n');
    assert.match(text, /【人物 · 70 人】/);
    assert.match(text, /— 主要角色（12）—/);
    assert.match(text, /— 天使（10）—/);
    assert.match(text, /克莱恩·莫雷蒂/);
  } finally { h.app.close(); }
});

test('图鉴：人物详查带序列 / 身份 / 结局', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '看书的人');
    const text = (await h.send({ rawText: '.图鉴 人物 克莱恩·莫雷蒂', userId: USER })).map((m) => m.text).join('\n');
    assert.match(text, /【克莱恩·莫雷蒂】主要角色/);
    assert.match(text, /途径：/);
    assert.match(text, /序列：/);
    assert.ok(text.length > 200, '详查要有内容：' + text.length);
  } finally { h.app.close(); }
});

test('图鉴：生物名录只列**生物**（M2.93 起不再混进材料清单与整理笔记）', async () => {
  /*
   * ⚠️ M2.93 换了这条的口径。原来断言的是「544 条，按分类分组（… 普通物种与材料 157）」——
   * 而那正是用户报的那个毛病：玩家在「生物名录」底下读到「红葡萄酒100毫升」「血月与红月的关系」。
   *
   * 现在只列真生物与神话生物形态（342 条 = 285 + 32 + 17 + 2 + 6），
   * 其余在尾部一句话说清「它们不是生物」。条数是**算出来的**（见 m2-93-bestiary-kind）。
   */
  const h = createHarness();
  try {
    await h.createCharacter(USER, '看书的人');
    const text = (await h.send({ rawText: '.图鉴 生物', userId: USER })).map((m) => m.text).join('\n');
    assert.match(text, /【生物名录 · 342 条】/);
    assert.match(text, /— 超凡生物（285）—/);
    assert.match(text, /— 神话生物形态（32）—/, '形态是「形态」不是个体，但单列一节 —— 玩家确实想知道愚者的形态是什么');
    assert.ok(!text.includes('— 普通物种与材料（'), '材料清单不该出现在生物名录里');
    assert.ok(!text.includes('— 存疑记录（'), '整理笔记不该出现在生物名录里');
    assert.match(text, /另有 \d+ 条和生物共用一张表/, '没列出来的那部分要说清是什么');
  } finally { h.app.close(); }
});

test('图鉴：生物详查带产出材料与配方引用；原作没写的字段明说「未记载」', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '看书的人');
    const text = (await h.send({ rawText: '.图鉴 生物 暗影之蛇', userId: USER })).map((m) => m.text).join('\n');
    assert.match(text, /【暗影之蛇】超凡生物/);
    assert.match(text, /产出材料：/);
    assert.match(text, /用在：criminal:7/);
    assert.match(text, /原作未记载它的栖息地与外形/, '原作 null 的字段要说明白，不许偷偷补');
  } finally { h.app.close(); }
});

test('图鉴：权柄与象征 95 条（原作 118 条去重后），按途径分组', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '看书的人');
    const text = (await h.send({ rawText: '.图鉴 权柄', userId: USER })).map((m) => m.text).join('\n');
    assert.match(text, /【权柄与象征 · 95 条】/);
    assert.match(text, /— 占卜家·愚者途径（11）—/);
    assert.match(text, /诡异/);
  } finally { h.app.close(); }
});

test('图鉴：权柄详查带途径与描述（原作数据）', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '看书的人');
    const text = (await h.send({ rawText: '.图鉴 权柄 愚弄', userId: USER })).map((m) => m.text).join('\n');
    assert.match(text, /【愚弄】权柄/);
    assert.match(text, /途径：愚者/);
    assert.match(text, /来源：https?:\/\//);
  } finally { h.app.close(); }
});

test('图鉴：原作材料 1173 种，按主/辅助分组', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '看书的人');
    const text = (await h.send({ rawText: '.图鉴 材料', userId: USER })).map((m) => m.text).join('\n');
    assert.match(text, /【原作材料 · 1147 种】/);
    assert.match(text, /— 辅助材料（775）—/);
    assert.match(text, /— 主材料（372）—/);
  } finally { h.app.close(); }
});

test('图鉴：材料详查连上「需求它的配方」与「产出它的生物」', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '看书的人');
    const text = (await h.send({ rawText: '.图鉴 材料 纯水', userId: USER })).map((m) => m.text).join('\n');
    assert.match(text, /【纯水】/);
    assert.match(text, /需求它的配方：/);
    assert.match(text, /序列 \d/);
    assert.match(text, /产出它的生物：/);
  } finally { h.app.close(); }
});

test('图鉴：原作能力清单 2405 条，按途径汇总', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '看书的人');
    const text = (await h.send({ rawText: '.图鉴 能力', userId: USER })).map((m) => m.text).join('\n');
    assert.match(text, /【原作能力清单 · 2405 条】/);
    assert.match(text, /· 愚者：/);
  } finally { h.app.close(); }
});

test('图鉴：某途径某序列的原作能力（原文直出 + 序列称号）', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '看书的人');
    const text = (await h.send({ rawText: '.图鉴 能力 愚者 8', userId: USER })).map((m) => m.text).join('\n');
    assert.match(text, /【愚者 · 序列 8 · \d+ 条】（原作原文）/);
    assert.match(text, /— 序列 8「小丑」—/);
  } finally { h.app.close(); }
});

test('图鉴：写错的序列要说清范围（不静默）', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '看书的人');
    const text = (await h.send({ rawText: '.图鉴 能力 愚者 99', userId: USER })).map((m) => m.text).join('\n');
    assert.match(text, /序列要写 0—9/);
  } finally { h.app.close(); }
});

test('图鉴：查不到的名字要说清下一步（不静默）', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '看书的人');
    const text = (await h.send({ rawText: '.图鉴 神明 不存在的神', userId: USER })).map((m) => m.text).join('\n');
    assert.match(text, /没有叫「不存在的神」的神明/);
    assert.match(text, /\.图鉴 神明/, '要给下一步');
  } finally { h.app.close(); }
});
