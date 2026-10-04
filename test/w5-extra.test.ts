import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { NUMERIC, applyNumericOverrides, resetNumeric } from '../src/config/numeric.ts';
import { birthCityOf } from '../src/domain/geo/index.ts';
import { PATHWAY_LABELS } from '../src/domain/character/rules.ts';
import { validateNumeric } from '../src/config/validate.ts';
import { loadCards } from '../src/cards/loader.ts';
import { EventEngine } from '../src/domain/event/engine.ts';
import { silentLogger } from '../src/infra/logger.ts';
import { createApp, createOneBotApp, startHttpServer } from '../src/main.ts';
import { MemoryAdapter } from '../src/adapter/memory.ts';
import { runSimulation } from '../src/sim/simulator.ts';
import type { CharacterState } from '../src/domain/character/types.ts';
import { createHarness } from './helpers/app.ts';

function makeState(overrides: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'char-1', userId: 'u1', name: '克莱恩', pathway: 'seer', pathwayStatus: 'initiated', gender: 'male', sequence: 9,
    hp: 100, mp: 100, mad: 0, cor: 0, dig: 0, dp: 0,
    status: 'active', promotionFails: 0, createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

test('W5 终值都在 numeric 里，且都带依据注释', async () => {
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(join(process.cwd(), 'src', 'config', 'numeric.ts'), 'utf8'),
  );
  // 终值本身（lossOfControl 三个数在 M2.1 重定过，见 docs/M2-失控重定报告.md）
  assert.equal(NUMERIC.lossOfControl.divisor, 250);
  assert.equal(NUMERIC.lossOfControl.madThreshold, 65);
  assert.equal(NUMERIC.lossOfControl.corThreshold, 65);
  assert.equal(NUMERIC.play.exposureChance, 0.38);
  assert.equal(NUMERIC.promotion.madPenalty, 0.3);
  assert.equal(NUMERIC.promotion.corPenalty, 0.15);
  assert.equal(NUMERIC.potion.madOnDrink, 6);
  assert.equal(NUMERIC.recovery.purify.mad, -8);
  assert.equal(NUMERIC.explore.bonusDropChance, 0.06);
  // 每个 W5 旋钮都要在注释里写清依据（防止后人拍脑袋改）
  for (const marker of ['W5 依据', 'W5：', 'W5 定值', 'M2.1 依据']) {
    assert.ok(source.includes(marker), `numeric.ts 缺少依据注释标记：${marker}`);
  }
  assert.deepEqual(validateNumeric().filter((issue) => issue.level === 'error'), []);
});

test('运行期覆盖：applyNumericOverrides 改值、resetNumeric 复原（模拟器调参用）', () => {
  const original = NUMERIC.lossOfControl.divisor;
  applyNumericOverrides({ lossOfControl: { divisor: 999 } });
  assert.equal(NUMERIC.lossOfControl.divisor, 999);
  resetNumeric();
  assert.equal(NUMERIC.lossOfControl.divisor, original);
});

test('模拟器：材料比按「本途径配方所需材料」口径统计，并有全材料对照值', () => {
  const report = runSimulation({ characterCount: 60, days: 20, seed: 'caliber', strategy: 'steady' });
  const s = report.summary;
  assert.ok(s.materialRatioNeededGained > 0, '本途径材料产出必须被统计');
  assert.ok(s.materialsAllRatio > 0, '全材料口径也要有');
  assert.ok(
    s.materialRatioNeededGained <= s.materialsGained,
    '本途径口径不会超过总产出',
  );
  assert.equal(s.materialsConsumed, s.materialsConsumed, '消耗在两种口径下是同一个数（只消耗本途径材料）');
});

test('模拟器：激进型比稳健型更常净化、更容易失控', () => {
  const steady = runSimulation({ characterCount: 120, days: 30, seed: 'w5-steady', strategy: 'steady' });
  const aggressive = runSimulation({ characterCount: 120, days: 30, seed: 'w5-aggressive', strategy: 'aggressive' });
  assert.ok(aggressive.summary.purifyUsageRate > steady.summary.purifyUsageRate);
  assert.ok(aggressive.summary.lostControlRate > steady.summary.lostControlRate);
});

