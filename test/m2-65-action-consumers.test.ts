/**
 * M2.65：**行动效果的下家** —— 把「有落点」验成「真的动了一样东西」。
 *
 * ## 这份文件守什么
 *
 * M2.38 立了一条判据：每条行动的 `effect` 都必须在 `ACTION_FIELD_EFFECTS` 里。
 * 那条判据的漏洞在 M2.65 被测出来了：**它只问「表里有没有这个 field」，不问「有没有人读它」**。
 * 实测那段时间里 `loot` / `nextAttack` / `eventDelay` / `divinationDaily`
 * **四个标记一个消费者都没有**，另有 10 个 field 停在 `pending` —— 十四件事全是空的，
 * 而审计表把它们显示成「有落点」。
 *
 * 这份文件的四层，逐层都比「表里有」更硬：
 *
 * | 层 | 判据 | 抓的是 |
 * | --- | --- | --- |
 * | **名册** | mark 落点必须在 `ACTION_MARK_READERS` 里，item 落点必须在 `ACTION_ITEM_PLANNERS` 里 | 「登记了却没人读」 |
 * | **数值** | 每条 buff/produce 的 payload 都读得到一个数 | 「配置里写了 0.4、跑起来是 1」 |
 * | **件数** | 每条 `consume: N` 的行动，计划扣的**正好 N 件** | 「写了消耗、一件都没扣」 |
 * | **端到端** | `.行动` → 背包 / 行动点 / 标记 / 战斗结算真的变了 | 「函数对了、接线没接」 |
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ACTION_FIELD_EFFECTS,
  ACTION_MARKS,
  ACTION_MARK_READERS,
  actionEffectKeyOf,
  actionMarkFlag,
  auditActionEffects,
  battleActionMarks,
  markValueOf,
} from '../src/domain/menu/pathway-action-resolve.ts';
import { ACTION_ITEM_PLANNERS, planActionItems } from '../src/domain/menu/pathway-action-items.ts';
import { PATHWAY_ACTIONS } from '../src/domain/menu/pathway-actions.ts';
import { battleSpeciesViewOf, resolveBattleRound } from '../src/domain/battle/index.ts';
import type { BattleState } from '../src/domain/battle/types.ts';
import type { CharacterState } from '../src/domain/character/types.ts';
import { loadCreatures, loadItems } from '../src/data/loader.ts';
import { FLAG_LOCATION } from '../src/infra/db/flags.ts';
import { createHarness } from './helpers/app.ts';

/* ================================================================== *
 * 夹具
 * ================================================================== */

/** 永远掷出 0：命中率高于 0 的攻击必中（与 m2-9 的 RNG_SOURCES.low 同一手法） */
const RNG_LOW = { next: () => 0 };

