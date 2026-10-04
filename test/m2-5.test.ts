/**
 * M2.5 单测：晋升仪式 + 干扰。
 *
 * 五组：
 *   一、成功率拆解（沿用 W5 公式的恒等式 + 每一项配置都真的生效）
 *   二、多阶段判定（三阶段的失败分支各是一条测试）
 *   三、干扰判定（公式 + 失败代价）
 *   四、指令链路（准备 → 布置 → 开始 → 融合；干扰的每日上限与材料消耗）
 *   五、口径守卫（地点 key 真实存在、数值不越界、W5 的旋钮没被动过）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadLocations } from '../src/data/loader.ts';
import { computePromotionSuccess } from '../src/domain/character/rules.ts';
import { createSeededRng, seedFrom } from '../src/domain/rng.ts';
import {
  interferenceChance,
  materialGradeOf,
  resolveInterference,
  resolveRitualFuse,
  resolveRitualSetup,
  ritualChance,
  type RitualChanceInput,
} from '../src/domain/ritual/index.ts';
import { createHarness, GROUP_ID, DEFAULT_USER } from './helpers/app.ts';

const RITUAL = NUMERIC.ritual;
const INTERFERENCE = NUMERIC.interference;

const LOCATIONS = loadLocations().locations;
const GRAVEYARD = LOCATIONS.find((location) => location.id === 'graveyard_path')!;

/** 一份「中等偏上」的角色状态：既没顶到上限，也没掉到下限 */
function chanceInput(over: Partial<RitualChanceInput> = {}): RitualChanceInput {
  return {
    state: { dig: 80, sequence: 9, mad: 30, cor: 20 },
    fails: 0,
    locationId: 'graveyard_path',
    timeOfDay: 'night',
    weather: 'clear',
    witnessCount: 0,
    mainMaterialId: '主材料·夜之瞳',
    interferenceCount: 0,
    ...over,
  };
}

function joined(replies: ReadonlyArray<{ text: string }>): string {
  return replies.map((reply) => reply.text).join('\n');
}

/* ================= 一、成功率拆解 ================= */

test('M2.5 拆解：五项之和严格等于 W5 的 computePromotionSuccess（沿用原公式）', () => {
  // 挑几组不会撞上下限的状态，逐组比恒等式
  const states = [
    { dig: 80, sequence: 9, mad: 30, cor: 20 },
    { dig: 100, sequence: 9, mad: 0, cor: 0 },
    { dig: 60, sequence: 8, mad: 60, cor: 40 },
    { dig: 95, sequence: 9, mad: 65, cor: 65 },
  ];
  for (const state of states) {
    const breakdown = ritualChance(chanceInput({ state, locationId: null, witnessCount: 0, mainMaterialId: null }));
    const sum = breakdown.base + breakdown.dig + breakdown.sequence + breakdown.mad + breakdown.cor;
    const w5 = computePromotionSuccess(state);
    assert.ok(
      Math.abs(sum - w5) < 1e-9,
      '拆解的前五项必须等于 W5 公式：' + JSON.stringify(state) + ' 拆解 ' + sum + ' vs W5 ' + w5,
    );
  }
});

test('M2.5 拆解：地点 / 时段 / 天气 / 见证 / 材料每一项都真的算进去了', () => {
  const bare = ritualChance(chanceInput({ locationId: null, timeOfDay: 'day', weather: 'clear', witnessCount: 0, mainMaterialId: null, interferenceCount: 0 }));
  const full = ritualChance(chanceInput({ locationId: 'above_grey_fog', timeOfDay: 'night', weather: 'blood_moon', witnessCount: 3, mainMaterialId: '主材料·夜之瞳' }));
  assert.equal(bare.location, 0);
  assert.equal(bare.time, 0);
  assert.equal(bare.weather, 0);
  assert.equal(bare.witness, 0);
  assert.equal(bare.material, 0);
  assert.equal(full.location, RITUAL.locationBonus.above_grey_fog);
  assert.equal(full.time, RITUAL.timeBonus.night);
  assert.equal(full.weather, RITUAL.weatherBonus.blood_moon);
  assert.equal(full.witness, 3 * RITUAL.witnessBonusPer);
  assert.equal(full.material, RITUAL.materialQuality.high);
  assert.ok(full.final > bare.final, '配置齐全必须比裸装更容易成功');
});

