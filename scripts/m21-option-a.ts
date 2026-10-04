/**
 * 候选方案 A 的量化推演（M2.1 决策支持）
 *
 *   node scripts/m21-option-a.ts --log docs/archive-m21/M2-回归首轮-行为日志.jsonl
 *
 * 方案 A：把 lost_001—005 的 cond 从 status:lost_control 改成「失控当天」标记。
 * 本脚本用**同一批实测日志**算：把这些失控日的整天 .扮演/.事件 都算成抽卡机会，
 * 再乘真实暴露概率与真实卡池权重占比，得到每张卡的期望触发次数。
 * 不引入任何新假设 —— 变的只有「窗口取多宽」这一个语义。
 */
import { NUMERIC } from '../src/config/numeric.ts';
import { cardVisibility } from '../src/sim/visibility.ts';
import { fullDayExposure, lostDaysFromDatabase } from '../src/sim/visibility-evidence.ts';

const ACCEPTANCE_CARDS = ['lost_001', 'lost_002', 'lost_003', 'lost_004', 'lost_005'];

function arg(name: string): string | undefined {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const log = arg('log');
if (!log) {
  console.error('用法：node scripts/m21-option-a.ts --log <行为日志.jsonl> [--db <sqlite>] [--players 40]');
  process.exit(1);
}
const db = arg('db');
const playersPerPersona = Number(arg('players') ?? '40');

const exposure = await fullDayExposure(log, {
  ...(db ? { lostDays: lostDaysFromDatabase(db) } : {}),
});

console.log('日志：' + log);
console.log('');
console.log('| 画像 | 失控日 | 当天 .扮演 合计 | 每失控日 .扮演 | 每失控日 .事件 |');
console.log('|---|---|---|---|---|');
for (const row of exposure) {
  console.log(
    '| ' + row.persona + ' | ' + row.lostDays + ' | ' + row.plays + ' | ' + row.playsPerLostDay + ' | ' +
      (row.lostDays === 0 ? 0 : Number((row.events / row.lostDays).toFixed(2))) + ' |',
  );
}
console.log('');

const lostControlDaysPerCharacter = Object.fromEntries(
  exposure.map((row) => [row.persona, row.lostDays / playersPerPersona]),
);
const playsPerDay = Object.fromEntries(exposure.map((row) => [row.persona, row.playsPerLostDay]));

for (const partyShare of [0.058, 0.25, 0.4]) {
  const rows = cardVisibility({
    cards: ACCEPTANCE_CARDS,
    lostControlDaysPerCharacter,
    playersPerPersona,
    playsPerDay,
    days: 14,
    partyShare,
    activePersonas: exposure.map((row) => row.persona),
  });
  console.log('队伍占比 ' + (partyShare * 100).toFixed(1) + '%' + (partyShare === 0.058 ? '（W8 实测：240 人里 14 人进过 2 人队）' : partyShare === 0.4 ? '（若同时做候选方案 C）' : ''));
  console.log('');
  console.log('| 卡 | 期望触发次数（14 天） | 一次都不出现的概率 | 条件 |');
  console.log('|---|---|---|---|');
  for (const row of rows) {
    console.log('| ' + row.cardId + ' | ' + row.expectedHits.toFixed(2) + ' | ' + (row.zeroProbability * 100).toFixed(1) + '% | ' + row.note + ' |');
  }
  console.log('');
}
console.log('暴露概率：' + NUMERIC.play.exposureChance + '（脚本不写死，从 config 读）');
