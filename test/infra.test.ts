import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrate, openDatabase } from '../src/infra/db/sqlite.ts';
import { CharacterRepo } from '../src/infra/db/characters.ts';
import { IdempotencyStore } from '../src/infra/idempotency.ts';
import { RateLimiter, TokenBucket } from '../src/infra/ratelimit.ts';
import { KeyedQueue } from '../src/infra/queue.ts';
import { AuditLog } from '../src/infra/audit.ts';
import { SensitiveFilter } from '../src/infra/sensitive.ts';
import { buildInitialCharacter } from '../src/router/commands/create.ts';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * G1：仓库里真实存在的迁移文件清单（不硬编码 —— 新增迁移不该让任何测试变红）。
 * 见 docs/架构铁律.md §三·补。
 */
const MIGRATION_FILES = readdirSync(
  fileURLToPath(new URL('../src/infra/db/migrations', import.meta.url)),
)
  .filter((file) => file.endsWith('.sql'))
  .sort();

test('迁移可重复执行，第二次不再应用', () => {
  const db = openDatabase(':memory:');
  const first = migrate(db);
  const second = migrate(db);
  /*
   * G1（M2.18 拍板三）：这一条**不再硬编码迁移清单**。
   *
   * 它断言的本质是「两份清单一致」—— schema_migrations 里应用过的，与仓库里存在的。
   * 硬编码时，新增一条迁移就会让它变红（M2.18 的 0023 就是这么绊到的），
   * 而那种红**不是问题**；改成读目录之后，它红了才是真问题
   * （有文件没被应用 / 有记录没有文件）。
   *
   * 与它相对的是 G2—G7 那些**内容盘点**断言（能力条数 / 教会家数 / 失控文本条数…）——
   * 那些变红是「该去看一眼」，保留硬编码。见 docs/架构铁律.md §三·补。
   */
  assert.deepEqual([...first].sort(), MIGRATION_FILES);
  assert.deepEqual(second, []);
  db.close();
});

test('幂等：同一 message_id 只放行一次；cleanup 清理过期键', () => {
  const db = openDatabase(':memory:');
  migrate(db);
  const store = new IdempotencyStore(db);
  assert.equal(store.tryMark('m1', 'u1', 1000), true);
  assert.equal(store.tryMark('m1', 'u1', 1001), false);
  assert.equal(store.seen('m1'), true);
  assert.equal(store.tryMark('m2', 'u1', 2000), true);
  assert.equal(store.count(), 2);
  assert.equal(store.cleanup(1500), 1);
  assert.equal(store.count(), 1);
  db.close();
});

test('令牌桶：容量、补充、拒绝与 retryAfter', () => {
  const bucket = new TokenBucket({ capacity: 1, refillPerSec: 1 / 5 });
  assert.equal(bucket.consume('u1', 0).ok, true);
  const denied = bucket.consume('u1', 1000);
  assert.equal(denied.ok, false);
  assert.equal(denied.retryAfterMs, 4000);
  assert.equal(bucket.consume('u1', 5000).ok, true);
  assert.equal(bucket.consume('u2', 5000).ok, true, '不同 key 互不影响');
});

test('频控：.状态 5 秒冷却，.创建 只防刷屏（唯一性由角色表保证）', () => {
  const limiter = new RateLimiter();
  assert.equal(limiter.check('状态', 'u1', 0).ok, true);
  assert.equal(limiter.check('状态', 'u1', 4000).ok, false);
  assert.equal(limiter.check('状态', 'u1', 5000).ok, true);

  // .创建 的「1 次/人」由角色表唯一性保证（见 router 测试），频控只防刷屏
  for (let i = 0; i < 5; i += 1) assert.equal(limiter.check('创建', 'u1', i).ok, true);
  assert.equal(limiter.check('创建', 'u1', 5).ok, false);
  assert.equal(RateLimiter.describe({ ok: false, retryAfterMs: Infinity }), '这条指令每人只能使用一次。');
  assert.match(RateLimiter.describe(limiter.check('状态', 'u1', 5001)), /秒后再试/);
});

test('actor 队列：同 key 串行、异 key 并行、异常不堵塞后续', async () => {
  const queue = new KeyedQueue();
  const order: string[] = [];
  const slow = (tag: string, ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(() => { order.push(tag); resolve(); }, ms));

  await Promise.all([
    queue.run('a', () => slow('a1', 20)),
    queue.run('a', () => slow('a2', 1)),
    queue.run('b', () => slow('b1', 1)),
  ]);
  assert.deepEqual(order.filter((t) => t.startsWith('a')), ['a1', 'a2'], '同 key 必须按提交顺序');

  await assert.rejects(queue.run('c', () => { throw new Error('boom'); }));
  assert.equal(await queue.run('c', () => 'ok'), 'ok');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(queue.size, 0);
});

test('角色仓储：建号、读号、改号、事件落库', () => {
  const db = openDatabase(':memory:');
  migrate(db);
  const repo = new CharacterRepo(db);
  // M2.7.6：创建出来的是普通人（没有途径、没有序列）
  const character = buildInitialCharacter({ userId: 'u1', name: '克莱恩', gender: 'male', now: 1000 });

  repo.ensureUser('u1', '克莱恩', 1000);
  repo.insert(character);
  assert.equal(repo.count(), 1);
  /*
   * ⚠️ M2.90：仓储读出来的对象比 `buildInitialCharacter` 多两个**可选**字段
   * （`currentLocationId` / `exp` —— 列就在那儿，值是 null / 0）。
   * 这不是新 bug，是这条断言一直没跟上：可选字段让 tsc 看不见这点差别，
   * 于是一直到有人真的跑这个文件才发现它红着。
   * 修法是把期望补全，而不是去改建号那条链路 —— 后者会牵动一串无关的东西。
   */
  const stored = { ...character, currentLocationId: null, exp: 0 };
  assert.deepEqual(repo.findByUserId('u1'), stored);
  assert.deepEqual(repo.findById(character.id), stored);
  assert.equal(repo.findByUserId('nobody'), null);

  repo.update({ ...character, mad: 12, updatedAt: 2000 });
  assert.equal(repo.findByUserId('u1')?.mad, 12);

  repo.appendEvents([
    { type: 'mad_delta', characterId: character.id, payload: { before: 0, after: 12, delta: 12 }, reason: '测试', createdAt: 2000 },
  ]);
  const events = repo.eventsOf(character.id);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]?.payload, { before: 0, after: 12, delta: 12 });
  db.close();
});

test('审计日志与敏感词', () => {
  const db = openDatabase(':memory:');
  migrate(db);
  const audit = new AuditLog(db);
  audit.write({ userId: 'u1', command: '创建', input: '.创建 克莱恩 愚者', output: 'ok', createdAt: 1 });
  audit.write({ userId: 'u1', command: '状态', input: '.状态', output: 'ok', createdAt: 2 });
  assert.equal(audit.count(), 2);
  assert.deepEqual(audit.recent('u1').map((e) => e.command), ['状态', '创建']);
  db.close();

  const filter = new SensitiveFilter();
  assert.equal(filter.hit('正常的一句话'), null);
  assert.equal(filter.hit('来加微信买魔药'), '加微信');
  assert.equal(filter.mask('加微信'), '***');
});
