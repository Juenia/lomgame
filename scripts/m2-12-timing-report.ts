/**
 * M2.12 前置 1 的**对照实验**报告（同 seed、只差 timing）。
 *
 * 用法：node scripts/m2-12-timing-report.ts
 *
 * 为什么必须对照而不是「看新值合不合理」：
 *   这一轮改的是**等待窗口**，而窗口的效果只有在跑批里才看得见 ——
 *   71% 的代打占比、75% 的交易过期率都是实测出来的，
 *   任何一个「更合理的数」都必须用同一套尺子重新量一遍才算数。
 *
 * 口径：
 *   - 两轮**同 seed**（m212-timing）、同人数天数，只有 NUMERIC.timing 不同；
 *   - 「PVP 代打占比」= pvp_round.auto=true 的回合 / PVP 总回合（全口径，见 M2.11 的修正）；
 *   - 「交易过期率」= 过期的单 / 创建的单；
 *   - 「菜单过期」= 行为日志里回执含「菜单已过期」的动作条数。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { openDatabase } from '../src/infra/db/sqlite.ts';

interface Row {
  /** PVP 总回合 */
  pvpRounds: number;
  /** 其中「触发结算的那一方是超时代打」的回合 */
  pvpAutoRounds: number;
  /** PVP 场次 */
  pvpBattles: number;
  /** 交易创建 / 完成 / 过期 */
  tradesCreated: number;
  tradesCompleted: number;
  tradesExpired: number;
  /** 行为日志里的动作条数 / 菜单过期条数 */
  actions: number;
  menuExpired: number;
  /** 晋升完成人数（序列 8） */
  promotions: number;
  /** 悬着的 PVP 战斗（跑批结束时仍未结束） */
  pvpActive: number;
}

function readDb(path: string): Row {
  const db = openDatabase(path);
  const one = (sql: string, ...args: unknown[]): number =>
    Number((db.prepare(sql).get(...(args as never[])) as { n: number }).n);

  const pvpRounds = one(
    "SELECT COUNT(*) AS n FROM battle_rounds r JOIN battles b ON b.id = r.battle_id WHERE b.is_pvp = 1",
  );
  let pvpAutoRounds = 0;
  for (const row of db.prepare("SELECT payload FROM domain_events WHERE type = 'pvp_round'").all() as Array<{ payload: string }>) {
    try {
      if ((JSON.parse(row.payload) as { auto?: boolean }).auto === true) pvpAutoRounds += 1;
    } catch {
      /* 忽略 */
    }
  }
  const promotions = one("SELECT COUNT(*) AS n FROM characters WHERE sequence = 8");
  const row: Row = {
    pvpRounds,
    pvpAutoRounds,
    pvpBattles: one('SELECT COUNT(*) AS n FROM battles WHERE is_pvp = 1'),
    tradesCreated: one('SELECT COUNT(*) AS n FROM trades'),
    tradesCompleted: one("SELECT COUNT(*) AS n FROM trades WHERE status = 'completed'"),
    tradesExpired: one("SELECT COUNT(*) AS n FROM trades WHERE status = 'expired'"),
    actions: 0,
    menuExpired: 0,
    promotions,
    pvpActive: one("SELECT COUNT(*) AS n FROM battles WHERE is_pvp = 1 AND status = 'active'"),
  };
  db.close();
  return row;
}

function readLog(path: string, row: Row): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    row.actions += 1;
    if (line.includes('菜单已过期')) row.menuExpired += 1;
  }
}

const pct = (value: number, total: number): string =>
  total > 0 ? ((value / total) * 100).toFixed(1) + '%' : '—';

const oldRow = readDb('data/timing-old.db');
readLog('docs/M2.12-时间尺度-旧-行为日志.jsonl', oldRow);
const midRow = readDb('data/timing-new.db');
readLog('docs/M2.12-时间尺度-新-行为日志.jsonl', midRow);
const new24Row = existsSync('data/timing-new24.db') ? readDb('data/timing-new24.db') : null;
if (new24Row) readLog('docs/M2.12-时间尺度-新24-行为日志.jsonl', new24Row);

const line = (label: string, o: string, m: string, n: string, target: string): string =>
  '| ' + label + ' | ' + o + ' | ' + m + ' | ' + n + ' | ' + target + ' |';

