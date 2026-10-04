/**
 * M2.1 可见性取证 CLI
 *
 *   node scripts/m21-visibility-evidence.ts --log docs/M2-回归-行为日志.jsonl [--db data/loadtest-xxx.db]
 *
 * 输出：失控发生在哪些画像身上、他们当天还在不在玩（决定 lost_* 抽不抽得到）。
 * --db 给服务端库：lost_control_events 是失控的权威账本。
 */
import { NUMERIC } from '../src/config/numeric.ts';
import {
  collectVisibilityEvidence,
  lostDayActionMix,
  lostDaysFromDatabase,
  renderVisibilityEvidence,
} from '../src/sim/visibility-evidence.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const log = arg('log');
if (!log) {
  console.error('用法：node scripts/m21-visibility-evidence.ts --log <行为日志.jsonl> [--db <sqlite>]');
  process.exit(1);
}
const db = arg('db');

const evidence = await collectVisibilityEvidence(log, {
  ...(db ? { lostDays: lostDaysFromDatabase(db) } : {}),
});
console.log('日志：' + evidence.log + '（' + evidence.playerDays + ' 个玩家日）' + (db ? '，失控账本：' + db : ''));
console.log('');
for (const line of renderVisibilityEvidence(evidence, NUMERIC.play.exposureChance)) console.log(line);

// 失控日的动作构成：lost_* 只挂在「.扮演 暴露抽卡」这条通道上，
// 而失控日玩家到底在干什么，直接决定这条通道有多少流量。
const mix = await lostDayActionMix(log);
console.log('');
console.log('失控日的动作构成（失控日 ' + mix.lostDays + ' 天 / 普通日 ' + mix.normalDays + ' 天，单位：每人日均）');
console.log('');
console.log('| 指令 | 失控日 | 普通日 | 倍数 |');
console.log('|---|---|---|---|');
for (const row of mix.rows.slice(0, 12)) {
  console.log(
    '| .' + row.command + ' | ' + row.lostPerDay + ' | ' + row.normalPerDay + ' | ' +
      (row.normalPerDay === 0 ? '—' : row.ratio.toFixed(2)) + ' |',
  );
}
