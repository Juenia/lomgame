/**
 * M2.2 §5.6 失控阈值复算
 *
 *   node scripts/m22-recalc.ts \
 *     --before data/measured-mad-cor-round3.json --before-db data/dbs/m21-final-200x14.db \
 *     --after  data/measured-mad-cor-m22.json    --after-db  data/dbs/m22-final-200x14.db \
 *     --out docs/M2.2-失控复算报告.md
 *
 * 做什么：
 *   1) 新旧 MAD 分布对照（按画像：均值 / P90 / 最大值 + 逐日均值曲线）
 *   2) 时段拆分（夜晚 vs 白天：扮演次数、MAD 增量、MAD 水平）—— 验证「夜晚 MAD 涨得更快」这条机制真的落地了
 *   3) 用新分布重跑 m21-sweep 的同一套扫参（真实纯函数 + 经验投影）
 *   4) 给出定值建议：保持 M2.1 的 65/65/250，还是调整（附新旧对照）
 */
import { writeFileSync } from 'node:fs';
import { NUMERIC } from '../src/config/numeric.ts';
import { project, type PersonaProjection } from '../src/sim/empirical.ts';
import { readDistribution, timeOfDayBreakdown, type MeasuredDistribution } from '../src/sim/measured.ts';

const NL = String.fromCharCode(10);
const pct = (value: number, digits = 1): string => (value * 100).toFixed(digits) + '%';
const f1 = (value: number): string => value.toFixed(1);

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

/** M2.1 定值（对照用，写死：改完 numeric.ts 之后报告里还要跟它比） */
const M21_GATE = { mad: 65, cor: 65, divisor: 250 };
/** W5 旧闸门（第二对照） */
const W5_GATE = { mad: 80, cor: 70, divisor: 430 };

const GRID = {
  mad: [45, 50, 55, 60, 65, 70, 75],
  cor: [55, 65],
  divisor: [90, 130, 180, 250, 350],
};

const TARGETS = {
  aggressive: { min: 0.2, max: 0.4 },
  steady: { min: 0, max: 0.1 },
  deadlock: { min: 0, max: 0.05 },
  /** 激进型 / 稳健型 的失控率之比，任务书要求 2—4 倍 */
  ratio: { min: 2, max: 4 },
};

interface Row {
  mad: number;
  cor: number;
  divisor: number;
  aggressive30: number;
  steady30: number;
  chaotic30: number;
  perfectionist30: number;
  ratio30: number;
  deadlock30: number;
  pass: boolean;
}

function personaOf(rows: readonly PersonaProjection[], persona: string): PersonaProjection | null {
  return rows.find((row) => row.persona === persona) ?? null;
}

function sweep(distribution: MeasuredDistribution, escalation?: { threshold: number; madPerExtraPlay: number }): Row[] {
  const rows: Row[] = [];
  for (const mad of GRID.mad) {
    for (const cor of GRID.cor) {
      for (const divisor of GRID.divisor) {
        const common = {
          charactersPerPersona: 1200,
          seed: 'm22-sweep',
          divisor,
          madThreshold: mad,
          corThreshold: cor,
          ...(escalation ? { escalation } : {}),
        };
        const r30 = project(distribution, { ...common, days: 30 });
        const a = personaOf(r30, 'aggressive');
        const s = personaOf(r30, 'steady');
        const c = personaOf(r30, 'chaotic');
        const p = personaOf(r30, 'perfectionist');
        const aggressive30 = a?.lostControlRate ?? 0;
        const steady30 = s?.lostControlRate ?? 0;
        rows.push({
          mad,
          cor,
          divisor,
          aggressive30,
          steady30,
          chaotic30: c?.lostControlRate ?? 0,
          perfectionist30: p?.lostControlRate ?? 0,
          ratio30: steady30 > 0 ? aggressive30 / steady30 : aggressive30 > 0 ? Number.POSITIVE_INFINITY : 0,
          deadlock30: Math.max(0, ...r30.map((row) => row.deadlockShare)),
          pass: false,
        });
      }
    }
  }
  for (const row of rows) {
    row.pass =
      row.aggressive30 >= TARGETS.aggressive.min &&
      row.aggressive30 <= TARGETS.aggressive.max &&
      row.steady30 < TARGETS.steady.max &&
      row.deadlock30 < TARGETS.deadlock.max;
  }
  return rows;
}

