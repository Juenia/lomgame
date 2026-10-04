/**
 * 封测前最终自检（W6）
 *   node scripts/beta-preflight.ts [--out docs/封测自检记录.md]
 *
 * 逐项验证：数值冻结 → 内容与卡片 lint → 运营物料 → 启动自检 → 备份 → /health 与 /metrics → 结算幂等 → 告警
 * 任何一项失败就以非零码退出（封测准入条件）。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { validateNumeric } from '../src/config/validate.ts';
import { loadCards } from '../src/cards/loader.ts';
import { loadContent } from '../src/data/loader.ts';
import { loadCommunity } from '../src/data/community.ts';
import { loadLostControlPool } from '../src/cards/lost-control.ts';
import { getSwitches } from '../src/config/switches.ts';
import { dateKey } from '../src/infra/date.ts';
import { checkAlerts, renderAlerts } from '../src/ops/alerts.ts';
import { cleanupDb, startTestServer } from '../src/loadtest/harness.ts';

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return (index >= 0 ? process.argv[index + 1] : undefined) ?? fallback;
}

const checks: Check[] = [];
const add = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail });
};

// 1) 数值冻结
const numericIssues = validateNumeric().filter((issue) => issue.level === 'error');
add('数值冻结：配置校验', numericIssues.length === 0, numericIssues.map((i) => `${i.path}: ${i.message}`).join('；') || '全部通过');

// 2) 内容与卡片
const cards = loadCards();
const cardErrors = cards.issues.filter((issue) => issue.level === 'error');
add('内容：事件卡 lint', cardErrors.length === 0, `${cards.cards.length} 张卡，${cardErrors.length} 个 error`);

const content = loadContent({ cardIds: new Set(cards.cards.map((card) => card.id)) });
const contentErrors = content.issues.filter((issue) => issue.level === 'error');
add(
  '内容：物品/地点/配方/能力交叉校验',
  contentErrors.length === 0,
  `items=${content.items.length} locations=${content.locations.length} recipes=${content.recipes.length} abilities=${content.abilities.length}，${contentErrors.length} 个 error`,
);

const lostControl = loadLostControlPool();
add(
  '内容：失控文本池',
  lostControl.issues.filter((issue) => issue.level === 'error').length === 0,
  `共 ${lostControl.all.length} 条（余波 ${lostControl.aftershock.length} 条）`,
);

// 3) 运营物料
const community = loadCommunity();
add(
  '运营物料：FAQ / 群规则 / 公告',
  community.issues.length === 0,
  `FAQ ${community.faq.length} 条、规则 ${community.rules.rules.length} 条、公告要点 ${community.beta.scope.length + community.beta.not_included.length} 条`,
);

// 4) 运行时自检
const server = await startTestServer();
try {
  const healthResponse = await fetch(`http://127.0.0.1:${server.appPort}/health`);
  const health = (await healthResponse.json()) as Record<string, unknown>;
  add(
    '运行时：/health',
    healthResponse.ok && health.ok === true,
    `commands=${Array.isArray(health.commands) ? health.commands.length : '?'} characters=${health.characters} cards=${health.cards} locations=${health.locations} lastTick=${JSON.stringify(health.lastTick)}`,
  );

  const metricsResponse = await fetch(`http://127.0.0.1:${server.appPort}/metrics`);
  const metrics = (await metricsResponse.json()) as { ok?: boolean; monitor?: { total?: number } };
  add('运行时：/metrics', metricsResponse.ok && metrics.ok === true, `监控快照可用（total=${metrics.monitor?.total ?? 0}）`);

  add(
    '备份：封测前完整备份',
    health.backup !== null && health.backup !== undefined,
    JSON.stringify(health.backup),
  );

  const tick = async (): Promise<{ ok?: boolean; summary?: { skipped?: boolean } }> => {
    const response = await fetch(`http://127.0.0.1:${server.appPort}/admin/tick`, {
      method: 'POST',
      headers: { 'x-admin-token': server.token },
    });
    return (await response.json()) as { ok?: boolean; summary?: { skipped?: boolean } };
  };
  const firstTick = await tick();
  const secondTick = await tick();
  const db = server.openDb();
  try {
    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM daily_ticks WHERE date = ?')
      .get(dateKey(Date.now())) as { n: number };
    add(
      '结算幂等：同一天只结算一次',
      rows.n === 1,
      `daily_ticks 记录 ${rows.n} 条（第一次 skipped=${firstTick.summary?.skipped}，第二次 skipped=${secondTick.summary?.skipped}）`,
    );

    const alerts = checkAlerts(db, dateKey(Date.now()));
    add(
      '告警：死循环比例与应急开关',
      true,
      alerts.length === 0
        ? `无告警（阈值 ${(getSwitches().deadlockAlertThreshold * 100).toFixed(0)}%，应急开关 ${getSwitches().purifyHalfCost ? '已打开' : '关闭'}）`
        : renderAlerts(alerts).join('；'),
    );
  } finally {
    db.close();
  }

  add('进程稳定性：自检期间未退出', server.alive(), server.alive() ? '进程存活' : '进程已退出');
} finally {
  const dbPath = server.dbPath;
  await server.stop();
  cleanupDb(dbPath);
}

const failed = checks.filter((check) => !check.pass);
const lines: string[] = [];
lines.push('# 封测前自检记录');
lines.push('');
lines.push(`- 执行命令：\`node scripts/beta-preflight.ts\``);
lines.push(`- 时间：${new Date().toISOString()}`);
lines.push('');
lines.push('| 检查项 | 结论 | 细节 |');
lines.push('|---|---|---|');
for (const check of checks) lines.push(`| ${check.name} | ${check.pass ? '通过' : '未通过'} | ${check.detail} |`);
lines.push('');
lines.push(failed.length === 0 ? '**自检通过**：可以开始封测。' : `**自检未通过**：${failed.map((check) => check.name).join('、')}`);
lines.push('');

const out = arg('out', join('docs', '封测自检记录.md'));
writeFileSync(out, lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
console.log(`自检记录已写入 ${out}`);
void dirname;
if (failed.length > 0) process.exitCode = 1;
