/**
 * M2.72：**埋在地点下的封印物接判定**。
 *
 * ## 台账记的是什么（M2.61 §4.1）
 *
 * > 封印物与禁忌知识**只落数据、未接判定**
 *
 * 具体现场：`history.yaml` 的 8 场历史里写着「这底下埋着东西」
 *（「灰雾之下那道封条」「圣髑匣（里外不是一个东西）」「开拓队留下的铜箱」…），
 * `historyEffects()` 把它们压成一份 `sealed` 清单 —— 然后**只有后台的只读页读它**，
 * 而那一页的小标题原文就是「封印物（N 件 · **未接判定**）」。
 *
 * 这一轮接上的是**封印物那一半**：埋着东西的地点，探索时真的能挖出来。
 * 禁忌知识那一半（谁想埋掉它 / 谁知道）仍然开放 —— 它需要一个「知道」的载体
 *（玩家侧的知识账），那是新设计而不是接线，见 §五。
 *
 * ## 落点
 *
 *     历史说这里埋着东西  →  在这里探索时多掷一次骰（0.04 / 0.08 / 0.14）
 *                          →  挖出**一件真实的封印物**（items.yaml 的 sealed 池）
 *                          →  回执里点名「挖出来的是历史上那一件」
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadContent } from '../src/data/loader.ts';
import {
  HistoryIndex,
  historyEffects,
  sealedDigChanceOf,
} from '../src/domain/world/history.ts';
import { createHarness } from './helpers/app.ts';

const CONTENT = loadContent();
const FACTS = historyEffects(CONTENT.history);
const INDEX = new HistoryIndex(CONTENT.history, FACTS.sealed);

/* ================================================================== *
 * 一、内容侧：历史真的埋了东西
 * ================================================================== */

test('M2.72 内容：8 场历史里埋着 6 件封印物，每个地点最多算一件', () => {
  assert.ok(FACTS.sealed.length >= 5, '历史必须埋着东西 —— 否则这一层没有内容可接');
  for (const item of FACTS.sealed) {
    assert.ok(item.location.length > 0, '埋藏物必须绑在一个地点上');
    assert.ok(item.what.length > 0, '埋的是什么必须有说法');
    assert.ok(['low', 'medium', 'high', 'forbidden'].includes(item.level), '等级取值域');
  }
  // 同一个地点最多的那一件（索引的口径）
  const byLocation = new Map<string, number>();
  for (const item of FACTS.sealed) byLocation.set(item.location, (byLocation.get(item.location) ?? 0) + 1);
  assert.equal(INDEX.sealedCount, byLocation.size, '索引里的地点数 = 去重后的地点数');
});

test('M2.72 索引：埋着的地点查得到，没埋的查不到', () => {
  const buried = FACTS.sealed[0]!;
  const found = INDEX.sealedAt(buried.location);
  assert.ok(found !== null, buried.location + ' 应当查得到');
  assert.ok(FACTS.sealed.some((item) => item.what === found.what), '查到的必须是历史里那一条');
  assert.equal(INDEX.sealedAt('这个地点不存在'), null, '没埋东西的地点返回 null（调用方据此不掷骰）');
});

test('M2.72 索引（K23 反向用例）：同一地点埋两件时取 level 最高的那件', () => {
  const dup = [
    { location: 'loc_x', what: '浅的那件', level: 'low' as const, because: 'a' },
    { location: 'loc_x', what: '深的那件', level: 'high' as const, because: 'b' },
  ];
  const index = new HistoryIndex([], dup);
  assert.equal(index.sealedAt('loc_x')?.what, '深的那件', '取更要紧的那一件');
  assert.equal(index.sealedCount, 1, '同一个地点只算一处');
});

/* ================================================================== *
 * 二、概率：三档，越深的越难挖
 * ================================================================== */

test('M2.72 概率：low < medium < high，且都远高于通用掉落率', () => {
  const rows = (['low', 'medium', 'high'] as const).map((level) => [level, sealedDigChanceOf(level)] as const);
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i]![1] > rows[i - 1]![1], rows[i]![0] + ' 必须比 ' + rows[i - 1]![0] + ' 更容易挖到');
  }
  // 与通用封印物掉落（explore 0.8%）对比：埋着东西的地方要明显更容易
  assert.ok(sealedDigChanceOf('low') >= 0.04, '最低档也要是通用掉落的 5 倍以上');
  assert.ok(sealedDigChanceOf('high') <= 0.25, '再高也不该变成「一挖一个」');
});

/* ================================================================== *
 * 三、端到端：真的挖得出来（且只有埋着东西的地点）
 * ================================================================== */

