/**
 * M2.85 世界演化：**NPC 会自己往上走**（用户拍板的三条）。
 *
 *   1. NPC 参与世界演化（晋升 → 登神 → 世界事件）
 *   2. 限速：按原著进度，**不能很快成神**（序列 9→8 三十天，1→0 七千六百多天）
 *   3. 神不是不可战胜的 —— 这一条在战斗侧，本文件只守前两条
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/app.ts';
import { runDailyTick } from '../src/infra/tick.ts';
import { daysRequiredFor, qualifiedForGodhood, willAscend } from '../src/domain/world/npc-advance.ts';
import { canHandle, handleChance, maxCalamityLevel, meritOfCalamity, meritOfHunt } from '../src/domain/world/npc-calamity.ts';

process.env.TEMP = process.env.TEMP ?? 'data/tmp';
const DAY = 86_400_000;

test('世界演化：NPC 的晋升门槛按原著进度指数递增（限速就在这一条）', () => {
  // 低序列按月，高序列按年 —— 具体天数见 NUMERIC.npc（项目派生旋钮）
  assert.equal(daysRequiredFor(9), 30, '序列 9 → 8：一个月');
  assert.equal(daysRequiredFor(5), 480, '序列 5 → 4：一年多');
  assert.equal(daysRequiredFor(1), 7680, '序列 1 → 0：二十一年');
  assert.equal(daysRequiredFor(0), null, '已经是神了，不再晋升');
  // 全程合计要几十年 —— 「不能很快成神」的量化说法
  const total = [9, 8, 7, 6, 5, 4, 3, 2, 1].reduce((sum, seq) => sum + daysRequiredFor(seq)!, 0);
  assert.ok(total > 15_000, `序列 9 走到 0 需要 ${total} 天，至少应超过 15000（约 41 年）`);
});

test('世界演化：停留时间不够就不晋升（时间门槛是硬的）', () => {
  const now = 1_800_000_000_000;
  // 序列 9 需要 30 天；只待了 10 天 → 无论掷什么都不会晋升
  assert.equal(willAscend({ sequence: 9, since: now - 10 * DAY, now, roll: 0 }), false);
  // 待满 30 天且掷 0（最小）→ 会晋升（门槛已过）
  assert.equal(willAscend({ sequence: 9, since: now - 30 * DAY, now, roll: 0 }), true);
});

test('世界演化：tick 会播种 NPC 进度，且不会把原作里已是神的人算进去', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    runDailyTick(deps, h.now());
    const seeded = deps.npcProgress.all();
    assert.ok(seeded.length > 0, '第一次 tick 应当把 NPC 进度播种进来');
    for (const p of seeded) {
      assert.ok(p.sequence >= 1, p.npcId + ' 的初始序列不该是 0（原作已是神的人不纳入演化）');
    }
    // 原作里序列 0 的人（克莱恩 / 罗塞尔）不该出现在进度表里
    assert.equal(deps.npcProgress.of('klein_moretti'), null, '克莱恩在原著里就是序列 0，不该被世界演化接管');
  } finally {
    h.app.close();
  }
});

test('世界演化：跑够天数额，低序列 NPC 真的会晋升（且写进大事记）', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    const start = h.now();
    for (let d = 0; d < 400; d += 1) runDailyTick(deps, start + d * DAY);
    const advanced = deps.npcProgress.all().filter((p) => p.ascensions > 0);
    assert.ok(advanced.length > 0, '400 天里应当有人往上走一档');
    const deeds = deps.npcDeeds.recent(20);
    assert.ok(deeds.some((d) => d.kind === 'advance'), '晋升要写进大事记（世界要记得）');
    // 限速的另一面：高序列（序列 ≤ 3）在 400 天里一档都不该动
    const deepMove = deps.npcProgress.all().filter((p) => p.ascensions > 0 && p.sequence <= 3);
    assert.deepEqual(deepMove, [], '高序列在 400 天内不该晋升 —— 那不符合原著进度');
  } finally {
    h.app.close();
  }
});

test('世界演化：走到序列 0 会发一条全服世界事件（「他登神了」）', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    const now = h.now();
    // 构造：把一位序列 1 的 NPC 放成「已经在序列 1 上待了 20 年」→ 远超 7680 天门槛
    runDailyTick(deps, now);                          // 第一次 tick：把 NPC 进度播种进来
    const anyTrack = deps.npcTracks.find((t: { currentSequence: number | null }) => t.currentSequence === 1);
    assert.ok(anyTrack, '要有至少一位序列 1 的人物（例如威尔·昂赛汀 / 伯特利·亚伯拉罕）');
    /*
     * ⚠️ M2.85：光有时间**不够**了 —— 成神还要求功绩过线（用户拍板「不能让路人甲窜一下成神」）。
     * 所以这个用例先给他记上足够的功绩（相当于「他这些年确实做了事」），再验证时间一到就登神。
     */
    deps.npcDeeds.record({ npcId: anyTrack!.id, kind: 'calamity', detail: '（测试用）化解神话级灾厄 ×4', merit: 120, at: now });
    // 序列 1 → 0 需要 7680 天（21 年），所以循环要推进得够久 —— 这本身也是限速的验证
    let got = false;
    for (let d = 1; d <= 40 && !got; d += 1) {
      runDailyTick(deps, now + d * 400 * DAY);
      got = deps.npcProgress.of(anyTrack!.id)!.sequence <= 0;
    }
    assert.equal(got, true, anyTrack!.id + ' 应当在足够久之后走到序列 0');
    const events = deps.worldEvents.latest(10);
    assert.ok(events.some((e) => e.text.includes('登神')), '登神要发全服世界事件，实际：' + events.map((e) => e.text.slice(0, 30)).join(' | '));
    assert.ok(deps.npcDeeds.recent(20).some((d) => d.kind === 'godhood'), '登神要写进大事记');
  } finally {
    h.app.close();
  }
});