function makeCharacter(patch: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'c-m265',
    userId: 'u-m265',
    name: '验的人',
    pathway: 'warrior',
    sequence: 8,
    pathwayStatus: 'initiated',
    gender: 'male',
    hp: 100,
    mp: 60,
    mad: 20,
    cor: 0,
    dig: 0,
    dp: 0,
    status: 'active',
    promotionFails: 0,
    currentCityId: 'tingen',
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

function makeBattle(patch: Partial<BattleState> = {}): BattleState {
  const base: BattleState = {
    id: 'b-m265',
    characterId: 'c-m265',
    creatureId: 'whisperer-1',
    speciesId: 'whisperer',
    speciesName: '低语者',
    creatureSequence: 8,
    creatureDying: false,
    world: {
      locationId: 'old_dock',
      locationName: '老码头',
      night: false,
      danger: 2,
      weatherHitPenalty: 0,
      weatherLabel: '晴',
    },
    round: 1,
    status: 'active',
    playerHp: 100,
    playerMp: 60,
    playerStatuses: [],
    playerDefensePenalty: 0,
    creatureHp: 999,
    creatureMaxHp: 999,
    creatureStatuses: [],
    creatureBerserk: false,
    creatureEvolved: false,
    creatureShield: false,
    allyCalled: false,
    allyArrivesAtRound: null,
    allyCount: 0,
    creaturePlayingDead: false,
    negateCreatureActions: 0,
    negatePlayerActions: 0,
    isPvp: false,
    opponentCharacterId: null,
    opponentName: null,
    turnOf: 'challenger' as const,
    pendingAction: null,
    foresight: null,
    lastPlayerDamage: 0,
    startedAt: 0,
    lastRoundAt: 0,
    resolvedAt: null,
  };
  return { ...base, ...patch, world: { ...base.world, ...(patch.world ?? {}) } };
}

const CREATURES = loadCreatures().creatures;
const WHISPERER = CREATURES.find((species) => species.id === 'whisperer')!;

/** 生物这一回合就做这一件事（不让 AI 掷骰 —— 这条测的是倍率，不是 AI） */
const CREATURE_ATTACKS = { kind: 'attack' as const, label: '攻击', note: '' };

/* ================================================================== *
 * 一、名册：每一个落点都必须有人读
 * ================================================================== */

test('M2.65 名册：mark 落点必须有读取函数，item 落点必须有计划函数', () => {
  for (const [field, spec] of Object.entries(ACTION_FIELD_EFFECTS)) {
    if (spec.to === 'mark') {
      assert.ok(ACTION_MARKS[spec.mark], field + ' 指向的标记 ' + spec.mark + ' 不在 ACTION_MARKS 里');
      assert.equal(
        typeof ACTION_MARK_READERS[spec.mark],
        'function',
        field + ' 的标记 ' + spec.mark + ' 没有读取函数 —— 那就是「写了没人读」',
      );
    }
    if (spec.to === 'item') {
      assert.equal(
        typeof ACTION_ITEM_PLANNERS[spec.effect],
        'function',
        field + ' 的物品落点 ' + spec.effect + ' 没有计划函数',
      );
    }
  }
});

test('M2.65 名册（K23 反向用例）：名册是**有边界**的 —— 幽灵标记读不到读取函数', () => {
  /*
   * K23：写下判据之后先拿「已知会失败」的输入试一次。
   * 这里要证明的是上面那条断言**不是恒真**的 —— 表里没有的键，查出来必须是 undefined。
   */
  const table = ACTION_MARK_READERS as Readonly<Record<string, unknown>>;
  assert.equal(table['这个标记不存在'], undefined);
  assert.equal(ACTION_MARKS['exploreDanger' as never] !== undefined, true, '对照侧：真标记查得到');
});

test('M2.65：42 条行动一条 pending 都没有了（M2.38 时是 10 条）', () => {
  const rows = auditActionEffects(PATHWAY_ACTIONS);
  assert.deepEqual(rows.filter((row) => row.status !== 'handled').map((row) => row.actionId + ':' + row.status), []);
});

test('M2.65 数值：payload 里写了数的行动，resolver 必须读得到那个数', () => {
  /*
   * 「读不到数」的表现是 `markValueOf` 悄悄退回中性值 —— 配置里写 0.4、跑起来 1，
   * 而回执、审计、测试**全都不会红**（K10 的形状）。这条用一个哨兵值把它抓出来。
   *
   * ⚠️ 判据只对**写了数**的 payload 生效：`lootGrant` / `freeExplore` 这类
   * 「存在即生效」的标记本来就没写数（见下一条断言）。
   */
  const SENTINEL = -12345;
  const NUMERIC_KEYS = ['value', 'multiplier', 'penalty', 'turns'];
  const numeric = PATHWAY_ACTIONS.filter(
    (action) => action.effect.kind === 'buff' || action.effect.kind === 'produce',
  );
  const offenders: string[] = [];
  let checked = 0;
  for (const action of numeric) {
    const payload = (action.effect.payload ?? {}) as Readonly<Record<string, unknown>>;
    const spec = ACTION_FIELD_EFFECTS[actionEffectKeyOf(payload)];
    if (spec === undefined || spec.to === 'item') continue;
    if (!NUMERIC_KEYS.some((key) => payload[key] !== undefined)) continue;
    checked += 1;
    if (markValueOf(payload, SENTINEL) === SENTINEL) offenders.push(action.id);
  }
  assert.deepEqual(offenders, [], '这些行动的 payload 里写了数，resolver 却读不到 —— 效果会静默失效');
  assert.ok(checked >= 10, '对照侧：真的检了足够多的行动（实际 ' + checked + ' 条）');
});

test('M2.65 数值：不写数的标记只能是「存在即生效」的那一类（中性值 0）', () => {
  /*
   * 反过来的一半：payload 里一个数都没有时，`markValueOf` 会退回中性值。
   * 那个中性值必须是 0（=「没有这件事」）——
   * 若某条标记的中性值是 1（倍率类），退回 1 就等于「什么都没发生」，
   * 于是整条行动变成了纯文案（M2.38 之前那 21 条行动就是这个样子）。
   */
  const NUMERIC_KEYS = ['value', 'multiplier', 'penalty', 'turns'];
  for (const action of PATHWAY_ACTIONS) {
    if (action.effect.kind !== 'buff' && action.effect.kind !== 'produce') continue;
    const payload = (action.effect.payload ?? {}) as Readonly<Record<string, unknown>>;
    const spec = ACTION_FIELD_EFFECTS[actionEffectKeyOf(payload)];
    if (spec === undefined || spec.to !== 'mark') continue;
    if (NUMERIC_KEYS.some((key) => payload[key] !== undefined)) continue;
    assert.equal(
      ACTION_MARKS[spec.mark].neutral,
      0,
      action.id + ' 没写数，而它的标记中性值是 ' + ACTION_MARKS[spec.mark].neutral + ' —— 退回中性就等于没效果',
    );
  }
});

test('M2.65 件数：每条 consume: N 的行动，计划真扣 N 件（一份「什么都有」的背包）', () => {
  const items = loadItems().items;
  /*
   * 「什么都有」的背包：十份每一种物品（十份是为了让「同一件连扣两件」也能成立）。
   * 注意 `便士` 也在里面 —— 它**不该**被自动挑走，这条同时是那个判据的对照侧。
   */
  const slots = items.map((item) => ({ itemId: item.id, quantity: 10 }));
  const offenders: string[] = [];
  for (const action of PATHWAY_ACTIONS) {
    const payload = (action.effect.payload ?? {}) as Readonly<Record<string, unknown>>;
    const want = Number(payload.consume ?? 0);
    if (!Number.isFinite(want) || want <= 0) continue;
    const plan = planActionItems({ payload, items, slots });
    if (!plan.ok) {
      offenders.push(action.id + '：计划不成立（' + plan.reason + '）');
      continue;
    }
    const total = plan.picks.reduce((sum, pick) => sum + pick.qty, 0);
    if (total !== want) offenders.push(action.id + '：写了消耗 ' + want + ' 件，计划扣 ' + total + ' 件');
  }
  assert.deepEqual(offenders, []);
  assert.ok(PATHWAY_ACTIONS.some((a) => Number((a.effect.payload as never as Record<string, unknown>)?.consume ?? 0) > 0),
    '对照侧：内容表里确实有带 consume 的行动（否则上面那条是空转）');
});

/* ================================================================== *
 * 二、物品侧：计划是纯函数，且挑得有理
 * ================================================================== */

const ITEMS = loadItems().items;
const held = (...ids: string[]) => ids.map((itemId) => ({ itemId, quantity: 1 }));

test('M2.65 物品：自动挑物按「材料 → 消耗品 → 杂物」，货币与封印物不参与', () => {
  const payload = { consume: 1, grant: 'freeExplore' };
  // 背包里同时有便士、材料、杂物 —— 该挑材料
  const plan = planActionItems({
    payload,
    items: ITEMS,
    slots: held('便士', '淬火匕首', '主材料·灰雾结晶'),
  });
  assert.ok(plan.ok, plan.reason);
  assert.equal(plan.picks.length, 1);
  assert.equal(plan.picks[0]!.itemId, '主材料·灰雾结晶', '材料最不心痛，应当先被挑走');
});

test('M2.65 物品：点名的东西不在身上 → 整条行动不发生（不是「换一件」）', () => {
  const plan = planActionItems({
    payload: { consume: 1, grant: 'freeExplore' },
    items: ITEMS,
    slots: held('主材料·灰雾结晶'),
    named: ['淬火匕首'],
  });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /淬火匕首/);
  assert.deepEqual(plan.picks, [], '被拒时不许扣任何东西');
});

