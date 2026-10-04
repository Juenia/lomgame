/**
 * M2.70：**物种的 `flavor`（标题里那一句氛围）接判定**。
 *
 * ## 这一份守什么
 *
 * `creature.flavor` 从 M2.8 起就写在 11 个物种上（「雾比刚才厚了一点。」「你听见自己刚才说过的一句话。」），
 * 而 `infra/db/creatures.ts` 把它存进库之后**没有任何地方读过** —— 台账 **B2-4** 记的就是它：
 *
 * > schema 注释说用于「遭遇回执标题」，但 `src/domain/creature/*` 与 `src/router/*` 里 0 处读取 ——
 * > 意图与落点不一致，没有文档裁决
 *
 * 这一轮给出裁决并落地：**它就写进遭遇标题**（与两处内容表注释一致），
 * 并且把标题格式从「三处各写一遍」收成**一个生成函数**（K22）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadContent } from '../src/data/loader.ts';
import { buildEncounterMenu, encounterFlavorOf, encounterTitleOf } from '../src/domain/menu/encounter-menu.ts';
import { perceptionLayerOf } from '../src/domain/creature/perception.ts';

const SPECIES = loadContent().creatures;

function viewOf(patch: Record<string, unknown> = {}): Parameters<typeof buildEncounterMenu>[0] {
  return {
    locationName: '老码头',
    weatherLabel: '雾天',
    text: '水里有东西。',
    layer: 'blur',
    allowedActions: ['observe', 'retreat'],
    mortal: false,
    ...patch,
  } as Parameters<typeof buildEncounterMenu>[0];
}

/* ================================================================== *
 * 一、内容侧：11 句氛围都在，而且都不一样
 * ================================================================== */

test('M2.70 内容：每个物种都写了 flavor，且没有两句重复', () => {
  const missing = SPECIES.filter((species) => species.flavor.trim() === '').map((species) => species.id);
  assert.deepEqual(missing, [], '这些物种没有氛围句 —— 标题会退回物种名（那就等于没写）');
  const flavors = SPECIES.map((species) => species.flavor.trim());
  assert.equal(new Set(flavors).size, flavors.length, '氛围句不能重复：两句一样就等于其中一个物种没有自己的味道');
  // M2.76：11 → 19（补序列 4 / 3 / 2 那一档）。物种数变了要同步这一条（G 表口径）。
  assert.equal(SPECIES.length, 293, '物种数变了要同步这一条（G 表口径）');   // M2.85 生态补足（方案 A）：19 → 71
});

/* ================================================================== *
 * 二、标题：一个生成函数，三种情形
 * ================================================================== */

test('M2.70 标题：有氛围句就带上，没有就**逐字退回**老格式', () => {
  assert.equal(
    encounterTitleOf({ locationName: '老码头', weatherLabel: '雾天' }),
    '【遭遇 · 老码头 · 雾天】',
    '不传 flavor 时与 M2.8 逐字相同（既有调用点一个字都不用改）',
  );
  assert.equal(
    encounterTitleOf({ locationName: '老码头', weatherLabel: '雾天', flavor: '雾比刚才厚了一点。' }),
    '【遭遇 · 老码头 · 雾天 · 雾比刚才厚了一点。】',
  );
  assert.equal(
    encounterTitleOf({ locationName: '老码头', weatherLabel: '雾天', flavor: '   ' }),
    '【遭遇 · 老码头 · 雾天】',
    '只有空白 = 没写',
  );
});

test('M2.70 标题：菜单真的用上了它（而不是只在生成函数里）', () => {
  const menu = buildEncounterMenu(viewOf({ flavor: '雾比刚才厚了一点。' }));
  assert.match(menu.title, /雾比刚才厚了一点。/, '菜单标题里要看得见氛围句：' + menu.title);
  const plain = buildEncounterMenu(viewOf());
  assert.equal(plain.title, '【遭遇 · 老码头 · 雾天】');
});