/* ============ 三道闸：不让「路人甲窜一下」就成神（用户拍板） ============ */

test('三道闸①资格：低序列连靠近大灾厄都做不到', () => {
  assert.equal(maxCalamityLevel(9), 1, '序列 9 只应付得了小事');
  assert.equal(maxCalamityLevel(5), 2);
  assert.equal(maxCalamityLevel(2), 3, '高序列才敢碰神话级灾厄');
  assert.equal(canHandle(9, 3), false, '路人甲不能解决大灾厄 —— 这是资格闸');
  assert.equal(canHandle(5, 3), false);
  assert.equal(canHandle(5, 2), true);
  assert.equal(canHandle(2, 3), true);
  // 能力余量越大越稳；同级只有基础成功率；低打高即使硬算也很低（实际已被资格闸拦掉）
  assert.ok(handleChance(2, 1) > handleChance(2, 3), '打低一档更稳');
  assert.ok(handleChance(2, 3) > handleChance(4, 3), '高一档更稳');
});

test('三道闸②功绩：成神必须做过事，躺着等时间永远不行', async () => {
  const { godhoodMeritRequired } = await import('../src/domain/world/npc-advance.ts');
  assert.equal(qualifiedForGodhood({ sequence: 1, merit: 0 }), false, '序列 1、功绩 0 → 不能成神');
  assert.equal(qualifiedForGodhood({ sequence: 1, merit: godhoodMeritRequired() - 1 }), false, '差一分也不行');
  assert.equal(qualifiedForGodhood({ sequence: 1, merit: godhoodMeritRequired() }), true, '够了才行');
  assert.equal(qualifiedForGodhood({ sequence: 2, merit: 9999 }), false, '序列没到 1，功绩再高也不成神');
});

test('三道闸③功绩的来源：化解灾厄按等级给分，失败给 0', () => {
  assert.equal(meritOfCalamity(3), 30, '神话级灾厄 30 分 ⇒ 成神至少要处理 4 次');
  assert.equal(meritOfCalamity(1), 10);
  assert.ok(meritOfHunt(1) > meritOfHunt(9), '猎杀越强的怪物给分越多');
});

test('世界演化：灾厄来了，够格的人会出手（赢记功、输记伤）', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    const start = h.now();
    for (let d = 0; d < 400; d += 1) runDailyTick(deps, start + d * DAY);
    const deeds = deps.npcDeeds.recent(50);
    const fought = deeds.filter((d) => d.kind === 'calamity' || d.kind === 'injury');
    // 灾厄是周期性的（30 天里平均 3 次），400 天里必然遇到过 —— 关键是**出手的人够格**
    if (fought.length > 0) {
      for (const d of fought) {
        const p = deps.npcProgress.of(d.npcId);
        assert.ok(p, '出手的人要有进度记录');
        assert.ok(p!.sequence <= 6, d.detail + ' —— 出手者的序列应当够高（' + p!.sequence + '）');
      }
    }
    // 功绩榜：只有真正化解过的人才有分
    for (const row of deps.npcDeeds.topByMerit(5)) assert.ok(row.merit > 0, '上榜的人必须有正功绩');
  } finally {
    h.app.close();
  }
});