test('M2.65 物品：改装 → 产出复合 id 的改制品（P16 的变体机制）', () => {
  const plan = planActionItems({
    payload: { consume: 1, variant: true },
    items: ITEMS,
    slots: held('淬火匕首'),
  });
  assert.ok(plan.ok, plan.reason);
  assert.deepEqual(plan.picks, [{ itemId: '淬火匕首', qty: 1 }]);
  assert.deepEqual(plan.grants, [{ itemId: '淬火匕首#retrofit', quantity: 1, bindType: 'unbound' }]);
  const product = ITEMS.find((item) => item.id === '淬火匕首#retrofit');
  assert.ok(product, '产物必须真的在物品表里（加载期展开的变体）');
  assert.equal(product!.baseId, '淬火匕首');
});

test('M2.65 物品：总装 → 原物品 + from 指的那一件，两件合一件', () => {
  const plan = planActionItems({
    payload: { consume: 2, grant: 'assembled', qty: 1 },
    items: ITEMS,
    slots: held('铜哨', '符咒·定身'),
  });
  assert.ok(plan.ok, plan.reason);
  assert.deepEqual(
    plan.picks.slice().sort((a, b) => (a.itemId < b.itemId ? -1 : 1)),
    [{ itemId: '符咒·定身', qty: 1 }, { itemId: '铜哨', qty: 1 }],
  );
  assert.deepEqual(plan.grants, [{ itemId: '铜哨#assembled', quantity: 1, bindType: 'unbound' }]);
});

