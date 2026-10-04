/**
 * 长链路验收：**两段各自判定**（M2.13 前置 1）。
 *
 * ## 为什么要有这个文件
 *
 * M2.12 用的是**复合指标** `9→8→7 ≥ 50` —— 它要求两个转化同时达到各自的最高水位，
 * 在数学上就是紧的。从 M2.13 起改判两段，各自给结论：
 *
 * | 链路 | 门槛 | 判定 |
 * | --- | --- | --- |
 * | **入途径 → 序列 8** | ≥ 50 人 | 主验收项 |
 * | **序列 8 → 序列 7** | ≥ 25 人 | 主验收项 |
 * | 序列 9 → 序列 7（全链） | 记录但**不阻塞** | 观察项 |
 *
 * 门槛的来处：50 是 M2.7 起就在验收里写着的「入途径 → 序列 8」那条不变；
 * 25 是 50 的一半 —— 第二段的人口基数已经比建号数少了一半以上，
 * 用同一个 50 会让这一段无论怎么调都过不去。依据见 README 的
 * 「长链路验收：两段各自判定（M2.13 前置 1）」一节。
 *
 * ## 为什么要抽成一份（而不是各自写一遍）
 *
 * 口径一旦有两份实现，就会漂移 —— M2.13.1 被打回的那份报告就是这么坏的：
 * 同一个数在两份报告里各写了一遍（见 m2-13-1-anomaly-lib.ts 的同类注释）。
 * 所以两段口径**只写在这里**：长链路报告（scripts/m2-13-longchain-report.ts）、
 * 覆盖率报告（src/vplayer/report.ts）与合并报告（src/vplayer/merge.ts）都 import 它。
 *
 * ## 口径（写死，别再改）
 *
 * - **入途径 → 序列 8** 的人数 = 期末停在**序列 8** 的人数；
 * - **序列 8 → 序列 7** 的人数 = 期末在**序列 7 及以下**的人数；
 * - 转化率的分母：第一段用「已入途径」，第二段用「序列 8 的人数」；
 * - **序列号越小越强**，所以「升到序列 7」= sequence <= 7。
 */
import { NUMERIC } from '../config/numeric.ts';
import type { Db } from '../infra/db/sqlite.ts';

export interface LongChainGate {
  /** 第一段门槛：入途径 → 序列 8 */
  readonly toSeq8: number;
  /** 第二段门槛：序列 8 → 序列 7 */
  readonly toSeq7: number;
}

/**
 * 门槛（200 人批次的口径）。**改值请改 `NUMERIC.longChain`（唯一出处），这里只是引用。**
 *
 * | 段 | 值 | 来处 |
 * | --- | --- | --- |
 * | 入途径 → 序列 8 | **50** | M2.7 起就在验收里的值，M2.13 拆两段时保留；**M2.34 重标时判定为「不受 P6 影响」⇒ 不动** |
 * | 序列 8 → 序列 7 | **12** | **M2.34 重标**（P6 之后）：两轮标准对照轮实测 16（m234a）/ 11（m234b）⇒ `min + 1 = 12` |
 *
 * ## ⚠️ toSeq7 为什么搬进了 `numeric.ts`（M2.27 → M2.34）
 *
 * 它以前就写在这个文件的第 44 行（硬编码 `{ toSeq8: 50, toSeq7: 25 }`），于是**同一个门槛散在三处**：
 * 拍板文档写 15（M2.27）、代码写 25、M2.12 的历史快照写 25。
 * M2.27 拍板后**只改了文档** ⇒ 此后每一轮跑批都在用 25，而**没有任何断言会红**。
 * ⇒ M2.34 把它搬进 `NUMERIC.longChain`（**值只在一处定义**），这里只留引用；
 * 并由 `docs/架构铁律.md` 的 G13 / G14 用「声明值 === 现场读」守着。
 * 这是新增的 **K22**（同一个数值散在多处，改一处不够）。
 */
export const LONG_CHAIN_GATE: LongChainGate = NUMERIC.longChain;

interface LongChainStage {
  /** 这一段走完的人数 */
  count: number;
  /** 这一段的基数（第一段是「已入途径」，第二段是「序列 8 的人数」） */
  base: number;
  required: number;
  pass: boolean;
}

export interface LongChainReport {
  characters: number;
  initiated: number;
  toSeq8: LongChainStage;
  toSeq7: LongChainStage;
  /** 观察项：走完全链（序列 ≤ 7）的人数 */
  fullChain: number;
}

export interface LongChainCounts {
  characters: number;
  initiated: number;
  seq8: number;
  seq7: number;
}

