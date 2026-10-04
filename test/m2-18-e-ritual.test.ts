/**
 * M2.18 任务 E：仪式融合窗口的**端到端路径测试**。
 *
 * 目标：**验路径，不验值**。
 *
 * 三段（同一个仪式的时间线）：
 *   t=0        .仪式 开始 → 进入 running（pending），ritual_setup 落库
 *   t=31min    旧窗口（30 分钟）之外融合 —— 断言**不再**被置为「超时未融合」
 *   t≈12h      融合成功事件落库、序列变更真的生效
 * 外加边界：t = 12h + 1min 仍然会散（窗口有上界，不是无限等）
 * 外加对照：.晋升 是同步结算，**不受** ritual 窗口影响（奇偶分流的两条路互不干扰）
 *
 * 时钟：用 harness 的 now() 注入 + advance()（项目现有的 clock 抽象），
 *       **不 setTimeout 真等**；推进量都是固定常数，判定 seed 因此可复现。
 *
 * 判据的两条来源分开读（K4）：
 *   「曾经」读 domain_events（ritual_setup / ritual_success / sequence_delta），
 *   「此刻」读状态表（rituals.status / characters.sequence）。
 * 耗时一律取「发起 → 融合成功」的**事件时间差**，不读状态表的 started_at / resolved_at
 * （那两个字段只在「落库了没有」这一类断言里用）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import type { DomainEvent } from '../src/domain/character/types.ts';
import { createHarness } from './helpers/app.ts';

const RITUAL = NUMERIC.ritual;
const USER = '41001';
const SOLO = '41002';

type Harness = ReturnType<typeof createHarness>;

/**
 * 「马上能晋升」的夹具：DIG 拉满 + MAD/COR 归零 + 魔药已服 + 材料备足。
 * MAD/COR 归零是为了把阶段 3 的成功率顶到上限（95%）—— 阶段 3 是概率的，
 * 用例需要能稳定走到「成功」那一支（走不到就补料重来，见 fuseUntilSuccess）。
 */
function makeReady(h: Harness, userId = USER): string {
  const character = h.repos.characters.findByUserId(userId)!;
  h.repos.characters.update({
    ...character, dig: 100, mad: 0, cor: 0, hp: 100, status: 'active',
  });
  h.repos.flags.set(character.id, 'ability_seer_9', h.now());
  h.repos.inventory.add(character.id, '主材料·灰雾结晶', 4, 'unbound', h.now());
  return character.id;
}

const joined = (messages: Array<{ text: string }>): string => messages.map((m) => m.text).join('\n');
const eventsOf = (h: Harness, id: string): DomainEvent[] => h.repos.characters.eventsOf(id);
const ritualRowOf = (h: Harness, ritualId: string): Record<string, unknown> | undefined =>
  h.app.db.prepare('SELECT * FROM rituals WHERE id = ?').get(ritualId) as Record<string, unknown> | undefined;

/** 反复「地点 + 开始」直到进入 running（阶段 1 固定 80%，连着失败 40 次的概率是 1e-28） */
async function startRitual(h: Harness, userId: string, characterId: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const running = h.repos.rituals.runningOf(characterId);
    if (running) return running.id;
    /*
     * M2.21：**重试要跨过冷却，还要把状态拉回可用。**
     *
     * 这个循环就是 M2.20 §7.1 那条 flaky 的真正根因（当时归给了 apply 的默认参数，错了），
     * 两件事叠在一起让那 40 次重试变成空转：
     *
     *   1. **冷却读注入时钟**：.仪式 开始 有 1 秒冷却，而 harness 的 clock 默认不动 ——
     *      不推进的话第 3 次起全部回「冷却中，请 1 秒后再试」；
     *   2. **阶段 1 失败会损材料**（回执里写着「损失：主材料·灰雾结晶 ×1」），
     *      makeReady 只给了 4 份 —— 连挂四五次之后，剩下的尝试全部因**材料不足**失败。
     *
     * 两件合起来：连挂几次 ⇒ 这个循环再也出不来 ⇒ 抛「连续失败 40 次」。
     * 四条用例共用这个夹具 ⇒ **哪一条红看运气**，于是当年被记成「两条用例互相轮流红」。
     *
     * attempt > 0 才动：第一次不能推进，也不能重设状态（那时夹具刚摆好）。
     */
    if (attempt > 0) {
      h.advance(2000);
      makeReady(h, userId);
    }
    await h.send({ rawText: '.仪式 地点 灰雾之上', userId });
    await h.send({ rawText: '.仪式 开始', userId });
  }
  throw new Error('仪式没能进入 running：阶段 1/2 连续失败 40 次');
}

