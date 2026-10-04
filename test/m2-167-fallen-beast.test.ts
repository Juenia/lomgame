/**
 * M2.167：**堕落者** —— 从人到非凡生物，以及教会来清理。
 *
 * 用户口径：「NPC 堕落了应该堕落成非凡生物，会袭击人，教会组织等正神的组织会去清理堕落者。」
 * 设计依据：docs/M2.167-堕落者-设计与原作依据.md（每条都标了原作出处）。
 *
 * 这一条守五件事：
 *   ① 数据面：22 个形态都有生物、五层感知齐全、掉落是真实物品、形态 id 都在 forms 里
 *   ② 判定面：**没到 fallen 的人不会异变**（反向自检 —— 少了它「堕落」这个阶段就是装饰）
 *   ③ 数值面：异变概率**接既有的失控公式**（不是另造的一套数字）
 *   ④ 清剿面：**清剿不是猎杀**（差 2 档的闸会让它永不触发 —— 第一版实测 45 天 0 次）
 *   ⑤ 端到端：喂到堕落 → 跑世界 → 它真的变成生物、真的会袭击人
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { FallenBeastFileSchema } from '../src/domain/world/fallen-beast-schema.ts';
import {
  BEAST_ATTACK_PER_HOUR,
  CULL_SQUADS,
  beastSequenceOf,
  cullChance,
  cullOutcome,
  hybridTraits,
  mutationMultiplier,
  npcMutationChance,
  pickFallenBeast,
  squadOf,
  willCull,
  willEngage,
} from '../src/domain/world/fallen-beast.ts';
import { humanOf } from '../src/domain/world/npc-life.ts';
import { createHarness } from './helpers/app.ts';
import { runDailyTick } from '../src/infra/tick.ts';
import { advanceWorld } from '../src/infra/world-tick.ts';

process.env.TEMP = process.env.TEMP ?? 'data/tmp';
const HOUR = 3_600_000;
const BEASTS = new URL('../src/data/fallen-beasts.yaml', import.meta.url);
const FORMS = new URL('../src/cards/lost-control.yaml', import.meta.url);

function loadBeasts() {
  const parsed = FallenBeastFileSchema.safeParse(parse(readFileSync(BEASTS, 'utf8')));
  assert.ok(parsed.success, '堕落生物 schema 不过');
  return parsed.data.fallen_beasts;
}
function loadForms(): Array<{ id: string; pathway: string; name: string; min_seq: number }> {
  const raw = parse(readFileSync(FORMS, 'utf8')) as { forms: Array<{ id: string; pathway: string; name: string; min_seq: number }> };
  return raw.forms;
}

test('M2.167 数据：22 个堕落形态，每一个都指得到形态、都有掉落与五层感知', () => {
  const beasts = loadBeasts();
  assert.equal(beasts.length, 44, '堕落生物条数变了 —— meta.count 与这条断言都要跟着改');
  const formIds = new Set(loadForms().map((f) => f.id));
  for (const beast of beasts) {
    assert.ok(formIds.has(beast.formId), beast.formId + ' 不在 lost-control.yaml 的 forms 里');
    assert.ok(beast.drops.length > 0, beast.formId + ' 没有掉落（原作：怪物是魔药材料的来源）');
    for (const key of ['blur', 'silhouette', 'full', 'advantage', 'essence'] as const) {
      assert.ok(beast.perception[key].length > 0, beast.formId + ' 缺感知层 ' + key);
    }
    assert.ok(beast.flavor.length > 0, beast.formId + ' 缺氛围句');
  }
  /*
   * **每一个形态都要有对应的生物**（44 / 44）—— 22 条途径 × 低/高两档。
   *
   * 少了任何一条的后果不是报错，而是**那个形态的人堕落时不会变成生物**：
   * `pickFallenBeast` 找不到就返回 null，而他每小时都会再掷一次，永远掷不到 ——
   * 于是那类人只是安静地「撑得住」，而报表上看不出任何异常。
   */
  for (const form of loadForms()) {
    assert.ok(beasts.some((b) => b.formId === form.id), '形态 ' + form.id + ' 还没有对应的生物');
  }
});