test('M2.5 拆解：MAD / COR 惩罚为负且能被单独读出（死循环 UX 缺口的落点）', () => {
  const low = ritualChance(chanceInput({ state: { dig: 80, sequence: 9, mad: 10, cor: 5 } }));
  const high = ritualChance(chanceInput({ state: { dig: 80, sequence: 9, mad: 72, cor: 45 } }));
  assert.ok(low.mad > high.mad, 'MAD 越高惩罚越重');
  assert.ok(high.mad < 0 && high.cor < 0, '惩罚项是负数，能直接显示成 -10.8%');
  assert.ok(Math.abs(high.mad - -0.3 * 0.72) < 1e-9);
  assert.ok(Math.abs(high.cor - -0.15 * 0.45) < 1e-9);
  assert.ok(high.final < low.final, 'MAD/COR 高 → 成功率低（玩家该先去休息/净化）');
});

test('M2.5 拆解：上限 95% 截断，且不会突破 W5 的天花板', () => {
  const maxed = ritualChance(
    chanceInput({
      state: { dig: 100, sequence: 9, mad: 0, cor: 0 },
      locationId: 'above_grey_fog',
      timeOfDay: 'night',
      weather: 'blood_moon',
      witnessCount: 3,
      mainMaterialId: '主材料·夜之瞳',
    }),
  );
  assert.equal(maxed.final, RITUAL.successCap);
  assert.equal(maxed.capped, true);
  assert.ok(RITUAL.successCap <= NUMERIC.promotion.ceil);
});

test('M2.5 拆解：地点加成的 key 全是真实存在的地点（改名不会静默失效）', () => {
  const ids = new Set(LOCATIONS.map((location) => location.id));
  for (const key of Object.keys(RITUAL.locationBonus)) {
    assert.ok(ids.has(key), '仪式地点加成指向了不存在的地点 id：' + key);
  }
});

test('M2.5 拆解：材料成色——夜之瞳 high(+10%)、灰雾结晶 normal(+0%)', () => {
  assert.equal(materialGradeOf('主材料·夜之瞳'), 'high');
  assert.equal(materialGradeOf('主材料·灰雾结晶'), 'normal');
  assert.equal(materialGradeOf(null), 'normal');
  assert.equal(ritualChance(chanceInput({ mainMaterialId: '主材料·夜之瞳' })).material, 0.1);
  assert.equal(ritualChance(chanceInput({ mainMaterialId: '主材料·灰雾结晶' })).material, 0);
});

/* ================= 二、多阶段判定 ================= */

const MATERIALS = [{ itemId: '主材料·夜之瞳', qty: 2 }];

test('M2.5 判定：阶段 1 失败 → 仪式中断，材料损 30%，属性不动', () => {
  // 阶段 1 的成功率是 80%：找一个 roll >= 0.8 的 seed
  let found: ReturnType<typeof resolveRitualSetup> | null = null;
  for (let i = 0; i < 200 && !found; i += 1) {
    const outcome = resolveRitualSetup({
      chance: chanceInput(),
      materials: MATERIALS,
      rng: createSeededRng(seedFrom(['m25', i])),
    });
    if (outcome.interrupted) found = outcome;
  }
  assert.ok(found, '200 个 seed 里总该有一个阶段 1 失败');
  assert.equal(found.reachedStage, 0);
  assert.deepEqual(found.materialLoss, [{ itemId: '主材料·夜之瞳', qty: 1 }], '2 份损 30% = 1 份（向上取整）');
  assert.equal(found.stages.length, 1, '中断时只有阶段 1 的记录');
});