/**
 * 融合到成功为止。
 *
 * 阶段 3 的上限是 95%，所以 5% 的一次性失败是**正常产品行为**，不该让用例变 flaky：
 * 失败就补料重来（失败本来就损 50% 材料 + 重伤），成功即返回那条 ritual_success 事件。
 * 12 连败的概率是 1e-16，真发生说明产品坏了，抛错比静默通过好。
 */
async function fuseUntilSuccess(h: Harness, userId: string, characterId: string, advanceMs: number): Promise<DomainEvent> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    // 时间推进可能跨天（每日 tick 会动状态），所以每次尝试前把状态拉回「能晋升」
    makeReady(h, userId);
    await startRitual(h, userId, characterId);
    h.advance(advanceMs);
    await h.send({ rawText: '.仪式 融合', userId });
    const success = eventsOf(h, characterId).find((event) => event.type === 'ritual_success');
    if (success) return success;
  }
  throw new Error('连续 12 次融合都没成功（上限 95%，12 连败概率 1e-16）');
}

/* ==================== 段一：t=0 ==================== */

test('M2.18-E 仪式窗口 t=0：.仪式 开始 → running 落库 + ritual_setup 事件落库', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '仪式者');
    const id = makeReady(h);
    const startedAt = h.now();

    const ritualId = await startRitual(h, USER, id);

    // 「此刻」：状态表里这条仪式是 running（阶段 1/2 过了，等融合）
    const row = ritualRowOf(h, ritualId)!;
    assert.equal(row.status, 'running', 't=0：仪式要进入 running');
    /*
     * M2.21：**不再与循环前的 startedAt 比**。
     *
     * startRitual 会在重试时推进注入时钟（跨过 .仪式 开始 的 1 秒冷却），
     * 所以「这一次成功发起」的时刻可能比用例开始时晚几秒 —— 那正是产品的真实行为
     * （玩家等 1 秒再试，而不是「重试不花时间」）。
     * 真正要守的是下面那条**状态表 vs 事件流的对账**（K4 的两侧指的是同一时刻）。
     */
    assert.ok(
      Number(row.started_at) >= startedAt,
      't=0：started_at 不能早于用例开始的那一刻（实际 ' + row.started_at + ' vs ' + startedAt + '）',
    );
    assert.equal(row.resolved_at, null, 't=0：还没结算');
    assert.equal(Number(row.stage) >= 1, true, 't=0：至少过了阶段 1');

    /*
     * 「曾经」：事件流那一侧也要有 —— 耗时口径将来全靠它配对。
     *
     * ⚠️ **不能断言「恰好一条」**：startRitual 会重试阶段 1（固定 80%），重试几次就有几条 ritual_setup。
     * 真正要断言的是「**这一次成功的仪式**有配对的发起事件」，所以取最后一条、并按 ritualId 核对。
     * （这条曾经写成 === 1，在全量并行跑时偶发红 —— 它断言的是夹具的重试次数，不是产品行为。）
     */
    const setups = eventsOf(h, id).filter((event) => event.type === 'ritual_setup');
    assert.ok(setups.length >= 1, 't=0：ritual_setup 要落库');
    const lastSetup = setups[setups.length - 1]!;
    assert.equal(String(lastSetup.payload.ritualId), ritualId, 't=0：事件与状态表指的是同一条仪式');
    // 状态表的 started_at 与配对事件的 createdAt 必须是**同一个时刻**（「此刻」对「曾经」）
    assert.equal(Number(row.started_at), lastSetup.createdAt, 't=0：started_at 与配对事件的时刻一致');
    assert.ok(lastSetup.seed && lastSetup.seed.length > 0, 't=0：判定 seed 进库');
  } finally {
    h.app.close();
  }
});

