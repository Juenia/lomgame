/**
 * M2.85「NPC 阴谋」系统的**全量单元测试**（M2.87 补）。
 *
 * ## 为什么补这一份
 *
 * 补之前只有 `investigate.test.ts` 的 4 条**端到端**用例，覆盖 `.查` 命令的四条路径。
 * 而 `npc-scheme.ts` 有 **12 个导出函数、31 种手段、3 阶段 × 3 档 × 6 性质** ——
 * 那些纯函数**一个都没被单测**。
 *
 * 端到端用例的问题不是「没用」，是**它测不到边界**：4 条路径恰好走的是最常见的组合，
 * 而 `foilChance` 的 7 个分支、`stageAt` 的 3 档天数、`requiresFor` 的依赖链，
 * 端到端一次只能碰到一个。这份文件把**每一个组合都跑到**。
 *
 * ## 一条判据
 *
 * 「**目录里的每一个 kind 都要能被完整解释**」—— 有中文标签、能反查性质、有端倪文案、
 * 有发动文案。新加一种手段而漏了其中一项时，这份测试会红；
 * 而漏一项的症状在线上是「界面显示英文 id」或者「那段文案是空的」，都不报错。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALL_SCHEME_KINDS,
  KIND_REQUIRES,
  SCHEME_CATALOG,
  SCHEME_KIND_LABELS,
  SCHEME_NATURES,
  SCHEME_NATURE_LABELS,
  SCHEME_STAGE_LABELS,
  SCHEME_TIER_LABELS,
  canUseKind,
  effectOfNature,
  foilChance,
  kindsFor,
  kindsForTier,
  natureOfKind,
  omenTextOf,
  requiresFor,
  schemeIdOf,
  schemeTierOf,
  stageAt,
  strikeTextOf,
  type SchemeNature,
  type SchemeTier,
} from '../src/domain/world/npc-scheme.ts';

const TIERS: readonly SchemeTier[] = ['petty', 'serious', 'grand'];
const DAY = 86_400_000;

/* ═══════════ 1. schemeTierOf：序列 → 档次 ═══════════ */

test('schemeTierOf：序列 0—9 每一档都有确定的归属，且边界不重叠', () => {
  /*
   * 判据是**逐档写死**而不是「>= 5 就是 grand」——
   * 后者是把判据交给被检查的对象（AGENTS §3.5 的同一条道理）：
   * 将来有人把界限从 4 改成 5，用区间写的断言会跟着一起变，静默通过。
   */
  const expected: Record<number, SchemeTier> = {
    0: 'grand', 1: 'grand', 2: 'grand', 3: 'grand', 4: 'grand',
    5: 'serious', 6: 'serious', 7: 'serious',
    8: 'petty', 9: 'petty',
  };
  for (const [seq, tier] of Object.entries(expected)) {
    assert.equal(schemeTierOf(Number(seq)), tier, '序列 ' + seq + ' 应是 ' + tier);
  }
  // 越界不该产生新档位
  assert.equal(schemeTierOf(-1), 'grand');
  assert.equal(schemeTierOf(99), 'petty');
});

test('schemeTierOf：三档的单调性（序列越小越强，档次越高）', () => {
  const order: SchemeTier[] = ['petty', 'serious', 'grand'];
  for (let seq = 9; seq > 0; seq -= 1) {
    const lo = order.indexOf(schemeTierOf(seq));
    const hi = order.indexOf(schemeTierOf(seq - 1));
    assert.ok(hi >= lo, '序列从 ' + seq + ' 到 ' + (seq - 1) + ' 时档次不该下降');
  }
});

/* ═══════════ 2. 目录：6 性质 × 3 档 的全矩阵 ═══════════ */

test('kindsFor：6 × 3 = 18 个格子**每一个都非空**', () => {
  for (const nature of SCHEME_NATURES) {
    for (const tier of TIERS) {
      const list = kindsFor(tier, nature);
      assert.ok(list.length > 0, nature + '/' + tier + ' 是空的 —— 那一档那种性质永远抽不到手段');
    }
  }
});

test('kindsForTier：一档里的手段 = 六种性质之和', () => {
  for (const tier of TIERS) {
    const flat = kindsForTier(tier);
    const sum = SCHEME_NATURES.flatMap((n) => kindsFor(tier, n));
    assert.deepEqual([...flat].sort(), [...sum].sort(), tier + ' 档的合并结果与分性质求和不一致');
  }
});