const lines: string[] = [];
lines.push('# M2.12 时间尺度对照（同 seed，只差 NUMERIC.timing）');
lines.push('');
lines.push('- 两轮：**40 人 × 7 天**，seed 都是 **m212-timing**，世界 seed 都是 world');
lines.push('- 三档窗口（同 seed，只有 NUMERIC.timing 不同）：');
lines.push('  - **A = M2.11 的旧尺度**（PVP 5 分钟 / 交易 6 小时 / 菜单 5 分钟 / 干扰 10 分钟）');
lines.push('  - **B = 中间值**（PVP 12 小时 / 交易 24 小时 / 菜单 30 分钟 / 干扰 30 分钟）');
lines.push('  - **C = 再往上推一档**（PVP 24 小时，其余同 B）');
lines.push('- 跑三档是为了拿到一条**曲线**而不是两个点：从 5 分钟直接跳到「多少才够」需要一个中间值来判断边际效果');
lines.push('- 同 seed 的意义：玩家、登录时刻、行为倾向**逐个相同**，所以差异可以归因给窗口');
lines.push('');
const ratio = (row: Row): string =>
  pct(row.pvpAutoRounds, row.pvpRounds) + '（' + row.pvpAutoRounds + '/' + row.pvpRounds + '）';
const expired = (row: Row): string =>
  pct(row.tradesExpired, row.tradesCreated) + '（' + row.tradesExpired + '/' + row.tradesCreated + '）';
const cell = (row: Row | null, pick: (r: Row) => string): string => (row ? pick(row) : '（未跑）');

lines.push('| 指标 | 窗口 A：5 分钟 / 6 小时 / 5 分钟 | 窗口 B：12 小时 / 24 小时 / 30 分钟 | 窗口 C：24 小时 / 24 小时 / 30 分钟 | 目标 |');
lines.push('| --- | --- | --- | --- | --- |');
lines.push(line('PVP 场次', String(oldRow.pvpBattles), String(midRow.pvpBattles), cell(new24Row, (r) => String(r.pvpBattles)), '—'));
lines.push(line('PVP 总回合', String(oldRow.pvpRounds), String(midRow.pvpRounds), cell(new24Row, (r) => String(r.pvpRounds)), '—'));
lines.push(line('**PVP 代打占比**', ratio(oldRow), ratio(midRow), cell(new24Row, ratio), '**< 50%**'));
lines.push(line('**交易过期率**', expired(oldRow), expired(midRow), cell(new24Row, expired), '**< 50%**'));
lines.push(line('交易成交数', String(oldRow.tradesCompleted), String(midRow.tradesCompleted), cell(new24Row, (r) => String(r.tradesCompleted)), '上升'));
lines.push(line('菜单过期拒绝', String(oldRow.menuExpired), String(midRow.menuExpired), cell(new24Row, (r) => String(r.menuExpired)), '下降'));
lines.push(line('动作总数', String(oldRow.actions), String(midRow.actions), cell(new24Row, (r) => String(r.actions)), '—'));
lines.push(line('序列 8 人数（长链路）', String(oldRow.promotions), String(midRow.promotions), cell(new24Row, (r) => String(r.promotions)), '不受影响'));
lines.push('');
lines.push('## 读法');
lines.push('');
lines.push(
  '- **PVP 代打占比**：窗口从 5 分钟拉到 12 小时后，' +
    '「一方出招后另一方还来不及响应就被系统代打」的回合应当明显变少。',
);
lines.push(
  '- **交易过期率**：交易是点对点的（卖家挂单、买家下次登录才看得到），' +
    '所以这个数直接量的是「窗口够不够跨一次登录」。',
);
lines.push(
  '- **菜单过期**：5 分钟对「读完菜单再想一下」本来就太短，30 分钟应当把它压下去。',
);
lines.push(
  '- **长链路不受影响**是**必须**的：窗口只该影响「等待中的代打」，' +
    '不该让晋升变快或变慢。若它变了，说明这一轮动到了不该动的东西。',
);
lines.push('');

writeFileSync('docs/M2.12-时间尺度对照.md', lines.join('\n'), 'utf8');
console.log(lines.slice(0, 20).join('\n'));
console.log('');
console.log('已写出 docs/M2.12-时间尺度对照.md');