test('M2.5 判定：阶段 2 失败 → 继续，但 reachedStage=1（阶段 3 要 -20%）', () => {
  let stage2Fail: ReturnType<typeof resolveRitualSetup> | null = null;
  let bothPass: ReturnType<typeof resolveRitualSetup> | null = null;
  for (let i = 0; i < 400 && (!stage2Fail || !bothPass); i += 1) {
    const outcome = resolveRitualSetup({
      chance: chanceInput(),
      materials: MATERIALS,
      rng: createSeededRng(seedFrom(['m25-s2', i])),
    });
    if (outcome.interrupted) continue;
    if (outcome.reachedStage === 1) stage2Fail = stage2Fail ?? outcome;
    if (outcome.reachedStage === 2) bothPass = bothPass ?? outcome;
  }
  assert.ok(stage2Fail && bothPass);
  assert.deepEqual(stage2Fail.materialLoss, [], '阶段 2 失败不扣材料');
  assert.equal(stage2Fail.stages.length, 2);
});

test('M2.5 判定：阶段 3 成功 → 序列 -1、全额材料、解锁能力 flag', () => {
  const chance = chanceInput({ state: { dig: 100, sequence: 9, mad: 0, cor: 0 } });
  const fuse = resolveRitualFuse({
    chance,
    setupStage: 2,
    materials: MATERIALS,
    targetSequence: 8,
    flagsToSet: ['ability_seer_8'],
    rng: createSeededRng('m25-fuse-success'),
  });
  assert.equal(fuse.outcome, 'success');
  assert.deepEqual(fuse.materialLoss, MATERIALS, '成功时全额扣除');
  assert.deepEqual(fuse.deltas[0], { type: 'sequence', value: -1 });
  assert.deepEqual(fuse.flagsToSet, ['ability_seer_8']);
  assert.equal(fuse.status, 'active');
});

test('M2.5 判定：阶段 3 失败 → 材料损 50% + 重伤 + MAD +10', () => {
  // 把成功率压到最低（静默 -50%），找一个融合失败的 seed
  const chance = chanceInput({
    state: { dig: 80, sequence: 9, mad: 70, cor: 60 },
    locationId: 'tingen',
    weather: 'silence',
    timeOfDay: 'dawn',
  });
  let fuse: ReturnType<typeof resolveRitualFuse> | null = null;
  for (let i = 0; i < 200 && !fuse; i += 1) {
    const outcome = resolveRitualFuse({
      chance,
      setupStage: 2,
      materials: MATERIALS,
      targetSequence: 8,
      flagsToSet: ['ability_seer_8'],
      rng: createSeededRng(seedFrom(['m25-fuse-fail', i])),
    });
    if (outcome.outcome === 'fail') fuse = outcome;
  }
  assert.ok(fuse, '200 个 seed 里总该有一次融合失败');
  assert.deepEqual(fuse.materialLoss, [{ itemId: '主材料·夜之瞳', qty: 1 }], '2 份损 50% = 1 份');
  assert.equal(fuse.status, 'injured', '失败 = 重伤');
  const mad = fuse.deltas.find((delta) => delta.type === 'mad') as { type: 'mad'; value: number } | undefined;
  assert.equal(mad?.value, RITUAL.stage3FailMad);
  assert.deepEqual(fuse.flagsToSet, [], '失败不该解锁能力');
});

test('M2.5 判定：阶段 2 没稳住时，阶段 3 的成功率要低 20 个百分点', () => {
  const chance = chanceInput({ state: { dig: 80, sequence: 9, mad: 30, cor: 20 } });
  const ok = resolveRitualFuse({ chance, setupStage: 2, materials: MATERIALS, targetSequence: 8, flagsToSet: [], rng: createSeededRng('a') });
  const unstable = resolveRitualFuse({ chance, setupStage: 1, materials: MATERIALS, targetSequence: 8, flagsToSet: [], rng: createSeededRng('a') });
  assert.ok(
    Math.abs(ok.finalChance - unstable.finalChance - Math.abs(RITUAL.stage2FailPenalty)) < 1e-9,
    '阶段 2 失败的代价就是阶段 3 -20%',
  );
});

