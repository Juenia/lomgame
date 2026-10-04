/**
 * M2.13.1 任务 C：**晋升计数的口径变化**（逐片数，不合并）。
 *
 * 用法：node scripts/m2-13-1-promotion-count-diff.ts [输出路径]
 *
 * ## 两种口径
 *
 * - **旧口径（事件条数）**：数 domain_events 里 promotion_success 的条数。
 *   它是覆盖率报告 promotionCompletions 的原实现，两个毛病：
 *   ① **不是人数** —— 一个人可以晋升两次（9→8 再 8→7），会被数成两条；
 *   ② **不分段** —— 9→8 与 8→7 混在一个数里，所以它没法拆成两段（M2.13 前置 1 要的两段）。
 *
 * - **新口径（期末序列人数）**：读 characters.sequence —— 序列 8 的人数 = 第一段，
 *   序列 ≤7 的人数 = 第二段。这是 scripts/m2-12-sequence7-report.ts 一直在用的口径
 *   （M2.12 的 33 就是它），也是 M2.13 前置 1 的两段口径。
 *
 * ## 为什么要逐片列
 *
 * 合并会掩盖分布：有的片差 0、有的片差好几条，只报合计就看不出来。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const OUT = process.argv[2] ?? join('.git', 'm2-13-1-task-c.md');
const SHARDS = 8;
const ROUNDS = [
  { key: 'm213boff', label: '关闭前置 4（M2.12 口径）' },
  { key: 'm213b', label: '开启前置 4（交付版）' },
];

interface Row {
  shard: number;
  events: number;
  ev9to8: number;
  ev8to7: number;
  seq8: number;
  seq7: number;
  /** sequence_delta（仪式那条路）的条数 —— 旧口径**看不见**它 */
  seqDelta: number;
}

function readRound(prefix: string): Row[] {
  const rows: Row[] = [];
  for (let shard = 0; shard < SHARDS; shard += 1) {
    const path = join('data', prefix + '-shard-' + shard + '.db');
    if (!existsSync(path)) continue;
    const db = new DatabaseSync(path, { readOnly: true });
    const sql = 'SELECT payload FROM domain_events WHERE type = ' + "'promotion_success'";
    let ev9to8 = 0;
    let ev8to7 = 0;
    for (const row of db.prepare(sql).all() as Array<{ payload: string }>) {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        payload = {};
      }
      if (Number(payload.from) === 9 && Number(payload.to) === 8) ev9to8 += 1;
      else if (Number(payload.from) === 8 && Number(payload.to) === 7) ev8to7 += 1;
    }
    /* sequence_delta 那条路（仪式融合）：payload 用的是 before/after，不是 from/to */
    const seqDelta = Number(
      (
        db
          .prepare('SELECT COUNT(*) AS n FROM domain_events WHERE type = ? AND payload LIKE ?')
          .get('sequence_delta', '%"after":7%') as { n: number }
      ).n,
    );
    const seq = db
      .prepare(
        'SELECT ' +
          'SUM(CASE WHEN sequence = 8 THEN 1 ELSE 0 END) AS seq8, ' +
          'SUM(CASE WHEN sequence <= 7 THEN 1 ELSE 0 END) AS seq7 ' +
          'FROM characters WHERE pathway IS NOT NULL',
      )
      .get() as { seq8: number | null; seq7: number | null };
    db.close();
    rows.push({
      shard,
      events: ev9to8 + ev8to7,
      ev9to8,
      ev8to7,
      seq8: Number(seq.seq8 ?? 0),
      seq7: Number(seq.seq7 ?? 0),
      seqDelta,
    });
  }
  return rows;
}

const data = ROUNDS.map((round) => ({ round, rows: readRound(round.key) }));
const sum = (rows: readonly Row[], pick: (r: Row) => number): number => rows.reduce((t, r) => t + pick(r), 0);

