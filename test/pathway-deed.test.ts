/**
 * M2.85 世界演化：**NPC 会做符合自己途径的事**（用户拍板）。
 *
 * 在此之前，NPC 干的事只有三种（晋升 / 猎杀 / 化解灾厄），全是通用的 ——
 * 一个走「愚者」的天使和一个走「红祭司」的天使除了数值没有任何区别。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadContentOrThrow } from '../src/data/loader.ts';
import { PATHWAY_LABELS } from '../src/domain/character/rules.ts';
import { DEED_EFFECTS, deedsFor, deedMerit, pickDeed, renderDeedText } from '../src/domain/world/pathway-deed.ts';
import { createHarness } from './helpers/app.ts';
import { runDailyTick } from '../src/infra/tick.ts';

test('途径行为：22 条途径每一条都有行为，且总数为 44', () => {
  const content = loadContentOrThrow();
  assert.equal(content.pathwayDeeds.length, 44, '22 途径 × 2 条');
  const covered = new Set(content.pathwayDeeds.map((d) => d.pathway));
  for (const id of Object.keys(PATHWAY_LABELS)) {
    assert.ok(covered.has(id), PATHWAY_LABELS[id as keyof typeof PATHWAY_LABELS] + ' 途径没有行为 —— 「符合自己途径」对它就是句空话');
  }
});

test('途径行为：文案不许重样（模板化会被这条抓住）', () => {
  const content = loadContentOrThrow();
  const texts = content.pathwayDeeds.map((d) => d.text);
  assert.equal(new Set(texts).size, texts.length, '行为文案必须互不相同');
});

test('途径行为：效果只有 6 种，每种都有人用', () => {
  const content = loadContentOrThrow();
  const used = new Set(content.pathwayDeeds.map((d) => d.effect));
  for (const e of DEED_EFFECTS) assert.ok(used.has(e), '效果 ' + e + ' 没有任何一条行为在用 —— 那是没人验的代码');
  for (const e of used) assert.ok((DEED_EFFECTS as readonly string[]).includes(e));
});

test('途径行为：按途径与序列过滤（低序列做不了高序列的事）', () => {
  const content = loadContentOrThrow();
  const seer = content.pathwayDeeds.filter((d) => d.pathway === 'seer');
  assert.equal(seer.length, 2);
  // 序列 9 的愚者做得了「占卜」（minSequence 9），做不了「奇迹」（minSequence 3）
  const atNine = deedsFor(content.pathwayDeeds, 'seer', 9).map((d) => d.id);
  assert.deepEqual(atNine, ['seer_divine']);
  const atThree = deedsFor(content.pathwayDeeds, 'seer', 3).map((d) => d.id).sort();
  assert.deepEqual(atThree, ['seer_divine', 'seer_miracle']);
  // 别的途径的人挑不出愚者的行为
  assert.equal(deedsFor(content.pathwayDeeds, 'hunter', 9).every((d) => d.pathway === 'hunter'), true);
});

test('途径行为：抽签只在自己途径的池子里，且 `{name}` 会被替换', () => {
  const content = loadContentOrThrow();
  const pool = deedsFor(content.pathwayDeeds, 'hunter', 9);
  for (const roll of [0, 0.5, 0.999]) {
    const deed = pickDeed(pool, roll);
    assert.equal(deed?.pathway, 'hunter', '抽到的人必须是这条途径的');
    assert.ok(!renderDeedText(deed!, '安德森').includes('{name}'), '文案里的 {name} 必须被替换掉');
  }
  // 有真实世界影响的效果最值钱（成神看履历）
  assert.ok(deedMerit('calm') > deedMerit('observe'));
});

test('途径行为：世界 tick 里真的会发生（而且看得到是哪条途径的气质）', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    const start = h.now();
    const DAY = 86_400_000;
    for (let d = 0; d < 400; d += 1) runDailyTick(deps, start + d * DAY);
    const deeds = deps.npcDeeds.recent(300).filter((d) => d.kind === 'deed');
    assert.ok(deeds.length > 0, '400 天里应当有人做过符合自己途径的事');
    // 每条行为都要挂在一个「有途径记载」的人身上
    const tracks = new Map(deps.npcTracks.map((t) => [t.id, t]));
    for (const d of deeds) {
      const track = tracks.get(d.npcId);
      assert.ok(track, d.npcId + ' 不该是没记载的人');
      assert.ok(track!.pathways.length > 0, track!.name + ' 要有途径才谈得上「符合途径的行为」');
    }
  } finally {
    h.app.close();
  }
});
