/**
 * M2.13.1 任务 C + D：**从分片重建覆盖率报告，并出两份合并报告**。
 *
 * 用法：node scripts/m2-13-1-merged-report.ts
 *
 * 产出四类文件：
 *
 *   1. docs/<分片前缀>-覆盖率.md        —— 重跑的单片覆盖率（**两段口径**，任务 C）
 *   2. docs/M2.13.1-合并覆盖率.md       —— 8 分片合并（任务 D）
 *   3. docs/M2.13.1-合并异常.md         —— 8 分片合并（任务 D）
 *
 * ## 为什么不重新跑批
 *
 * 分片结果已经落在 data/vplayer-shards{,-off}/shard-N.json 里（含完整 coverage 与 anomalies），
 * 分片库也留在 data/<前缀>-shard-N.db。所以这一份脚本**只读**：读 JSON 出覆盖率与异常，
 * 读库补长链路两段（老 JSON 里没有这个字段）。
 *
 * ## 为什么长链路要从库里补
 *
 * `longChain` 是 M2.13.1 才加进 CoverageReport 的字段，M2.13.1 之前跑出来的 JSON 里没有它。
 * 而覆盖率报告的口径必须从「走完序列 9 → 8：N 人（要求 ≥ 50）」换成
 * 「入途径 → 8 ≥ 50」「8 → 7 ≥ 25」两段（M2.13 前置 1）—— 所以这里从 characters 表重新数人。
 * **不重跑批**，因为跑批会换掉 seed 与随机序列，那就没法与已经交付的那一批对照了。
 *
 * ## 口径
 *
 * - 合并走 src/vplayer/merge.ts（纯函数、有单测）：按 key 累加、分子分母都加；
 * - 长链路两段走 src/vplayer/longchain.ts（与覆盖率报告、长链路报告**同一份实现**）；
 * - 逐片明细一律进合并报告（铁律 11）—— 合计行必须等于各片之和。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadCards } from '../src/cards/loader.ts';
import { loadLocations, loadRecipes } from '../src/data/loader.ts';
import {
  analyzeCardReachability,
  computeCoverage,
  coverageFailures,
} from '../src/vplayer/coverage.ts';
import type { ActionRecord } from '../src/vplayer/types.ts';
import { mergeShards } from '../src/vplayer/merge.ts';
import { renderCoverageReport } from '../src/vplayer/report.ts';
import { SHARD_SCHEMA, type ShardJson } from '../src/vplayer/shard-json.ts';
import { readLongChain, renderLongChainLines, type LongChainReport } from '../src/vplayer/longchain.ts';

const SHARDS = 8;

interface RoundSpec {
  key: string;
  label: string;
  jsonDir: string;
  dbPrefix: string;
}

/** 两轮：交付版（前置 4 开）与它的同 seed 对照（前置 4 关） */
const ROUNDS: RoundSpec[] = [
  /* 路径写正斜杠：报告里要显示成 `data/vplayer-shards`，join() 在 Windows 上会给出反斜杠 */
  { key: 'm213b', label: '交付版（前置 4 开）', jsonDir: 'data/vplayer-shards', dbPrefix: 'm213b' },
  {
    key: 'm213boff',
    label: '同 seed 对照（前置 4 关）',
    jsonDir: 'data/vplayer-shards-off',
    dbPrefix: 'm213boff',
  },
];

interface ShardEntry {
  index: number;
  json: ShardJson;
  /** 长链路两段是不是从库里补出来的（老 JSON 没有这个字段） */
  longChainFromDb: boolean;
}

interface RoundResult {
  spec: RoundSpec;
  entries: ShardEntry[];
  merged: ReturnType<typeof mergeShards>;
}

function readShard(path: string): ShardJson {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as ShardJson;
  if (raw.schema !== SHARD_SCHEMA) {
    throw new Error(path + ' 不是 ' + SHARD_SCHEMA + ' 口径（读到 ' + String(raw.schema) + '）');
  }
  return raw;
}