test('M2.167 判定：**没到 fallen 的人不会异变**（反向自检）', () => {
  // 被碰过 / 动摇 —— 都还没到堕落那一档
  assert.equal(npcMutationChance({ corrupted: 10, sequence: 9 }), 0, '被碰过的人不该异变');
  assert.equal(npcMutationChance({ corrupted: 60, sequence: 9 }), 0, '动摇的人不该异变');
  // 到了 fallen 才有概率，而且**接的是既有那条失控公式**（闸门 65 / divisor 250）
  assert.ok(Math.abs(npcMutationChance({ corrupted: 70, sequence: 9 }) - 5 / 250) < 1e-9);
  assert.ok(Math.abs(npcMutationChance({ corrupted: 100, sequence: 9 }) - 35 / 250) < 1e-9);
  // 序列越高闸门越低（6—4 档是 60）—— 高序列的人更容易撑不住，这是原作那句「序列 4 起极易失控」
  assert.ok(npcMutationChance({ corrupted: 100, sequence: 5 }) > npcMutationChance({ corrupted: 100, sequence: 9 }));
  // 环境：血月 ×2、堕落源 ×3、晋升失败 +0.5/次（显式表，不是拍脑袋的叠加）
  const base = npcMutationChance({ corrupted: 100, sequence: 9 });
  const moon = npcMutationChance({ corrupted: 100, sequence: 9, env: { corruptionSource: false, bloodMoon: true, promotionFails: 0 } });
  const source = npcMutationChance({ corrupted: 100, sequence: 9, env: { corruptionSource: true, bloodMoon: false, promotionFails: 0 } });
  const failed = npcMutationChance({ corrupted: 100, sequence: 9, env: { corruptionSource: false, bloodMoon: false, promotionFails: 2 } });
  assert.ok(Math.abs(moon - base * 2) < 1e-9);
  assert.ok(Math.abs(source - base * 3) < 1e-9);
  assert.ok(Math.abs(failed - base * 2) < 1e-9);
  assert.equal(mutationMultiplier({ corruptionSource: false, bloodMoon: false, promotionFails: 0 }), 1);
});

test('M2.167 挑形态：按他的途径；普通人按蛊惑他那位的途径', () => {
  const beasts = loadBeasts();
  const forms = loadForms().map((f) => ({ id: f.id, pathway: f.pathway, name: f.name, minSeq: f.min_seq, weight: 1 })) as never;
  const rng = { next: () => 0.5 };
  const seer = pickFallenBeast({ beasts, forms, pathways: ['seer'], sequence: 9, rng });
  assert.ok(seer !== null && seer.form.pathway === 'seer', '按自己的途径挑');
  // 没有途径（既不是非凡者、也没被低语过）⇒ 挑不到 —— 他不会变成任何东西
  assert.equal(pickFallenBeast({ beasts, forms, pathways: [], sequence: 9, rng }), null);
  // 转途径者：除了主途径，其余途径的形态名会拼进播报（原作因斯的「八条腿 + 白羽毛」）
  const traits = hybridTraits({ forms, pathways: ['seer', 'door'], primaryPathway: 'seer', sequence: 9 });
  assert.ok(traits.length <= 2);
  assert.equal(hybridTraits({ forms, pathways: ['seer'], primaryPathway: 'seer', sequence: 9 }).length, 0, '单途径不是混合形态');
});

test('M2.167 强度：变成生物之后取**更强的那个**', () => {
  const beast = loadBeasts().find((b) => b.formId === 'seer_foreseer')!;
  assert.equal(beastSequenceOf(4, beast), 4, '序列 4 的人堕落，比形态基线更强');
  assert.equal(beastSequenceOf(9, beast), beast.baseSequence, '凡人堕落按形态基线');
});

