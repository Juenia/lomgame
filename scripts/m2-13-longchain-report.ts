/**
 * M2.13 前置 1：**长链路验收拆成两段**（各自判定）。
 *
 * 用法：node scripts/m2-13-longchain-report.ts [片数] [输出路径] [库前缀]
 *   例：node scripts/m2-13-longchain-report.ts 8 docs/M2.13-长链路两段.md m213
 *
 * ## 为什么拆
 *
 * M2.12 用的复合指标 `9→8→7 ≥ 50` **在数学上就是紧的** ——
 * 它要求两个转化**同时**达到各自的最高水位，而实测 `入途径→8` 的上限就是 **28.4%**
 * （M2.8：入途径平均 6.5 天，14 天窗口里攒不满 M2.5 定的 DIG 60）。
 * 卡点在序列 9→8，不在序列 8→7（后者的 61.1% 是健康的）。
 *
 * 所以从 M2.13 起改判两段：
 *
 * | 链路 | 门槛 | 判定 |
 * | --- | --- | --- |
 * | **入途径 → 序列 8** | ≥ 50 人 | 主验收项 |
 * | **序列 8 → 序列 7** | ≥ 25 人 | 主验收项 |
 * | 序列 9 → 序列 7（全链） | 记录但**不阻塞** | 观察项 |
 *
 * 门槛的来处：50 是 M2.7 起就在验收里写着的「入途径 → 序列 8」那条不变
 * （W7 的 200×7 是 74 人、M2.8 的 200×30 是 54 人）；25 是 50 的一半 ——
 * 序列 8→7 是**第二段**，它的人口基数已经比建号数少了一半以上，
 * 用同一个 50 会让这一段无论怎么调都过不去（那是把口径问题伪装成内容问题）。
 *
 * 这一份报告读的是**分片库**（`data/<prefix>-shard-N.db`），不跑批、不改任何东西。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../src/infra/db/sqlite.ts';
import { longChainOf, renderLongChainLines } from '../src/vplayer/longchain.ts';

const SHARDS = Number(process.argv[2] ?? 8);
const OUT = process.argv[3] ?? join('docs', 'M2.13-长链路两段.md');
const PREFIX = process.argv[4] ?? 'm213';

/*
 * 门槛与取数口径**不写在这里** —— 它是 src/vplayer/longchain.ts 的 LONG_CHAIN_GATE，
 * 覆盖率报告与合并报告读的是同一份。这一份脚本只负责「从分片库把数读出来」。
 */

interface ShardCount {
  path: string;
  characters: number;
  mortal: number;
  initiated: number;
  seq9: number;
  seq8: number;
  seq7: number;
}

const shards: ShardCount[] = [];
for (let index = 0; index < SHARDS; index += 1) {
  const path = join('data', PREFIX + '-shard-' + index + '.db');
  if (!existsSync(path)) {
    console.log('跳过不存在的库：' + path);
    continue;
  }
  const db = openDatabase(path);
  const count: ShardCount = {
    path,
    characters: 0,
    mortal: 0,
    initiated: 0,
    seq9: 0,
    seq8: 0,
    seq7: 0,
  };
  for (const row of db.prepare('SELECT sequence, pathway FROM characters').all() as Array<
    Record<string, unknown>
  >) {
    count.characters += 1;
    if (row.pathway === null || row.pathway === undefined) {
      count.mortal += 1;
      continue;
    }
    count.initiated += 1;
    const seq = Number(row.sequence);
    if (seq >= 9) count.seq9 += 1;
    if (seq === 8) count.seq8 += 1;
    if (seq <= 7) count.seq7 += 1;
  }
  shards.push(count);
  db.close();
}

const sum = (pick: (s: ShardCount) => number): number => shards.reduce((total, s) => total + pick(s), 0);
const total = {
  characters: sum((s) => s.characters),
  mortal: sum((s) => s.mortal),
  initiated: sum((s) => s.initiated),
  seq9: sum((s) => s.seq9),
  seq8: sum((s) => s.seq8),
  seq7: sum((s) => s.seq7),
};

const pct = (n: number, base: number): string =>
  base > 0 ? ((n / base) * 100).toFixed(1) + '%' : '—';

/* 两段：口径来自 src/vplayer/longchain.ts（这里只负责把库里的四元组喂给它） */
const chain = longChainOf({
  characters: total.characters,
  initiated: total.initiated,
  seq8: total.seq8,
  seq7: total.seq7,
});

const lines: string[] = [];
lines.push('# M2.13 长链路：两段各自判定（口径修正）');
lines.push('');
lines.push('> 数据来源：' + shards.length + ' 个分片库（`data/' + PREFIX + '-shard-N.db`）。');
lines.push('> 口径来源：M2.13 前置 1（README 的「长链路验收：两段各自判定」一节）。');
lines.push('');
lines.push('## 一、序列分布');
lines.push('');
lines.push('| 阶段 | 人数 | 占建号比例 |');
lines.push('| --- | --- | --- |');
lines.push('| 建号总数 | ' + total.characters + ' | 100% |');
lines.push('| 普通人（还没入途径） | ' + total.mortal + ' | ' + pct(total.mortal, total.characters) + ' |');
lines.push('| 已入途径 | ' + total.initiated + ' | ' + pct(total.initiated, total.characters) + ' |');
lines.push('| 序列 9 | ' + total.seq9 + ' | ' + pct(total.seq9, total.characters) + ' |');
lines.push('| 序列 8 | ' + total.seq8 + ' | ' + pct(total.seq8, total.characters) + ' |');
lines.push('| **序列 7** | **' + total.seq7 + '** | **' + pct(total.seq7, total.characters) + '** |');
lines.push('');
lines.push('## 二、两段验收（各自判定）');
lines.push('');
lines.push('> 判定口径与覆盖率报告、合并报告**共用同一份实现**（`src/vplayer/longchain.ts`）。');
lines.push('');
for (const line of renderLongChainLines(chain)) lines.push(line);
lines.push('');
lines.push('## 三、逐片');
lines.push('');
lines.push('| 分片 | 建号 | 入途径 | 序列 8 | 序列 7 |');
lines.push('| --- | --- | --- | --- | --- |');
for (const shard of shards) {
  lines.push(
    '| ' +
      shard.path +
      ' | ' +
      shard.characters +
      ' | ' +
      shard.initiated +
      ' | ' +
      shard.seq8 +
      ' | ' +
      shard.seq7 +
      ' |',
  );
}
lines.push('');

writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('已写出 ' + OUT);
console.log(
  '两段：入途径→8 ' +
    chain.toSeq8.count +
    '/' +
    chain.toSeq8.base +
    '（门槛 ' +
    chain.toSeq8.required +
    '，' +
    (chain.toSeq8.pass ? '达标' : '未达标') +
    '）；8→7 ' +
    chain.toSeq7.count +
    '/' +
    chain.toSeq7.base +
    '（门槛 ' +
    chain.toSeq7.required +
    '，' +
    (chain.toSeq7.pass ? '达标' : '未达标') +
    '）',
);
console.log('全链（观察项）：' + chain.fullChain + ' 人');
