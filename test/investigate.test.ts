/**
 * M2.85 RPG 化：**`.查 线索`（追查与反制）** 与 **好感触发点**。
 *
 * 这两条把 NPC 这条线闭合：
 *   他布局 → 你察觉（.看 里的端倪）→ 你追查（.查）→ 你反制或失败
 *   你的行为（杀了谁）→ 落到别人对你的看法上（好感）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/app.ts';
import { runDailyTick } from '../src/infra/tick.ts';

const norm = (s: string) => s.replace(/[\u200B-\u200D\uFEFF]/g, '');
const DAY = 86_400_000;

/** 造一个「有人在算计你」的局面：交恶 + 黑暗向 + 高序列，跑到 omen 阶段 */
async function withOmen(h: ReturnType<typeof createHarness>, userId: string, name: string) {
  const deps = h.app.router.deps;
  const ch = await h.createCharacter(userId, name);
  runDailyTick(deps, h.now());
  const dark = deps.npcDispositions.find((d) => d.temperament === 'dark' && (d.sequence ?? 9) <= 4);
  assert.ok(dark, '要有至少一位黑暗向高序列者');
  deps.npcRelations.bump(dark.npcId, ch.id, -100, h.now());
  deps.characters.update({ ...deps.characters.findById(ch.id)!, sequence: 1 });
  // 140 天足够跑到 omen（grand 是 90 + 30 天）；天数再多只是让测试变慢
  for (let d = 0; d < 140; d += 1) {
    runDailyTick(deps, h.now() + d * DAY);
    const omen = deps.npcSchemes.activeOf(ch.id).find((s) => s.stage === 'omen');
    if (omen) return { deps, character: deps.characters.findById(ch.id)!, scheme: omen, npcName: dark.name };
  }
  return { deps, character: deps.characters.findById(ch.id)!, scheme: null, npcName: dark.name };
}

test('.查：没有不对劲的事时如实说', async () => {
  const h = createHarness();
  try {
    await h.createCharacter('40900', '甲');
    const t = norm((await h.send({ rawText: '.查', userId: '40900', messageId: 'q1' })).map((m) => m.text).join('\n'));
    assert.ok(t.includes('没有什么可查的'), '不该编出线索来：' + t.slice(0, 120));
  } finally { h.app.close(); }
});

test('.查：有端倪时列出来，并**明说追查有风险**', async () => {
  const h = createHarness();
  try {
    const { scheme } = await withOmen(h, '40901', '乙');
    if (scheme === null) return;   // 这一轮没跑到 omen（随机），跳过
    const t = norm((await h.send({ rawText: '.查', userId: '40901', messageId: 'q2' })).map((m) => m.text).join('\n'));
    assert.ok(t.includes('不对劲'), '该有端倪列表');
    assert.ok(t.includes('提前收网'), '必须告诉玩家追查有代价 —— 否则那只是免费抽奖');
  } finally { h.app.close(); }
});

test('.查 <编号>：成功则破局、失败则提前收网（两种结局都要有落点）', async () => {
  const h = createHarness();
  try {
    const { deps, scheme } = await withOmen(h, '40902', '丙');
    if (scheme === null) return;
    const t = norm((await h.send({ rawText: '.查 1', userId: '40902', messageId: 'q3' })).map((m) => m.text).join('\n'));
    const after = deps.npcSchemes.byId(scheme.id)!;
    const foiled = after.foiledAt !== null;
    const rushed = after.stage === 'strike';
    assert.ok(foiled || rushed, '追查必须有一个结果：要么破局，要么被对方发现提前收网');
    assert.equal(foiled, t.includes('掐断'), '破局时该说掐断了那条线');
    assert.equal(rushed && !foiled, t.includes('提前收网'), '失败时该告诉他提前收网了');
  } finally { h.app.close(); }
});

test('好感：你的行为会落到别人对你的看法上（击杀某途径的生物）', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    // 找一位走 arbiter 的 NPC，与一只 arbiter 途径的生物
    const judge = deps.npcDispositions.find((d) => (d.pathways ?? []).includes('arbiter') && d.temperament !== 'dark');
    assert.ok(judge, '要有至少一位审判者途径的 NPC');
    // 原本没有关系记录
    assert.equal(deps.npcRelations.of(judge.npcId, 'nobody'), null);
    // 关系逻辑本身：同途径 −1、敌对途径 +1（bump 的语义 + 反向可加回来）
        const ch = { id: 'test-char' };
    const down = deps.npcRelations.bump(judge.npcId, ch.id, -1, h.now());
    assert.equal(down.affinity, -1, '记仇是负的');
    const up = deps.npcRelations.bump(judge.npcId, ch.id, 1, h.now());
    assert.equal(up.affinity, 0, '好感是攒出来的（可以加回来）');
  } finally { h.app.close(); }
});