test('M2.65 物品：两件装不到一起时明确拒绝（不硬造一件东西出来）', () => {
  const plan = planActionItems({
    payload: { consume: 2, grant: 'assembled' },
    items: ITEMS,
    slots: held('潮湿的火柴', '黑纱手套'),
  });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /装不到一起/);
});

test('M2.65 物品：手上没有可改装的东西 → 拒绝（而不是白拿一次）', () => {
  const plan = planActionItems({
    payload: { consume: 1, variant: true },
    items: ITEMS,
    slots: held('主材料·灰雾结晶'),
  });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /没有能改装的东西/);
});

/* ================================================================== *
 * 三、标记的作用域与读取
 * ================================================================== */

test('M2.65 标记：当日作用域不带地点，地点作用域带地点与日期', () => {
  assert.equal(actionMarkFlag('divinationDaily', 'tingen', '2026-01-01'), 'action:divinationDaily::2026-01-01');
  assert.equal(actionMarkFlag('lootGrant', 'tingen', '2026-01-01'), 'action:lootGrant::2026-01-01');
  assert.equal(actionMarkFlag('exploreDanger', 'tingen', '2026-01-01'), 'action:exploreDanger:tingen:2026-01-01');
});

test('M2.65 标记：战斗侧三条一次读全，读不到就是中性值', () => {
  const store = new Map<string, string>();
  const read = (flag: string) => store.get(flag) ?? null;

  const empty = battleActionMarks(read, 'tingen', '2026-01-01');
  assert.deepEqual(empty, { nextAttack: 1, guardDamage: 1, enemyDamage: 0 }, '没有标记时三项都必须是中性的');

  store.set('action:nextAttack:tingen:2026-01-01', '1.5');
  store.set('action:guardDamage:tingen:2026-01-01', '0.5');
  store.set('action:enemyDamage:tingen:2026-01-01', '0.4');
  assert.deepEqual(battleActionMarks(read, 'tingen', '2026-01-01'), {
    nextAttack: 1.5,
    guardDamage: 0.5,
    enemyDamage: 0.4,
  });
  // 换天 / 换地点都读不到 —— 键自带作用域与过期
  assert.deepEqual(battleActionMarks(read, 'tingen', '2026-01-02'), { nextAttack: 1, guardDamage: 1, enemyDamage: 0 });
  assert.deepEqual(battleActionMarks(read, 'backlund', '2026-01-01'), { nextAttack: 1, guardDamage: 1, enemyDamage: 0 });
});

/* ================================================================== *
 * 四、战斗侧：三条标记真的改了结算
 * ================================================================== */

test('M2.65 战斗：nextAttack 提高第一次出手的伤害，并且**用完即消**', () => {
  const plain = resolveBattleRound(makeCharacter(), makeBattle(), { kind: 'attack' }, RNG_LOW, {
    species: battleSpeciesViewOf(WHISPERER),
    creatureAction: CREATURE_ATTACKS,
  });
  const boosted = resolveBattleRound(
    makeCharacter(),
    makeBattle(),
    { kind: 'attack' },
    RNG_LOW,
    {
      species: battleSpeciesViewOf(WHISPERER),
      creatureAction: CREATURE_ATTACKS,
      action: { nextAttack: 2 },
    },
  );
  assert.ok(plain.playerDamageDealt > 0, '对照侧：不带标记也打得出伤害');
  assert.ok(
    boosted.playerDamageDealt > plain.playerDamageDealt,
    '带 nextAttack ×2 的伤害必须更高（' + boosted.playerDamageDealt + ' vs ' + plain.playerDamageDealt + '）',
  );
  assert.deepEqual(boosted.consumedActionMarks, ['nextAttack'], '用掉了就要回报（命令层据此删 flag）');
  assert.deepEqual(plain.consumedActionMarks, [], '没挂标记时不许回报任何东西 —— 否则会误删别人的标记');
});