test('M2.5 判定：同 seed 同输出（可复现）', () => {
  const build = (): string => {
    const setup = resolveRitualSetup({ chance: chanceInput(), materials: MATERIALS, rng: createSeededRng('repro') });
    const fuse = resolveRitualFuse({ chance: chanceInput(), setupStage: setup.reachedStage, materials: MATERIALS, targetSequence: 8, flagsToSet: [], rng: createSeededRng('repro') });
    return JSON.stringify({ setup, fuse });
  };
  assert.equal(build(), build());
});

/* ================= 三、干扰判定 ================= */

test('M2.5 干扰：成功率 = 0.4 + 0.3×(对方 MAD/100)，clamp 在 0.1—0.8', () => {
  assert.ok(Math.abs(interferenceChance(0) - 0.4) < 1e-9);
  assert.ok(Math.abs(interferenceChance(50) - 0.55) < 1e-9);
  // MAD 上限 100 → 0.4 + 0.3 = 0.7；cap 0.8 是安全上限，正常玩到不了（任务书给的公式就是这样）
  assert.ok(Math.abs(interferenceChance(100) - 0.7) < 1e-9);
  assert.ok(interferenceChance(100) <= INTERFERENCE.successCap);
  // MAD 不可能是负数：负值按 0 算（所以实际取值范围是 0.4—0.7，clamp 的 0.1/0.8 只是安全边界）
  assert.equal(interferenceChance(-50), interferenceChance(0));
  assert.ok(interferenceChance(0) >= INTERFERENCE.successMin);
  assert.ok(interferenceChance(80) > interferenceChance(20), '对方越疯越好下手');
});

test('M2.5 干扰：失败时干扰者 COR +5，成功时不受罚', () => {
  const seen = { success: false, fail: false };
  for (let i = 0; i < 200 && !(seen.success && seen.fail); i += 1) {
    const outcome = resolveInterference({ targetMad: 50, rng: createSeededRng(seedFrom(['m25-int', i])) });
    if (outcome.success) {
      seen.success = true;
      assert.deepEqual(outcome.deltas, []);
    } else {
      seen.fail = true;
      assert.deepEqual(outcome.deltas, [{ type: 'cor', value: INTERFERENCE.failCorPenalty }]);
    }
  }
  assert.ok(seen.success && seen.fail, '200 个 seed 里成功与失败都该出现');
});
/* ================= 四、指令链路 ================= */

const USER = '30001';
const RIVAL = '30002';

/** 把角色直接改成「马上能晋升」的状态：DIG 达标、服过魔药、材料备齐 */
function makeReady(h: ReturnType<typeof createHarness>, userId = USER): string {
  const character = h.repos.characters.findByUserId(userId)!;
  h.repos.characters.update({ ...character, dig: 90, mad: 10, cor: 5, status: 'active' });
  h.repos.flags.set(character.id, 'ability_seer_9', h.now());
  h.repos.inventory.add(character.id, '主材料·灰雾结晶', 4, 'unbound', h.now());
  h.repos.inventory.add(character.id, '辅助材料·圣盐', 4, 'unbound', h.now());
  return character.id;
}

async function readyHarness(): Promise<{ h: ReturnType<typeof createHarness>; id: string; rivalId: string }> {
  const h = createHarness();
  await h.createCharacter(USER, '仪式者');
  await h.createCharacter(RIVAL, '搅局者');
  const id = makeReady(h, USER);
  const rivalId = makeReady(h, RIVAL);
  return { h, id, rivalId };
}

