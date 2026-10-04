import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { clamp, computePromotionSuccess } from '../src/domain/character/rules.ts';
import { promotionChance } from '../src/domain/promotion/promotion.ts';
import { materialLossOf } from '../src/domain/ritual/resolve.ts';
import { createSeededRng, seedFrom } from '../src/domain/rng.ts';
import type { InitiatedCharacter } from '../src/domain/character/types.ts';
import { createHarness } from './helpers/app.ts';

const A = '20001';

/**
 * 晋升判定是随机的（seed = messageId:characterId:now:promote）。
 * 测试通过挑选 messageId 来锁定抽样结果 —— 这是确定性的测试准备，不是碰运气。
 */
function findMessageId(
  prefix: string,
  characterId: string,
  now: number,
  predicate: (roll: number) => boolean,
): string {
  for (let i = 0; i < 20_000; i += 1) {
    const messageId = `${prefix}-${i}`;
    const roll = createSeededRng(seedFrom([messageId, characterId, now, 'promote'])).next();
    if (predicate(roll)) return messageId;
  }
  throw new Error('找不到满足条件的 messageId');
}

async function promotable(h: ReturnType<typeof createHarness>, name = '克莱恩') {
  const character = await h.createCharacter(A, name);
  h.repos.inventory.add(character.id, '主材料·灰雾结晶', 4, 'unbound', h.now());
  h.repos.flags.set(character.id, 'ability_seer_9', h.now());
  return character;
}

function setDig(h: ReturnType<typeof createHarness>, characterId: string, dig: number, mad = 0, cor = 0): void {
  h.repos.characters.update({
    ...h.repos.characters.findById(characterId)!,
    dig,
    mad,
    cor,
    updatedAt: h.now(),
  });
}

test('.晋升：材料与门槛校验（未服魔药 / 消化不足 / 材料不足）', async () => {
  const h = createHarness();
  const character = await h.createCharacter(A, '克莱恩');
  h.advance(11_000);
  assert.match((await h.send({ rawText: '.晋升', userId: A }))[0]?.text ?? '', /还没有服下本序列的魔药/);

  h.repos.flags.set(character.id, 'ability_seer_9', h.now());
  h.advance(61_000);
  assert.match((await h.send({ rawText: '.晋升', userId: A }))[0]?.text ?? '', /消化度不足/);

  setDig(h, character.id, 90);
  h.advance(61_000);
  assert.match((await h.send({ rawText: '.晋升', userId: A }))[0]?.text ?? '', /晋升材料不足/);
  h.app.close();
});

test('.晋升：成功 → 序列 8、解锁能力、材料消耗、失败计数清零', async () => {
  const h = createHarness();
  const character = await promotable(h);
  setDig(h, character.id, 100, 0, 0);
  h.advance(11_000);

  const messageId = findMessageId('promo-ok', character.id, h.now(), (roll) => roll < 0.5);
  const sent = await h.send({ rawText: '.晋升', userId: A, messageId, scene: 'group' });
  /*
   * M2.35 任务 3：**期望值从表算，不抄数值（K22）**。
   * planned[8] 由 1.0 改成 0.95 之后，「基础 90.0%」不再等于「成功率」——
   * 回执现在写的是「成功率 85.5%（基础 90.0% × 高序列惩罚 0.95）」。
   * 这条断言原来写死 /成功率 90\.0%/，改梯度时它红了 —— 红得对（口径变了），
   * 但正确的修法是**从表算**，不是把 90.0 换成 85.5（那只是把副本换个值）。
   */
  const promoteBase = computePromotionSuccess({ dig: 100, mad: 0, cor: 0, sequence: 9 });
  const promoteGating = NUMERIC.promotion.sequenceGating.planned[8]!;
  const expectedChance = clamp(promoteBase * promoteGating, NUMERIC.promotion.floor, NUMERIC.promotion.ceil);
  // 群聊与私聊合并成同一条路：明细就在唯一的这条回执里
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.scene, 'group');
  assert.match(sent[0]?.text ?? '', new RegExp('成功率 ' + (expectedChance * 100).toFixed(1) + '%'));
  assert.match(sent[0]?.text ?? '', /你晋升为「小丑」/);

  const state = h.repos.characters.findById(character.id)!;
  assert.equal(state.sequence, 8);
  assert.equal(state.status, 'active');
  assert.equal(state.promotionFails, 0);
  assert.ok(h.repos.flags.has(character.id, 'ability_seer_8'), '解锁序列 8 能力');
  assert.equal(h.repos.inventory.count(character.id, '主材料·灰雾结晶'), 2, '消耗 2 份主材料');

  const events = h.app.db
    .prepare("SELECT type, seed, payload FROM domain_events WHERE type = 'promotion_success'")
    .all() as Array<{ type: string; seed: string; payload: string }>;
  assert.equal(events.length, 1);
  assert.match(events[0]!.seed, new RegExp(`^${messageId}:${character.id}:`));
  assert.equal(JSON.parse(events[0]!.payload).to, 8);
  h.app.close();
});