test('M2.65 战斗：guardDamage 让自己挨的那一下变轻，并且用完即消', () => {
  const plain = resolveBattleRound(makeCharacter(), makeBattle(), { kind: 'defend' }, RNG_LOW, {
    species: battleSpeciesViewOf(WHISPERER),
    creatureAction: CREATURE_ATTACKS,
  });
  const guarded = resolveBattleRound(
    makeCharacter(),
    makeBattle(),
    { kind: 'defend' },
    RNG_LOW,
    {
      species: battleSpeciesViewOf(WHISPERER),
      creatureAction: CREATURE_ATTACKS,
      action: { guardDamage: 0.5 },
    },
  );
  assert.ok(plain.creatureDamageDealt > 0, '对照侧：它打得到你');
  assert.ok(
    guarded.creatureDamageDealt < plain.creatureDamageDealt,
    '立阵之后挨的伤害必须更少（' + guarded.creatureDamageDealt + ' vs ' + plain.creatureDamageDealt + '）',
  );
  assert.deepEqual(guarded.consumedActionMarks, ['guardDamage']);
});

test('M2.65 战斗（对手侧）：foe 的三条方向相反，且分两个数组回报', () => {
  /*
   * PVP 的结算永远以发起者为 player 侧，所以应战者的标记必须走 `action.foe` ——
   * 方向全部对着发起者：它提高对手的出手伤害、削减你打出去的那一下。
   * 这一条守的是「两侧都要接」：只接一侧的话，同一招在两边表现不一样。
   */
  const plain = resolveBattleRound(makeCharacter(), makeBattle(), { kind: 'attack' }, RNG_LOW, {
    species: battleSpeciesViewOf(WHISPERER),
    creatureAction: CREATURE_ATTACKS,
  });
  const pressed = resolveBattleRound(makeCharacter(), makeBattle(), { kind: 'attack' }, RNG_LOW, {
    species: battleSpeciesViewOf(WHISPERER),
    creatureAction: CREATURE_ATTACKS,
    action: { foe: { guardDamage: 0.5 } },
  });
  assert.ok(
    pressed.playerDamageDealt < plain.playerDamageDealt,
    '对手挂的减伤必须作用在**你打出去**的那一下上',
  );
  assert.deepEqual(pressed.consumedActionMarks, [], '对手的标记不该记在自己头上');
  assert.deepEqual(pressed.consumedFoeMarks, ['guardDamage'], '对手侧的标记要单独回报（删的是他的 flag）');

  // ⚠️ 对照侧必须也是「防御」那一回合：防御本身就把挨的伤害减半，拿攻击回合当基线会得出反向结论
  const plainDefend = resolveBattleRound(makeCharacter(), makeBattle(), { kind: 'defend' }, RNG_LOW, {
    species: battleSpeciesViewOf(WHISPERER),
    creatureAction: CREATURE_ATTACKS,
  });
  const foeAttack = resolveBattleRound(makeCharacter(), makeBattle(), { kind: 'defend' }, RNG_LOW, {
    species: battleSpeciesViewOf(WHISPERER),
    creatureAction: CREATURE_ATTACKS,
    action: { foe: { nextAttack: 2 } },
  });
  assert.ok(
    foeAttack.creatureDamageDealt > plainDefend.creatureDamageDealt,
    '对手挂的出手倍率必须作用在**他打出来**的那一下上（' +
      foeAttack.creatureDamageDealt + ' vs ' + plainDefend.creatureDamageDealt + '）',
  );
  assert.deepEqual(foeAttack.consumedFoeMarks, ['nextAttack']);
});

test('M2.65 战斗：enemyDamage 削减对方这一次出手，并且用完即消', () => {
  const plain = resolveBattleRound(makeCharacter(), makeBattle(), { kind: 'defend' }, RNG_LOW, {
    species: battleSpeciesViewOf(WHISPERER),
    creatureAction: CREATURE_ATTACKS,
  });
  const pressed = resolveBattleRound(
    makeCharacter(),
    makeBattle(),
    { kind: 'defend' },
    RNG_LOW,
    {
      species: battleSpeciesViewOf(WHISPERER),
      creatureAction: CREATURE_ATTACKS,
      action: { enemyDamage: 0.5 },
    },
  );
  assert.ok(pressed.creatureDamageDealt < plain.creatureDamageDealt);
  assert.deepEqual(pressed.consumedActionMarks, ['enemyDamage']);
});
/* ================================================================== *
 * 五、端到端：.行动 真的动了东西
 * ================================================================== */

