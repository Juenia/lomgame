import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateNumeric } from '../src/config/validate.ts';
import { NUMERIC } from '../src/config/numeric.ts';
import { archiveAuditLogs, archiveStats } from '../src/infra/archive.ts';
import { backupDatabase, listBackups, pruneBackups } from '../src/infra/backup.ts';
import { AuditLog } from '../src/infra/audit.ts';
import { Monitor } from '../src/infra/monitor.ts';
import { checkIntegrity, runStartupRecovery } from '../src/infra/recovery.ts';
import { migrate, openDatabase } from '../src/infra/db/sqlite.ts';
import { runDailyTick } from '../src/infra/tick.ts';
import { createHarness } from './helpers/app.ts';

const TMP_ROOT = join(process.cwd(), 'data', 'test-ops');

function tempDir(name: string): string {
  const dir = join(TMP_ROOT, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('备份：当天只备一份，重复调用不会覆盖', () => {
  const dir = tempDir('backup');
  const db = openDatabase(':memory:');
  migrate(db);
  try {
    const now = Date.UTC(2026, 5, 1, 3, 0, 0);
    const first = backupDatabase(db, dir, now);
    assert.equal(first.created, true);
    assert.ok(existsSync(first.file));
    assert.ok(first.bytes > 0);

    const second = backupDatabase(db, dir, now + 60 * 1000);
    assert.equal(second.created, false, '同一天第二次调用直接复用');
    assert.equal(second.file, first.file);
    assert.equal(listBackups(dir).length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('备份：保留 7 天，超期文件被清理（按文件名日期判断）', () => {
  const dir = tempDir('prune');
  const db = openDatabase(':memory:');
  migrate(db);
  try {
    const now = Date.UTC(2026, 5, 20);
    for (const day of ['2026-06-01', '2026-06-10', '2026-06-19']) {
      writeFileSync(join(dir, `backup-${day}.db`), 'x');
    }
    const pruned = pruneBackups(dir, 7, now);
    assert.equal(pruned.length, 2, '6-01 与 6-10 应被清理（6-19 还在 7 天窗口内）');
    assert.deepEqual(
      listBackups(dir).map((entry) => entry.file.replace(/^.*backup-/, '')),
      ['2026-06-19.db'],
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('审计归档：只搬走过期记录，热表保留近期', () => {
  const db = openDatabase(':memory:');
  migrate(db);
  try {
    const audit = new AuditLog(db);
    const now = Date.UTC(2026, 5, 20);
    audit.write({ userId: 'u1', command: '旧', createdAt: now - 30 * 24 * 3600 * 1000 });
    audit.write({ userId: 'u1', command: '旧2', createdAt: now - 10 * 24 * 3600 * 1000 });
    audit.write({ userId: 'u1', command: '新', createdAt: now - 1000 });

    const result = archiveAuditLogs(db, now - 7 * 24 * 3600 * 1000, now);
    assert.equal(result.moved, 2);
    assert.equal(result.hotRemaining, 1);
    assert.equal(result.archivedTotal, 2);
    assert.deepEqual(archiveStats(db), { hotRemaining: 1, archivedTotal: 2 });

    const again = archiveAuditLogs(db, now - 7 * 24 * 3600 * 1000, now);
    assert.equal(again.moved, 0, '重复归档不产生重复行');
    assert.equal(again.archivedTotal, 2);
  } finally {
    db.close();
  }
});

test('监控：耗时、错误率与分位数', () => {
  const monitor = new Monitor({ startedAt: 1000, maxSamples: 10 });
  for (let i = 1; i <= 10; i += 1) monitor.record('状态', i * 10, true);
  monitor.record('状态', 500, false);
  monitor.record('探索', 20, true);

  const snapshot = monitor.snapshot(2000);
  assert.equal(snapshot.total, 12);
  assert.equal(snapshot.errors, 1);
  assert.ok(Math.abs(snapshot.errorRate - 1 / 12) < 1e-9);
  assert.equal(snapshot.uptimeMs, 1000);
  const status = snapshot.commands.find((entry) => entry.command === '状态');
  assert.equal(status?.count, 11);
  assert.equal(status?.errors, 1);
  assert.equal(status?.maxMs, 500);
  assert.ok(snapshot.p50Ms > 0 && snapshot.p95Ms >= snapshot.p50Ms);

  monitor.reset();
  assert.equal(monitor.snapshot(3000).total, 0);
});

test('崩溃恢复：自检通过 + 补跑每日结算 + 解冻超时交易', async () => {
  const h = createHarness();
  const a = await h.createCharacter('20001', '克莱恩');
  const b = await h.createCharacter('20002', '正义', 'warrior');
  h.repos.inventory.add(a.id, '辅助材料·银粉', 1, 'unbound', h.now());
  h.repos.inventory.add(b.id, '便士', 200, 'unbound', h.now());
  h.advance(11_000);
  await h.send({ rawText: '.交易 @20002 辅助材料·银粉 1 40', userId: '20001' });
  assert.equal(h.repos.inventory.count(a.id, '辅助材料·银粉'), 0, '创建时冻结');

  h.advance(NUMERIC.trade.timeoutMs + 1000);
  const report = runStartupRecovery(h.app.router.deps, h.now());
  assert.equal(report.integrity, 'ok');
  assert.equal(report.expiredTrades, 1, '重启要把超时交易解冻');
  assert.equal(report.tickSkipped, false, '当天没结算过要补跑');
  assert.equal(h.repos.inventory.count(a.id, '辅助材料·银粉'), 1);

  const second = runStartupRecovery(h.app.router.deps, h.now());
  assert.equal(second.tickSkipped, true, '同一天再启动不会重复结算');
  assert.equal(checkIntegrity(h.app.router.deps).ok, true);
  h.app.close();
});

test('运行时监控接到指令上：跑几条指令后 /metrics 有数据', async () => {
  const h = createHarness();
  await h.createCharacter('20001', '克莱恩');
  await h.send({ rawText: '.状态', userId: '20001' });
  await h.send({ rawText: '.升维', userId: '20001' });

  const snapshot = h.app.monitor.snapshot();
  assert.ok(snapshot.total >= 2, `至少记录两条指令，实际 ${snapshot.total}`);
  const commands = snapshot.commands.map((entry) => entry.command);
  assert.ok(commands.includes('状态'));
  assert.ok(commands.every((command) => typeof command === 'string' && command.length > 0));
  h.app.close();
});

test('配置校验：正常配置零 error；坏配置会被逐条抓出来', () => {
  assert.deepEqual(
    validateNumeric().filter((issue) => issue.level === 'error'),
    [],
  );

  const broken = structuredClone(NUMERIC) as typeof NUMERIC;
  (broken as { lossOfControl: { divisor: number } }).lossOfControl.divisor = 0;
  (broken as { play: { exposureChance: number } }).play.exposureChance = 1.5;
  (broken as { party: { maxMembers: number } }).party.maxMembers = 1;
  const issues = validateNumeric(broken);
  const paths = issues.filter((issue) => issue.level === 'error').map((issue) => issue.path);
  assert.ok(paths.includes('lossOfControl.divisor'));
  assert.ok(paths.includes('play.exposureChance'));
  assert.ok(paths.includes('party.maxMembers'));
});

test('每日结算与运维不互相踩：tick 幂等且监控/备份互不影响', async () => {
  const h = createHarness();
  await h.createCharacter('20001', '克莱恩');
  const before = h.app.monitor.snapshot().total;
  const first = runDailyTick(h.app.router.deps, h.now());
  const second = runDailyTick(h.app.router.deps, h.now());
  assert.equal(first.skipped, false);
  assert.equal(second.skipped, true);
  assert.equal(h.app.monitor.snapshot().total, before, '每日结算不计入指令调用统计');
  h.app.close();
});