test('M2.5 链路：.仪式 准备 给出拆开的成功率预览与 MAD/COR 提示', async () => {
  const { h, id } = await readyHarness();
  try {
    // 把 MAD 抬到会触发提示的水平
    const character = h.repos.characters.findById(id)!;
    h.repos.characters.update({ ...character, mad: 72, cor: 45 });
    const replies = await h.send({ rawText: '.仪式 准备', userId: USER });
    const text = joined(replies);
    assert.match(text, /【仪式 · 准备】/);
    assert.match(text, /基础成功率/, '必须拆开显示');
    assert.match(text, /MAD 惩罚/, '必须能单独看到 MAD 惩罚');
    assert.match(text, /COR 惩罚/, '必须能单独看到 COR 惩罚');
    assert.match(text, /休息/, '要告诉玩家怎么降 MAD');
    assert.match(text, /净化/, '要告诉玩家怎么降 COR');
    assert.match(text, /最终成功率：/);
    assert.equal(h.app.router.deps.pendingMenus.current(id, h.now())?.menuType, 'ritual');
  } finally {
    h.app.close();
  }
});

test('M2.5 链路：布置（地点 / 时间 / 见证）会实时改变预览', async () => {
  const { h } = await readyHarness();
  try {
    const before = joined(await h.send({ rawText: '.仪式 准备', userId: USER }));
    const after = joined(await h.send({ rawText: '.仪式 地点 灰雾之上', userId: USER }));
    // 灰雾之上 +15%：预览要跟着变（不再是「还没选」）
    assert.match(after, /灰雾之上/);
    assert.notEqual(before, after);

    const timed = joined(await h.send({ rawText: '.仪式 时间 夜晚', userId: USER }));
    assert.match(timed, /夜晚/);

    const witnessed = joined(await h.send({ rawText: '.仪式 见证', userId: USER }));
    assert.match(witnessed, /见证人/);
  } finally {
    h.app.close();
  }
});

test('M2.5 链路：.仪式 开始 跑阶段 1/2，进入 running，并匿名播到群里', async () => {
  const { h, id } = await readyHarness();
  try {
    await h.send({ rawText: '.仪式 地点 墓园小径', userId: USER });
    const replies = await h.send({ rawText: '.仪式 开始', scene: 'group', groupId: GROUP_ID, userId: USER });
    const text = joined(replies);
    assert.match(text, /阶段 1 布置/);
    // 阶段 1 可能失败（80%）—— 两种结局都要能自洽
    const running = h.repos.rituals.runningOf(id);
    if (running) {
      assert.match(text, /阶段 2 引导/);
      assert.equal(running.stage >= 1, true);
      assert.match(text, /仪式 融合/, '要告诉玩家下一步');
    } else {
      assert.match(text, /阶段 1 布置/);
      const row = h.repos.rituals.countByStatus();
      assert.equal(row.interrupted ?? 0, 1, '中断要落库');
    }
  } finally {
    h.app.close();
  }
});

test('M2.5 链路：.仪式 融合 结算并落 domain_events（判定 seed 进库）', async () => {
  const { h, id } = await readyHarness();
  try {
    await h.send({ rawText: '.仪式 地点 灰雾之上', userId: USER });
    await h.send({ rawText: '.仪式 开始', userId: USER });
    if (!h.repos.rituals.runningOf(id)) return; // 阶段 1 挂了就没什么可融合的

    const materialBefore = h.repos.inventory.count(id, '主材料·灰雾结晶');
    const replies = await h.send({ rawText: '.仪式 融合', scene: 'group', groupId: GROUP_ID, userId: USER });
    const text = joined(replies);
    assert.match(text, /阶段 3 融合/);
    assert.equal(h.repos.rituals.runningOf(id), null, '融合完就不能再融合一次');

    const events = h.repos.characters.eventsOf(id);
    const ritualEvents = events.filter((event) => event.type.startsWith('ritual_'));
    assert.ok(ritualEvents.length >= 2, '阶段 1/2 与阶段 3 各要落一条 domain_events');
    for (const event of ritualEvents) {
      assert.ok(event.seed && event.seed.length > 0, '每次判定的 seed 必须写进 domain_events');
    }
    assert.ok(
      h.repos.inventory.count(id, '主材料·灰雾结晶') < materialBefore,
      '融合无论成败都要消耗材料（成功全额 / 失败 50%）',
    );
  } finally {
    h.app.close();
  }
});

