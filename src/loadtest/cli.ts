/**
 * 压测 CLI（W6）
 *
 *   node src/loadtest/cli.ts --users 100 --per-user 20 --out docs/压测记录.md
 *
 * 流程：起真实服务进程（含迁移/播种/自检/备份）→ 跑 5 个并发场景 → 跑 100×20 负载 → 判定阈值。
 * 任何一项不达标就以非零码退出（封测准入条件）。
 */
import { writeFileSync } from 'node:fs';
import { judgeLoad, LOAD_THRESHOLDS, runLoad, type LoadReport } from './runner.ts';
import { cleanupDb, startTestServer, type TestServer } from './harness.ts';
import {
  scenarioExploreOnce,
  scenarioPromotionNoDoubleDeduct,
  scenarioSameMessageId,
  scenarioTickIdempotentDuringLoad,
  scenarioTradeDoubleConfirm,
  type ScenarioResult,
} from './scenarios.ts';

export interface CliOptions {
  users: number;
  perUser: number;
  out?: string;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { users: 100, perUser: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === '--users' && next) options.users = Number(next);
    else if (arg === '--per-user' && next) options.perUser = Number(next);
    else if (arg === '--out' && next) options.out = next;
  }
  return options;
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

export function renderReport(
  options: CliOptions,
  scenarios: ScenarioResult[],
  load: LoadReport,
  judge: { pass: boolean; failures: string[] },
  environment: { node: string; dbPath: string; startedAt: string },
): string {
  const lines: string[] = [];
  lines.push('# W6 真实压测记录');
  lines.push('');
  lines.push(`- 执行命令：\`node src/loadtest/cli.ts --users ${options.users} --per-user ${options.perUser}\``);
  lines.push(`- 时间：${environment.startedAt}　Node：${environment.node}`);
  lines.push('- 方式：独立服务进程 + 真实 HTTP 上报（POST /onebot/event）+ 假 OneBot API 收出站消息；库断言直接读同一个 SQLite 文件');
  lines.push(`- 数据库：\`${environment.dbPath}\``);
  lines.push('');
  lines.push('## 一、并发场景');
  lines.push('');
  lines.push(table(
    ['场景', '结论', '细节'],
    scenarios.map((item) => [item.name, item.pass ? '通过' : '未通过', item.detail]),
  ));
  lines.push('');
  lines.push('## 二、负载结果');
  lines.push('');
  lines.push(table(['指标', '实测', '阈值', '结论'], [
    ['并发用户 × 每人指令', `${load.users} × ${load.perUser} = ${load.total}`, '100 × 20', load.total >= options.users * options.perUser ? '通过' : '未通过'],
    ['P50', `${load.p50Ms.toFixed(0)} ms`, '—', '—'],
    ['P90', `${load.p90Ms.toFixed(0)} ms`, '—', '—'],
    ['P95', `${load.p95Ms.toFixed(0)} ms`, `< ${LOAD_THRESHOLDS.p95Ms} ms`, load.p95Ms < LOAD_THRESHOLDS.p95Ms ? '通过' : '未通过'],
    ['P99', `${load.p99Ms.toFixed(0)} ms`, '—', '—'],
    ['最大', `${load.maxMs.toFixed(0)} ms`, '—', '—'],
    ['错误率', `${(load.errorRate * 100).toFixed(3)}%`, '< 0.1%', load.errorRate < LOAD_THRESHOLDS.errorRate ? '通过' : '未通过'],
    ['崩溃', load.alive ? '0（进程存活）' : '进程退出', '0', load.alive ? '通过' : '未通过'],
    ['吞吐', `${load.throughputPerSec.toFixed(1)} 条/秒`, '—', '—'],
    ['总耗时', `${(load.wallMs / 1000).toFixed(1)} s`, '—', '—'],
  ]));
  lines.push('');
  if (load.sampleErrors.length > 0) {
    lines.push('错误样例：');
    for (const error of load.sampleErrors) lines.push(`- ${error}`);
    lines.push('');
  }
  lines.push('## 三、准入判定');
  lines.push('');
  lines.push(judge.pass ? '**压测通过**：可以进入封测。' : `**压测未通过**：${judge.failures.join('；')}`);
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  console.log(`压测开始：${options.users} 并发用户 × ${options.perUser} 条指令`);

  let server: TestServer | null = null;
  try {
    server = await startTestServer();
    console.log(`服务已就绪：app=${server.appPort} 假OneBot=${server.apiPort} db=${server.dbPath}`);

    const scenarios: ScenarioResult[] = [];
    scenarios.push(await scenarioSameMessageId(server, '810001'));
    scenarios.push(await scenarioPromotionNoDoubleDeduct(server, '810002'));
    scenarios.push(await scenarioExploreOnce(server, '810003'));
    scenarios.push(await scenarioTradeDoubleConfirm(server, '810004', '810005'));
    scenarios.push(
      await scenarioTickIdempotentDuringLoad(server, ['810006', '810007', '810008'], server.token),
    );

    for (const scenario of scenarios) {
      console.log(`${scenario.pass ? '✔' : '✖'} ${scenario.name} —— ${scenario.detail}`);
    }

    console.log('开始负载……');
    const load = await runLoad(server, { users: options.users, perUser: options.perUser, tag: 'w6' });
    const judge = judgeLoad(load);

    const report = renderReport(options, scenarios, load, judge, {
      node: process.version,
      dbPath: server.dbPath,
      startedAt,
    });
    if (options.out) {
      writeFileSync(options.out, report, 'utf8');
      console.log(`报告已写入 ${options.out}`);
    } else {
      console.log(report);
    }

    console.log(
      `负载：total=${load.total} ok=${load.ok} err=${load.errors} p50=${load.p50Ms.toFixed(0)}ms p95=${load.p95Ms.toFixed(0)}ms p99=${load.p99Ms.toFixed(0)}ms max=${load.maxMs.toFixed(0)}ms 吞吐=${load.throughputPerSec.toFixed(1)}/s`,
    );
    const scenarioFailures = scenarios.filter((scenario) => !scenario.pass);
    if (!judge.pass || scenarioFailures.length > 0) {
      console.error('压测未通过：', [...judge.failures, ...scenarioFailures.map((s) => s.name)].join('；'));
      process.exitCode = 1;
    } else {
      console.log('压测通过：可以进入封测。');
    }
  } finally {
    if (server) {
      const dbPath = server.dbPath;
      await server.stop();
      cleanupDb(dbPath);
    }
  }
}

const entry = process.argv[1] ? new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href : '';
if (import.meta.url === entry) {
  main().catch((error) => {
    console.error('压测失败：', error);
    process.exit(1);
  });
}