test('M2.167 清剿：**不是猎杀** —— 同序列会去，差太远才等精英', () => {
  // 值夜者的编制（原作：红手套最低序列 7）
  assert.equal(willCull('night_goddess'), true);
  assert.equal(squadOf('night_goddess'), '值夜者');
  assert.equal(willCull('earth_mother'), false, '原作没给大地母神非凡编制 —— 她不来');
  assert.equal(willCull('god_of_war'), false);
  assert.equal(CULL_SQUADS['night_goddess']?.eliteMinSeq, 7, '红手套最低序列 7（原作直出）');
  // 同序列会去（这正是第一版漏掉的那一条：差 2 档的闸让它永不触发）
  assert.ok(cullChance(8, 8) > 0.5, '同序列要敢上');
  assert.ok(cullChance(6, 8) > cullChance(8, 8), '更强的更稳');
  assert.ok(cullChance(9, 8) < cullChance(8, 8), '比它弱还去，但更危险');
  assert.equal(willEngage(9, 3), false, '差太远就不上（等精英）');
  assert.equal(willEngage(8, 8), true);
  // 三档结果都能出现（可失败：这不是必胜的判定）
  /*
   * ⚠️ 两次 `rng.next()` 要拿到**不同的值** —— 第一版用一个常数 rng（`next: () => roll`），
   * 于是「失手之后死没死」那一次掷的和「打不打得过」是同一下：
   * 只要 roll ≥ 成功率，第二次必然 ≥ 死亡率 ⇒ **death 那一档永远构造不出来**，
   * 而断言只会说「三档没齐」—— 看上去像代码的问题，其实是判据自己不够。
   */
  const outcomes = new Set<string | null>();
  for (let i = 0; i < 200; i += 1) {
    const rolls = [i / 200, (i % 10) / 10];
    let k = 0;
    const rng = { next: () => rolls[Math.min(k++, rolls.length - 1)]! };
    outcomes.add(cullOutcome({ cullerSequence: 8, beastSequence: 8, rng }));
  }
  assert.ok(outcomes.has('success') && outcomes.has('injury') && outcomes.has('death'), '三档结果都要能出现');
  assert.ok(outcomes.has(null) === false, '同序列不该出现「无人可派」');
  assert.equal(cullOutcome({ cullerSequence: 9, beastSequence: 3, rng: { next: () => 0.1 } }), null, '差太远时不上');
  // 怪物吃人的频率（显式常量，不是散在代码里的字面量）
  assert.ok(BEAST_ATTACK_PER_HOUR > 0 && BEAST_ATTACK_PER_HOUR < 0.5);
  assert.equal(humanOf('thrall'), false);
});

test('M2.167 端到端：喂到堕落 → 变成生物（带原名）→ 会袭击人', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    let now = h.now();
    runDailyTick(deps, now);
    const npc = deps.npcCast.find((n) => n.id === 'cast_tingen_sergeant')!;
    // 被宇宙暗面（error 途径）低语到底 —— 他自己没有途径，所以长成「那条途径的」东西
    deps.npcLife.corrupt(npc.id, 100, 'error');
    let mutated = false;
    for (let i = 0; i < 400 && !mutated; i += 1) {
      now += HOUR;
      advanceWorld(deps, now);
      mutated = deps.npcLife.beastIdOf(npc.id) !== null;
    }
    assert.ok(mutated, '400 小时里没有异变 —— 判定没接上');
    const life = deps.npcLife.of(npc.id)!;
    assert.equal(life.human, false, '变成怪物的不算人了');
    assert.equal(life.alive, true, '他没死 —— 他变成了别的东西');
    const beast = deps.creatures.byId(life.beastId);
    assert.ok(beast !== null, 'creatures 里没有这只生物');
    assert.ok(beast!.speciesId.startsWith('fallen:'), '物种不对：' + beast!.speciesId);
    // 栖息地为空 —— 世界不会自己刷出它（它只由人堕落产生）
    const species = deps.creatureIndex.byId(beast!.speciesId)!;
    assert.deepEqual(species.habitat, [], '堕落生物不该有出生点');
    // 播报带**他原本的名字** —— 这是这一整套设计的恐怖点
    const ev = deps.worldEvents.all().filter((e) => e.id.startsWith('npc-mutation-'));
    assert.ok(ev.length >= 1, '没有异变播报');
    assert.ok(ev[0]!.text.includes(npc.name), '播报里没有他原本的名字：' + ev[0]!.text);
    assert.ok(ev[0]!.text.includes('不再是人了'), '播报要写清他不再是人了');
  } finally {
    h.app.close();
  }
});