test('.晋升：失败 → INJURED、材料损失、失败计数 +1', async () => {
  const h = createHarness();
  const character = await promotable(h);
  setDig(h, character.id, 60, 0, 0);
  h.advance(11_000);

  const messageId = findMessageId('promo-fail', character.id, h.now(), (roll) => roll > 0.95);
  const sent = await h.send({ rawText: '.晋升', userId: A, messageId });
  assert.match(sent[0]?.text ?? '', /重伤状态/);

  const state = h.repos.characters.findById(character.id)!;
  assert.equal(state.sequence, 9, '失败不改变序列');
  assert.equal(state.status, 'injured');
  assert.equal(state.promotionFails, 1);
  assert.equal(state.mad, NUMERIC.promotion.madOnFail);
  assert.equal(state.cor, NUMERIC.promotion.corOnFail);
  /*
   * M2.20（K7）：失败**只扣一半**。
   *
   * 这一条原来断言的是 2（夹具给 4 份、需求 2 份 ⇒ 全额扣 2 剩 2）。
   * K7 之后失败扣 ceil(需求 × 0.5) = ceil(2 × 0.5) = 1 ⇒ 剩 3。
   * 用 materialLossOf 现算而不是写死 3 —— 将来调倍率或配方时这条会自己跟上。
   */
  assert.equal(
    h.repos.inventory.count(character.id, '主材料·灰雾结晶'),
    4 - materialLossOf([{ itemId: '主材料·灰雾结晶', qty: 2 }], NUMERIC.promotion.failMaterialLoss)[0]!.qty,
    '失败只损失一半（K7：与 .仪式 阶段 3 失败同口径）',
  );
  assert.equal(h.repos.flags.has(character.id, 'ability_seer_8'), false);
  h.app.close();
});

test('.晋升：连续失败 2 次后第 3 次成功率 +10%，能把失败翻成成功', async () => {
  const h = createHarness();
  const character = await promotable(h);
  setDig(h, character.id, 60, 0, 0);

  // 先失败两次
  for (let i = 0; i < NUMERIC.promotion.failStreakThreshold; i += 1) {
    h.advance(61_000);
    const messageId = findMessageId(`promo-miss${i}`, character.id, h.now(), (roll) => roll > 0.95);
    await h.send({ rawText: '.晋升', userId: A, messageId });
  }
  assert.equal(h.repos.characters.findById(character.id)!.promotionFails, 2);

  // 挑一个「只有连续失败保护生效才会成功」的抽样：区间由公式现算，调数值也不会写死
  h.repos.inventory.add(character.id, '主材料·灰雾结晶', 4, 'unbound', h.now());
  h.advance(61_000);
  // 夹具建出来的角色一定是已入途径的（见 helpers/app.ts 的 createCharacter 校正）
  const state = h.repos.characters.findById(character.id)! as InitiatedCharacter;
  // M2.33：第三个参数是目标序列（P6 落地后成功率要乘 planned[目标序列]）
  const target = state.sequence - 1;
  const withoutBonus = promotionChance(state, 0, target).chance;
  const withBonus = promotionChance(state, NUMERIC.promotion.failStreakThreshold, target).chance;
  assert.ok(withBonus > withoutBonus, '连续失败保护必须真的提高成功率');
  const messageId = findMessageId(
    'promo-protected',
    character.id,
    h.now(),
    (roll) => roll > withoutBonus + 0.005 && roll < withBonus - 0.005,
  );
  const sent = await h.send({ rawText: '.晋升', userId: A, messageId });
  assert.match(sent[0]?.text ?? '', /连续失败保护 10%/);
  assert.equal(h.repos.characters.findById(character.id)!.sequence, 8);
  assert.equal(h.repos.characters.findById(character.id)!.promotionFails, 0);
  h.app.close();
});