/** 按批次规模缩放门槛（准入判定用；200 人时与 LONG_CHAIN_GATE 完全一致） */
export function longChainGateFor(players: number): LongChainGate {
  const scale = players / 200;
  return {
    toSeq8: Math.max(1, Math.round(LONG_CHAIN_GATE.toSeq8 * scale)),
    toSeq7: Math.max(1, Math.round(LONG_CHAIN_GATE.toSeq7 * scale)),
  };
}

export function longChainOf(counts: LongChainCounts, gate: LongChainGate = LONG_CHAIN_GATE): LongChainReport {
  return {
    characters: counts.characters,
    initiated: counts.initiated,
    toSeq8: {
      count: counts.seq8,
      base: counts.initiated,
      required: gate.toSeq8,
      pass: counts.seq8 >= gate.toSeq8,
    },
    toSeq7: {
      count: counts.seq7,
      base: counts.seq8,
      required: gate.toSeq7,
      pass: counts.seq7 >= gate.toSeq7,
    },
    fullChain: counts.seq7,
  };
}

/** 从库里数两段的原始量（characters 表：一条 SQL 就够，别分三次查） */
export function countLongChain(db: Db): LongChainCounts {
  const row = db
    .prepare(
      'SELECT ' +
        'COUNT(*) AS characters, ' +
        'SUM(CASE WHEN pathway IS NOT NULL THEN 1 ELSE 0 END) AS initiated, ' +
        'SUM(CASE WHEN pathway IS NOT NULL AND sequence = 8 THEN 1 ELSE 0 END) AS seq8, ' +
        'SUM(CASE WHEN pathway IS NOT NULL AND sequence <= 7 THEN 1 ELSE 0 END) AS seq7 ' +
        'FROM characters',
    )
    .get() as Record<string, unknown>;
  return {
    characters: Number(row.characters ?? 0),
    initiated: Number(row.initiated ?? 0),
    seq8: Number(row.seq8 ?? 0),
    seq7: Number(row.seq7 ?? 0),
  };
}

export function readLongChain(db: Db, gate: LongChainGate = LONG_CHAIN_GATE): LongChainReport {
  return longChainOf(countLongChain(db), gate);
}

/** 分片合并：分子分母都累加，pass 按合并后的总数重算（不能各片各判再「或」起来） */
export function mergeLongChain(
  reports: readonly LongChainReport[],
  gate: LongChainGate = LONG_CHAIN_GATE,
): LongChainReport {
  const sum = (pick: (report: LongChainReport) => number): number =>
    reports.reduce((total, report) => total + pick(report), 0);
  return longChainOf(
    {
      characters: sum((r) => r.characters),
      initiated: sum((r) => r.initiated),
      seq8: sum((r) => r.toSeq8.count),
      seq7: sum((r) => r.toSeq7.count),
    },
    gate,
  );
}

function pct(value: number, base: number): string {
  return base > 0 ? ((value / base) * 100).toFixed(1) + '%' : '—';
}

/** 覆盖率 / 合并报告里的「晋升链路」一节 —— 两段各自判定 */
export function renderLongChainLines(report: LongChainReport): string[] {
  const lines: string[] = [];
  lines.push('| 链路 | 人数 | 转化率 | 门槛 | 判定 |');
  lines.push('| --- | --- | --- | --- | --- |');
  lines.push(
    '| **入途径 → 序列 8** | ' + report.toSeq8.count + ' | ' +
      pct(report.toSeq8.count, report.toSeq8.base) + '（' + report.toSeq8.count + '/' + report.toSeq8.base + '） | ≥ ' +
      report.toSeq8.required + ' | ' + (report.toSeq8.pass ? '达标' : '未达标') + ' |',
  );
  lines.push(
    '| **序列 8 → 序列 7** | ' + report.toSeq7.count + ' | ' +
      pct(report.toSeq7.count, report.toSeq7.base) + '（' + report.toSeq7.count + '/' + report.toSeq7.base + '） | ≥ ' +
      report.toSeq7.required + ' | ' + (report.toSeq7.pass ? '达标' : '未达标') + ' |',
  );
  lines.push(
    '| 序列 9 → 序列 7（全链，观察项） | ' + report.fullChain + ' | ' +
      pct(report.fullChain, report.characters) + ' | — | 记录（不阻塞） |',
  );
  return lines;
}

/** 覆盖率失败清单里属于长链路的条目 */
export function longChainFailures(report: LongChainReport): string[] {
  const failures: string[] = [];
  if (!report.toSeq8.pass) {
    failures.push('入途径 → 序列 8 完成 ' + report.toSeq8.count + ' 人 < 要求 ' + report.toSeq8.required + ' 人');
  }
  if (!report.toSeq7.pass) {
    failures.push('序列 8 → 序列 7 完成 ' + report.toSeq7.count + ' 人 < 要求 ' + report.toSeq7.required + ' 人');
  }
  return failures;
}