/* ==================== 段二：t=31min ==================== */

test('M2.18-E 仪式窗口 t=31min：旧窗口之外融合，不再被置为「超时未融合」', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '仪式者');
    const id = makeReady(h);
    const ritualId = await startRitual(h, USER, id);

    // 推进到旧窗口之外（30 分钟 → 31 分钟）。不真等，改注入的时钟。
    h.advance(31 * 60 * 1000);

    const text = joined(await h.send({ rawText: '.仪式 融合', userId: USER }));
    assert.doesNotMatch(text, /已经散了/, 't=31min：不该再因为超过 30 分钟散掉');
    assert.doesNotMatch(text, /超时未融合/);
    assert.match(text, /阶段 3 融合/, 't=31min：要真的走到阶段 3');

    // 「此刻」：这条仪式是被阶段 3 结算的，不是被超时打掉的
    const row = ritualRowOf(h, ritualId)!;
    assert.notEqual(String(row.result ?? ''), '超时未融合', 't=31min：结果不能是「超时未融合」');
    assert.notEqual(String(row.status), 'interrupted', 't=31min：不能被判成中断');
    assert.ok(Number(row.resolved_at) > 0, 't=31min：融合之后要写 resolved_at');
    assert.equal(h.repos.rituals.runningOf(id), null, 't=31min：融合完就不能再融合一次');

    // 全库不该有任何一条「超时未融合」
    const timedOut = h.app.db.prepare("SELECT COUNT(*) AS n FROM rituals WHERE result = '超时未融合'").get() as { n: number };
    assert.equal(Number(timedOut.n), 0, 't=31min：一条「超时未融合」都不该有');

    // 「曾经」：阶段 3 的判定落库（成功或失败都算真的走过了那段路）
    const stage3 = eventsOf(h, id).filter((event) => event.type === 'ritual_success' || event.type === 'ritual_fail');
    assert.equal(stage3.length, 1, 't=31min：阶段 3 的判定要落库');
    assert.ok(stage3[0]!.seed && stage3[0]!.seed!.length > 0, 't=31min：阶段 3 的 seed 也要进库');
  } finally {
    h.app.close();
  }
});

/* ==================== 段三：t≈12h ==================== */

test('M2.18-E 仪式窗口 t≈12h：融合成功落库、序列变更生效，耗时来自事件流', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '守夜人');
    const id = makeReady(h);
    assert.equal(h.repos.characters.findById(id)!.sequence, 9, '起点是序列 9');

    // 推进到「12 小时窗口之内、离上界还差 1 分钟」—— 固定推进量，seed 可复现
    const advanceMs = RITUAL.runTimeoutMs - 60 * 1000;
    const success = await fuseUntilSuccess(h, USER, id, advanceMs);

    // 「曾经」：成功事件 + 配对的发起事件，耗时用两者的时间差算（不读状态表时间戳）
    const ritualId = String(success.payload.ritualId);
    const setup = eventsOf(h, id).find(
      (event) => event.type === 'ritual_setup' && String(event.payload.ritualId) === ritualId,
    );
    assert.ok(setup, '这次成功的仪式必须有配对的 ritual_setup');
    const hours = (success.createdAt - setup!.createdAt) / 3600000;
    assert.ok(
      hours > 11.9 && hours < 12,
      '发起→融合成功要跨 11 小时 59 分（事件流口径），实测 ' + hours.toFixed(3) + 'h',
    );
    assert.equal(Number(success.payload.from), 9, '这次仪式是 9 → 8');
    assert.equal(Number(success.payload.to), 8);

    const seqDeltas = eventsOf(h, id).filter(
      (event) => event.type === 'sequence_delta' && event.reason.startsWith('仪式:'),
    );
    assert.equal(seqDeltas.length, 1, '仪式路径的序列变更要落库（reason = 仪式:9->8）');
    assert.equal(seqDeltas[0]!.reason, '仪式:9->8');

    // 「此刻」：序列变更真的生效了
    assert.equal(h.repos.characters.findById(id)!.sequence, 8, '序列变更要生效（状态表）');
    assert.equal(h.repos.rituals.runningOf(id), null, '融合完之后没有挂着的仪式');
  } finally {
    h.app.close();
  }
});