test('.休息：MAD-5、HP+20、消耗 1 AP、每日 1 次、可解除失控', async () => {
  const h = createHarness();
  const character = await h.createCharacter(A, '克莱恩');
  h.repos.characters.update({
    ...h.repos.characters.findById(character.id)!,
    mad: 30,
    hp: 50,
    status: 'lost_control',
    updatedAt: h.now(),
  });

  h.advance(11_000);
  const sent = await h.send({ rawText: '.休息', userId: A });
  assert.match(sent[0]?.text ?? '', /疯狂 30 → 25/);
  assert.match(sent[0]?.text ?? '', /生命 50 → 70/);
  assert.match(sent[0]?.text ?? '', /拽了回来/);

  const state = h.repos.characters.findById(character.id)!;
  assert.equal(state.mad, 25);
  assert.equal(state.hp, 70);
  assert.equal(state.status, 'active', '休息是失控的恢复路径之一');

  h.advance(11_000);
  assert.match((await h.send({ rawText: '.休息', userId: A }))[0]?.text ?? '', /今天已经休息过了/);

  h.advance(24 * 60 * 60 * 1000);
  h.repos.characters.update({ ...h.repos.characters.findById(character.id)!, updatedAt: h.now() });
  const next = await h.send({ rawText: '.休息', userId: A });
  assert.match(next[0]?.text ?? '', /生命 70 → 90/, '次日可以再休息');
  h.app.close();
});

test('.休息：战士序列 8 的 HP 上限 +10 生效（能力查表，不硬编码）', async () => {
  const h = createHarness();
  const character = await h.createCharacter(A, '正义', 'warrior');
  h.repos.flags.set(character.id, 'ability_warrior_8', h.now());
  h.repos.characters.update({
    ...h.repos.characters.findById(character.id)!,
    hp: 105,
    mad: 10,
    updatedAt: h.now(),
  });

  h.advance(11_000);
  await h.send({ rawText: '.休息', userId: A });
  assert.equal(h.repos.characters.findById(character.id)!.hp, 110, '上限 110 而不是 100');
  h.app.close();
});

test('.净化：COR-15、MAD-5、消耗材料、每日 1 次', async () => {
  const h = createHarness();
  const character = await h.createCharacter(A, '克莱恩');
  h.repos.inventory.add(character.id, '辅助材料·圣盐', 2, 'bound', h.now());
  h.repos.characters.update({
    ...h.repos.characters.findById(character.id)!,
    cor: 40,
    mad: 30,
    status: 'lost_control',
    updatedAt: h.now(),
  });

  h.advance(11_000);
  const sent = await h.send({ rawText: '.净化', userId: A });
  assert.match(sent[0]?.text ?? '', /污染 40 → 25/);
  assert.match(sent[0]?.text ?? '', /疯狂 30 → 22/);

  const state = h.repos.characters.findById(character.id)!;
  assert.equal(state.cor, 25, 'COR 有下降路径，不再是死循环');
  assert.equal(state.mad, 22, 'W5：净化同时压疯狂（只压污染会让双阈值卡死比例下不来）');
  assert.equal(state.status, 'active');
  assert.equal(h.repos.inventory.count(character.id, '辅助材料·圣盐'), 1);

  h.advance(11_000);
  assert.match((await h.send({ rawText: '.净化', userId: A }))[0]?.text ?? '', /今天已经净化过了/);
  h.app.close();
});