test('M2.5 链路：.晋升 仍然可用（快速晋升入口没被仪式取代）', async () => {
  const { h, id } = await readyHarness();
  try {
    const replies = await h.send({ rawText: '.晋升', userId: USER });
    const text = joined(replies);
    assert.match(text, /晋升判定/);
    assert.doesNotMatch(text, /未识别指令/);
  } finally {
    h.app.close();
  }
});

test('M2.5 链路：.干扰 要满足「对方在举行仪式 + 每日 1 次 + 消耗圣盐」', async () => {
  const { h, id, rivalId } = await readyHarness();
  try {
    // 对方还没开始仪式 → 拒绝
    const early = joined(await h.send({ rawText: '.干扰 搅局者', userId: USER }));
    assert.match(early, /没有在举行仪式/);

    // 让对方开始仪式（阶段 1 挂了就重来一次）
    let started = false;
    for (let attempt = 0; attempt < 12 && !started; attempt += 1) {
      /*
       * M2.21：**每次重试必须先把注入时钟往前推。**
       *
       * 漏掉这一行的症状是「偶发红」：阶段 1 挂了要重来，而 .仪式 开始 有
       * **1 秒冷却**（读的是注入时钟），harness 的 clock 默认不动 ——
       * 于是第 3 次起全部回「冷却中，请 1 秒后再试」，剩下 10 次尝试**根本没判定**。
       * 那 12 次重试是**假的**：真正有效的只有前两次，全失败概率 0.2 的平方 = 4%。
       * 实测全量跑 3 次红 1 次、40 次抽样红 3 次，与 4% 同量级（见 docs/M2.21-交付说明.md）。
       */
      h.advance(2000);
      await h.send({ rawText: '.仪式 地点 墓园小径', userId: RIVAL });
      await h.send({ rawText: '.仪式 开始', userId: RIVAL });
      started = h.repos.rituals.runningOf(rivalId) !== null;
      if (!started) {
        h.repos.flags.set(rivalId, 'ability_seer_9', h.now());
        h.repos.inventory.add(rivalId, '主材料·灰雾结晶', 4, 'unbound', h.now());
      }
    }
    assert.ok(started, '十几轮里总该有一次撑过阶段 1');

    const saltBefore = h.repos.inventory.count(id, '辅助材料·圣盐');
    const first = joined(await h.send({ rawText: '.干扰 搅局者', userId: USER }));
    assert.match(first, /【干扰/);
    assert.equal(h.repos.inventory.count(id, '辅助材料·圣盐'), saltBefore - INTERFERENCE.materialQty, '要消耗圣盐');

    // 同一天再干扰 → 被每日上限挡住
    const second = joined(await h.send({ rawText: '.干扰 搅局者', userId: USER }));
    assert.match(second, /今天已经干扰过|上限/);
    assert.equal(h.repos.rituals.countInterferencesSince(id, 0), 1, '上限是硬约束，第二次不该落库');
  } finally {
    h.app.close();
  }
});