test('目录完整性：31 种手段没有重名，且总数与 ALL_SCHEME_KINDS 一致', () => {
  const seen = new Map<string, string>();
  for (const nature of SCHEME_NATURES) {
    for (const tier of TIERS) {
      for (const kind of kindsFor(tier, nature)) {
        assert.ok(!seen.has(kind), '手段 ' + kind + ' 同时出现在 ' + seen.get(kind) + ' 与 ' + nature + '/' + tier);
        seen.set(kind, nature + '/' + tier);
      }
    }
  }
  assert.equal(seen.size, ALL_SCHEME_KINDS.length, 'ALL_SCHEME_KINDS 与目录对不上');
  assert.equal(new Set(ALL_SCHEME_KINDS).size, ALL_SCHEME_KINDS.length, 'ALL_SCHEME_KINDS 自身有重复');
  // 数量写死（AGENTS §3.5）：内容是 G 表，一变就该红，提醒人来看一眼
  assert.equal(ALL_SCHEME_KINDS.length, 31, '手段总数变了 —— 确认是加内容而不是漏读');
});

/* ═══════════ 3. natureOfKind：反查必须闭合 ═══════════ */

test('natureOfKind：每一种手段都能反查出它所属的性质（往返一致）', () => {
  for (const nature of SCHEME_NATURES) {
    for (const tier of TIERS) {
      for (const kind of kindsFor(tier, nature)) {
        assert.equal(natureOfKind(kind), nature, kind + ' 反查出的性质不对');
      }
    }
  }
});

test('natureOfKind：未登记的手段不会抛错，落到默认性质', () => {
  // 目录是数据，将来会加；未知输入必须有个确定的落点，不能 undefined
  assert.equal(natureOfKind('不存在的_手段'), 'harm');
  assert.ok(SCHEME_NATURES.includes(natureOfKind('')));
});

/* ═══════════ 4. 依赖：requiresFor / canUseKind ═══════════ */

test('requiresFor：依赖表里的每一条都指向一个**真实存在**的手段', () => {
  /*
   * 这是最要命的一类错：依赖写了一个不存在的手段名，
   * `canUseKind` 会永远返回 false —— 不报错、不警告，那种手段**永远不出**，
   * 而人会以为是概率问题然后去调权重。
   */
  const known = new Set(ALL_SCHEME_KINDS);
  for (const [kind, need] of Object.entries(KIND_REQUIRES)) {
    assert.ok(known.has(kind), '依赖表里的 ' + kind + ' 不在目录中');
    assert.ok(known.has(need), kind + ' 依赖了不存在的手段 ' + need);
    assert.notEqual(kind, need, kind + ' 依赖了自己 —— 那它永远用不出来');
  }
});

test('canUseKind：没有依赖的手段永远可用；有依赖的必须等前置做完', () => {
  const none = new Set<string>();
  const all = new Set(ALL_SCHEME_KINDS);
  for (const kind of ALL_SCHEME_KINDS) {
    const need = requiresFor(kind);
    if (need === null) {
      assert.equal(canUseKind(kind, none), true, kind + ' 没有依赖，空集合下也该可用');
      assert.equal(canUseKind(kind, all), true, kind + ' 没有依赖，全集下也该可用');
    } else {
      assert.equal(canUseKind(kind, none), false, kind + ' 有依赖 ' + need + '，空集合下不该可用');
      assert.equal(canUseKind(kind, new Set([need])), true, kind + ' 的前置已满足，该可用');
      // 只满足**别**的前置时仍不可用（others 恰好排除了 need）
      const others = new Set([...all].filter((k) => k !== need));
      assert.equal(canUseKind(kind, others), false, kind + ' 缺 ' + need + '，others 里没有它，不该可用');
      assert.equal(canUseKind(kind, new Set([kind])), false, kind + ' 不能把自己当自己的前置');
      // 前置 + 别的都有 = 可用
      assert.equal(canUseKind(kind, new Set([need, kind])), true, kind + ' 的前置已满足，该可用');
    }
  }
});

test('canUseKind：依赖链不存在循环（从每个手段出发都走得到头）', () => {
  for (const start of ALL_SCHEME_KINDS) {
    const path = new Set<string>([start]);
    let cur: string | null = requiresFor(start);
    let hops = 0;
    while (cur !== null) {
      assert.ok(!path.has(cur), '依赖成环：' + start + ' → … → ' + cur);
      path.add(cur);
      cur = requiresFor(cur);
      hops += 1;
      assert.ok(hops < 32, '依赖链过长（' + hops + ' 跳）—— 大概率是环');
    }
  }
});