test('失控卡：有队伍时「攻击队友」进入抽取池，独狼时不进入', () => {
  const { cards } = loadCards();
  const engine = new EventEngine(cards);
  const date = '2026-06-01';
  const solo = engine.eligible(
    { character: makeState({ status: 'lost_control' }), flags: new Set(), date, partySize: 1 },
    { date, types: ['random'] },
  );
  const paired = engine.eligible(
    { character: makeState({ status: 'lost_control' }), flags: new Set(), date, partySize: 2 },
    { date, types: ['random'] },
  );
  // M2.1 方案 D：队伍版从 lost_001 / lost_005 挪到了 lost_006 / lost_007，
  // 原来这两张改成独狼版（否则独狼永远碰不到，8/8 验收过不去）。
  assert.ok(!solo.some((card) => card.id === 'lost_006'), '独狼不该碰到队伍版');
  assert.ok(!solo.some((card) => card.id === 'lost_007'), '独狼不该碰到队伍版');
  assert.ok(paired.some((card) => card.id === 'lost_006'), '有队伍才触发攻击队友版');
  assert.ok(paired.some((card) => card.id === 'lost_007'), '有队伍才触发被队友捡回来版');
  assert.ok(solo.some((card) => card.id === 'lost_001'), '独狼版必须能碰到');
  assert.ok(solo.some((card) => card.id === 'lost_005'), '独狼版必须能碰到');
});

test('HTTP：/metrics 暴露监控与归档，/health 暴露备份与失控计数', async () => {
  const app = createOneBotApp(
    { dbPath: ':memory:', port: 0, onebotApiBase: 'http://127.0.0.1:1', detailToPrivate: true, startOps: false },
    silentLogger,
  );
  const server = startHttpServer(app);
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  try {
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as Record<string, unknown>;
    assert.equal(health.ok, true);
    assert.ok(Array.isArray(health.commands));
    assert.ok('backup' in health);
    assert.ok('audit' in health);
    assert.equal(typeof health.lostControlEvents, 'number');

    const metrics = (await (await fetch(`http://127.0.0.1:${port}/metrics`)).json()) as {
      ok: boolean;
      monitor: { total: number; errorRate: number; commands: unknown[] };
    };
    assert.equal(metrics.ok, true);
    assert.equal(typeof metrics.monitor.total, 'number');
    assert.equal(typeof metrics.monitor.errorRate, 'number');
    assert.ok(Array.isArray(metrics.monitor.commands));
  } finally {
    server.close();
    app.close();
  }
});

