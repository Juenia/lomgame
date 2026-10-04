/**
 * 封测日报 CLI（W6）
 *   node scripts/beta-daily.ts --date 2026-09-22 --db data/beta.db --out docs/封测日报-2026-09-22.md
 * 产物：markdown 日报 + beta_daily 表里的一条快照（复盘时可追溯）
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../src/infra/db/sqlite.ts';
import { buildDailyReport } from '../src/ops/daily-report.ts';
import { renderAlerts } from '../src/ops/alerts.ts';
import { dateKey } from '../src/infra/date.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ?? fallback;
}

const dbPath = arg('db', join(process.cwd(), 'data', 'game.db'));
const date = arg('date', dateKey(Date.now()));
const out = arg('out', join('docs', `封测日报-${date}.md`));

const db = openDatabase(dbPath);
try {
  const note = arg('note', '');
const report = buildDailyReport(db, date);
const markdown = note ? `${report.markdown}\n---\n\n> 备注：${note}\n` : report.markdown;
writeFileSync(out, markdown, 'utf8');

  db.prepare(
    `INSERT INTO beta_daily (date, dau, new_users, commands, retention_d1, retention_d7, feedback_count, deadlock_rate, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       dau = excluded.dau, new_users = excluded.new_users, commands = excluded.commands,
       retention_d1 = excluded.retention_d1, retention_d7 = excluded.retention_d7,
       feedback_count = excluded.feedback_count, deadlock_rate = excluded.deadlock_rate,
       payload_json = excluded.payload_json, created_at = excluded.created_at`,
  ).run(
    date,
    report.stats.dauByDate.find((entry) => entry.date === date)?.dau ?? 0,
    report.stats.dauByDate.find((entry) => entry.date === date)?.newUsers ?? 0,
    report.stats.dauByDate.find((entry) => entry.date === date)?.commands ?? 0,
    report.stats.retention.find((entry) => entry.cohort === date)?.d1 ?? null,
    report.stats.retention.find((entry) => entry.cohort === date)?.d7 ?? null,
    report.stats.feedback.total,
    report.stats.gameplay.deadlockRate,
    JSON.stringify(report.stats),
    Date.now(),
  );

  console.log(`日报已写入 ${out}`);
  const alerts = renderAlerts(report.alerts);
  console.log(alerts.length === 0 ? '告警：无' : `告警：\n${alerts.map((line) => '  ' + line).join('\n')}`);
  console.log(
    `DAU=${report.stats.dauByDate.find((entry) => entry.date === date)?.dau ?? 0} 指令=${report.stats.dauByDate.find((entry) => entry.date === date)?.commands ?? 0} 死循环=${(report.stats.gameplay.deadlockRate * 100).toFixed(2)}%`,
  );
} finally {
  db.close();
}
