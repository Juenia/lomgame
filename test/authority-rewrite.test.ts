/**
 * **权柄全链路（M2.87）** —— 「让玩家直白感受到神明权柄的强大」。
 *
 * 用户的要求：
 *
 * > 「神明的权柄是能够影响整个世界的，这点你要设计的让玩家都能直白的感受到神明权柄的强大」
 *
 * 「直白地感受到」= 三件事同时成立：
 *   ① **看得见**（`.世界` 里的【神明出手】栏）；
 *   ② **摸得到**（日常动作被改写：禁令 / 理智 / 物价 / 遭遇）；
 *   ③ **不是一闪而过**（持续一段时间的处境）。
 *
 * ## 这份测试最重要的一条
 *
 * **`banCommand` 的值必须是真实存在的命令名。**
 * 写错一个字的症状是：权柄照常生效、日志照常打、天气照常变 ——
 * **而那条禁令永远不触发**。不报错。
 * 所以这里把 YAML 里的值与 `router.register()` 的命令表**交叉核对**。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { createHarness } from './helpers/app.ts';
import { applyAuthority } from '../src/infra/authority.ts';
import {
  AUTHORITY_KIND_LABELS,
  activeAuthorities,
  applyPriceFactor,
  commandBanAt,
  encounterRateAt,
  hoursLeft,
  madRateAt,
  priceFactorAt,
} from '../src/domain/world/authority-effects.ts';

interface Auth { id: string; pathway: string; name: string; effects: Array<{ kind: string; value: string }> }
const AUTHORS: Auth[] = (
  parseYaml(readFileSync(new URL('../src/data/authorities.yaml', import.meta.url), 'utf8')) as {
    authorities: Auth[];
  }
).authorities;

/** 从 commands/index.ts 里取真实注册的命令名 —— 不抄第二份清单 */
function registeredCommands(): Set<string> {
  const src = readFileSync(new URL('../src/router/commands/index.ts', import.meta.url), 'utf8');
  const names = new Set<string>();
  for (const m of src.matchAll(/router\.register\('([^']+)'/g)) names.add(m[1]!);
  return names;
}

/* ═══════════ 1. 数据层 ═══════════ */

test('每一条权柄都有天气以外的改写（不许只改天气）', () => {
  // M2.91：条数从 22 起只会往上（一条途径可以有多条权柄）—— 判据守的是「每一条」
  assert.ok(AUTHORS.length >= 22, '权柄条数不该少于途径数：' + AUTHORS.length);
  const naked = AUTHORS.filter((a) => a.effects.length === 0).map((a) => a.id);
  assert.deepEqual(naked, [], '这些权柄仍然只会改天气：' + naked.join(', '));
});

test('⚠️ banCommand 的值必须是**真实注册的命令**', () => {
  /*
   * 这条是整份文件里最要紧的一条。
   * 写错一个字的症状是：权柄照常生效、天气照常变、日志照常打，
   * **而那条禁令永远不触发** —— 排查时人会去怀疑概率，不会怀疑拼写。
   */
  const known = registeredCommands();
  assert.ok(known.size >= 40, '没能从 commands/index.ts 读到命令表（' + known.size + ' 条）');
  const bad: string[] = [];
  for (const a of AUTHORS) {
    for (const e of a.effects) {
      if (e.kind !== 'banCommand') continue;
      for (const cmd of e.value.split('|').map((s) => s.trim()).filter((s) => s.length > 0)) {
        if (!known.has(cmd)) bad.push(a.id + ' 禁了一条不存在的命令：' + cmd);
      }
    }
  }
  assert.deepEqual(bad, [], bad.join('；'));
});

test('⚠️ 不许禁掉「世界 / 状态 / 帮助 / 菜单」—— 那是可用性底线', () => {
  /*
   * 玩家必须永远能搞清楚发生了什么。把 `.世界` 也禁掉，
   * 权柄就从「强大」变成了「游戏坏了」—— 他连是谁在出手都看不见。
   */
  const sacred = ['世界', '状态', '帮助', '菜单'];
  for (const a of AUTHORS) {
    for (const e of a.effects) {
      if (e.kind !== 'banCommand') continue;
      for (const cmd of e.value.split('|').map((s) => s.trim())) {
        assert.ok(!sacred.includes(cmd), a.id + ' 禁掉了 ' + cmd + ' —— 那会让玩家看不见是谁在出手');
      }
    }
  }
});

test('每个用到的 kind 都有中文名（否则界面显示英文 id）', () => {
  for (const a of AUTHORS) {
    for (const e of a.effects) {
      const label = AUTHORITY_KIND_LABELS[e.kind];
      assert.ok(label !== undefined, a.id + ' 的 ' + e.kind + ' 没有中文名');
      assert.ok(/[\u4e00-\u9fa5]/.test(label), a.id + ' 的 ' + e.kind + ' 中文名里没有汉字');
    }
  }
});

test('数值型 kind 的值都能解析成合法数字', () => {
  for (const a of AUTHORS) {
    for (const e of a.effects) {
      if (e.kind === 'banCommand') continue;
      const n = Number(e.value);
      assert.ok(Number.isFinite(n) && n > 0, a.id + ' 的 ' + e.kind + ' 值不合法：' + e.value);
    }
  }
});

/* ═══════════ 2. 读取器（各处共用这一层） ═══════════ */

const fake = (rows: Array<[string, string]>) => ({
  overrideValueOf: (kind: string, _scope: string, _now: number) =>
    rows.find(([k]) => k === kind)?.[1] ?? null,
  activeOverrides: (_now: number) =>
    rows.map(([kind, value]) => ({ kind, scope: '*', value, until: 9_999_999_999_999, source: 'authority:x' })),
});

test('commandBanAt：命中才拦，没命中放行；支持 | 分隔多命令', () => {
  const r = fake([['banCommand', '占卜|查']]);
  assert.equal(commandBanAt(r, 'tingen', '占卜', 0), '占卜|查', '该命中');
  assert.equal(commandBanAt(r, 'tingen', '查', 0), '占卜|查', '第二个也该命中');
  assert.equal(commandBanAt(r, 'tingen', '探索', 0), null, '不在名单里该放行');
  assert.equal(commandBanAt(r, 'tingen', '占卜术', 0), null, '必须完全匹配，不许前缀命中');
  // 没有地点时一律放行（不知道人在哪，不该瞎拦）
  assert.equal(commandBanAt(r, null, '占卜', 0), null);
});

test('madRateAt：默认 1，脏值退回 1，上限压住', () => {
  assert.equal(madRateAt(fake([]), 'tingen', 0), 1, '没有覆盖时是 1');
  assert.equal(madRateAt(fake([['madRate', '1.5']]), 'tingen', 0), 1.5);
  assert.equal(madRateAt(fake([['madRate', '乱写的']]), 'tingen', 0), 1, '解析不了退回 1，不许变 NaN');
  assert.equal(madRateAt(fake([['madRate', '-3']]), 'tingen', 0), 1, '负数退回 1');
  assert.equal(madRateAt(fake([['madRate', '999']]), 'tingen', 0), 4, '上限 4 —— 神明不该一次按死玩家');
  assert.equal(madRateAt(fake([['madRate', '0.01']]), 'tingen', 0), 0.1, '下限 0.1');
});

test('priceFactorAt / applyPriceFactor：至少 1 便士（否则是刷钱漏洞）', () => {
  assert.equal(priceFactorAt(fake([]), 'tingen', 0), 1);
  assert.equal(priceFactorAt(fake([['priceFactor', '0.6']]), 'tingen', 0), 0.6);
  assert.equal(applyPriceFactor(100, 0.6), 60);
  assert.equal(applyPriceFactor(1, 0.6), 1, '打折也不能低于 1 便士');
  assert.equal(applyPriceFactor(0, 0.6), 1, '0 也要抬到 1');
});

test('encounterRateAt：0 是合法值（可以完全没有遭遇）', () => {
  assert.equal(encounterRateAt(fake([]), 'tingen', 0), 1);
  assert.equal(encounterRateAt(fake([['encounterRate', '0']]), 'tingen', 0), 0, '0 合法 —— 那一带暂时安全');
  assert.equal(encounterRateAt(fake([['encounterRate', '1.8']]), 'tingen', 0), 1.8);
  assert.equal(encounterRateAt(fake([['encounterRate', '-1']]), 'tingen', 0), 1, '负数退回 1');
});

test('activeAuthorities：按来源归并（同一个权柄的多条覆盖算一条）', () => {
  const reader = {
    overrideValueOf: () => null,
    activeOverrides: () => [
      { kind: 'weather', scope: '*', value: 'storm', until: 1000, source: 'authority:a' },
      { kind: 'madRate', scope: '*', value: '1.5', until: 1000, source: 'authority:a' },
      { kind: 'banCommand', scope: '*', value: '占卜', until: 1000, source: 'authority:a' },
      { kind: 'weather', scope: '*', value: 'clear', until: 2000, source: 'authority:b' },
      // 非权柄来源（GM 手写）不该出现在「神明出手」栏里
      { kind: 'weather', scope: '*', value: 'fog', until: 3000, source: 'gm:manual' },
    ],
  };
  const got = activeAuthorities(reader, 0);
  assert.equal(got.length, 2, '该归并成 2 条（gm 那条不算）');
  const a = got.find((x) => x.source === 'authority:a')!;
  assert.equal(a.kinds.length, 3, 'a 有 3 个维度');
  assert.ok(a.kinds.includes('weather') && a.kinds.includes('madRate') && a.kinds.includes('banCommand'));
  assert.ok(!got.some((x) => x.source.startsWith('gm:')), 'GM 手写的不该混进神明出手');
});

test('hoursLeft：说人话', () => {
  const h = 3_600_000;
  assert.equal(hoursLeft(1000, 2000), '即将结束');
  assert.equal(hoursLeft(30 * 60_000, 0), '不到一小时');
  assert.equal(hoursLeft(4 * h, 0), '约 4 小时');
});

/* ═══════════ 3. 端到端：真权柄真的改得动世界 ═══════════ */

test('端到端：把真表里的权柄逐条落库，禁令与倍率都读得回来', () => {
  const h = createHarness();
  try {
    const now = h.now();
    const world = h.app.router.deps.world;
    const list = h.app.router.deps.authorities ?? [];
    // M2.91：条数不再写死（扩表后一条途径有多条）—— 这里要的是「全部都落库」
    assert.ok(list.length >= 22, 'harness 里该有权柄：' + list.length);
    assert.equal(list.length, AUTHORS.length, 'harness 里的权柄与 yaml 里的条数不一致');
    for (const a of list) applyAuthority(world, a, now);
    /*
     * ⚠️ 22 条权柄**同时**落库是刻意的最坏情况：
     * 它们都往 `kind='banCommand'` + `scope='*'` 写，所以这里同时在验
     * 「多条禁令并存时取并集」—— 取最新会让先写的那条无声失效。
     */
    for (const a of list) {
      for (const e of a.effects) {
        if (e.kind === 'banCommand') {
          const first = e.value.split('|')[0]!.trim();
          const got = commandBanAt(world, 'tingen', first, now);
          assert.ok(got !== null && got.includes(first),
            a.id + ' 的禁令读不回来（22 条并存时该取并集）：' + String(got));
        }
      }
    }
    // 倍率类取最新一条 —— 由最后写入的那条决定，但必须是个合法值
    for (const a of list) {
      for (const e of a.effects) {
        if (e.kind === 'banCommand') continue;
        const got = e.kind === 'madRate' ? madRateAt(world, 'tingen', now)
          : e.kind === 'priceFactor' ? priceFactorAt(world, 'tingen', now)
            : encounterRateAt(world, 'tingen', now);
        assert.ok(Number.isFinite(got) && got > 0, a.id + ' 的 ' + e.kind + ' 读出来不合法：' + got);
      }
    }
    // 神明出手栏读得到东西
    const active = activeAuthorities(world, now);
    assert.ok(active.length >= 1, '【神明出手】栏该有内容');
  } finally {
    h.app.close();
  }
});

test('端到端：禁令真的能拦住一条命令（走完整的 router.handle）', async () => {
  /*
   * 前面测的是读取器，这一条测的是**接线**：
   * 从玩家发一句话，到被权柄拦下，中间不能有断点。
   */
  const h = createHarness();
  try {
    const now = h.now();
    const deps = h.app.router.deps;
    const me = await h.createCharacter('880001', '曾经', 'seer');
    const world = deps.world;
    // 把愚弄落到玩家所在的地点
    /*
     * ⚠️ 与 router 里**同一套取法**：先 currentLocationId，再退到 currentCityId。
     * 本 harness 的角色 `currentLocationId` 是 null（只有 currentCityId='tingen'），
     * 用 `!` 断言会骗过类型检查，然后在库上撞 NOT NULL。
     */
    const ch = deps.characters.findById(me.id)!;
    const here = ch.currentLocationId ?? ch.currentCityId ?? null;
    assert.ok(here !== null, '前置：角色必须有个地点');
    const seer = (deps.authorities ?? []).find((a) => a.id === 'authority_seer')!;
    world.setOverride({ kind: 'banCommand', scope: here, value: '占卜', until: now + 6 * 3_600_000, source: 'authority:authority_seer' }, now);
    const out = await h.send({ rawText: '.占卜', userId: '880001', messageId: 'ban1' });
    const text = out.map((m) => m.text).join('\n');
    assert.ok(text.includes('压着') || text.includes('做不成'), '该被权柄拦下：' + text.slice(0, 160));
    assert.ok(text.includes('世界'), '该告诉玩家去哪看是谁在出手');
    // 白名单命令不受影响
    const ok = await h.send({ rawText: '.状态', userId: '880001', messageId: 'ban2' });
    assert.ok(!ok.map((m) => m.text).join('').includes('压着'), '.状态 必须永远可用');
  } finally {
    h.app.close();
  }
});

test('端到端：没被权柄覆盖的地方不受影响（scope 生效）', async () => {
  const h = createHarness();
  try {
    const now = h.now();
    const deps = h.app.router.deps;
    await h.createCharacter('880002', '曾经', 'seer');
    // 只覆盖**另一个**地点 —— 这样玩家所在处不该受影响
    const elsewhere = deps.locations.all().map((l) => l.id).find((id) => id !== 'tingen' && id !== 'old_dock') ?? 'pritz';
    deps.world.setOverride({ kind: 'banCommand', scope: elsewhere, value: '占卜', until: now + 3_600_000, source: 'authority:authority_seer' }, now);
    assert.equal(commandBanAt(deps.world, 'tingen', '占卜', now), null, '前提：廷根没被覆盖');
    assert.ok(commandBanAt(deps.world, elsewhere, '占卜', now) !== null, '前提：那个地点被覆盖了');
    const out = await h.send({ rawText: '.占卜', userId: '880002', messageId: 'scope1' });
    assert.ok(!out.map((m) => m.text).join('').includes('压着'), '别的地方不该被拦');
  } finally {
    h.app.close();
  }
});
/* ═══════════ 4. 读点接线：权柄真的改得动玩家的数字 ═══════════ */

test('priceFactor 接线：`.商店` 的价签真的按当地权柄变（买与卖都变）', async () => {
  /*
   * 前面测的是「读取器能读出值」，这一条测的是**真的有人在用它**。
   * 两者的差别就是这个项目里反复出现的那类 bug：
   * **内容写了、世界没变** —— 不报错，日志里还看得见那条权柄事件。
   */
  const h = createHarness();
  try {
    const now = h.now();
    const deps = h.app.router.deps;
    const shop = (deps.shops ?? [])[0];
    assert.ok(shop !== undefined, '得有至少一家商店');
    const me = await h.createCharacter('870001', '曾经', 'seer');
    deps.db.prepare('UPDATE characters SET current_location_id = ? WHERE id = ?').run(shop.locationId, me.id);
    deps.inventory.add(me.id, '便士', 500, 'unbound', now);
    const read = async (cmd: string, id: string) =>
      (await h.send({ rawText: cmd, userId: '870001', messageId: id }))
        .map((m) => m.text).join('\n').replace(/[\u200B-\u200D\uFEFF]/g, '');
    const before = await read('.商店', 'x1');
    // 让物价打六折（「滋长」）
    deps.world.setOverride(
      { kind: 'priceFactor', scope: shop.locationId, value: '0.6', until: now + 3_600_000, source: 'authority:authority_mother' },
      now,
    );
    const after = await read('.商店', 'x2');
    // 抽出第一件商品的价签对比
    const pennyOf = (text: string): number | null => {
      const m = /(\d+)\s*便士/.exec(text);
      if (m) return Number(m[1]);
      const s = /(\d+)\s*苏勒/.exec(text);
      return s ? Number(s[1]) * 12 : null;
    };
    const b = pennyOf(before);
    const a = pennyOf(after);
    assert.ok(b !== null && a !== null, '两边都该有价签');
    assert.ok(a < b, '权柄生效后该更便宜：' + b + ' → ' + a);
  } finally {
    h.app.close();
  }
});

test('priceFactor 接线：倍率为 1 时价格与不加权柄完全一致', async () => {
  const h = createHarness();
  try {
    const now = h.now();
    const deps = h.app.router.deps;
    const shop = (deps.shops ?? [])[0];
    const me = await h.createCharacter('870002', '曾经', 'seer');
    deps.db.prepare('UPDATE characters SET current_location_id = ? WHERE id = ?').run(shop.locationId, me.id);
    const read = async (id: string) =>
      (await h.send({ rawText: '.商店', userId: '870002', messageId: id }))
        .map((m) => m.text).join('\n').replace(/[\u200B-\u200D\uFEFF]/g, '');
    const a = await read('y1');
    deps.world.setOverride(
      { kind: 'priceFactor', scope: shop.locationId, value: '1', until: now + 3_600_000, source: 'authority:test' },
      now,
    );
    const b = await read('y2');
    assert.equal(a, b, '倍率 1 不该改变任何价签');
  } finally {
    h.app.close();
  }
});
/* ═══════════ 5. madRate 接线：唯一数值入口 ═══════════ */

test('madRate 接线：当地权柄真的改疯狂涨幅（乘在唯一的数值入口上）', async () => {
  /*
   * 乘在 `applyFor` 里是刻意的 —— 那是全项目唯一的数值入口，
   * 于是「这一带疯狂涨得快」不需要在几十处 delta 生成点里各写一遍。
   */
  const h = createHarness();
  try {
    const now = h.now();
    const deps = h.app.router.deps;
    const { applyFor } = await import('../src/router/commands/common.ts');
    const me = await h.createCharacter('860001', '曾经', 'seer');
    const ch = deps.characters.findById(me.id)!;
    const here = ch.currentLocationId ?? ch.currentCityId ?? null;
    assert.ok(here !== null, '角色得有个地点');
    // 把 MAD 抬到中间，免得撞 0/100 的下限掩盖真实效果
    deps.characters.update({ ...ch, mad: 50 });
    const gain = (v: number): number => {
      const cur = deps.characters.findById(me.id)!;
      const r = applyFor(deps, cur, [{ type: 'mad', value: v }], '测试', now);
      return r.newState.mad - cur.mad;
    };
    assert.equal(gain(4), 4, '无权柄时该是原值');
    deps.world.setOverride(
      { kind: 'madRate', scope: here, value: '2', until: now + 3_600_000, source: 'authority:authority_apothecary' },
      now,
    );
    assert.equal(gain(4), 8, 'madRate 2 时该翻倍');
    /*
     * ⚠️ 这一条是设计判断：**只放大正的 mad**。
     * 连负的一起乘的话，`madRate = 2` 会变成「涨一倍、休息也降一倍」——
     * 那等于权柄没有净效果，只是把刻度尺换了。
     */
    assert.equal(gain(-4), -4, '降低的那一侧**不该**被放大');
    deps.world.setOverride(
      { kind: 'madRate', scope: here, value: '0.5', until: now + 3_600_000, source: 'authority:authority_sun' },
      now,
    );
    assert.equal(gain(4), 2, 'madRate 0.5 时该减半');
  } finally {
    h.app.close();
  }
});

test('madRate 接线：倍率再低也不会把一次涨幅抹成 0', async () => {
  /*
   * 抹成 0 的话，「这一带疯狂不会涨」就成了一条**隐性无敌** ——
   * 而它应该是「涨得慢」，不是「不涨」。
   */
  const h = createHarness();
  try {
    const now = h.now();
    const deps = h.app.router.deps;
    const { applyFor } = await import('../src/router/commands/common.ts');
    const me = await h.createCharacter('860002', '曾经', 'seer');
    const ch = deps.characters.findById(me.id)!;
    const here = ch.currentLocationId ?? ch.currentCityId ?? null;
    deps.characters.update({ ...ch, mad: 50 });
    deps.world.setOverride(
      { kind: 'madRate', scope: here as string, value: '0.1', until: now + 3_600_000, source: 'authority:test' },
      now,
    );
    const cur = deps.characters.findById(me.id)!;
    const r = applyFor(deps, cur, [{ type: 'mad', value: 1 }], '测试', now);
    assert.ok(r.newState.mad > cur.mad, '1 点涨幅在 0.1 倍率下也该至少涨 1');
  } finally {
    h.app.close();
  }
});
/* ═══════════ 6. encounterRate 接线：遭遇率 ═══════════ */

test('encounterRate 接线：当地权柄真的改遭遇率（而且 clamp 在 [0,1]）', async () => {
  /*
   * 用 `rollEncounter` 返回的 **chance 字段**断言，而不是靠统计命中率 ——
   * 后者要跑几千次才稳定，而前者一次就能说清「倍率到底有没有乘上去」。
   *
   * ⚠️ 数值型权柄最容易出的错不是「没生效」，是**越界**：
   * 概率被乘过 1 之后，`roll >= chance` 的判定会**反过来** ——
   * 从「更容易遇到」变成「永远遇不到」。所以这条同时守着 clamp。
   */
  const h = createHarness();
  try {
    const now = h.now();
    const deps = h.app.router.deps;
    const { rollEncounter } = await import('../src/domain/creature/perception.ts');
    const { createSeededRng } = await import('../src/domain/rng.ts');
    const me = await h.createCharacter('850001', '曾经', 'seer');
    const ch = deps.characters.findById(me.id)!;
    /*
     * 候选取真表里的一只 —— 用真数据而不是造一只假生物：
     * 造假的会在 `encounterChance` 读 `habits` / `pathwayAffinity` 时炸，
     * 而那种炸法测的是「我的假对象对不对」，不是「接线通不通」。
     */
    /*
     * 候选的构造与 `creature-hooks.ts` 的 `candidatesAt` **完全一致**：
     * 先取地点上的实例，再按 `speciesId` 查物种。
     * 不一致的话这条测的就成了「我的假对象对不对」，而不是「接线通不通」。
     */
    const here0 = deps.characters.findById(me.id)!.currentLocationId
      ?? deps.characters.findById(me.id)!.currentCityId;
    let candidates: Array<{ creature: never; species: never }> = [];
    for (const loc of [here0, ...deps.locations.all().map((l) => l.id)]) {
      if (loc === null || loc === undefined) continue;
      const built = deps.creatures.atLocation(loc)
        .map((cr) => ({ creature: cr, species: deps.creatureIndex.byId(cr.speciesId) }))
        .filter((x) => x.species !== undefined && x.species !== null);
      if (built.length > 0) { candidates = built as never; break; }
    }
    assert.ok(candidates.length > 0, '得找到一个有生物的地点');
    const rollWith = (mult: number | undefined) =>
      rollEncounter({
        state: ch,
        candidates,
        world: { night: false, foggy: false, ...(mult === undefined ? {} : { rateMultiplier: mult }) },
        rng: createSeededRng('test-seed'),
      }).chance;
    const base = rollWith(undefined);
    assert.ok(base > 0, '前置：这只生物的基础遭遇率该大于 0');
    assert.equal(rollWith(1), base, '倍率 1 时该与不传一模一样');
    assert.ok(Math.abs(rollWith(3) - Math.min(1, base * 3)) < 1e-9, '倍率 3 该是三倍（未越界时）');
    assert.equal(rollWith(0), 0, '倍率 0 时该完全遇不到 —— 0 是合法值（那一带暂时安全）');
    // 越界保护：一个很大的倍率不该让概率超过 1
    assert.ok(rollWith(100) <= 1, '概率被乘过 1 会让判定反过来：' + rollWith(100));
    assert.equal(rollWith(100), 1, '越界时该 clamp 到 1');
  } finally {
    h.app.close();
  }
});

test('encounterRate 接线：`.探索` 走的是同一条路（readSighting 真的读了权柄）', async () => {
  /*
   * 上一条测的是 `rollEncounter` 本身。这一条测**调用点有没有把倍率传进去** ——
   * 两者的区别就是这个项目里反复出现的那类 bug：函数对了，但没人给它那个参数。
   */
  const h = createHarness();
  try {
    const now = h.now();
    const deps = h.app.router.deps;
    const me = await h.createCharacter('850002', '曾经', 'seer');
    const ch = deps.characters.findById(me.id)!;
    const here = ch.currentLocationId ?? ch.currentCityId ?? null;
    assert.ok(here !== null);
    const { encounterRateAt } = await import('../src/domain/world/authority-effects.ts');
    assert.equal(encounterRateAt(deps.world, here, now), 1, '前置：本来没有覆盖');
    deps.world.setOverride(
      { kind: 'encounterRate', scope: here as string, value: '3', until: now + 3_600_000, source: 'authority:authority_hunter' },
      now,
    );
    assert.equal(encounterRateAt(deps.world, here, now), 3, '覆盖之后读得到 3');
    // 这条链路只要读得到，runSighting 就会把它传进 rollEncounter（那一行是直连的）
    const src = await import('node:fs').then((m) =>
      m.readFileSync(new URL('../src/router/commands/creature-hooks.ts', import.meta.url), 'utf8'),
    );
    assert.ok(
      src.includes('rateMultiplier: encounterRate'),
      '调用点必须把 encounterRate 传进 rollEncounter —— 少了这一句，权柄就只是「看得见」',
    );
  } finally {
    h.app.close();
  }
});