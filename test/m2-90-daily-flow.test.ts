/**
 * **日常动作推进仪式流程（M2.90）** —— 用户要的「玩着玩着就走完了」。
 *
 * 用户否掉计时模型的原话是：「39个游戏日也不对，拿现实时间去要求就是纯折磨，
 * 而是应该设计一个剧情流程，让他去完成流程，达成仪式，也有可能被破坏」。
 * 改成剧情流程之后，第一版唯一的推进方式是 `.仪式 推进` —— **点 12 次**：
 * 那只是把折磨从时钟搬到了手指上。M2.89 接上了探索，M2.90 把扮演 / 事件 /
 * 战斗（PVE 收场 + PVP 收场）也接上，并把入口收敛成 `dailyFlowLines` 一份实现。
 *
 * 这份测试守四件事：
 *   ① 每个日常动作都**真的**会推进（不是「显示个文本」）；
 *   ② 还没入途径的人不推进 —— 他连途径是什么都还不知道；
 *   ③ **只靠日常动作能把一整条流程走完** —— 这一条就是「玩着玩着走完」的判据本身；
 *   ④ 逻辑只有一份：除了 ritual.ts，没有任何命令文件自己拼 runFlowStep。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { createHarness, type Harness } from './helpers/app.ts';
import { FLAG_LOCATION, FLAG_RITUAL_FLOW } from '../src/infra/db/flags.ts';
import { loadCreatures } from '../src/data/loader.ts';

/** 物种表（与生产同一份 YAML）—— 战斗那条用例要摆一只自己打得死的生物 */
const SPECIES = new Map(loadCreatures().creatures.map((species) => [species.id, species]));
const SPECIES_ID = 'whisperer';
const LOCATION_ID = 'old_dock';

/**
 * 夹具：一个**序列 4** 的占卜家 —— 于是目标序列是 3，对应【古代学者】那条仪式
 * （sustain×8 + 献出×1）。选它是因为它正是「三百年」那条：
 * 时长被翻译成 8 次判定，最能说明「不是等，是玩着玩着做完」。
 */
async function climber(userId: string): Promise<{ h: Harness; userId: string; characterId: string }> {
  const h = createHarness({ deterministicIds: true });
  const { id } = await h.createCharacter(userId, '占卜家', 'seer');
  const state = h.repos.characters.findByUserId(userId)!;
  h.repos.characters.update({ ...state, sequence: 4, updatedAt: h.now() });
  return { h, userId, characterId: id };
}

interface FlowFlag { riteId: string; done: number[] }

/** 流程进度落在 flags 里（不放 rituals.config_json —— 那一行只在准备期存在） */
function flowOf(h: Harness, characterId: string): FlowFlag | null {
  const raw = h.repos.flags.value(characterId, FLAG_RITUAL_FLOW);
  return raw === null ? null : (JSON.parse(raw) as FlowFlag);
}
const doneTotal = (f: FlowFlag | null): number => (f === null ? 0 : f.done.reduce((s, x) => s + x, 0));

/* ═══════════ ① 每个日常动作都会推进 ═══════════ */

test('扮演推进流程：连发几次扮演，进度自己往前走（不用点 .仪式 推进）', async () => {
  const { h, userId, characterId } = await climber('41001');
  let sawLine = false;
  for (let i = 0; i < 8; i += 1) {
    // .扮演 有 10 秒频控（防连点）：像真人一样等一等 —— 那条冷却本身是设计的一部分
    h.advance(11_000);
    const text = (await h.send({ rawText: '.扮演 我在书房里摊开牌，替人占卜今天的运势' + i, userId }))
      .map((m) => m.text).join('\n');
    if (text.includes('仪式 ·')) sawLine = true;
  }
  assert.ok(sawLine, '六次扮演一次都没带回仪式进度 —— 接上了吗？');
  assert.equal(flowOf(h, characterId)?.riteId, 'seer_3', '进度该记在【古代学者】这条仪式上');
  assert.ok(doneTotal(flowOf(h, characterId)) >= 1, '八次扮演之后进度一点没动 —— 判定没接上？');
});

test('事件推进流程：.事件 也会带回一次仪式进度', async () => {
  const { h, userId, characterId } = await climber('41002');
  const text = (await h.send({ rawText: '.事件', userId })).map((m) => m.text).join('\n');
  assert.ok(text.includes('事件 ·'), '夹具没抽到事件卡，这一条测不了：' + text.slice(0, 120));
  assert.ok(text.includes('仪式 ·'), '事件没有带回仪式进度：' + text.slice(-200));
  assert.ok(flowOf(h, characterId) !== null, '进度该被写到 flags 里');
});