/* ==================== 边界：t = 12h + 1min ==================== */

test('M2.18-E 仪式窗口 t=12h+1min：窗口有上界，过了仍然散（不是无限等）', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '过夜的人');
    const id = makeReady(h);
    const ritualId = await startRitual(h, USER, id);

    h.advance(RITUAL.runTimeoutMs + 60 * 1000);

    const text = joined(await h.send({ rawText: '.仪式 融合', userId: USER }));
    assert.match(text, /已经散了/, 't=12h+1min：应该散掉');
    assert.match(text, /12 小时|分钟/, '散掉的说明要把窗口讲清楚');

    const row = ritualRowOf(h, ritualId)!;
    assert.equal(String(row.result), '超时未融合');
    assert.equal(String(row.status), 'interrupted');
    // 超时不算失败：材料没损失，玩家可以重新准备（这是回执里承诺的）
    const stage3 = eventsOf(h, id).filter((event) => event.type === 'ritual_success' || event.type === 'ritual_fail');
    assert.equal(stage3.length, 0, '超时散掉的仪式不该落阶段 3 的判定事件');
  } finally {
    h.app.close();
  }
});

/* ==================== 对照：.晋升 不走 ritual ==================== */

test('M2.18-E 对照：.晋升 是同步结算，不受 ritual 窗口影响', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(SOLO, '快速通道');
    const id = makeReady(h, SOLO);

    // 先在库里挂一场仪式（走 .仪式 那条路），然后让它远远超过窗口
    const ritualId = await startRitual(h, SOLO, id);
    h.advance(30 * 3600 * 1000); // 30 小时 ≫ 12 小时窗口

    makeReady(h, SOLO); // 跨天之后把状态拉回能晋升
    const text = joined(await h.send({ rawText: '.晋升', userId: SOLO }));
    assert.match(text, /晋升判定/, '.晋升 要照常结算');
    assert.match(text, /成功率/, '.晋升 有自己的判定与回执');
    assert.doesNotMatch(text, /已经散了|超时未融合/, '.晋升 不该把仪式窗口的文案带出来');

    // 「曾经」：.晋升 的判定独立落库（reason 与仪式路径分得开）
    const promo = eventsOf(h, id).filter(
      (event) => event.type === 'promotion_success' || event.type === 'promotion_fail',
    );
    assert.equal(promo.length, 1, '.晋升 要落一条自己的判定事件');
    assert.equal(promo[0]!.reason, '晋升判定');
    assert.equal(promo[0]!.reason.startsWith('仪式'), false);

    /*
     * 「此刻」：那条挂着的仪式**原封不动** —— .晋升 既不读它、也不结算它。
     * 这正是「奇偶分流 = 一条同步路 + 一条跨登录路」的证据：
     * 修窗口只会影响后者，前者在任何时间点都能走。
     */
    const row = ritualRowOf(h, ritualId)!;
    assert.equal(String(row.status), 'running', '.晋升 不该动那条挂着的仪式');
    assert.equal(row.resolved_at, null);
    assert.ok(h.repos.rituals.runningOf(id), '仪式仍然挂在那里');
  } finally {
    h.app.close();
  }
});