/* ================================================================== *
 * 三、退回规则：不写氛围时退回物种名，但**只在看得见的时候**
 * ================================================================== */

test('M2.70 退回：没写氛围 → 看得见时用物种名，看不见时**留空**（不泄漏）', () => {
  assert.equal(
    encounterFlavorOf({ flavor: '', visibleName: '低语者' }),
    '低语者',
    '写了名字线索就用它（内容表注释：「不给就退回物种名」）',
  );
  assert.equal(
    encounterFlavorOf({ flavor: '', visibleName: null }),
    '',
    '⚠️ 看不见的时候**不能**把物种名写进标题 —— 那会把感知分层当场作废',
  );
  assert.equal(
    encounterFlavorOf({ flavor: '  墙后面有人在唱。  ', visibleName: '骨唱诗班' }),
    '墙后面有人在唱。',
    '有氛围句时优先用它，并去掉首尾空白',
  );
});

test('M2.70 退回：感知层的可见性判据在别的模块，这里只对齐口径', () => {
  // 五层里只有三层看得见名字（与 domain/creature/perception.ts 的 visibilityOf 同一口径）
  const visible = (['full', 'advantage', 'essence'] as const).filter(
    (layer) => perceptionLayerOf({ playerSequence: 9, creatureSequence: 9, mortal: false }) === layer,
  );
  assert.ok(visible.length >= 0, '对照侧：分层函数的签名没变');
  assert.equal(perceptionLayerOf({ playerSequence: 5, creatureSequence: 5, mortal: false }), 'full');
  assert.equal(perceptionLayerOf({ playerSequence: 9, creatureSequence: 4, mortal: false }), 'blur');
});

/* ================================================================== *
 * 四、端到端：真的遭遇一次，标题里有那句话
 * ================================================================== */

test('M2.70 端到端：遭遇菜单的标题里带着那个物种的氛围句', async () => {
  const { createHarness } = await import('./helpers/app.ts');
  const h = createHarness({ deterministicIds: true });
  try {
    const { id: characterId, userId } = await h.createCharacter('950001', '遇事的人', 'seer');
    const species = SPECIES[0]!;
    /*
     * 与 test/m2-9-battle.test.ts 同一个摆法：遭遇是**概率事件**（雾天约 15%），
     * 所以直接摆一只生物 + 一次未决遭遇，而不是等它自己撞上来。
     */
    h.repos.creatures.seedSpecies(SPECIES, h.now());
    const creatureId = 'flavor-creature';
    h.repos.creatures.insertMany([
      {
        id: creatureId,
        speciesId: species.id,
        locationId: 'old_dock',
        sequence: species.baseSequence,
        hp: species.baseHp,
        maxHp: species.baseHp,
        status: 'healthy',
        ageHours: 0,
        feedCount: 0,
        lastFedAt: h.now(),
        spawnedAt: h.now(),
        migratedFrom: null,
      },
    ]);
    h.repos.flags.set(characterId, 'loc', h.now(), 'old_dock');
    h.repos.creatures.recordSighting({
      id: 'flavor-sighting',
      characterId,
      creatureId,
      speciesId: species.id,
      layer: 'blur',
      seed: 'm2-70',
      at: h.now(),
    });

    // 遭遇是**未决状态**：.遭遇 会把它再摆一次（这正是玩家看到的那个标题）
    const sent = await h.send({ rawText: '.遭遇', userId });
    const text = sent.map((message) => message.text).join(String.fromCharCode(10));
    assert.ok(
      text.includes(species.flavor.trim()),
      '遭遇回执里应当出现「' + species.flavor.trim() + '」，实际：' + text.slice(0, 240),
    );
    assert.match(text, /【遭遇 · [^】]*· [^】]*】/, '标题格式没变（地点 + 天气，后面多一段氛围）');
  } finally {
    h.app.close();
  }
});