test('战斗收场推进流程：打完一整场才算，不是每一回合都算', async () => {
  const { h, userId, characterId } = await climber('41003');
  h.repos.flags.set(characterId, FLAG_LOCATION, h.now(), LOCATION_ID);
  const species = SPECIES.get(SPECIES_ID)!;
  /*
   * 摆一只**一击就该倒**的生物（hp 1），但真正决定「几回合结束」的是掷骰，
   * 所以下面按回合循环到出现【战斗结果】为止 —— 八回合打满会判僵持，
   * 而僵持同样是收场。
   */
  const creatureId = 'test-creature-flow';
  h.repos.creatures.insertMany([{
    id: creatureId,
    speciesId: species.id,
    locationId: LOCATION_ID,
    sequence: species.baseSequence,
    hp: 1,
    maxHp: 1,
    status: 'healthy' as const,
    ageHours: 0,
    feedCount: 0,
    lastFedAt: h.now(),
    spawnedAt: h.now(),
    migratedFrom: null,
  }]);
  h.repos.creatures.recordSighting({
    id: 'test-sighting-flow',
    characterId,
    creatureId,
    speciesId: species.id,
    layer: 'full' as const,
    seed: 'test',
    at: h.now(),
  });

  await h.send({ rawText: '.战斗 开始', userId });
  let text = '';
  for (let i = 0; i < 12; i += 1) {
    // 每回合 5 秒频控：像真人一样等一等，而不是绕过它
    h.advance(6000);
    text = (await h.send({ rawText: '.战斗 攻击', userId })).map((m) => m.text).join('\n');
    if (text.includes('【战斗结果】')) break;
  }
  assert.ok(text.includes('【战斗结果】'), '十二次攻击都没打完 —— 夹具坏了：' + text.slice(-200));
  assert.ok(text.includes('仪式 ·'), '战斗收场没有带回仪式进度：' + text.slice(-200));
});

/* ═══════════ ② 普通人不会被推进 ═══════════ */

test('还没入途径的人不推进流程（扮演会被拒，也没有可推进的仪式）', async () => {
  const h = createHarness({ deterministicIds: true });
  const mortal = await h.createMortal('41004', '路人');
  const text = (await h.send({ rawText: '.扮演 我在街上替人占卜', userId: '41004' })).map((m) => m.text).join('\n');
  assert.equal(h.repos.flags.value(mortal.id, FLAG_RITUAL_FLOW), null, '普通人身上不该有仪式流程');
  assert.ok(!text.includes('仪式 ·'), '普通人也不该看到仪式进度那一行：' + text.slice(0, 160));
});

/* ═══════════ ③ 玩着玩着走完（这条是判据本身） ═══════════ */

test('玩着玩着走完：只发 .扮演，一整条【古代学者】流程自己走到底', async () => {
  const { h, userId, characterId } = await climber('41005');
  let completed = false;
  let times = 0;
  for (let i = 0; i < 80 && !completed; i += 1) {
    times += 1;
    // 同上：.扮演 的 10 秒频控要等过去（虚拟时钟，不是真等）
    h.advance(11_000);
    /*
     * 这一批用例研究的是**流程**，不是失控：扮演会让 MAD 一路涨上去，
     * 涨到 100 角色就失控了（形态一变，要走的仪式也就换了）。
     * 所以每 8 次把 MAD 拉回 0 —— 夹具行为，写在明处。
     */
    if (i % 8 === 7) {
      const cur = h.repos.characters.findByUserId(userId)!;
      h.repos.characters.update({ ...cur, mad: 0, updatedAt: h.now() });
    }
    const text = (await h.send({ rawText: '.扮演 我在书房里摊开牌，替人占卜今天的运势' + i, userId }))
      .map((m) => m.text).join('\n');
    if (text.includes('整条路走完了')) completed = true;
  }
  assert.ok(completed, '发了 ' + times + ' 次扮演还没走完 —— 日常动作推不动整条流程');
  const flag = flowOf(h, characterId)!;
  assert.equal(flag.riteId, 'seer_3', '走完的该是【古代学者】那条');
  assert.equal(flag.done[0], 8, 'sustain 该累计 8 次（三百年 → 8 次判定），实际 ' + flag.done[0]);
  assert.equal(flag.done[1], 1, '献出该 1 次，实际 ' + flag.done[1]);
});

/* ═══════════ ④ 逻辑只有一份 ═══════════ */

test('逻辑只有一份：除 ritual.ts 外没有命令文件自己拼 runFlowStep', () => {
  const dir = 'src/router/commands';
  const callers: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(dir + '/' + file, 'utf8');
    if (file === 'ritual.ts') {
      assert.ok(src.includes('export function dailyFlowLines'), 'ritual.ts 必须导出那个唯一入口');
      continue;
    }
    assert.ok(!src.includes('runFlowStep('), file + ' 又自己拼了一遍流程判定 —— 逻辑必须只有一份');
    if (src.includes('dailyFlowLines(')) callers.push(file);
  }
  assert.deepEqual(callers.sort(), ['battle.ts', 'event.ts', 'explore.ts', 'play.ts'],
    '接进日常动作的文件变了：' + callers.join('、'));
  const battleSrc = readFileSync(dir + '/battle.ts', 'utf8');
  assert.equal(battleSrc.split('dailyFlowLines(').length - 1, 2, 'PVE 收场与 PVP 收场各算一次');
});