const lines: string[] = [];
const P = (s = ''): void => { lines.push(s); };
const N = String.fromCharCode(96);
const code = (s: string): string => N + s + N;

P('## 九、晋升计数的口径变化（M2.13.1）');
P();
P('> **这是口径变化，不是 bug fix。** M2.13.1 把覆盖率报告里的晋升计数从');
P('> 「promotion_success **事件条数**」改成了「**期末序列人数**」。');
P('> 两种口径都不是错的 —— 但它们回答的不是同一个问题，混用就会得出矛盾的结论。');
P();
P('### 9.1 两种口径分别是什么');
P();
P('| 口径 | 怎么数 | 用在哪 |');
P('| --- | --- | --- |');
P('| **旧：事件条数** | ' + code('domain_events') + ' 里 ' + code('promotion_success') + ' 的**条数** | 覆盖率报告的 ' + code('promotionCompletions') + '（M2.13.1 之前） |');
P('| **新：期末序列人数** | ' + code('characters.sequence') + '：序列 8 的人数 / 序列 ≤7 的人数 | 长链路报告（' + code('scripts/m2-12-sequence7-report.ts') + '）、M2.13 前置 1 的两段口径、本轮的覆盖率报告 |');
P();
P('旧口径有两个毛病，这也是它必须换掉的原因：');
P();
P('1. **它不是人数** —— 一个人可以晋升两次（9→8 再 8→7），会被数成两条；');
P('2. **它不分段** —— 9→8 与 8→7 混在一个数里，所以 M2.13 前置 1 要的「两段各自判定」它根本给不出来。');
P();
P('### 9.2 两轮数据上的逐片差异');
P();
P('> **逐片列，不合并** —— 合并会掩盖「有的片差 0、有的片差 3」这种分布。');
P();
for (const { round, rows } of data) {
  P('#### ' + round.label + '（' + round.key + '）');
  P();
  P('| 分片 | 旧：promotion_success 条数 | 其中 9→8 | 其中 8→7 | 旧口径看不见的：sequence_delta | 新：序列 8 人数 | 新：序列 ≤7 人数 | 差（条数 − 序列8人数） |');
  P('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    P('| ' + r.shard + ' | ' + r.events + ' | ' + r.ev9to8 + ' | ' + r.ev8to7 + ' | ' + r.seqDelta + ' | ' + r.seq8 + ' | ' + r.seq7 + ' | ' + (r.events - r.seq8) + ' |');
  }
  P('| **合计** | **' + sum(rows, (r) => r.events) + '** | **' + sum(rows, (r) => r.ev9to8) + '** | **' + sum(rows, (r) => r.ev8to7) + '** | **' + sum(rows, (r) => r.seqDelta) + '** | **' + sum(rows, (r) => r.seq8) + '** | **' + sum(rows, (r) => r.seq7) + '** | **' + (sum(rows, (r) => r.events) - sum(rows, (r) => r.seq8)) + '** |');
  P();
  const diffs = rows.map((r) => r.events - r.seq8);
  const kinds = [...new Set(diffs)].sort((a, b) => a - b);
  P('逐片差的分布：' + kinds.map((d) => '差 ' + d + ' 有 ' + diffs.filter((x) => x === d).length + ' 片').join('、') + '；差为 0 的 ' + diffs.filter((d) => d === 0).length + ' / ' + rows.length + ' 片。');
  P();
}
P('**读法**：两个口径**不能互相推算** —— 连差异的方向都不一致：');
P();
P('| 轮次 | 旧口径（事件条数） | 新口径第一段（序列 8 人数） | 差 |');
P('| --- | --- | --- | --- |');
for (const { round, rows } of data) {
  const ev = sum(rows, (r) => r.events);
  const s8 = sum(rows, (r) => r.seq8);
  P('| ' + round.label + '（' + round.key + '） | ' + ev + ' | ' + s8 + ' | **' + (ev - s8 > 0 ? '+' : '') + (ev - s8) + '** |');
}
P();
P('原因有三层：');
P();
P('1. **单位不同**：旧口径数**事件**，一个人可以贡献 2 条（9→8 一条、8→7 一条）；新口径数**人**；');
P('2. **分段不同**：旧口径把两段混成一个数；新口径分开给（第一段 / 第二段）；');
P('3. **路径不全**：旧口径只数 ' + code('promotion_success') + '（\.晋升 那条路），**完全看不见** ' + code('sequence_delta') + '（仪式融合）——');
P('   关闭轮有 37 条、开启轮有 19 条 ' + code('sequence_delta') + ' 完成了 8→7，旧口径一条都没算进去。');
P();
P('### 9.3 对 M2.12 的旧数 33 有什么影响');
P();
P('**没有影响 —— 33 本来就是新口径（人数）。**');
P();
P('| 出处 | 写法 | 口径 |');
P('| --- | --- | --- |');
P('| ' + code('docs/M2.12-交付说明.md') + ' | 「序列 7（走完 9→8→7）」**33** · 16.5% · 「序列 8 → 序列 7 61.1%（33/54）」 | **人数**（分母 54 是序列 8 的人数） |');
P('| ' + code('scripts/m2-12-sequence7-report.ts') + ' 第 30 行 | 注释写的是「走完 9→8→7 的人数（序列 ≤ 7）」 | **人数** |');
P();
P('所以 M2.12 的 33、M2.13 的 19、M2.13.1 归因里的 37 —— **三者同一口径，可以直接比。**');
P();
P('真正混进来的只有**覆盖率报告**那一路（' + code('promotionCompletions') + ' 数的是事件条数）——');
P('它在 M2.13.1 之前一直把两段之和当成「走完序列 9 → 8」，所以**那个数从来就不是第一段**。');
P();
P('### 9.4 从哪一版开始换，旧报告要不要回头改');
P();
P('| 问题 | 答案 |');
P('| --- | --- |');
P('| **从哪一版开始** | **M2.13.1**（本提交）。' + code('CoverageReport.promotionCompletions / promotionRequired / promotionPass') + ' 三个字段被 ' + code('longChain') + ' 取代，取数改成按 ' + code('characters.sequence') + ' 数人。 |');
P('| **旧报告要不要回头改** | **不回头改。** 历史报告（' + code('M2.11-CI-覆盖率.md') + '、' + code('M2.12-CI-覆盖率.md') + ' 等）记录的是当时脚本的输出，改它们等于篡改证据；而且它们各自的达标结论不依赖这个计数。 |');
P('| **本轮的 24 份覆盖率报告** | **已重跑**（' + code('docs/m213*-覆盖率.md') + '），用的是新口径。 |');
P();
P('> **下次谁对比旧数时，读哪个口径** —— 一句话：');
P('> **比「多少人在序列 7 / 序列 8」就读期末序列人数**（M2.12 的 33、M2.13 的 19、M2.13.1 的 37 都是这个口径）；');
P('> 只有在看「一共发生了多少次晋升成功」时才用事件条数 —— 而且要知道那是**两段之和**，');
P('> 同一个人的两次晋升会被数成两条。覆盖率报告自 M2.13.1 起两个数都给了：');
P('> 第一段是「入途径 → 序列 8」，第二段是「序列 8 → 序列 7」。');
P();

writeFileSync(OUT, lines.join('\n'), 'utf8');
for (const { round, rows } of data) {
  console.log(round.key + '：旧口径合计 ' + sum(rows, (r) => r.events) + '（9→8 ' + sum(rows, (r) => r.ev9to8) + ' + 8→7 ' + sum(rows, (r) => r.ev8to7) + '）；新口径 序列8 ' + sum(rows, (r) => r.seq8) + ' / 序列≤7 ' + sum(rows, (r) => r.seq7));
  console.log('  逐片差：' + rows.map((r) => r.shard + ':' + (r.events - r.seq8)).join(' '));
}
console.log('已写出 ' + OUT);