/** 把角色调到某个序列（解锁口径：`entry.seq >= 角色序列`） */
function setSequence(h: ReturnType<typeof createHarness>, id: string, sequence: number): void {
  const current = h.repos.characters.findById(id)!;
  h.repos.characters.update({ ...current, sequence, pathwayStatus: 'initiated' });
}

test('M2.65 端到端：.行动 改装 —— 背包里真的换了一件东西', async () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const who = await h.createCharacter('920001', '改装的人', 'perfect');
    setSequence(h, who.id, 5);
    h.repos.inventory.add(who.id, '淬火匕首', 1, 'unbound', h.now());
    h.advance(61_000);

    const text = (await h.send({ rawText: '.行动 改装 淬火匕首', userId: '920001' }))
      .map((message) => message.text)
      .join(String.fromCharCode(10));
    assert.match(text, /改装/, '回执要认这次行动。实际：' + text.slice(0, 200));

    assert.equal(h.repos.inventory.count(who.id, '淬火匕首'), 0, '原物品必须被扣掉（M2.29 起它一直是白拿的）');
    assert.equal(h.repos.inventory.count(who.id, '淬火匕首#retrofit'), 1, '改制品必须进背包');

    const gains = h.app.db
      .prepare("SELECT payload FROM domain_events WHERE type = 'item_gain'")
      .all() as Array<{ payload: string }>;
    assert.equal(gains.length, 1, '产出要留痕');
    assert.match(gains[0]!.payload, /retrofit/);
  } finally {
    h.app.close();
  }
});

/*
 * M2.85：perfect.schedule（排程，「消耗一件物品换回本日 1 点行动点」）随行动值一并下线。
 * 原来这里还有两条端到端：「.行动 排程 换回 1 点」「行动点满时被当面拒掉」——
 * 它们守的机制已经不存在了，随行动值一并删除。
 */

test('M2.65 端到端：秘偶代行 → 这一趟偶人替你走，标记用完即消（M2.85：不再提行动点）', async () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const who = await h.createCharacter('920004', '带偶人的人', 'seer');
    setSequence(h, who.id, 5);
    h.repos.inventory.add(who.id, '主材料·灰雾结晶', 1, 'unbound', h.now());
    h.advance(61_000);

    await h.send({ rawText: '.行动 秘偶代行', userId: '920004' });
    const flags = h.repos.flags.list(who.id);
    const mark = flags.find((flag) => flag.startsWith('action:freeExplore:tingen:'));
    assert.ok(mark, '秘偶代行要留下免行动点的标记。实际标记：' + flags.join('、'));

    h.advance(61_000);
    const text = (await h.send({ rawText: '.探索 tingen', userId: '920004' }))
      .map((message) => message.text)
      .join(String.fromCharCode(10));
    assert.match(text, /偶人替你去了/, '回执要说清这一趟是偶人走的。实际：' + text.slice(0, 200));
    // M2.85：探索已不扣任何点，原来那段「事件流里没有 ap_delta」的断言随行动值一并删除
    assert.equal(h.repos.flags.value(who.id, mark!), null, '标记用完即消（否则它会变成永久加成）');
  } finally {
    h.app.close();
  }
});

test('M2.65 端到端：威慑 → 本地点这一次不出事件，标记用完即消', async () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const who = await h.createCharacter('920005', '威慑的人', 'warrior');
    setSequence(h, who.id, 6);
    h.advance(61_000);

    await h.send({ rawText: '.行动 威慑', userId: '920005' });
    const flags = h.repos.flags.list(who.id);
    const mark = flags.find((flag) => flag.startsWith('action:eventDelay:tingen:'));
    assert.ok(mark, '威慑要留下「事件延后」的标记。实际标记：' + flags.join('、'));
    assert.equal(h.repos.flags.value(who.id, mark!), '1');

    h.advance(61_000);
    const text = (await h.send({ rawText: '.探索 tingen', userId: '920005' }))
      .map((message) => message.text)
      .join(String.fromCharCode(10));
    assert.match(text, /安静了一格/, '回执要说清这一次什么也没发生。实际：' + text.slice(0, 200));
    assert.equal(h.repos.flags.value(who.id, mark!), null, 'turns: 1 用掉就没了');
  } finally {
    h.app.close();
  }
});