test('M2.5 链路：干扰成功 → 对方的仪式配置记上一次干扰（阶段 3 会 -20%）', async () => {
  const { h, id, rivalId } = await readyHarness();
  try {
    // 让「仪式者」先把仪式开起来（阶段 1 挂了就重来）
    let started = false;
    for (let attempt = 0; attempt < 12 && !started; attempt += 1) {
      h.advance(2000); // 同上一处：先跨过 1 秒冷却，重试才是真的重试
      await h.send({ rawText: '.仪式 地点 墓园小径', userId: USER });
      await h.send({ rawText: '.仪式 开始', userId: USER });
      started = h.repos.rituals.runningOf(id) !== null;
      if (!started) {
        h.repos.flags.set(id, 'ability_seer_9', h.now());
        h.repos.inventory.add(id, '主材料·灰雾结晶', 4, 'unbound', h.now());
      }
    }
    assert.ok(started, '总该有一次撑过阶段 1');

    // 搅局者反复尝试（成功率 0.4—0.7，跨天绕开每日上限，机制上必然能成一次）
    for (let attempt = 0; attempt < 20 && h.repos.rituals.countInterferenceSuccess() === 0; attempt += 1) {
      h.advance(24 * 60 * 60 * 1000);
      const rival = h.repos.characters.findByUserId(RIVAL)!;
      h.repos.inventory.add(rival.id, '辅助材料·圣盐', 1, 'unbound', h.now());
      h.repos.characters.update({ ...rival, });
      // 跨天之后旧仪式的干扰窗口早过了，必须重新开一场
      // （顺带把产品里的超时清理路径也走一遍：.仪式 取消 + 重开）
      await h.send({ rawText: '.仪式 取消', userId: USER });
      await h.send({ rawText: '.仪式 地点 墓园小径', userId: USER });
      h.repos.flags.set(id, 'ability_seer_9', h.now());
      h.repos.inventory.add(id, '主材料·灰雾结晶', 4, 'unbound', h.now());
      await h.send({ rawText: '.仪式 开始', userId: USER });
      const live = h.repos.rituals.runningOf(id);
      if (!live || (live.startedAt ?? 0) + NUMERIC.interference.windowMs <= h.now()) continue;
      await h.send({ rawText: '.干扰 仪式者', userId: RIVAL });
    }

    assert.ok(h.repos.rituals.countInterferenceSuccess() > 0, '20 次尝试里总该成功一次');
    const ritual = h.repos.rituals.runningOf(id)!;
    assert.ok(ritual.config.interferenceCount >= 1, '被干扰次数要写进仪式配置，阶段 3 才会 -20%');
  } finally {
    h.app.close();
  }
});

/* ================= 五、口径守卫 ================= */

test('M2.5 口径：W5 / M2.1 / M2.2 的旋钮本轮一个都没动', () => {
  assert.equal(NUMERIC.promotion.base, 0.7);
  assert.equal(NUMERIC.promotion.madPenalty, 0.3);
  assert.equal(NUMERIC.promotion.corPenalty, 0.15);
  assert.equal(NUMERIC.promotion.digThreshold, 60);
  assert.equal(NUMERIC.play.exposureChance, 0.38);
  assert.equal(NUMERIC.lossOfControl.madThreshold, 65);
  assert.equal(NUMERIC.lossOfControl.corThreshold, 65);
  assert.equal(NUMERIC.world.weather.effects.blood_moon.exploreDanger, 1.4);
});

test('M2.5 口径：仪式上限不超过 W5 的天花板，且三阶段成功率与任务书一致', () => {
  assert.equal(RITUAL.stage1Base, 0.8);
  assert.equal(RITUAL.stage2Base, 0.7);
  assert.equal(RITUAL.stage2FailPenalty, -0.2);
  assert.equal(RITUAL.stage1FailMaterialLoss, 0.3);
  assert.equal(RITUAL.stage3FailMaterialLoss, 0.5);
  assert.equal(RITUAL.stage3FailMad, 10);
  assert.equal(RITUAL.witnessBonusPer, 0.03);
  assert.equal(RITUAL.witnessMax, 3);
  assert.equal(RITUAL.successCap, 0.95);
  assert.equal(INTERFERENCE.dailyLimit, 1);
  assert.equal(INTERFERENCE.baseSuccess, 0.4);
  assert.equal(INTERFERENCE.failCorPenalty, 5);
  assert.equal(INTERFERENCE.targetPenalty, -0.2);
});