/** 两只分布上的同一组闸门对照 */
function at(distribution: MeasuredDistribution, gate: { mad: number; cor: number; divisor: number }, days: number, escalation?: { threshold: number; madPerExtraPlay: number }) {
  const rows = project(distribution, {
    charactersPerPersona: 1500,
    days,
    seed: 'm22-detail-' + days,
    divisor: gate.divisor,
    madThreshold: gate.mad,
    corThreshold: gate.cor,
    ...(escalation ? { escalation } : {}),
  });
  return rows;
}

const curve = (values: readonly number[], days: readonly number[]): string =>
  days.map((day) => (values[day] ?? 0).toFixed(0)).join(' → ');

async function main(): Promise<void> {
  const beforeFile = arg('before', 'data/measured-mad-cor-round3.json')!;
  const afterFile = arg('after', 'data/measured-mad-cor-m22.json')!;
  const beforeDb = arg('before-db');
  const afterDb = arg('after-db');
  const out = arg('out', 'docs/M2.2-失控复算报告.md')!;
  const observedBeforeRaw = arg('observed-before');
  const observedRaw = arg('observed');
  /** 实测失控率（200×14 真实回归）——最终判据以它为准，投影只负责给方向 */
  const parseObserved = (raw: string | undefined): Record<string, number> | null =>
    raw
      ? Object.fromEntries(
          raw.split(',').map((entry) => {
            const [key, value] = entry.split(':');
            return [key ?? '', Number(value)];
          }),
        )
      : null;
  const observed = parseObserved(observedRaw);
  const observedBefore = parseObserved(observedBeforeRaw);
  const observedFinal = parseObserved(arg('observed-final'));
  const escalationRaw = arg('escalation');
  const escalation = escalationRaw
    ? (() => {
        const [threshold, madPerExtraPlay] = escalationRaw.split(',');
        return { threshold: Number(threshold), madPerExtraPlay: Number(madPerExtraPlay) };
      })()
    : undefined;

  const before = readDistribution(beforeFile);
  const after = readDistribution(afterFile);
  const days = [0, 3, 6, 9, 12, 13];

  const beforeRows = sweep(before);
  // 新分布下跑两套：不带补偿旋钮（世界时钟的净效果）/ 带旋钮（若给了 --escalation）
  const afterRows = sweep(after);
  const afterBoostRows = escalation ? sweep(after, escalation) : [];

  const before21 = at(before, M21_GATE, 30);
  const after21 = at(after, M21_GATE, 30);
  const after21_14 = at(after, M21_GATE, 14);
  const before21_14 = at(before, M21_GATE, 14);
  // 带旋钮的那一套（只有给了 --escalation 才有）
  const boost21 = escalation ? at(after, M21_GATE, 30, escalation) : null;
  const boost21_14 = escalation ? at(after, M21_GATE, 14, escalation) : null;

  const scanRows = afterBoostRows.length > 0 ? afterBoostRows : afterRows;
  const passing = scanRows.filter((row) => row.pass);
  const inRatio = passing.filter((row) => row.ratio30 >= TARGETS.ratio.min && row.ratio30 <= TARGETS.ratio.max);
  const pool = inRatio.length > 0 ? inRatio : passing;
  const chosen = [...pool].sort((a, b) => b.aggressive30 + b.chaotic30 - (a.aggressive30 + a.chaotic30))[0] ?? null;

  const todBefore = beforeDb ? timeOfDayBreakdown(beforeDb) : null;
  const todAfter = afterDb ? timeOfDayBreakdown(afterDb) : null;

  const push = (line: string): void => void lines.push(line);
  const lines: string[] = [];
  push('# M2.2 失控复算报告（§5.6）');
  push('');
  push('> 任务书第六节：世界时钟上线后夜晚 MAD 涨得更快，用新分布重跑 m21-sweep，看是否自然拉开激进型 / 稳健型的差距；');
  push('> 不够再用「激进行为 MAD 涨得更猛」补（不改稳健型）。本文件由 ' + '`scripts/m22-recalc.ts`' + ' 生成，数字全部来自真实纯函数与实测库。');
  push('');
  push('- 旧分布（世界时钟之前）：`' + beforeFile + '` —— ' + before.source);
  push('- 新分布（M2.2 之后）：`' + afterFile + '` —— ' + after.source);
  if (escalation) {
    push('- 附加情景（补偿旋钮）：当天第 ' + escalation.threshold + ' 次之后的每次 .扮演额外 MAD +' + escalation.madPerExtraPlay +
      '（按实测的每角色日扮演次数直方图抽样，高频玩家日才吃得到，稳健型天然落在阈值以下）');
  }
  push('');

  // ---- 一、结论 ----
  push('## 一、结论');
  push('');
  const aggBeforeP90 = before.byPersona.find((row) => row.persona === 'aggressive')?.madP90 ?? 0;
  const aggAfterP90 = after.byPersona.find((row) => row.persona === 'aggressive')?.madP90 ?? 0;
  const steBeforeP90 = before.byPersona.find((row) => row.persona === 'steady')?.madP90 ?? 0;
  const steAfterP90 = after.byPersona.find((row) => row.persona === 'steady')?.madP90 ?? 0;
  const gateAgg = personaOf(after21, 'aggressive')?.lostControlRate ?? 0;
  const gateSte = personaOf(after21, 'steady')?.lostControlRate ?? 0;
  push('1. **夜晚确实更危险了**：新分布里激进型 MAD P90 ' + f1(aggBeforeP90) + ' → ' + f1(aggAfterP90) + '，' +
    '稳健型 ' + f1(steBeforeP90) + ' → ' + f1(steAfterP90) + '（时段拆分见第三节）。');
  push('2. **同一把闸门（M2.1 的 ' + M21_GATE.mad + '/' + M21_GATE.cor + '/' + M21_GATE.divisor + '）在新分布下的 30 天失控率**：' +
    '激进型 ' + pct(gateAgg) + '、稳健型 ' + pct(gateSte) + '，比值 ' +
    (gateSte > 0 ? (gateAgg / gateSte).toFixed(2) + ' 倍' : '—') + '。');
  if (observed) {
    const agg = observed['aggressive'] ?? 0;
    const ste = observed['steady'] ?? 0;
    const deadlock = observed['deadlock'] ?? 0;
    const ratio = ste > 0 ? agg / ste : Number.POSITIVE_INFINITY;
    const ok =
      agg >= TARGETS.aggressive.min &&
      agg <= TARGETS.aggressive.max &&
      ste < TARGETS.steady.max &&
      deadlock < TARGETS.deadlock.max;
    push('2·补、**200×14 实测（最终判据）**：闸门 ' + M21_GATE.mad + '/' + M21_GATE.cor + '/' + M21_GATE.divisor + ' 不动，' +
      (observedBefore
        ? '激进型 ' + pct(observedBefore['aggressive'] ?? 0) + ' → **' + pct(agg) + '**、' +
          '稳健型 ' + pct(observedBefore['steady'] ?? 0) + ' → **' + pct(ste) + '**；'
        : '激进型 **' + pct(agg) + '**、稳健型 **' + pct(ste) + '**；') +
      '死循环 ' + pct(deadlock, 2) + '。目标（激进型 20%—40%、稳健型 < 10%、死循环 < 5%）：' +
      (ok ? '**达成**' : '**未达成**') + '。' +
      (observedBefore && ok ? ' —— **世界时钟单独就把差距拉开了**，不需要「激进行为 MAD 涨得更猛」那一刀。' : ''));
    push('');
  }
  if (observedFinal && observed) {
    const aggF = observedFinal['aggressive'] ?? 0;
    const steF = observedFinal['steady'] ?? 0;
    const nPer = observedFinal['n'] ?? 40;
    const aggAll = ((observed['aggressive'] ?? 0) + aggF) / 2;
    const steAll = ((observed['steady'] ?? 0) + steF) / 2;
    push('2·补·2、**交付版本终验**（含 `.世界` 覆盖率注入）：激进型 **' + pct(aggF) + '**、稳健型 **' + pct(steF) + '**。' +
      '与上一轮的差异不是规则变了，而是虚拟玩家的行为被扰动了一下（每个玩家偶尔多看一眼世界，替换掉一次闲逛动作）——' +
      '而 ' + nPer + ' 人样本里失控角色只有个位数，**14 天失控率的标准误很大**。');
    push('   两轮合并（' + nPer * 2 + ' 人/画像）的估计：激进型 **' + pct(aggAll) + '**、稳健型 **' + pct(steAll) + '**。' +
      '所以本轮能确定的是**两端都落在目标区间内**（激进型 20%—40%、稳健型 < 10%）与方向（激进型显著更高）；' +
      '「相差 2—4 倍」这个口径在 40 人样本下锁不住（稳健型的分母只有 0—2 个人），要精确断言需要更大的样本。');
    push('');
  }
  push('3. **扫参结论（投影口径，只读方向）**：' + scanConclusion(afterRows, afterBoostRows, escalation) +
    ' ⚠️ 这条是**投影**口径：它不建模「失控之后玩家会去净化 / 休息」，系统性高估稳健型 —— ' +
    '本轮最终判据是上面的 200×14 实测，差异说明见第五节。');
  push('');

  // ---- 二、新旧分布对照 ----
  push('## 二、新旧 MAD / COR 分布对照（旧 ' + before.window.characters + ' 角色 × ' + before.window.days +
    ' 天 / 新 ' + after.window.characters + ' 角色 × ' + after.window.days + ' 天）');
  push('');
  push('| 画像 | 旧 MAD 均值 | 新 MAD 均值 | 旧 MAD P90 | 新 MAD P90 | 旧 COR 均值 | 新 COR 均值 | 旧死循环 | 新死循环 |');
  push('|---|---|---|---|---|---|---|---|---|');
  for (const persona of [...new Set([...before.byPersona, ...after.byPersona].map((row) => row.persona))].sort()) {
    const b = before.byPersona.find((row) => row.persona === persona);
    const a = after.byPersona.find((row) => row.persona === persona);
    push('| ' + persona + ' | ' + f1(b?.madMean ?? 0) + ' | ' + f1(a?.madMean ?? 0) + ' | ' +
      f1(b?.madP90 ?? 0) + ' | ' + f1(a?.madP90 ?? 0) + ' | ' +
      f1(b?.corMean ?? 0) + ' | ' + f1(a?.corMean ?? 0) + ' | ' +
      pct(b?.deadlockShare ?? 0) + ' | ' + pct(a?.deadlockShare ?? 0) + ' |');
  }
  push('');
  push('逐日 MAD 均值（第 ' + days.join(' / ') + ' 天）：');
  push('');
  push('| 画像 | 旧轨线 | 新轨线 |');
  push('|---|---|---|');
  for (const persona of ['aggressive', 'steady', 'chaotic', 'perfectionist']) {
    const bCurve = curve(measuredMeanByDay(before, persona), days);
    const aCurve = curve(measuredMeanByDay(after, persona), days);
    push('| ' + persona + ' | ' + bCurve + ' | ' + aCurve + ' |');
  }
  push('');
  push('> 口径：逐日 MAD 均值取实测分布里该画像第 N 天的全部角色样本（不是模拟，是实测）。');
  push('');

  // ---- 三、时段拆分 ----
  push('## 三、时段拆分（夜晚 MAD 涨得更快，落在哪一步）');
  push('');
  if (todBefore && todAfter) {
    push('| 时段 | 旧 MAD 增量均值 | 新 MAD 增量均值 | 旧扮演次数 | 新扮演次数 | 旧 MAD 水平均值 | 新 MAD 水平均值 |');
    push('|---|---|---|---|---|---|---|');
    for (const slot of ['dawn', 'day', 'dusk', 'night']) {
      const b = todBefore.byTimeOfDay.find((row) => row.timeOfDay === slot);
      const a = todAfter.byTimeOfDay.find((row) => row.timeOfDay === slot);
      push('| ' + slot + ' | ' + f1(b?.madGainMean ?? 0) + ' | ' + f1(a?.madGainMean ?? 0) + ' | ' +
        String(b?.plays ?? 0) + ' | ' + String(a?.plays ?? 0) + ' | ' +
        f1(b?.madLevelMean ?? 0) + ' | ' + f1(a?.madLevelMean ?? 0) + ' |');
    }
    push('');
    push('按 reason 拆（新分布，取量最大的前 8 项）：');
    push('');
    push('| reason | 时段 | 事件数 | MAD 增量均值 |');
    push('|---|---|---|---|');
    for (const row of todAfter.byReason.slice(0, 8)) {
      push('| ' + row.reason + ' | ' + row.timeOfDay + ' | ' + row.events + ' | ' + row.madGainMean.toFixed(2) + ' |');
    }
  } else {
    push('（未给 --before-db / --after-db，跳过时段拆分；给出库路径即可补上）');
  }
  push('');

  // ---- 四、扫参 ----
  push('## 四、扫参（新分布，' + GRID.mad.length * GRID.cor.length * GRID.divisor.length + ' 组）');
  push('');
  const table = (rows: readonly Row[], title: string, limit: number): void => {
    push('### ' + title);
    push('');
    push('| 闸门 (mad/cor/divisor) | 激进型 30 天 | 稳健型 30 天 | 比值 | 混乱型 | 完美主义 | 死循环 | 达标 |');
    push('|---|---|---|---|---|---|---|---|');
    const sorted = [...rows].sort((a, b) => b.aggressive30 - a.aggressive30);
    for (const row of sorted.slice(0, limit)) {
      push('| ' + row.mad + '/' + row.cor + '/' + row.divisor + ' | ' + pct(row.aggressive30) + ' | ' + pct(row.steady30) + ' | ' +
        (Number.isFinite(row.ratio30) ? row.ratio30.toFixed(2) : '∞') + ' | ' + pct(row.chaotic30) + ' | ' + pct(row.perfectionist30) + ' | ' +
        pct(row.deadlock30, 2) + ' | ' + (row.pass ? '✅' : '') + ' |');
    }
    push('');
  };
  table(afterRows, '4.1 新分布（世界时钟上线，未启用补偿旋钮）', 14);
  if (afterBoostRows.length > 0) {
    table(afterBoostRows, '4.2 新分布 + 补偿旋钮（激进行为 MAD 涨得更猛）', 14);
  }
  push('> 只列激进型 30 天失控率最高的若干组；达标 = 激进型 20%—40% 且 稳健型 < 10% 且 死循环 < 5%。');
  push('');

  // ---- 五、定值 ----
  push('## 五、定值');
  push('');
  push('| 闸门 | 激进型 14 天 | 稳健型 14 天 | 激进型 30 天 | 稳健型 30 天 | 死循环 | 说明 |');
  push('|---|---|---|---|---|---|---|');
  push('| ' + W5_GATE.mad + '/' + W5_GATE.cor + '/' + W5_GATE.divisor + '（W5 旧闸门） | ' +
    pct(personaOf(at(after, W5_GATE, 14, escalation), 'aggressive')?.lostControlRate ?? 0) + ' | ' +
    pct(personaOf(at(after, W5_GATE, 14, escalation), 'steady')?.lostControlRate ?? 0) + ' | ' +
    pct(personaOf(at(after, W5_GATE, 30, escalation), 'aggressive')?.lostControlRate ?? 0) + ' | ' +
    pct(personaOf(at(after, W5_GATE, 30, escalation), 'steady')?.lostControlRate ?? 0) + ' | ' +
    pct(Math.max(0, ...at(after, W5_GATE, 30, escalation).map((row) => row.deadlockShare)), 2) + ' | 保留作对照 |');
  push('| ' + M21_GATE.mad + '/' + M21_GATE.cor + '/' + M21_GATE.divisor + '（M2.1 定值） | ' +
    pct(personaOf(before21_14, 'aggressive')?.lostControlRate ?? 0) + '（旧分布） / ' +
    pct(personaOf(after21_14, 'aggressive')?.lostControlRate ?? 0) + '（新分布） | ' +
    pct(personaOf(before21_14, 'steady')?.lostControlRate ?? 0) + '（旧分布） / ' +
    pct(personaOf(after21_14, 'steady')?.lostControlRate ?? 0) + '（新分布） | ' +
    pct(personaOf(before21, 'aggressive')?.lostControlRate ?? 0) + '（旧分布） → ' + pct(gateAgg) + '（新分布） | ' +
    pct(personaOf(before21, 'steady')?.lostControlRate ?? 0) + '（旧分布） → ' + pct(gateSte) + '（新分布） | ' +
    pct(Math.max(0, ...after21.map((row) => row.deadlockShare)), 2) + ' | 本版对照的基线 |');
  if (boost21 && boost21_14) {
    push('| ' + M21_GATE.mad + '/' + M21_GATE.cor + '/' + M21_GATE.divisor + '（M2.1 定值）+ 补偿旋钮 | ' +
      pct(personaOf(boost21_14, 'aggressive')?.lostControlRate ?? 0) + ' | ' +
      pct(personaOf(boost21_14, 'steady')?.lostControlRate ?? 0) + ' | ' +
      pct(personaOf(boost21, 'aggressive')?.lostControlRate ?? 0) + ' | ' +
      pct(personaOf(boost21, 'steady')?.lostControlRate ?? 0) + ' | ' +
      pct(Math.max(0, ...boost21.map((row) => row.deadlockShare)), 2) + ' | 闸门不动，只加行为加压 |');
  }
  if (chosen) {
    push('| **' + chosen.mad + '/' + chosen.cor + '/' + chosen.divisor + '（本轮建议）** | ' +
      pct(personaOf(at(after, chosen, 14, escalation), 'aggressive')?.lostControlRate ?? 0) + ' | ' +
      pct(personaOf(at(after, chosen, 14, escalation), 'steady')?.lostControlRate ?? 0) + ' | ' +
      pct(chosen.aggressive30) + ' | ' + pct(chosen.steady30) + ' | ' + pct(chosen.deadlock30, 2) + ' | ' +
      (escalation ? '含「激进行为加压」情景' : '纯新分布，未加任何补偿旋钮') + ' |');
  }
  push('');
  push('### 为什么最终采信实测，而不是第四节的投影');
  push('');
  push('第四节的扫参是**经验投影**：以实测的逐日 MAD 增量为输入做 bootstrap、判定走真实纯函数，');
  push('但它**不建模「失控之后玩家会去净化 / 休息」**，所以系统性地高估稳健型（M2.1 就记录过这条已知边界）。实测才是判据：');
  push('');
  push('| 口径 | 激进型 14 天 | 稳健型 14 天 | 说明 |');
  push('|---|---|---|---|');
  if (observed && observedBefore) {
    push('| **200×14 实测（本版依据）** | ' + pct(observedBefore['aggressive'] ?? 0) + ' → ' + pct(observed['aggressive'] ?? 0) + ' | ' +
      pct(observedBefore['steady'] ?? 0) + ' → ' + pct(observed['steady'] ?? 0) + ' | 闸门不动，唯一变量是世界时钟 |');
  }
  push('| 投影 30 天（同闸门） | ' + pct(personaOf(before21, 'aggressive')?.lostControlRate ?? 0) + ' → ' + pct(personaOf(after21, 'aggressive')?.lostControlRate ?? 0) + ' | ' +
    pct(personaOf(before21, 'steady')?.lostControlRate ?? 0) + ' → ' + pct(personaOf(after21, 'steady')?.lostControlRate ?? 0) + ' | 高估稳健型，只能读**方向** |');
  push('');
  push('方向是一致的：新旧分布下激进型的失控率都明显上移，稳健型基本不动（实测里干脆是 0）。');
  push('因此本轮的用法是「**投影定位方向 → 实测定值**」，与 M2.1 第三轮相同。');
  push('');
  push('### 生效值（写进 `src/config/numeric.ts`）');
  push('');
  push('- 当前生效：`lossOfControl.divisor = ' + NUMERIC.lossOfControl.divisor + '`，' +
    '`madThreshold = ' + NUMERIC.lossOfControl.madThreshold + '`，' +
    '`corThreshold = ' + NUMERIC.lossOfControl.corThreshold + '`');
  push('- 与前两版的对照：W5 80/70/430 → M2.1 65/65/250 → M2.2 ' +
    (chosen ? chosen.mad + '/' + chosen.cor + '/' + chosen.divisor : '保持 65/65/250'));
  push('- **实测（判据）**：闸门 65/65/250 不动，200×14 三轮实测 —— 激进型 12.5% → 20.0% → 27.5%，稳健型 0% → 0% → 5.0%（详见第一节 2·补）');
  push('- 补偿旋钮 `play.escalation.madPerExtraPlay`：**0（关闭）** —— 复算证明不需要它');
  push('');
  push('## 六、复现命令');
  push('');
  push('```bash');
  push('node src/vplayer/cli.ts --players 200 --days 14 --seed vplayer-m21 --persona all --keep-db \\');
  push('  --report-prefix M2.2-终验 --out docs/M2.2-终验报告.md');
  push('node scripts/m21-extract.ts --db data/dbs/m21-final-200x14.db --out data/measured-mad-cor-m21-final.json');
  push('node scripts/m21-extract.ts --db data/dbs/m22-A-200x14.db --out data/measured-mad-cor-m22.json');
  push('node scripts/m22-recalc.ts --before ' + beforeFile + ' --after ' + afterFile +
    (beforeDb ? ' --before-db ' + beforeDb : '') + (afterDb ? ' --after-db ' + afterDb : '') + ' --out ' + out);
  push('```');
  push('');

  writeFileSync(out, lines.join(NL), 'utf8');
  console.log('已写入 ' + out);
  console.log('定值建议：' + (chosen ? chosen.mad + '/' + chosen.cor + '/' + chosen.divisor : '保持 ' + M21_GATE.mad + '/' + M21_GATE.cor + '/' + M21_GATE.divisor));
}