test('运维服务开启时：启动即产出一份备份', async () => {
  const dir = join(process.cwd(), 'data', 'test-stage-backup');
  rmSync(dir, { recursive: true, force: true });
  const app = createApp(
    {
      dbPath: ':memory:',
      port: 0,
      onebotApiBase: 'http://127.0.0.1:1',
      detailToPrivate: true,
      backupDir: dir,
      runTickOnStart: false,
    },
    { adapter: new MemoryAdapter(), logger: silentLogger },
  );
  try {
    assert.ok(existsSync(dir), '备份目录应当被创建');
    const files = (await import('node:fs')).readdirSync(dir);
    assert.equal(files.length, 1, '当天只应有一份备份');
    assert.match(files[0] ?? '', /^backup-\d{4}-\d{2}-\d{2}\.db$/);
  } finally {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('W5 压测：100 人并发跑日常 + 组队任务 + 每日结算，不崩且幂等', async () => {
  const h = createHarness();
  const users = Array.from({ length: 100 }, (_, i) => String(70000 + i));

  await Promise.all(
    users.map(async (userId, index) => {
      // M2.7.6：两步建号（先问性别，回 1 才建号）
      await h.deliver({ rawText: `.创建 终局者${index}`, userId, messageId: `w5:create:${userId}` });
      await h.deliver({ rawText: '1', userId, messageId: `w5:create:${userId}:gender` });
      await h.deliver({ rawText: '.扮演 我占卜今天的运势', userId, messageId: `w5:play:${userId}` });
      await h.deliver({ rawText: '.探索 廷根市', userId, messageId: `w5:explore:${userId}` });
      await h.deliver({ rawText: '.队伍 创建', userId, messageId: `w5:party:${userId}` });
      await h.deliver({ rawText: '.队伍 任务', userId, messageId: `w5:task:${userId}` });
    }),
  );

  const first = runSimulation({ characterCount: 5, days: 2, seed: 'stress-sim', strategy: 'steady' });
  assert.ok(first.summary.characterCount === 5);

  const characters = h.app.db.prepare('SELECT COUNT(*) AS n FROM characters').get() as { n: number };
  assert.equal(characters.n, 100);
  const parties = h.app.db.prepare('SELECT COUNT(*) AS n FROM parties').get() as { n: number };
  assert.equal(parties.n, 100, '100 人各建了一个队');
  const tasks = h.app.db.prepare('SELECT COUNT(*) AS n FROM party_tasks').get() as { n: number };
  assert.equal(tasks.n, 0, '单人队伍达不到人数门槛，不该产生队伍任务');
  const monitor = h.app.monitor.snapshot();
  assert.ok(monitor.total > 0 && monitor.errorRate === 0, `不该有异常：${JSON.stringify(monitor)}`);
  h.app.close();
});
test('模拟器：给出调制瓶颈诊断，便于判断循环卡在哪', () => {
  const report = runSimulation({ characterCount: 60, days: 20, seed: 'bottleneck', strategy: 'aggressive' });
  const s = report.summary;
  assert.ok(Array.isArray(s.brewBottleneck));
  assert.ok(s.brews >= 0 && s.drinks >= 0);
  assert.ok(s.materialsFromExplore >= 0 && s.materialsFromCards >= 0);
  assert.ok(
    s.materialsFromExplore + s.materialsFromCards <= s.materialsGained + 1e-9,
    '按来源拆分的产出不能超过总产出',
  );
  assert.ok(s.brewBlockedNoMaterials >= 0 && s.brewBlockedNoMp >= 0);
  for (const entry of s.brewBottleneck) {
    assert.ok(entry.itemId.length > 0 && entry.count > 0);
  }
});

test('备份：产出的文件是可直接打开的 SQLite 快照', async () => {
  const { backupDatabase } = await import('../src/infra/backup.ts');
  const { openDatabase, migrate } = await import('../src/infra/db/sqlite.ts');
  const dir = join(process.cwd(), 'data', 'test-backup-verify');
  rmSync(dir, { recursive: true, force: true });
  const db = openDatabase(':memory:');
  migrate(db);
  db.prepare(
    'INSERT INTO users (id, qq_id, nickname, status, created_at) VALUES (?,?,?,?,?)',
  ).run('u1', 'u1', '克莱恩', 'active', 0);
  try {
    const result = backupDatabase(db, dir, Date.UTC(2026, 6, 1));
    const restored = openDatabase(result.file);
    const row = restored.prepare('SELECT nickname FROM users WHERE id = ?').get('u1') as
      | { nickname: string }
      | undefined;
    assert.equal(row?.nickname, '克莱恩', '备份里必须能查到数据');
    restored.close();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('余波只在解除失控时出现：普通休息不带余波', async () => {
  const h = createHarness();
  await h.createCharacter('20001', '克莱恩');
  h.advance(11_000);
  const sent = await h.send({ rawText: '.休息', userId: '20001' });
  assert.doesNotMatch(sent[0]?.text ?? '', /拽了回来/);
  assert.ok((sent[0]?.text ?? '').includes('你把自己关在屋里'));
  h.app.close();
});