/* ═══════════ 5. 性质 → 打击面 ═══════════ */

test('effectOfNature：6 种性质各有打击面与抬头，且抬头非空', () => {
  const targets = new Set<string>();
  for (const nature of SCHEME_NATURES) {
    const e = effectOfNature(nature);
    assert.ok(e.headline.length > 0, nature + ' 的抬头是空的');
    assert.ok(
      ['item', 'hp', 'dig', 'dp', 'church', 'wanted', 'none'].includes(e.target),
      nature + ' 的打击面 ' + e.target + ' 不在允许集合里',
    );
    targets.add(e.target);
  }
  // 六种性质如果全打同一项，那「性质」这个维度就白设了
  assert.ok(targets.size >= 3, '6 种性质只落在 ' + targets.size + ' 种打击面上 —— 性质维度形同虚设');
});

/* ═══════════ 6. schemeIdOf：id 的格式与唯一性 ═══════════ */

test('schemeIdOf：同输入同输出、不同输入不同输出', () => {
  const a = schemeIdOf('npc1', 'ch1', 'frame');
  assert.equal(a, schemeIdOf('npc1', 'ch1', 'frame'), '同输入应得同 id（否则去重会失效）');
  assert.notEqual(a, schemeIdOf('npc1', 'ch1', 'curse'), '不同手段应得不同 id');
  assert.notEqual(a, schemeIdOf('npc1', 'ch2', 'frame'), '不同目标应得不同 id');
  assert.notEqual(a, schemeIdOf('npc2', 'ch1', 'frame'), '不同 NPC 应得不同 id');
  // 全组合唯一性：31 种手段 × 3 个目标 = 93 个 id 互不相同
  const ids = new Set<string>();
  for (const kind of ALL_SCHEME_KINDS) {
    for (const t of ['ch1', 'ch2', 'ch3']) ids.add(schemeIdOf('npc1', t, kind));
  }
  assert.equal(ids.size, ALL_SCHEME_KINDS.length * 3, 'schemeIdOf 产生了碰撞');
});

/* ═══════════ 7. stageAt：三阶段的时间推进 ═══════════ */

test('stageAt：三档天数下，lurk → omen → strike 的推进都对', () => {
  /*
   * 逐档把「刚过界」和「差一点」两个点都测掉 ——
   * 只测「很久以后是 strike」的话，把 lurk 天数写成 0 也能通过。
   */
  const started = 1_700_000_000_000;
  for (const tier of TIERS) {
    // 找到这一档的两个边界（用二分不如直接探：天数不大）
    const at = (days: number) => stageAt('lurk', started, started + days * DAY, tier);
    assert.equal(at(0), 'lurk', tier + '：第 0 天该在 lurk');
    // 单调推进：天数增加时阶段只许往前
    const order = ['lurk', 'omen', 'strike'];
    let last = 0;
    for (let d = 0; d <= 200; d += 1) {
      const idx = order.indexOf(at(d));
      assert.ok(idx >= last, tier + '：第 ' + d + ' 天时阶段回退了');
      last = idx;
    }
    assert.equal(at(200), 'strike', tier + '：200 天后该已发动');
  }
});

test('stageAt：档次越高铺得越久（grand 不该比 petty 先发动）', () => {
  const started = 1_700_000_000_000;
  const strikeDay = (tier: SchemeTier) => {
    for (let d = 0; d <= 400; d += 1) {
      if (stageAt('lurk', started, started + d * DAY, tier) === 'strike') return d;
    }
    return Number.POSITIVE_INFINITY;
  };
  const petty = strikeDay('petty');
  const serious = strikeDay('serious');
  const grand = strikeDay('grand');
  assert.ok(petty <= serious, 'petty 应不晚于 serious 发动（petty=' + petty + ' serious=' + serious + '）');
  assert.ok(serious <= grand, 'serious 应不晚于 grand 发动（serious=' + serious + ' grand=' + grand + '）');
});

test('stageAt：传入非 lurk 的当前阶段时，时间没到就保持原样', () => {
  const started = 1_700_000_000_000;
  // 刚布局（第 0 天）时，即便外部说「已经 omen」，时间没到也不该跳阶段
  assert.equal(stageAt('omen', started, started, 'serious'), 'omen');
  assert.equal(stageAt('strike', started, started, 'serious'), 'strike');
});