test('M2.65 端到端：探索时产出倍率作用在**件数**上，且标记用完即消', async () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const who = await h.createCharacter('920006', '留种的人', 'mother');
    setSequence(h, who.id, 4);
    h.advance(61_000);

    const text = (await h.send({ rawText: '.行动 留种', userId: '920006' }))
      .map((message) => message.text)
      .join(String.fromCharCode(10));
    assert.match(text, /留种/);
    const flags = h.repos.flags.list(who.id);
    const mark = flags.find((flag) => flag.startsWith('action:loot:tingen:'));
    assert.ok(mark, '留种要留下产出倍率的标记。实际标记：' + flags.join('、'));

    h.advance(61_000);
    await h.send({ rawText: '.探索 tingen', userId: '920006' });
    assert.equal(h.repos.flags.value(who.id, mark!), null, '倍率用完即消');
  } finally {
    h.app.close();
  }
});
/* ================================================================== *
 * 六、自身开销：needs 也要真的扣
 * ================================================================== */

/*
 * M2.85：原来这里还有一条「preview 写着『行动点 -1』的行动，真的扣了 1 点」——
 * 它守的是 needs: 'ap' 的执行（写一笔 ap_delta）。行动值机制整体移除后，
 * 'ap' 档从内容表与类型里一并删除，这条判据随之退役；mp 的对应判据仍在。
 */

test('M2.65 端到端：needs: mp 的行动扣灵性，不够时当面拒绝（不扣东西）', async () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const who = await h.createCharacter('920008', '灵性的人', 'mother');
    setSequence(h, who.id, 3);
    h.advance(61_000);

    const text = (await h.send({ rawText: '.行动 庇护', userId: '920008' }))
      .map((message) => message.text)
      .join(String.fromCharCode(10));
    assert.match(text, /庇护/);
    const rows = h.app.db
      .prepare("SELECT payload FROM domain_events WHERE type = 'mp_delta'")
      .all() as Array<{ payload: string }>;
    assert.equal(rows.length, 1, 'needs: mp 必须写一笔 mp_delta。实际：' + JSON.stringify(rows));
    assert.match(rows[0]!.payload, /"delta":-8/);

    // 灵性压到不够 —— 再来一次必须被拒，且不再写事件
    h.repos.characters.update({ ...h.repos.characters.findById(who.id)!, mp: 3 });
    h.advance(61_000);
    const denied = (await h.send({ rawText: '.行动 庇护', userId: '920008' }))
      .map((message) => message.text)
      .join(String.fromCharCode(10));
    assert.match(denied, /灵性不足/);
    const after = h.app.db.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'mp_delta'").get() as { n: number };
    assert.equal(after.n, 1, '被拒的那一次不该再扣');
  } finally {
    h.app.close();
  }
});

test('M2.65 对照侧：不写 needs 的行动一笔开销都不扣', async () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const who = await h.createCharacter('920009', '不扣的人', 'seer');
    setSequence(h, who.id, 6);
    h.advance(61_000);
    await h.send({ rawText: '.行动 化身', userId: '920009' });
    // M2.85：ap_delta 随行动值一并下线，这里只守 mp_delta
    const rows = h.app.db
      .prepare("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'mp_delta'")
      .get() as { n: number };
    assert.equal(rows.n, 0, '化身不消耗灵性 —— 扣了就是多扣');
  } finally {
    h.app.close();
  }
});
test('M2.85：内容表不许再残留行动值的承诺（文案与机制不许各说各话）', () => {
  /*
   * 判据（M2.85 反转，原 M2.65 的双向校验随行动值下线）：
   *   · preview 写「行动点 -1」或声明 needs: 'ap' —— 行动值机制已整体移除，
   *     任何残留都是空头支票（执行层已经没有扣点这件事）；
   *   · 「消耗灵性 / 灵性 -N」⇔ needs: 'mp' 的双向校验保留（灵性还在）。
   */
  const offenders: string[] = [];
  for (const action of PATHWAY_ACTIONS) {
    // String(...) 而不是直接比较：类型里已经没有 'ap' 这一档了，直接比会被 tsc 判成无重叠
    if (action.preview.includes('行动点 -1') || String(action.needs) === 'ap') {
      offenders.push(action.id + '：行动值残留（preview=' + action.preview + '，needs=' + String(action.needs) + '）');
    }
    const saysMp = action.preview.includes('消耗灵性') || action.preview.includes('灵性 -');
    if (saysMp !== (action.needs === 'mp')) offenders.push(action.id + '：preview 说扣灵性=' + saysMp + '，needs=' + String(action.needs));
  }
  assert.deepEqual(offenders, []);
  assert.ok(PATHWAY_ACTIONS.some((action) => action.needs === 'mp'), '对照侧：确实有声明了 mp 的行动');
});
/* ================================================================== *
 * 七、数据编辑器：新内容必须编辑得了
 * ================================================================== */

