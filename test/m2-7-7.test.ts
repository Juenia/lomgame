/**
 * M2.7.7：普通人入口校验（mortal-guard）+ 拒绝口径。
 *
 * 这一轮解决的是一个**架构口径**问题：
 *   命令层负责「有没有资格做」，判定层负责「这件事能不能成」。
 * 在 M2.7.7 之前，`.魔药` 漏了命令层这一道 —— 普通人一路走到判定层，
 * 拿到的是一句「材料不足」，而那句话在暗示「凑齐材料就能调」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRejected } from '../src/vplayer/analyzer.ts';
import { createHarness } from './helpers/app.ts';

test('.魔药：没有配方的普通人被命令层拒绝 —— 不扣任何东西、不给「材料不足」', async () => {
  const h = createHarness();
  try {
    const userId = '820001';
    const mortal = await h.createMortal(userId, '没有配方的人');
    const before = h.repos.characters.findById(mortal.id)!;
    const sent = await h.send({ rawText: '.魔药', userId });
    const text = sent[0]?.text ?? '';
    assert.match(text, /你还没有走上途径，不知道魔药为何物/, '要说清为什么不行');
    assert.match(text, /\.探索/, '要给出下一步：四处走走');
    assert.match(text, /\.线索/, '要给出下一步：看有没有人在注意你（M2.85：.引导 已由 .线索 接替）');
    assert.equal(text.includes('材料不足'), false, '不能给「凑齐材料就能调」的错误暗示');

    const after = h.repos.characters.findById(mortal.id)!;
    assert.equal(after.mp, before.mp, '拒绝不能消耗灵性');
    // 不落判定事件：domain_events 里只该有建号那一条
    const types = h.repos.characters.eventsOf(mortal.id).map((event) => event.type);
    assert.deepEqual(types, ['character_created'], '拒绝不该落任何判定事件');
  } finally {
    h.app.close();
  }
});

test('.魔药：手里真有配方的普通人仍然能调（例外不能被守卫误伤）', async () => {
  const h = createHarness();
  try {
    const userId = '820002';
    const mortal = await h.createMortal(userId, '手上有张纸的人');
    // 探索翻到一张纸（那是入途径两条路里「自己找到」那条的起点）
    h.repos.clues.insert({
      id: 'clue-1',
      characterId: mortal.id,
      pathway: 'seer',
      clueText: '一本没有封面的笔记本。',
      foundAt: h.now(),
      usedAt: null,
    });
    const sent = await h.send({ rawText: '.魔药 seer_9', userId });
    assert.match(sent[0]?.text ?? '', /材料不足/, '有配方的人该收到的是准确的材料清单');
    assert.equal((sent[0]?.text ?? '').includes('不知道魔药为何物'), false, '守卫不能挡住真的有配方的人');
  } finally {
    h.app.close();
  }
});

/* M2.7.7 修的「stage 口径」用例随 pathway_offers（M2.85）一并删除：
   手上有没有配方现在只有一个来源（recipe_clues），没有第二处口径要对齐。 */
test('普通人的其余动作走同一个入口守卫，回执口径一致（都有「为什么」+ 下一步）', async () => {
  const h = createHarness();
  try {
    const userId = '820004';
    await h.createMortal(userId, '白纸');
    const cases: Array<[string, RegExp]> = [
      ['.晋升', /没有序列/],
      ['.扮演 我在书店里替人占卜', /模仿/],
      ['.占卜 今天会出事吗', /能用来占卜/],
      ['.仪式 准备', /资格/],
      ['.干扰 某某', /看不见别人/],
    ];
    for (const [command, pattern] of cases) {
      h.advance(31_000);
      const text = (await h.send({ rawText: command, userId }))[0]?.text ?? '';
      assert.match(text, pattern, command + ' 该被拒绝');
      assert.match(text, /\.线索/, command + ' 的拒绝回执也要给出下一步（M2.85：线索是唯一入口）');
      // 只查正文首行：「下一步」菜单的标题里那句「还没有途径」不算 ——
      // 它说的是「这个格子是空的」，而不是「途径是什么」
      assert.equal(
        text.split('\n')[0]!.includes('途径'),
        false,
        command + ' 的正文不该点破「途径」这回事（魔药那条除外）',
      );
    }
  } finally {
    h.app.close();
  }
});

test('拒绝话术表认得出「X 属于 Y 途径，你是 Z」这类句式（M2.7.6 那 4 条 P1 的直接成因）', () => {
  // 前缀匹配抓不住它 —— 开头是变化的配方 id
  assert.equal(isRejected(['warrior_9 属于战士途径，你是愚者。']), true);
  assert.equal(isRejected(['sleepless_9 属于不眠者途径，你是战士。\n\n【下一步 · 战士 · 序列 9】\n…']), true);
  // 另外两条句式型拒绝
  assert.equal(isRejected(['没有「别的什么」这个选项。']), true);
  assert.equal(isRejected(['愚者不是你现在能选的东西。']), true);
  // 正常回执不能被误判成拒绝
  assert.equal(isRejected(['你在廷根市待了一段时间。']), false);
  assert.equal(isRejected(['材料不足：\n  主材料·灰雾结晶（需要 1，现有 0）']), true);
  assert.equal(isRejected([]), false);
});