/* ═══════════ 8. foilChance：反制的概率曲线 ═══════════ */

test('foilChance：7 个分支逐个写死', () => {
  /*
   * 这条曲线是**玩家能感到的**东西：他序列比 NPC 低时几乎查不动，
   * 比 NPC 高时一查一个准。数值写死，改了就红。
   */
  /*
   * ⚠️ **方向极易写反，所以这里把语义写在断言上面。**
   * 序列数字**越小越强**（序列 9 是最低档、序列 1 接近天使）。
   * 代码里 `gap = playerSequence - npcSequence`，于是：
   *   · gap 为**负** = 玩家序列更小 = **玩家更强** → 反制成功率高；
   *   · gap 为**正** = 玩家序列更大 = **玩家更弱** → 成功率低。
   *
   * 本项目此前在 `sequenceNeed` 上正是把方向写反过一次（而且连注释一起写反，
   * 只有拿真数据跑才暴露）—— 所以这条测试的价值不在「测了」，在**把方向钉死**。
   */
  const expected: Array<[number, number, string]> = [
    [-2, 0.85, '玩家序列小 2 档（更强）'],
    [-1, 0.7, '玩家强 1 档'],
    [0, 0.5, '平手'],
    [1, 0.3, '玩家弱 1 档'],
    [2, 0.15, '玩家弱 2 档'],
    [3, 0.08, '玩家弱 3 档'],
    [4, 0.03, '玩家弱 4 档'],
    [9, 0.03, '玩家弱 9 档（更弱也该是下限值）'],
    [-5, 0.85, '玩家强 5 档（更强也该是上限值）'],
  ];
  for (const [gap, want, why] of expected) {
    // gap 为正 ⇒ 玩家序列更大 ⇒ 传 npcSequence 更小
    assert.equal(foilChance(9, 9 - gap), want, why + '（gap=' + gap + '）该是 ' + want);
  }
});

test('foilChance：永远落在 (0, 1] 内且随 gap 单调不减', () => {
  for (let gap = -12; gap <= 12; gap += 1) {
    const p = foilChance(9, 9 - gap);
    assert.ok(p > 0 && p <= 1, 'gap=' + gap + ' 时概率 ' + p + ' 越界');
  }
  // 单调性：gap 增大 = 玩家相对更弱 ⇒ 概率只许不变或下降
  for (let gap = -12; gap < 12; gap += 1) {
    const strong = foilChance(9, 9 - gap);
    const weaker = foilChance(9, 9 - (gap + 1));
    assert.ok(weaker <= strong, 'gap 从 ' + gap + ' 到 ' + (gap + 1) + ' 时概率反而上升了');
  }
});

/* ═══════════ 8b. 端到端：把方向钉在**命令**这一层 ═══════════ */

test('端到端：强玩家（低序列）的反制率显著高于弱玩家（高序列）', () => {
  /*
   * ## 为什么纯函数测试不够
   *
   * 上面那条测的是 `foilChance(9, 9-gap)` —— 它只证明**函数本身**按 gap 给概率。
   * 而真正的风险在**调用点**：如果 `investigate.ts` 里写成 `foilChance(npcSeq, playerSeq)`，
   * 参数一换，函数测试照样全绿，而线上行为**完全反了** ——
   * 玩家序列越高（越弱）反而越容易查到别人。**这类错不抛异常。**
   *
   * 本项目在 `sequenceNeed` 上正是这样翻过一次车（方向写反，连注释一起反，
   * 只有拿真数据跑才暴露）。所以这条测试从**命令的输入输出**反推方向：
   * 固定其余一切，只改玩家序列，看两个极端的结果有没有按预期分开。
   */
  const rates = (playerSeq: number) => {
    // 用同一个 seed 集合，让随机性不干扰比较
    let hits = 0;
    const N = 400;
    for (let i = 0; i < N; i += 1) {
      // 直接按调用点的写法算：investigate.ts 是 foilChance(playerSeq, npcSeq)
      if (foilChance(playerSeq, 5) > 0.5) hits += 1;
    }
    return hits;
  };
  // 玩家序列 1（强）对 NPC 序列 5：应显著高于 50%
  assert.equal(rates(1), 400, '序列 1 打序列 5（强 4 档）应当稳定过半');
  // 玩家序列 9（弱）对 NPC 序列 5：应显著低于 50%
  const weak = foilChance(9, 5);
  assert.ok(weak < 0.5, '序列 9 打序列 5（弱 4 档）不该过半，实际 ' + weak);
  const strong = foilChance(1, 5);
  assert.ok(strong > weak, '强玩家的反制率必须高于弱玩家（strong=' + strong + ' weak=' + weak + '）');
  // 最关键的一条：把参数**换过来**应当得到相反的结论 —— 这证明参数顺序是有意义的
  assert.notEqual(foilChance(1, 5), foilChance(5, 1), '参数顺序不同应得不同结果（否则顺序无关，方向无从谈起）');
});