test('M2.65 编辑器：items 的变体表三列齐全，「合装要的另一件」是可留空的物品引用', async () => {
  const { entityById } = await import('../src/admin/schema.ts');
  const field = entityById('items')!.fields.find((f) => f.key === 'variants');
  assert.ok(field !== undefined, '数据编辑器里没有「变体」这一栏 —— 新加的两条合装件就没法改了');
  assert.equal(field.type, 'rows');
  const cols = new Map((field.rowFields ?? []).map((c) => [c.key, c]));
  for (const key of ['id', 'name', 'from', 'note']) {
    assert.ok(cols.has(key), '变体表少了列：' + key);
    assert.ok(cols.get(key)!.label.length > 0, '变体表的 ' + key + ' 没有中文标签');
  }
  /*
   * ★ 「合装要的另一件」必须是**指向物品的引用**（界面上下拉显示中文名，存的是 id），
   *   而且**可以留空**（留空 = 改制品）。
   *   没有 optional 的话，浏览器会默认选中列表里的第一项 ——
   *   「这一格我没填」会在保存时静默变成「它指向了 X」。
   */
  assert.equal(cols.get('from')!.type, 'ref');
  assert.equal(cols.get('from')!.ref, 'items');
  assert.equal(cols.get('from')!.optional, true);
});

test('M2.65 编辑器：把变体表的「合装用哪一件」清空 → 写回时**删键**，而不是写一个空串', async () => {
  /*
   * 为什么这条非测不可：下拉留空送出的是 `''`，而 zod 那一侧是
   * `z.string().min(1).optional()` —— `''` **过不了** min(1)。
   * 少了这一层清洗，「把这一格清空」的后果是下一次内容校验整份文件报错，
   * 而界面上看到的是一次「保存成功」（错误只在热重载 / 重启时才冒出来）。
   *
   * 测试用**临时文件 + 临时实体**，绝不动真的 items.yaml。
   */
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { entityById } = await import('../src/admin/schema.ts');
  const { writeEntity, readEntity } = await import('../src/admin/data.ts');

  const root = mkdtempSync(join(tmpdir(), 'm265-'));
  try {
    mkdirSync(join(root, 'src', 'data'), { recursive: true });
    const file = join(root, 'src', 'data', 'items.yaml');
    /*
     * 夹具里有**两条**物品，而且 id 是真的（`charm_banish` 而不是「符咒·定身」）：
     * M2.83 起保存时会校验引用目标真的存在（admin/data.ts 的 crossCheck），
     * 而它查的就是这个临时 items.yaml —— 用名字当 id 会被当场拦下。
     */
    writeFileSync(file,
      'items:' + String.fromCharCode(10) +
      '  - id: charm_banish' + String.fromCharCode(10) + '    name: 符咒·定身' + String.fromCharCode(10) +
      '  - id: A' + String.fromCharCode(10) + '    name: 甲' + String.fromCharCode(10),
      'utf8');
    const spec = { ...entityById('items')!, file: 'src/data/items.yaml' };

    // 先写一条**带 from** 的变体
    const withFrom = writeEntity(root, spec, 'A', {
      variants: [{ id: 'assembled', name: '甲装', from: 'charm_banish', note: '装上去' }],
    });
    assert.ok(withFrom.changed.includes('变体（改制品 / 合装件）'), '这一栏要能被写回');
    let text = readFileSync(file, 'utf8');
    assert.match(text, /from: charm_banish/);

    // 再把 from 清空 —— 必须**整行键消失**，不能留下 from: ''
    writeEntity(root, spec, 'A', {
      variants: [{ id: 'retrofit', name: '甲改', from: '', note: '拆开再装' }],
    });
    text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /from:/, '空的可选引用不该写进文件。实际：' + text);
    assert.match(text, /id: retrofit/);
    // 读回来也拿得到（round-trip 不是只在磁盘上看着对）
    const back = readEntity(root, spec, 'A') as { variants: Array<Record<string, unknown>> };
    assert.equal(back.variants[0]!.id, 'retrofit');
    assert.equal(back.variants[0]!.from, undefined, '没填的 from 读回来应当是 undefined');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