test('M2.72 端到端：在埋着东西的地点反复探索，真的挖出一件封印物', async () => {
  const { createHarness } = await import('./helpers/app.ts');
  const h = createHarness({ deterministicIds: true });
  try {
    const buried = FACTS.sealed.find((item) => item.level === 'high') ?? FACTS.sealed[0]!;
    const location = CONTENT.locations.find((entry) => entry.id === buried.location)!;
    const { id: characterId } = await h.createCharacter('960001', '挖东西的人', 'seer');

    // 站到那个地点上（用 .移动 太慢：直接摆位置 + 序列够得着）
    h.repos.flags.set(characterId, 'loc', h.now(), location.id);
    h.repos.characters.update({
      ...h.repos.characters.findById(characterId)!,
      sequence: Math.min(9, location.min_seq),
    });

    const itemEvents = () => h.app.db
      .prepare("SELECT payload FROM domain_events WHERE type = 'item_gain' AND reason = '探索·挖出封印物'")
      .all() as Array<{ payload: string }>;

    /*
     * ⚠️ **每次要推进一整天**：同一个地点每天最多探索 3 次（NUMERIC.explore.dailyCapPerLocation），
     * 只推 61 秒的话第二次就被拦下了 —— 第一版就是这么写的，60 次「探索」里只有 3 次真的执行。
     * 模拟器里的 messageId 是确定性的，所以这一串掷骰也是确定的：要么每次过，要么每次红。
     */
    let dug = 0;
    for (let i = 0; i < 40 && dug === 0; i += 1) {
      h.advance(24 * 3600_000 + 61_000);
      h.repos.characters.update({ ...h.repos.characters.findById(characterId)!, });
      await h.send({ rawText: '.探索 ' + location.name, userId: '960001' });
      dug = itemEvents().length;
    }

    assert.ok(dug > 0, '四十天都没挖到 —— 挖掘链路可能没接上（' + location.name + '，' + buried.what + '）');
    const payload = JSON.parse(itemEvents()[0]!.payload) as Record<string, unknown>;
    assert.equal(payload['source'], 'sealed-dig');
    assert.equal(payload['because'], buried.because, '留档要写清挖的是哪一件历史');
    assert.equal(payload['level'], buried.level, '档位也要留档（报告要能数「8 处被挖过几次」）');

    // 挖到的必须是**真实存在的封印物**
    const itemId = String(payload['itemId']);
    const item = CONTENT.items.find((entry) => entry.id === itemId);
    assert.ok(item !== undefined, '挖出来的东西必须在 items.yaml 里：' + itemId);
    assert.equal(item.type, 'sealed', '挖出来的必须是封印物：' + itemId);
  } finally {
    h.app.close();
  }
});

test('M2.72 对照侧：没埋东西的地点一次都不掷（既有行为逐位不变）', async () => {
  const { createHarness } = await import('./helpers/app.ts');
  const h = createHarness({ deterministicIds: true });
  try {
    // 挑一个**历史里没有埋藏记录**的地点
    const plain = CONTENT.locations.find(
      (location) => INDEX.sealedAt(location.id) === null && location.min_seq >= 9,
    );
    assert.ok(plain !== undefined, '总要有一个没埋东西的地点');
    const { id: characterId } = await h.createCharacter('960002', '走过的人', 'seer');
    h.repos.flags.set(characterId, 'loc', h.now(), plain.id);
    h.repos.flags.set(characterId, 'marked_locations', h.now(), '[]');

    for (let i = 0; i < 12; i += 1) {
      h.advance(24 * 3600_000 + 61_000);
      h.repos.characters.update({ ...h.repos.characters.findById(characterId)!, });
      await h.send({ rawText: '.探索 ' + plain.name, userId: '960002' });
    }
    const dug = h.app.db
      .prepare("SELECT COUNT(*) AS n FROM domain_events WHERE reason = '探索·挖出封印物'")
      .get() as { n: number };
    assert.equal(dug.n, 0, plain.name + ' 底下没埋东西 —— 一次都不该挖出');
  } finally {
    h.app.close();
  }
});
/* ================================================================== *
 * 四、M2.72 的另一半：`mutated` 因果边（失真传闻）
 * ================================================================== */

test('M2.72 因果：失真传闻连的是 mutated 边，没失真的仍然是 caused', async () => {
  const { createHarness } = await import('./helpers/app.ts');
  const { CausalRepo } = await import('../src/infra/causal-log.ts');
  const h = createHarness({ deterministicIds: true });
  try {
    const causal = new CausalRepo(h.app.db);
    // 不失真：与 M2.60 逐位相同
    causal.recordSighting({
      sightingId: 's-plain', characterId: 'c1', locationId: 'old_dock',
      speciesId: 'whisperer', speciesName: '低语者', layer: 'full', intensity: 0.5,
      summary: '看见了低语者', rumorEventId: 'rumor:plain', at: h.now(),
    });
    const plain = causal.edgesFrom('sighting:s-plain');
    assert.equal(plain.length, 1);
    assert.equal(plain[0]!.relation, 'caused', '不失真 = 信息原样传出去了');

    // 失真：信息在传出去的**路上被改成了另一件事**
    causal.recordSighting({
      sightingId: 's-distorted', characterId: 'c1', locationId: 'old_dock',
      speciesId: 'whisperer', speciesName: '低语者', layer: 'full', intensity: 0.5,
      summary: '看见了低语者', rumorEventId: 'rumor:distorted', distorted: true, at: h.now(),
    });
    const distorted = causal.edgesFrom('sighting:s-distorted');
    assert.equal(distorted.length, 1);
    assert.equal(distorted[0]!.relation, 'mutated', '失真 = A 改变了 B 的属性');
    // 传闻节点自己的摘要也要说清它是离谱的那一条
    const rumor = causal.node('worldevent:rumor:distorted');
    assert.match(rumor?.summary ?? '', /失真传闻/);

    // 三种关系现在都有生产者了（M2.60 的 mutated 一直是空的）
    const byRelation = causal.countByRelation();
    assert.ok((byRelation['caused'] ?? 0) >= 1 && (byRelation['mutated'] ?? 0) >= 1);
  } finally {
    h.app.close();
  }
});