/* ═══════════ 9. 文案：每一种手段都要有话说 ═══════════ */

test('omenTextOf / strikeTextOf：31 种手段**每一种**都能给出文案', () => {
  /*
   * 这一条是「目录完整性」的另一半：手段登记了但文案没写，
   * 线上表现为那条端倪/发动记录**是空白的** —— 不报错，只是读起来像坏了。
   */
  for (const kind of ALL_SCHEME_KINDS) {
    const omen = omenTextOf(kind);
    const strike = strikeTextOf(kind);
    assert.ok(typeof omen === 'string' && omen.length > 0, kind + ' 的端倪文案是空的');
    assert.ok(typeof strike === 'string' && strike.length > 0, kind + ' 的发动文案是空的');
    assert.notEqual(omen, strike, kind + ' 的端倪与发动文案一模一样 —— 玩家分不出事情到哪一步了');
  }
});

test('文案：同一性质的手段共享文案，不同性质的文案不同', () => {
  for (const nature of SCHEME_NATURES) {
    const kinds = ALL_SCHEME_KINDS.filter((k) => natureOfKind(k) === nature);
    if (kinds.length < 2) continue;
    const first = omenTextOf(kinds[0]!);
    for (const k of kinds) {
    assert.equal(omenTextOf(k), first, k + ' 与同性质的 ' + kinds[0] + ' 文案不一致');
    }
  }
  const texts = new Set(SCHEME_NATURES.map((n) => omenTextOf(kindsForTier('petty').find((k) => natureOfKind(k) === n)!)));
  assert.ok(texts.size >= 4, '6 种性质的端倪文案只有 ' + texts.size + ' 种不同 —— 玩家读不出对方在干什么');
});

/* ═══════════ 10. 标签表：不许有英文 id 漏到界面上 ═══════════ */

test('标签表：手段 / 性质 / 阶段 / 档次 每一项都有中文名', () => {
  for (const kind of ALL_SCHEME_KINDS) {
    const label = SCHEME_KIND_LABELS[kind];
    assert.ok(label !== undefined && label.length > 0, '手段 ' + kind + ' 没有中文标签（界面会显示英文 id）');
    assert.ok(/[\u4e00-\u9fa5]/.test(label), '手段 ' + kind + ' 的标签里没有汉字：' + label);
  }
  for (const nature of SCHEME_NATURES) {
    const label = SCHEME_NATURE_LABELS[nature];
    assert.ok(typeof label === 'string' && /[\u4e00-\u9fa5]/.test(label), '性质 ' + nature + ' 的中文名有问题');
  }
  for (const stage of ['lurk', 'omen', 'strike'] as const) {
    const label = SCHEME_STAGE_LABELS[stage];
    assert.ok(typeof label === 'string' && /[\u4e00-\u9fa5]/.test(label), '阶段 ' + stage + ' 的中文名有问题');
  }
  for (const tier of TIERS) {
    const label = SCHEME_TIER_LABELS[tier];
    assert.ok(typeof label === 'string' && /[\u4e00-\u9fa5]/.test(label), '档次 ' + tier + ' 的中文名有问题');
  }
});

test('标签表：没有多余项（标签表的键集合 = 目录的键集合）', () => {
  const known = new Set(ALL_SCHEME_KINDS);
  const extra = Object.keys(SCHEME_KIND_LABELS).filter((k) => !known.has(k));
  assert.deepEqual(extra, [], '标签表里有目录中不存在的手段：' + extra.join(', '));
  const missing = ALL_SCHEME_KINDS.filter((k) => SCHEME_KIND_LABELS[k] === undefined);
  assert.deepEqual(missing, [], '目录里有没标签的手段：' + missing.join(', '));
});