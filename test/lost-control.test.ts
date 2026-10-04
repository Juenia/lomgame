import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadCards } from '../src/cards/loader.ts';
import { PATHWAY_LABELS } from '../src/domain/character/rules.ts';
import type { PathwayId } from '../src/domain/character/types.ts';
import {
  MIN_AFTERSHOCK,
  MIN_LOST_CONTROL_PER_PATHWAY,
  loadLostControlPool,
  loadLostControlOrThrow,
  pickLostControlText,
} from '../src/cards/lost-control.ts';
import { lintCard, loadRegistry } from '../src/cards/lint.ts';
import { loadLocations } from '../src/data/loader.ts';
import { EventEngine } from '../src/domain/event/engine.ts';
import { COND_STATUSES, evalCond, parseCond } from '../src/domain/event/trigger.ts';
import { runDailyTick } from '../src/infra/tick.ts';
import type { CharacterState } from '../src/domain/character/types.ts';
import { createHarness } from './helpers/app.ts';

const A = '20001';

function makeState(overrides: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'char-1', userId: 'u1', name: '克莱恩', pathway: 'seer', pathwayStatus: 'initiated', gender: 'male', sequence: 9,
    hp: 100, mp: 100, mad: 0, cor: 0, dig: 0, dp: 0,
    status: 'active', promotionFails: 0, createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

test('失控文本：22 途径 × 10 条 = 220，余波不少于 3 条', () => {
  const pool = loadLostControlPool();
  assert.equal(pool.issues.filter((issue) => issue.level === 'error').length, 0);
  /*
   * M2.76：30 → **70**（补齐 sailor / perfect / reader / mother 四条途径）。
   *
   * ⚠️ 这个数**故意写死**，与下面那份「途径清单」的处理相反 —— 两者不是同一种东西：
   *   · **清单**（哪几条途径）不能抄：抄了之后加途径时它不会红，只会安静地少读一半
   *     （lost-control.ts 的 PATHWAYS 就是这么咬过一次的）⇒ 它改为从 PATHWAY_LABELS 派生。
   *   · **数量**（多少条）必须写死：它就是 G5，作用是「内容一变就变红，提醒你去看一眼」。
   *     写成「途径数 × 10」等于把判据交给被检查的对象 —— 内容表漏掉一整条途径时，
   *     判据会跟着一起漏、静默通过（K14：抓不住故障的判据是装饰）。
   */
  assert.equal(pool.all.length, 220);
  for (const pathway of Object.keys(PATHWAY_LABELS) as PathwayId[]) {
    assert.ok(
      (pool.byPathway[pathway] ?? []).length >= MIN_LOST_CONTROL_PER_PATHWAY,
      `${pathway} 至少 ${MIN_LOST_CONTROL_PER_PATHWAY} 条`,
    );
  }
  assert.ok(pool.aftershock.length >= MIN_AFTERSHOCK);
  assert.equal(new Set(pool.all).size, pool.all.length, '文本不应该重复');
  assert.equal(loadLostControlOrThrow().all.length, 220);
});

test('失控文本：七条途径的文本各自命中自己的主题，没有串味', () => {
  const pool = loadLostControlPool();
  const text = (pathway: PathwayId): string => (pool.byPathway[pathway] ?? []).join('');
  assert.match(text('seer'), /名字|牌|未来|钟/, '愚者：幻觉与预言');
  assert.match(text('warrior'), /手|血|打|疼/, '战士：暴怒与暴力');
  assert.match(text('sleepless'), /梦|睡|影子|黑暗/, '不眠者：梦魇与失序');
  // M2.76：补齐的四条途径 —— 每条都要有自己的词场，
  // 否则「专属文本」只是换了个人名的通用句（串味是这条用例唯一要挡的东西）。
  assert.match(text('sailor'), /海|盐|风|水/, '水手：风暴与溺水');
  assert.match(text('perfect'), /拆|齿轮|螺丝|精确/, '完美者：机械与拆解');
  assert.match(text('reader'), /书|读|记|页/, '阅读者：知识与记录');
  assert.match(text('mother'), /根|土|种|长/, '母亲：生长与土地');
  const rows = (Object.keys(PATHWAY_LABELS) as PathwayId[]).map(text);
  assert.equal(new Set(rows).size, rows.length, '任意两条途径的文本不该完全相同');
});

test('失控事件卡：7 张，全部要求 status:lost_control，且 lint 通过', () => {
  const { cards } = loadCards();
  const lostCards = cards.filter((card) => card.id.startsWith('lost_'));
  assert.equal(lostCards.length, 7, 'M2.1 方案 D 之后是 5 张独狼/通用 + 2 张队伍版');
  for (const card of lostCards) {
    assert.ok(
      card.trigger.cond.includes('status:lost_control'),
      `${card.id} 必须只在失控时可触发`,
    );
    assert.equal(card.trigger.type, 'random');
  }
  // 方案 D：lost_001 / lost_005 改成独狼版（否则独狼玩家永远碰不到，8/8 验收过不去），
  // 「队友在身边才会发生」的两个场景挪到 lost_006 / lost_007，队伍条件与文案原样保留。
  for (const id of ['lost_001', 'lost_005']) {
    const solo = lostCards.find((card) => card.id === id)!;
    assert.ok(
      !solo.trigger.cond.some((cond) => cond.startsWith('party:')),
      `${id} 不该再要求队伍`,
    );
  }
  for (const id of ['lost_006', 'lost_007']) {
    const party = lostCards.find((card) => card.id === id)!;
    assert.ok(party.trigger.cond.includes('party:size>=2'), `${id} 是队伍版，必须保留队伍条件`);
  }
  const lucid = lostCards.find((card) => card.id === 'lost_003')!;
  assert.ok(lucid.effects.some((effect) => (effect.mad ?? 0) < 0), '短暂清醒要压疯狂');

  const registry = loadRegistry({ flags: [] });
  for (const card of lostCards) {
    const errors = lintCard(card, { ...registry, flags: new Set([
      'marked_by_party', 'marked_by_church', 'lucid_moment', 'rescued_by_party',
      'marked_by_witness', 'found_way_back',
    ]) }).filter((issue) => issue.level === 'error');
    assert.deepEqual(errors, [], `${card.id} 不该有 lint error`);
  }
});

test('方案 E：lost_* 只在失控时进入探索池，普通日卡池一张都不多', () => {
  const { cards } = loadCards();
  const { locations } = loadLocations();
  const engine = new EventEngine(cards);
  const poolFor = (status: CharacterState['status'], locationName: string): string[] => {
    const location = locations.find((entry) => entry.name === locationName)!;
    return engine
      .eligible(
        {
          character: makeState({ status, sequence: 8, dig: 100, cor: 0, mad: 0 }),
          flags: new Set<string>(),
          date: '2026-06-01',
          location: location.name,
        },
        { date: '2026-06-01', location: location.name, types: ['daily', 'random', 'hidden'] },
      )
      .filter((card) => location.events.includes(card.id))
      .map((card) => card.id);
  };

  // 普通日：池子里没有任何 lost_*
  for (const name of ['灰雾之上', '无光地下室', '墓园小径', '老码头', '廷根市']) {
    const normal = poolFor('active', name);
    assert.equal(normal.filter((id) => id.startsWith('lost_')).length, 0, `${name} 普通日不该有失控卡`);
  }

  // 失控日：每个地点只多出挂好的那 2 张，地点自身的卡一张不少
  const changed: Record<string, string[]> = {
    灰雾之上: ['lost_002', 'lost_004'],
    无光地下室: ['lost_001', 'lost_003'],
    墓园小径: ['lost_003', 'lost_005'],
    老码头: ['lost_002', 'lost_003'],
    廷根市: ['lost_005', 'lost_003'],
  };
  for (const [name, expected] of Object.entries(changed)) {
    const normal = poolFor('active', name);
    const lost = poolFor('lost_control', name);
    const added = lost.filter((id) => !normal.includes(id));
    assert.deepEqual(added.sort(), [...expected].sort(), `${name} 失控日只应多出这 2 张`);
    assert.deepEqual(
      lost.filter((id) => !id.startsWith('lost_')).sort(),
      normal.sort(),
      `${name} 地点自身的卡不受影响`,
    );
  }

  // 队伍版（lost_006/007）不进探索池，只在 .扮演 暴露通道里出现
  const allPools = locations.flatMap((location) => poolFor('lost_control', location.name));
  assert.equal(allPools.includes('lost_006'), false);
  assert.equal(allPools.includes('lost_007'), false);
});

test('status 条件：解析、求值、非法取值被拒', () => {
  assert.deepEqual(parseCond('status:lost_control'), { kind: 'status', status: 'lost_control' });
  assert.equal(parseCond('status:'), null);
  assert.equal(evalCond('status:lost_control', {
    character: makeState({ status: 'lost_control' }),
    flags: new Set(),
    date: '2026-06-01',
  }), true);
  assert.equal(evalCond('status:lost_control', {
    character: makeState({ status: 'active' }),
    flags: new Set(),
    date: '2026-06-01',
  }), false);
  assert.ok(COND_STATUSES.includes('lost_control'));

  const { cards } = loadCards();
  const registry = loadRegistry({ flags: [] });
  const bogus = {
    ...cards.find((card) => card.id === 'lost_003')!,
    id: 'lost_999',
    trigger: {
      ...cards.find((card) => card.id === 'lost_003')!.trigger,
      cond: ['status:不存在的状态'],
    },
  };
  const issues = lintCard(bogus, registry);
  assert.ok(issues.some((issue) => issue.level === 'error' && issue.message.includes('status 条件取值非法')));
});

test('失控卡只在失控时进入抽取池', () => {
  const { cards } = loadCards();
  const engine = new EventEngine(cards);
  const date = '2026-06-01';
  const active = engine.eligible(
    { character: makeState({ status: 'active' }), flags: new Set(), date, partySize: 1 },
    { date, types: ['random'] },
  );
  const lost = engine.eligible(
    { character: makeState({ status: 'lost_control' }), flags: new Set(), date, partySize: 1 },
    { date, types: ['random'] },
  );
  assert.ok(!active.some((card) => card.id.startsWith('lost_')));
  assert.ok(lost.some((card) => card.id === 'lost_002'), '失控时教会注意可以触发');
  // M2.1 方案 D：独狼也能碰到 lost_001（改独狼版了）；队伍版挪到了 lost_006
  assert.ok(lost.some((card) => card.id === 'lost_001'), '独狼也能触发街头挥拳');
  assert.ok(!lost.some((card) => card.id === 'lost_006'), '没有队伍时不触发攻击队友版');

  // 有队伍时，队伍版才会进池
  const withParty = engine.eligible(
    { character: makeState({ status: 'lost_control' }), flags: new Set(), date, partySize: 2 },
    { date, types: ['random'] },
  );
  assert.ok(withParty.some((card) => card.id === 'lost_006'), '有队伍时才触发攻击队友版');
  assert.ok(withParty.some((card) => card.id === 'lost_007'), '有队伍时才触发被队友捡回来版');
});

test('每日结算：失控会按途径抽文本、写 lost_control_events、并发私聊', async () => {
  const h = createHarness();
  const characters = [];
  for (let i = 0; i < 10; i += 1) {
    const userId = String(31000 + i);
    const character = await h.createCharacter(userId, `失控者${i}`);
    h.repos.characters.update({
      ...h.repos.characters.findById(character.id)!,
      mad: 100,
      cor: 100,
      updatedAt: h.now(),
    });
    characters.push({ userId, character });
  }

  let triggered = 0;
  let notifications = 0;
  for (let day = 0; day < 10 && triggered === 0; day += 1) {
    const summary = runDailyTick(h.app.router.deps, h.now());
    triggered += summary.lostControl;
    notifications += summary.notifications.filter((notice) => notice.text.includes('你失控了')).length;
    h.advance(24 * 60 * 60 * 1000);
  }

  assert.ok(triggered > 0, 'MAD/COR 满值时 10 天里必然出现失控');
  assert.equal(triggered, notifications, '每次失控都要有对应私聊');
  const rows = h.app.db
    .prepare('SELECT character_id, pathway, text, hp_loss, mad_gain, form FROM lost_control_events')
    .all() as Array<{
      character_id: string;
      pathway: string;
      text: string;
      hp_loss: number;
      mad_gain: number;
      form: string | null;
    }>;
  assert.equal(rows.length, triggered);
  const pool = loadLostControlPool();
  for (const row of rows) {
    // 文本按途径抽取后再经模板渲染，所以这里校验「来自该途径的池子 + 片段已全部渲染」
    const pathwayTexts = pool.byPathway[row.pathway as 'seer'];
    assert.ok(pathwayTexts.length > 0, `${row.pathway} 必须有文本池`);
    assert.ok(row.text.length > 0);
    assert.ok(!row.text.includes('{{'), `文本里的片段必须已渲染：${row.text}`);
    assert.ok(row.hp_loss > 0);
    /*
     * M2.76：MAD 不再是一个全局常数 —— **它由这次落到的堕落形态决定**。
     * 所以判据从「等于 5」改成「等于那个形态的 mad_gain」；
     * 形态为 null（该途径没写 / 序列够不着）时才是全局缺省。
     * 校验用的是库里那一列 form，而不是「当前配置」—— 后者会在
     * 有人改了 YAML 之后让这条用例**追溯性地**变红（历史行没变，断言却变了）。
     */
    const form = pool.forms.find((entry) => entry.id === row.form) ?? null;
    assert.equal(row.mad_gain, form ? form.madGain : NUMERIC.tick.lostControlMad, `${row.pathway} 的 MAD 增量应等于 ${row.form ?? '缺省'}`);
    // 已实现途径都写了形态，所以这一轮走的一定是形态分支（不是缺省）
    assert.ok(form !== null, `${row.pathway} 这次应当落进一个形态`);
  }

  // 抽取本身是可复现的（固定下标 → 固定文本）
  assert.equal(pickLostControlText(pool, 'seer', 0), pool.byPathway.seer[0]);
  assert.equal(pickLostControlText(pool, 'warrior', 11), pool.byPathway.warrior[1]);
  h.app.close();
});

test('恢复余波：.休息 / .净化 解除失控时会带一句余波', async () => {
  const h = createHarness();
  const character = await h.createCharacter(A, '克莱恩');
  h.repos.characters.update({
    ...h.repos.characters.findById(character.id)!,
    status: 'lost_control',
    mad: 40,
    cor: 20,
    updatedAt: h.now(),
  });

  h.advance(11_000);
  const rested = await h.send({ rawText: '.休息', userId: A });
  assert.match(rested[0]?.text ?? '', /拽了回来/);
  const pool = loadLostControlPool();
  assert.ok(
    pool.aftershock.some((text) => (rested[0]?.text ?? '').includes(text.slice(0, 5))),
    `休息回执里应当有余波文本：${rested[0]?.text}`,
  );

  h.repos.inventory.add(character.id, '辅助材料·圣盐', 1, 'bound', h.now());
  h.repos.characters.update({
    ...h.repos.characters.findById(character.id)!,
    status: 'lost_control',
    updatedAt: h.now(),
  });
  h.advance(24 * 60 * 60 * 1000);
  const purified = await h.send({ rawText: '.净化', userId: A });
  assert.match(purified[0]?.text ?? '', /同步了/);
  assert.ok(pool.aftershock.some((text) => (purified[0]?.text ?? '').includes(text.slice(0, 5))));
  h.app.close();
});