test('.净化：材料不足时拒绝，且不消耗行动点与材料', async () => {
  const h = createHarness();
  const character = await h.createCharacter(A, '克莱恩');
  h.repos.characters.update({
    ...h.repos.characters.findById(character.id)!,
    cor: 40,
    updatedAt: h.now(),
  });

  // 手上一件圣盐都没有 → 拒绝
  h.advance(11_000);
  const sent = await h.send({ rawText: '.净化', userId: A });
  assert.match(sent[0]?.text ?? '', /净化材料不足/);
  const state = h.repos.characters.findById(character.id)!;
  assert.equal(state.cor, 40, '被拒时状态不变');

  // 补上一件材料后就能净化，证明拦住的确实是材料
  h.repos.inventory.add(character.id, '辅助材料·圣盐', 1, 'bound', h.now());
  h.advance(11_000);
  const ok = await h.send({ rawText: '.净化', userId: A });
  assert.match(ok[0]?.text ?? '', /污染 40 → 25/);
  assert.equal(h.repos.inventory.count(character.id, '辅助材料·圣盐'), 0);
  h.app.close();
});

test('.占卜：消耗灵性、写入每日计数、冷却与每日上限生效', async () => {
  const h = createHarness();
  const character = await h.createCharacter(A, '克莱恩');

  h.advance(11_000);
  const first = await h.send({ rawText: '.占卜 我会死在廷根市吗', userId: A });
  assert.match(first[0]?.text ?? '', /你的问题：我会死在廷根市吗/);
  assert.match(first[0]?.text ?? '', /今日剩余占卜：2 次/);
  assert.equal(h.repos.characters.findById(character.id)!.mp, 100 - NUMERIC.divination.mpCost);

  // 冷却（愚者未晋升：30 秒）
  h.advance(11_000);
  assert.match((await h.send({ rawText: '.占卜 再来一次', userId: A }))[0]?.text ?? '', /卜象还没散去/);

  h.advance(NUMERIC.divination.cooldownMs);
  await h.send({ rawText: '.占卜 第三次', userId: A });
  h.advance(NUMERIC.divination.cooldownMs);
  await h.send({ rawText: '.占卜 第四次', userId: A });
  h.advance(NUMERIC.divination.cooldownMs);
  assert.match((await h.send({ rawText: '.占卜 第五次', userId: A }))[0]?.text ?? '', /今天的占卜已经用完了/);
  assert.equal(
    h.app.db
      .prepare("SELECT count FROM daily_counters WHERE key = 'divination'")
      .get() !== undefined,
    true,
  );
  h.app.close();
});

test('.占卜：愚者序列 8 能力让每日多 1 次、冷却减半', async () => {
  const h = createHarness();
  const character = await h.createCharacter(A, '克莱恩');
  h.repos.flags.set(character.id, 'ability_seer_8', h.now());

  for (let i = 0; i < 3; i += 1) {
    h.advance(NUMERIC.divination.cooldownMs / 2 + 1000);
    const sent = await h.send({ rawText: `.占卜 第${i + 1}问`, userId: A });
    assert.match(sent[0]?.text ?? '', /你的问题/, `第 ${i + 1} 次应成功`);
  }
  h.advance(NUMERIC.divination.cooldownMs / 2 + 1000);
  const fourth = await h.send({ rawText: '.占卜 第四问', userId: A });
  assert.match(fourth[0]?.text ?? '', /你的问题/, '有序列 8 能力时每日 4 次');
  h.advance(NUMERIC.divination.cooldownMs / 2 + 1000);
  assert.match((await h.send({ rawText: '.占卜 第五问', userId: A }))[0]?.text ?? '', /今天的占卜已经用完了/);
  h.app.close();
});