function longChainOfShard(json: ShardJson, spec: RoundSpec, index: number): { chain: LongChainReport; fromDb: boolean } {
  const inline = (json.coverage as { longChain?: LongChainReport }).longChain;
  if (inline) return { chain: inline, fromDb: false };
  const dbPath = join('data', spec.dbPrefix + '-shard-' + index + '.db');
  if (!existsSync(dbPath)) {
    throw new Error('分片 ' + index + ' 既没有 longChain 也没有库：' + dbPath);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const chain = readLongChain(db);
  db.close();
  return { chain, fromDb: true };
}

const results: RoundResult[] = [];
for (const spec of ROUNDS) {
  const entries: ShardEntry[] = [];
  for (let index = 0; index < SHARDS; index += 1) {
    const path = join(spec.jsonDir, 'shard-' + index + '.json');
    if (!existsSync(path)) continue;
    const json = readShard(path);
    const filled = longChainOfShard(json, spec, index);
    const patched: ShardJson = {
      ...json,
      coverage: { ...json.coverage, longChain: filled.chain },
    };
    /*
     * **failures 必须重算。**
     *
     * JSON 里存的是跑批那一刻的文案 —— 那时候还是旧口径，
     * 「未达标项」里躺着一行「晋升完成 3 人 < 要求 50 人」。
     * 只换渲染、不重算 failures 的话，重跑出来的报告里旧口径会从后门溜回来。
     */
    patched.coverage.failures = coverageFailures({
      commands: patched.coverage.commands,
      cards: patched.coverage.cards,
      locations: patched.coverage.locations,
      recipes: patched.coverage.recipes,
      lostControlTexts: patched.coverage.lostControlTexts,
      longChain: patched.coverage.longChain,
      minCommandCount: patched.thresholds.minCommandCount,
    });
    patched.coverage.pass = patched.coverage.failures.length === 0;
    entries.push({ index, json: patched, longChainFromDb: filled.fromDb });
    /* 任务 C：重跑单片覆盖率报告（两段口径）。文件名沿用跑批时的命名。 */
    const coveragePath = join('docs', spec.dbPrefix + '-shard' + index + '-覆盖率.md');
    writeFileSync(
      coveragePath,
      renderCoverageReport({
        stage: spec.dbPrefix + '-shard' + index,
        players: patched.players,
        days: patched.days,
        seed: patched.seed,
        coverage: patched.coverage,
      }),
      'utf8',
    );
  }
  if (entries.length === 0) throw new Error('没有读到任何分片：' + spec.jsonDir);
  results.push({ spec, entries, merged: mergeShards(entries.map((entry) => entry.json)) });
}

/* ---------------- 渲染 ---------------- */

const N = String.fromCharCode(96);
const code = (s: string): string => N + s + N;
const pct = (value: number, base: number): string =>
  base > 0 ? ((value / base) * 100).toFixed(1) + '%' : '—';
const mark = (pass: boolean): string => (pass ? '达标' : '未达标');

const [DELIVER, CONTROL] = results as [RoundResult, RoundResult];

/** 长链路两段的原始四元组（用来算「序列 9」的人数：已入途径 − 8 − 7） */
function seq9Of(round: RoundResult): number {
  const chain = round.merged.coverage.longChain;
  return chain.initiated - chain.toSeq8.count - chain.toSeq7.count;
}

function overviewRow(label: string, pick: (round: RoundResult) => string): string {
  return '| ' + label + ' | ' + pick(DELIVER) + ' | ' + pick(CONTROL) + ' |';
}

/* ---- 合并覆盖率 ---- */

const covLines: string[] = [];
const CP = (s = ''): void => { covLines.push(s); };

CP('# M2.13.1 合并覆盖率（8 分片 · 200 人 × 30 天）');
CP();
CP('> **这一份是 200×30 的合并版** —— 在此之前只有单片覆盖率，没有加总过。');
CP('>');
CP('> 数据来源：' + code(DELIVER.spec.jsonDir + '/shard-N.json') + '（交付版）与 ' +
  code(CONTROL.spec.jsonDir + '/shard-N.json') + '（同 seed 对照），各 ' + DELIVER.entries.length + ' / ' + CONTROL.entries.length + ' 片。');
CP('> 长链路两段：' + code('src/vplayer/longchain.ts') + '（与覆盖率报告、长链路报告**同一份实现**）。');
CP('> 合并走 ' + code('src/vplayer/merge.ts') + ' 的累加（按 key 累加、分子分母都加），**不手拼数字**。');
CP('> 生成：' + code('scripts/m2-13-1-merged-report.ts') + '。');
CP();
CP('## 〇、两轮总览');
CP();
CP('| 指标 | ' + DELIVER.spec.label + '（' + DELIVER.spec.key + '） | ' + CONTROL.spec.label + '（' + CONTROL.spec.key + '） |');
CP('| --- | --- | --- |');
CP(overviewRow('分片数', (r) => String(r.entries.length)));
CP(overviewRow('玩家数 × 天数', (r) => r.merged.players + ' × ' + r.merged.days));
CP(overviewRow('建号总数', (r) => String(r.merged.coverage.longChain.characters)));
CP(overviewRow('已入途径', (r) => String(r.merged.coverage.longChain.initiated)));
CP(overviewRow('序列 9', (r) => String(seq9Of(r))));
CP(overviewRow('序列 8', (r) => String(r.merged.coverage.longChain.toSeq8.count)));
CP(overviewRow('序列 7', (r) => String(r.merged.coverage.longChain.toSeq7.count)));
CP(
  overviewRow(
    '指令覆盖（达标/总数）',
    (r) => r.merged.coverage.commands.filter((i) => i.pass).length + '/' + r.merged.coverage.commands.length,
  ),
);
CP(
  overviewRow(
    '事件卡覆盖（达标/总数）',
    (r) => r.merged.coverage.cards.filter((i) => i.pass).length + '/' + r.merged.coverage.cards.length,
  ),
);
CP(
  overviewRow(
    '地点覆盖（达标/总数）',
    (r) => r.merged.coverage.locations.filter((i) => i.pass).length + '/' + r.merged.coverage.locations.length,
  ),
);
CP(
  overviewRow(
    '配方覆盖（达标/总数）',
    (r) => r.merged.coverage.recipes.filter((i) => i.pass).length + '/' + r.merged.coverage.recipes.length,
  ),
);
CP(overviewRow('失控文本覆盖', (r) => r.merged.coverage.lostControlTexts.length + ' 条被触发'));
CP(
  overviewRow(
    '**入途径 → 序列 8**（≥ 50）',
    (r) =>
      '**' + r.merged.coverage.longChain.toSeq8.count + '**（' +
      pct(r.merged.coverage.longChain.toSeq8.count, r.merged.coverage.longChain.initiated) + '）—— ' +
      mark(r.merged.coverage.longChain.toSeq8.pass),
  ),
);
CP(
  overviewRow(
    '**序列 8 → 序列 7**（≥ 25）',
    (r) =>
      '**' + r.merged.coverage.longChain.toSeq7.count + '**（' +
      pct(r.merged.coverage.longChain.toSeq7.count, r.merged.coverage.longChain.toSeq8.count) + '）—— ' +
      mark(r.merged.coverage.longChain.toSeq7.pass),
  ),
);
CP(
  overviewRow('P0 / P1', (r) => {
    const p0 = r.merged.anomalies.filter((a) => a.level === 'P0').length;
    return p0 + ' / ' + (r.merged.anomalies.length - p0);
  }),
);
CP();
CP('> **两段各自判定**（M2.13 前置 1）：交付版第一段 **' + mark(DELIVER.merged.coverage.longChain.toSeq8.pass) +
  '**、第二段 **' + mark(DELIVER.merged.coverage.longChain.toSeq7.pass) + '**；');
CP('> 报告里**不再有那个复合指标** —— 它要求 `9→8` 与 `8→7` 两个转化同时达到各自的最高水位，在数学上就是紧的。');
CP();

const byKey = (items: ReadonlyArray<{ key: string; count: number; pass: boolean }>): Map<string, { count: number; pass: boolean }> =>
  new Map(items.map((item) => [item.key, { count: item.count, pass: item.pass }]));

function pairedSection(
  title: string,
  note: string,
  label: string,
  pick: (r: RoundResult) => ReadonlyArray<{ key: string; count: number; pass: boolean; excluded?: boolean }>,
  prefix: string,
): void {
  CP('## ' + title);
  CP();
  CP(note);
  CP();
  CP('| ' + label + ' | ' + DELIVER.spec.key + ' 次数 | 结论 | ' + CONTROL.spec.key + ' 次数 | 结论 |');
  CP('| --- | --- | --- | --- | --- |');
  const control = byKey(pick(CONTROL));
  for (const item of pick(DELIVER)) {
    const other = control.get(item.key);
    CP(
      '| ' + prefix + item.key + ' | ' + item.count + ' | ' + mark(item.pass) + ' | ' +
        (other ? String(other.count) : '—') + ' | ' + (other ? mark(other.pass) : '—') + ' |',
    );
  }
  CP();
}

pairedSection(
  '一、指令覆盖（汇总，要求 ≥ 10 次/条）',
  '按 key 累加：8 片各自不足 10 次的，合并之后可能达标 —— 这正是分片轮要看合并值的原因。',
  '指令',
  (r) => [...r.merged.coverage.commands].sort((a, b) => b.count - a.count),
  '.',
);
pairedSection(
  '二、事件卡覆盖（汇总，要求 ≥ 1 次）',
  '「抽不到」= 静态可达性判定为内容缺口，不计入达标要求。',
  '卡 id',
  (r) => r.merged.coverage.cards,
  '',
);
pairedSection(
  '三、地点覆盖（汇总，要求 ≥ 1 次）',
  '探索次数来自 explore_daily（按地点 id 取数，报告里显示中文名）。',
  '地点',
  (r) => r.merged.coverage.locations,
  '',
);
pairedSection(
  '四、配方覆盖（汇总，要求 ≥ 1 次）',
  '调制次数来自 domain_events 里 reason 形如「魔药:<配方 id>」的记录。',
  '配方',
  (r) => r.merged.coverage.recipes,
  '',
);
CP('## 五、失控文本覆盖（汇总，要求 ≥ 1 条）');
CP();
CP('| 文本片段 | ' + DELIVER.spec.key + ' | ' + CONTROL.spec.key + ' |');
CP('| --- | --- | --- |');
const lostKeys = new Set([
  ...DELIVER.merged.coverage.lostControlTexts.map((item) => item.key),
  ...CONTROL.merged.coverage.lostControlTexts.map((item) => item.key),
]);
const lostA = byKey(DELIVER.merged.coverage.lostControlTexts);
const lostB = byKey(CONTROL.merged.coverage.lostControlTexts);
if (lostKeys.size === 0) {
  CP('| （两轮都没有触发失控文本） | — | — |');
} else {
  for (const key of lostKeys) {
    CP('| ' + key + '… | ' + (lostA.get(key)?.count ?? 0) + ' | ' + (lostB.get(key)?.count ?? 0) + ' |');
  }
}
CP();
CP('## 六、长链路（两段各自判定，M2.13 前置 1）');
CP();
CP('### ' + DELIVER.spec.label + '（' + DELIVER.spec.key + '）');
CP();
for (const line of renderLongChainLines(DELIVER.merged.coverage.longChain)) CP(line);
CP();
CP('### ' + CONTROL.spec.label + '（' + CONTROL.spec.key + '）');
CP();
for (const line of renderLongChainLines(CONTROL.merged.coverage.longChain)) CP(line);
CP();
CP('## 七、逐片明细（合计行必须等于各片之和）');
CP();
for (const round of results) {
  CP('### ' + round.spec.label + '（' + round.spec.key + '）');
  CP();
  CP('| 片 | 建号 | 入途径 | 序列 8 | 序列 7 | 指令达标 | 事件卡达标 | 地点达标 | 配方达标 | 失控文本 | 长链路来源 |');
  CP('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  let sum8 = 0;
  let sum7 = 0;
  for (const entry of round.entries) {
    const chain = entry.json.coverage.longChain;
    sum8 += chain.toSeq8.count;
    sum7 += chain.toSeq7.count;
    CP(
      '| ' + entry.index + ' | ' + chain.characters + ' | ' + chain.initiated + ' | ' + chain.toSeq8.count +
        ' | ' + chain.toSeq7.count + ' | ' +
        entry.json.coverage.commands.filter((i) => i.pass).length + '/' + entry.json.coverage.commands.length + ' | ' +
        entry.json.coverage.cards.filter((i) => i.pass).length + '/' + entry.json.coverage.cards.length + ' | ' +
        entry.json.coverage.locations.filter((i) => i.pass).length + '/' + entry.json.coverage.locations.length + ' | ' +
        entry.json.coverage.recipes.filter((i) => i.pass).length + '/' + entry.json.coverage.recipes.length + ' | ' +
        entry.json.coverage.lostControlTexts.length + ' | ' +
        (entry.longChainFromDb ? '库（JSON 无此字段）' : 'JSON') + ' |',
    );
  }
  CP(
    '| **合计** | **' + round.merged.coverage.longChain.characters + '** | **' + round.merged.coverage.longChain.initiated +
      '** | **' + sum8 + '** | **' + sum7 + '** | — | — | — | — | — | — |',
  );
  CP();
}

writeFileSync(join('docs', 'M2.13.1-合并覆盖率.md'), covLines.join('\n'), 'utf8');

/* ---- 合并异常 ---- */

const anoLines: string[] = [];
const AP = (s = ''): void => { anoLines.push(s); };
const codeOf = (round: RoundResult, codeName: string): number =>
  round.merged.anomalies.filter((a) => a.code === codeName).length;

AP('# M2.13.1 合并异常（8 分片 · 200 人 × 30 天）');
AP();
AP('> 数据来源：各分片 JSON 的 anomalies（逐片全量，不是计数）。');
AP('> 逐片明细与逐条清单都进这一份报告（铁律 11）—— 合计行必须等于各片之和。');
AP();
AP('## 一、总览');
AP();
AP('| 指标 | ' + DELIVER.spec.label + '（' + DELIVER.spec.key + '） | ' + CONTROL.spec.label + '（' + CONTROL.spec.key + '） |');
AP('| --- | --- | --- |');
const totalRow = (label: string, pick: (round: RoundResult) => number): void => {
  AP('| ' + label + ' | ' + pick(DELIVER) + ' | ' + pick(CONTROL) + ' |');
};
totalRow('**P0 总数**', (r) => r.merged.anomalies.filter((a) => a.level === 'P0').length);
totalRow('**P1 总数**', (r) => r.merged.anomalies.filter((a) => a.level === 'P1').length);
totalRow('其中 `DEADLOCK`', (r) => codeOf(r, 'DEADLOCK'));
totalRow('其中 `NO_STATE_CHANGE`', (r) => codeOf(r, 'NO_STATE_CHANGE'));
totalRow(
  '其它',
  (r) =>
    r.merged.anomalies.length -
    codeOf(r, 'DEADLOCK') -
    codeOf(r, 'NO_STATE_CHANGE'),
);
AP();
AP('## 二、P1 按类型分类');
AP();
AP('> **这一节就是 M2.13.1 任务 2 被打回的那一处**：关闭那轮的 67 条 P1 一度被写成');
AP('> 「67 条 NO_STATE_CHANGE」，实际是 **66 条 `DEADLOCK` + 1 条 `NO_STATE_CHANGE`**。');
AP('> **P1 总数不变，改的只是分类。**');
AP();
for (const round of results) {
  const kinds = new Map<string, number>();
  for (const anomaly of round.merged.anomalies) {
    if (anomaly.level !== 'P1') continue;
    kinds.set(anomaly.code, (kinds.get(anomaly.code) ?? 0) + 1);
  }
  const total = [...kinds.values()].reduce((sum, n) => sum + n, 0);
  AP('### ' + round.spec.label + '（' + round.spec.key + '）—— P1 共 ' + total + ' 条');
  AP();
  if (kinds.size === 0) {
    AP('没有 P1。');
    AP();
    continue;
  }
  AP('| 类型 | 条数 | 占比 |');
  AP('| --- | --- | --- |');
  for (const [kind, n] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) {
    AP('| `' + kind + '` | ' + n + ' | ' + pct(n, total) + ' |');
  }
  AP();
}
AP('## 三、逐片明细');
AP();
for (const round of results) {
  AP('### ' + round.spec.label + '（' + round.spec.key + '）');
  AP();
  AP('| 片 | P0 | P1 | DEADLOCK | NO_STATE_CHANGE | 其它 |');
  AP('| --- | --- | --- | --- | --- | --- |');
  let p0Sum = 0;
  let p1Sum = 0;
  let dlSum = 0;
  let nsSum = 0;
  for (const entry of round.entries) {
    const p0 = entry.json.anomalies.filter((a) => a.level === 'P0').length;
    const p1 = entry.json.anomalies.filter((a) => a.level === 'P1').length;
    const dl = entry.json.anomalies.filter((a) => a.code === 'DEADLOCK').length;
    const ns = entry.json.anomalies.filter((a) => a.code === 'NO_STATE_CHANGE').length;
    p0Sum += p0;
    p1Sum += p1;
    dlSum += dl;
    nsSum += ns;
    AP('| ' + entry.index + ' | ' + p0 + ' | ' + p1 + ' | ' + dl + ' | ' + ns + ' | ' + (p1 - dl - ns) + ' |');
  }
  AP('| **合计** | **' + p0Sum + '** | **' + p1Sum + '** | **' + dlSum + '** | **' + nsSum + '** | **' + (p1Sum - dlSum - nsSum) + '** |');
  AP();
}
AP('## 四、逐条清单');
AP();
for (const round of results) {
  AP('### ' + round.spec.label + '（' + round.spec.key + '）');
  AP();
  if (round.merged.anomalies.length === 0) {
    AP('没有异常。');
    AP();
    continue;
  }
  for (const entry of round.entries) {
    if (entry.json.anomalies.length === 0) continue;
    AP('**片 ' + entry.index + '**');
    AP();
    for (const anomaly of entry.json.anomalies) {
      AP(
        '- [' + anomaly.code + '] 玩家#' + anomaly.playerId + ' 第' + anomaly.day + '天 「' + anomaly.command +
          '」：' + anomaly.detail,
      );
    }
    AP();
  }
}

writeFileSync(join('docs', 'M2.13.1-合并异常.md'), anoLines.join('\n'), 'utf8');

/* ---------------- 自检与控制台 ---------------- */

for (const round of results) {
  const p1 = round.merged.anomalies.filter((a) => a.level === 'P1').length;
  const p1PerShard = round.entries.reduce((sum, e) => sum + e.json.anomalies.filter((a) => a.level === 'P1').length, 0);
  if (p1 !== p1PerShard) {
    throw new Error('自检失败：' + round.spec.key + ' 合并 P1 ' + p1 + ' ≠ 各片之和 ' + p1PerShard);
  }
  const chain = round.merged.coverage.longChain;
  const seq8PerShard = round.entries.reduce((sum, e) => sum + e.json.coverage.longChain.toSeq8.count, 0);
  if (chain.toSeq8.count !== seq8PerShard) {
    throw new Error('自检失败：' + round.spec.key + ' 合并序列 8 ' + chain.toSeq8.count + ' ≠ 各片之和 ' + seq8PerShard);
  }
}

console.log('=== 任务 C + D ===');
for (const round of results) {
  const chain = round.merged.coverage.longChain;
  const p0 = round.merged.anomalies.filter((a) => a.level === 'P0').length;
  const fromDb = round.entries.filter((e) => e.longChainFromDb).length;
  console.log(
    round.spec.key + '（' + round.entries.length + ' 片）：' +
      '入途径→8 ' + chain.toSeq8.count + '/' + chain.initiated + '（≥' + chain.toSeq8.required + '，' + mark(chain.toSeq8.pass) + '）、' +
      '8→7 ' + chain.toSeq7.count + '/' + chain.toSeq8.count + '（≥' + chain.toSeq7.required + '，' + mark(chain.toSeq7.pass) + '）、' +
      'P0 ' + p0 + '、P1 ' + (round.merged.anomalies.length - p0) +
      '；长链路从库补 ' + fromDb + '/' + round.entries.length + ' 片',
  );
}
/*
 * ---------------- 任务 C 补充：M2.13 那一轮（m213）的单片覆盖率 ----------------
 *
 * 为什么单独一段：**分片 JSON 的文件名不带前缀**（scripts/vplayer-shard.ts 写死 shard-N.json），
 * 所以 m213 那一轮的结果已经被 m213b 覆盖掉了 —— 只剩库与行为日志。
 *
 * 好在覆盖率要的两样东西都还在：
 *   - 指令次数 → docs/m213-shardN-行为日志.jsonl（每条指令一行 JSON）
 *   - 其余各项 → data/m213-shard-N.db（事件触发 / 探索 / 配方 / 失控文本 / 序列分布）
 * 内容是静态的（locations.yaml / recipes.yaml / cards），所以离线也能算出同一份覆盖率。
 */
const REBUILD = { key: 'm213', stage: 'm213' };
/** 指令清单用交付版那一份 —— 同一份代码，指令集相同；门槛也照搬（`--min-command-count` 默认 10） */
const commandKeys = DELIVER.merged.coverage.commands.map((item) => item.key).sort();
const minCommandCount = DELIVER.entries[0]!.json.thresholds.minCommandCount;
const cardDefs = loadCards().cards;
const { locations: locationDefs } = loadLocations();
const { recipes: recipeDefs } = loadRecipes();
const reachability = analyzeCardReachability(
  cardDefs.map((card) => ({
    id: card.id,
    locations: card.trigger.location ?? [],
    type: card.trigger.type,
  })),
  locationDefs,
);
const unreachableCards = reachability.filter((entry) => !entry.reachable).map((entry) => entry.cardId);
const unreachableReasons: Record<string, string> = {};
for (const entry of reachability) {
  if (entry.reachable) continue;
  unreachableReasons[entry.cardId] =
    entry.locations.length > 0
      ? '限定了地点「' + entry.locations.join('、') + '」，但该地点的 events 名单里没有它'
      : '没有任何一条抽取路径会带上它';
}
const rebuiltPaths: string[] = [];
for (let index = 0; index < SHARDS; index += 1) {
  const dbPath = join('data', REBUILD.key + '-shard-' + index + '.db');
  const logPath = join('docs', REBUILD.stage + '-shard' + index + '-行为日志.jsonl');
  if (!existsSync(dbPath) || !existsSync(logPath)) continue;
  const records: ActionRecord[] = [];
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    records.push(JSON.parse(trimmed) as ActionRecord);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const characters = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM characters').get() as { n: number }).n,
  );
  const coverage = computeCoverage(
    records,
    db,
    {
      commands: commandKeys,
      cards: cardDefs.map((card) => card.id),
      locations: locationDefs.map((location) => ({ id: location.id, name: location.name })),
      recipes: recipeDefs.map((recipe) => recipe.id),
      lostControlTexts: [],
    },
    { minCommandCount, unreachableCards, unreachableReasons },
  );
  db.close();
  const outPath = join('docs', REBUILD.stage + '-shard' + index + '-覆盖率.md');
  writeFileSync(
    outPath,
    renderCoverageReport({
      stage: REBUILD.stage + '-shard' + index,
      players: characters,
      days: DELIVER.merged.days,
      seed: REBUILD.key + ':shard:' + index,
      coverage,
    }),
    'utf8',
  );
  rebuiltPaths.push(outPath);
}
if (rebuiltPaths.length > 0) {
  console.log(
    '另从「行为日志 + 库」重建了 ' + rebuiltPaths.length + ' 份 ' + REBUILD.key + ' 的单片覆盖率报告' +
      '（那一轮的 JSON 已被同名文件覆盖）',
  );
}

console.log('已写出 docs/M2.13.1-合并覆盖率.md、docs/M2.13.1-合并异常.md，并重跑 ' +
  results.reduce((sum, r) => sum + r.entries.length, 0) + ' 份单片覆盖率报告');

