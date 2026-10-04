/**
 * **「记载不详」不等于「最弱」（M2.90）** —— NPC 轨迹表里的那一半。
 *
 * M2.89 修掉的是「运行时表开局为空 + `?? 9` ⇒ 所有人都是序列 9」；
 * 这一轮发现的是**同一个 bug 的另一半**：设定层自己也有 8 条没填，
 * 其中 5 条的原作原文就写着「0（真神）」——只是解析规则没认这种写法。
 *
 * 后果与上一次一模一样，同样不报错：
 *   · 一位真神在「谁会来搅你的仪式」里被当成序列 9 ⇒ sabotageChance 恒为 0；
 *   · 阴谋分档 schemeTierOf(9) = 最低档「街面上的算计」。
 *
 * 这份测试守三件事：
 *   ① 41 条轨迹**一条都不许**是 null（数量写死：往后加人物忘了填就要红）；
 *   ② 解析规则覆盖真数据里的每一种写法，且解析结果与表里的值**同源**；
 *   ③ 写-读闭环：交恶的真神现在真的会来搅仪式（这一条才是「接上了」的判据）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { hasGodOnPathway, parseSequenceText, stepsToGodhood, type NpcTrack } from '../src/domain/world/npc-track.ts';
import { sabotageChance } from '../src/domain/ritual/sabotage.ts';
import { npcSequenceOf } from '../src/router/commands/common.ts';
import type { RouterDeps } from '../src/router/index.ts';
import { createHarness } from './helpers/app.ts';

const TRACKS: NpcTrack[] = (
  parseYaml(readFileSync(new URL('../src/data/npc-tracks.yaml', import.meta.url), 'utf8')) as { npc_tracks: NpcTrack[] }
).npc_tracks;

test('41 条轨迹一条都不许是「未载」——未载在读取端会变成序列 9（最弱）', () => {
  assert.equal(TRACKS.length, 41, '轨迹条数变了');
  const missing = TRACKS.filter((t) => t.currentSequence === null);
  assert.deepEqual(missing.map((t) => t.id), [], '这些人物没有当前序列 —— 填的时候要在 YAML 里写清依据');
  // 已经是神的那 8 位：他们的存在本身就是「这条途径有神了」的证据
  assert.equal(TRACKS.filter((t) => t.currentSequence === 0).length, 8, '序列 0 的人数变了');
});

test('解析规则覆盖真数据里的每一种写法，且与表里的值同源', () => {
  /*
   * 「解析不出来的」只许是这三条**语义型**记载（原作本来就没给数字）。
   * 多出一条，就说明有人用了一种新写法而规则没跟上 —— 而那会安静地变成序列 9。
   */
  const unmapped = TRACKS.filter((t) => parseSequenceText(t.raw).current === null).map((t) => t.id).sort();
  assert.deepEqual(unmapped, ['arrodes', 'gehrman_sparrow', 'old_neil'],
    '解析不出的应当是这三条语义型记载，实际：' + unmapped.join('、'));
  const mismatch = TRACKS.filter((t) => {
    const parsed = parseSequenceText(t.raw);
    return parsed.current !== null && parsed.current !== t.currentSequence;
  });
  assert.deepEqual(mismatch.map((t) => t.id), [], '解析结果与表里的 currentSequence 不一致 —— 两处必须同源');
});

test('「0（真神）」这种写法现在认得了（它就是那 5 条漏掉的）', () => {
  assert.equal(parseSequenceText('0（真神）').current, 0);
  assert.equal(parseSequenceText('0（真神；“灾祸主宰”）').current, 0);
  // 不认的那几种仍然不认：它们没有数字可认，编一个是错的
  assert.equal(parseSequenceText('低序列非凡者（萌娘百科导航模板将其列入“低序列非凡者”）').current, null);
  assert.equal(parseSequenceText('无序列；位格为圣者层次').current, null);
  assert.equal(parseSequenceText('随本体克莱恩·莫雷蒂的序列推进').current, null);
  // 老写法一位都不许掉
  assert.equal(parseSequenceText('9-占卜家 → 0-愚者（半个旧日“诡秘之主”）').current, 0);
  assert.equal(parseSequenceText('7-梦魇').current, 7);
  assert.equal(parseSequenceText('序列 0（真神）').current, 0);
});

test('设定层是兜底、运行时层是覆盖 —— 顺序不能反', () => {
  const fake = (runtime: number | null, current: number | null): RouterDeps =>
    ({
      npcProgress: { of: () => (runtime === null ? null : { sequence: runtime }) },
      npcTracks: [{ id: 'x', currentSequence: current }],
    }) as unknown as RouterDeps;
  assert.equal(npcSequenceOf(fake(null, 4), 'x'), 4, '运行时没有记录 ⇒ 用设定层（世界还没跑起来时不许变回最弱）');
  assert.equal(npcSequenceOf(fake(2, 4), 'x'), 2, '运行时优先 —— 世界演化过的位置要盖过原著记载');
  assert.equal(npcSequenceOf(fake(null, null), 'x'), 9, '两张表都没有才兜底 9');
});

test('写-读闭环：交恶的真神现在真的会来搅仪式（改之前恒为 0）', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    for (const id of ['klein_moretti', 'solomon', 'alistair_tudor', 'trenthorst', 'salinger', 'lumian_lee', 'gehrman_sparrow']) {
      assert.equal(npcSequenceOf(deps, id), 0, id + ' 在原著里是真神，不该被当成序列 9');
    }
    assert.equal(npcSequenceOf(deps, 'old_neil'), 9, '「低序列非凡者」取下界 9');
    assert.equal(npcSequenceOf(deps, 'arrodes'), 4, '「圣者层次」取下界 4');
    assert.equal(npcSequenceOf(deps, 'audrey_hall'), 3, '有明确记载的人走设定层');
    /*
     * 这一条才是「接上了」：序列 9 的人搅不了仪式（sabotageChance 要求 ≤ 6），
     * 而序列 0 的真神能 —— 改之前同一条判定恒为 0。
     */
    assert.equal(sabotageChance(9, -40, 9), 0, '序列 9 看不懂仪式（前提）');
    assert.ok(sabotageChance(npcSequenceOf(deps, 'solomon'), -40, 9) > 0, '交恶的黑皇帝该能搅你的仪式');
    // 顺带：这条途径现在「有神」了 —— 补数据之前 lawyer 途径在表里是无神的
    assert.equal(hasGodOnPathway(TRACKS, 'lawyer')?.id, 'solomon');
    assert.equal(hasGodOnPathway(TRACKS, 'corpse_collector')?.id, 'salinger');
    assert.equal(stepsToGodhood(TRACKS.find((t) => t.id === 'solomon')!), null, '已经在神位上的人不再有「距登神几档」');
  } finally {
    h.app.close();
  }
});