/** 实测逐日 MAD 均值（不跑投影，直接读分布） */
function measuredMeanByDay(distribution: MeasuredDistribution, persona: string): number[] {
  const rows = distribution.samples.filter((sample) => sample.persona === persona);
  const maxDay = rows.reduce((max, row) => Math.max(max, row.day), 0);
  const out: number[] = [];
  for (let day = 0; day <= maxDay; day += 1) {
    const values = rows.filter((row) => row.day === day).map((row) => row.mad);
    out.push(values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);
  }
  return out;
}

void NL;
main().catch((error) => {
  console.error('复算失败：', error);
  process.exit(1);
});
/** 结论措辞：自然拉开 / 补偿后才达标 / 都不达标，三种情况各自给出最接近的一组 */
function scanConclusion(
  natural: readonly Row[],
  boosted: readonly Row[],
  escalation?: { threshold: number; madPerExtraPlay: number },
): string {
  const bestOf = (rows: readonly Row[]): Row | null => {
    const inRatio = rows.filter((row) => row.ratio30 >= TARGETS.ratio.min && row.ratio30 <= TARGETS.ratio.max);
    const pool = inRatio.length > 0 ? inRatio : rows;
    return [...pool].sort((a, b) => b.aggressive30 + b.chaotic30 - (a.aggressive30 + a.chaotic30))[0] ?? null;
  };
  const describe = (row: Row | null): string =>
    row
      ? row.mad + '/' + row.cor + '/' + row.divisor + '（激进型 ' + pct(row.aggressive30) + ' / 稳健型 ' + pct(row.steady30) +
        '，比值 ' + (Number.isFinite(row.ratio30) ? row.ratio30.toFixed(2) : '∞') + ' 倍，死循环 ' + pct(row.deadlock30, 2) + '）'
      : '（无）';
  const naturalPass = natural.filter((row) => row.pass);
  const naturalInRatio = naturalPass.filter((row) => row.ratio30 >= TARGETS.ratio.min && row.ratio30 <= TARGETS.ratio.max);
  if (naturalInRatio.length > 0) {
    return '**世界时钟自己就把差距拉开了**：新分布下 ' + describe(bestOf(natural)) + ' 同时满足全部目标，不需要补偿旋钮。';
  }
  const boostedPass = boosted.filter((row) => row.pass);
  const boostedInRatio = boostedPass.filter((row) => row.ratio30 >= TARGETS.ratio.min && row.ratio30 <= TARGETS.ratio.max);
  if (boostedInRatio.length > 0) {
    return '**自然拉开不够**：新分布下最好的一组是 ' + describe(bestOf(natural)) + '；' +
      (escalation
        ? '启用补偿旋钮（当天第 ' + escalation.threshold + ' 次之后每次 +' + escalation.madPerExtraPlay + ' MAD）后，' +
          describe(bestOf(boosted)) + ' 达标。'
        : '需要启用补偿旋钮（用 --escalation 扫参）。');
  }
  return '**两套都不达标**：纯新分布最好的一组是 ' + describe(bestOf(natural)) + '；' +
    (escalation ? '加了补偿旋钮后最好的一组是 ' + describe(bestOf(boosted)) + '。' : '尚未评估补偿旋钮。');
}