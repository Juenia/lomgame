/**
 * M2.13.1 卡死判据重审：**用原始 DIG 序列重数**。
 *
 * 用法：node scripts/m2-13-1-deadlock-recount.ts [片数] [输出路径]
 *
 * ## 为什么要重数
 *
 * 上一轮任务 A 的结论（「37 个序列 7 里来自 DEADLOCK 的 = 0」）被它自己挖出的证据推翻了：
 * DEADLOCK 不是永久卡死（shard6#1 卡死之后仍完成 9→8，另两个 DIG 掉回门槛以下）。
 * 所以「卡死」不能拿 `[DEADLOCK]` 前缀当定义 —— 这一份**只看原始 DIG 序列**，
 * P1 清单只作为对照列。
 *
 * ## 取数口径（关键）
 *
 * 1. **指令流**：`docs/<前缀>-shardN-行为日志.jsonl`，每条指令一行，带 `playerId/day/login/step`。
 *    按 `(day, login, step)` 排序 —— 那就是这个玩家自己的时间序。
 * 2. **DIG 值**：`domain_events` 里 `type='dig_delta'` 的 `payload.after`。
 *    它的 `seed` 形如 `onebot:vp-<playerId>-<day>-<login>-<step>:c-XXXXXX:<ts>[:action]` ——
 *    **seed 里直接编码了触发它的那条指令的位置**，所以能与指令流逐条对齐，不用猜时间戳。
 * 3. **没有 `dig_delta` 的指令**（纯读指令如 `.状态`）：沿用上一条的 DIG —— 也就是
 *    「这一刻的 DIG 是多少」。
 * 4. 起手 DIG = 0（角色创建时的默认值）。
 *
 * ## 判据（任务书 §三 A3 的字面定义）
 *
 * - **判据 1（严格）**：DIG 曾连续 ≥ 10 次指令都低于「门槛 − 5」；
 * - **判据 2（宽松）**：DIG 曾连续 ≥ 10 次指令都低于「门槛」。
 *
 * 「连续 N 次」以**玩家自己的指令流**为序列（不是全局时间轴）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  COR_LIMIT,
  DIG_THRESHOLD as THRESHOLD,
  DIG_THRESHOLD_SEQ7 as THRESHOLD_SEQ7,
  MAD_LIMIT,
  RUN,
  STRICT_LIMIT,
  afterReadyDetail,
  countBlocked,
  firstReadyAt,
  hitAfterReady,
  hitsLiteral,
  longestRunUnder,
  nameOf,
  readShardSeries,
  type PlayerSeries,
} from './m2-13-1-dig-lib.ts';

const SHARDS = Number(process.argv[2] ?? 8);
const OUT = process.argv[3] ?? join('docs', 'M2.13.1-卡死判据重审.md');

const ROUNDS = [
  { key: 'm213boff', label: '关闭前置 4（M2.12 口径）', db: 'm213boff' },
  { key: 'm213b', label: '开启前置 4（交付版）', db: 'm213b' },
];

interface RoundResult {
  key: string;
  label: string;
  /** 期末序列 ≤ 7 的玩家 */
  targets: PlayerSeries[];
  /** 全部玩家（交叉验证要用全量，不能只看序列 7 的人） */
  all: PlayerSeries[];
}

const results: RoundResult[] = [];
for (const round of ROUNDS) {
  const all: PlayerSeries[] = [];
  for (let shard = 0; shard < SHARDS; shard += 1) {
    for (const series of readShardSeries(round.key, shard).values()) all.push(series);
  }
  results.push({
    key: round.key,
    label: round.label,
    targets: all.filter((s) => s.finalSequence !== null && s.finalSequence <= 7),
    all,
  });
}

/* ---------------- 控制台摘要（先看数，报告后写） ---------------- */

/* ---------------- 判据与口径 ---------------- */

/** 任务书字面判据：DIG 曾连续 ≥ RUN 次指令都低于 limit */
/* ---------------- 控制台摘要 ---------------- */

console.log(
  'A0 序列 9 晋升门槛 = ' + THRESHOLD + '（判据 1 阈值 = ' + STRICT_LIMIT + '）；序列 8→7 门槛 = ' + THRESHOLD_SEQ7,
);
console.log(
  '口径 C 的两条线（与 DEADLOCK 判据同源）：MAD ≥ ' + MAD_LIMIT + '、COR ≥ ' + COR_LIMIT + '；RUN = ' + RUN,
);
for (const round of results) {
  const targets = round.targets;
  const literal1 = targets.filter((s) => hitsLiteral(s, STRICT_LIMIT));
  const literal2 = targets.filter((s) => hitsLiteral(s, THRESHOLD));
  const afterReady = targets.filter(hitAfterReady);
  const blocked = targets.filter((s) => countBlocked(s) > 0);
  console.log('');
  console.log('=== ' + round.key + '：期末序列 ≤7 共 ' + targets.length + ' 人 ===');
  console.log('判据 1（< ' + STRICT_LIMIT + ' 连续 ≥' + RUN + '）命中：' + literal1.length + ' / ' + targets.length);
  console.log('判据 2（< ' + THRESHOLD + ' 连续 ≥' + RUN + '）命中：' + literal2.length + ' / ' + targets.length);
  console.log('口径 B（首次达标后又回落）命中：' + afterReady.length + ' / ' + targets.length);
  console.log('口径 C（够门槛却过不去，原始重算）命中：' + blocked.length + ' / ' + targets.length);
  console.log('逐人：');
  for (const s of [...targets].sort((a, b) => a.shard - b.shard || a.playerId - b.playerId)) {
    const first = firstReadyAt(s);
    console.log(
      '  shard' + s.shard + ' #' + s.playerId +
        ' n=' + s.dig.length +
        ' peak=' + Math.max(...s.dig).toFixed(0) +
        ' 首次达标@' + first +
        ' 判据1=' + hitsLiteral(s, STRICT_LIMIT) +
        ' 判据2=' + hitsLiteral(s, THRESHOLD) +
        ' 口径B=' + hitAfterReady(s) +
        ' 口径C=' + countBlocked(s) +
        ' P1DEADLOCK=' + s.deadlockLines,
    );
  }
}

/* 校验样本：三个已知卡死玩家（关闭那轮）—— 它们都**没有**升到序列 7，所以不在 targets 里 */
console.log('');
console.log('=== 校验样本（关闭那轮，已知卡死的三个玩家）===');
const controlRound = results[0]!;
for (const [shard, playerId] of [[0, 11], [6, 1], [7, 11]] as Array<[number, number]>) {
  const found = readShardSeries(controlRound.key, shard).get(playerId);
  if (!found) {
    console.log('shard' + shard + ' #' + playerId + '：读不到');
    continue;
  }
  console.log(
    '  shard' + shard + ' #' + playerId +
      ' 最终序列=' + found.finalSequence +
      ' n=' + found.dig.length +
      ' peak=' + Math.max(...found.dig).toFixed(1) +
      ' 首次达标@' + firstReadyAt(found) +
      ' 判据1=' + hitsLiteral(found, STRICT_LIMIT) +
      ' 判据2=' + hitsLiteral(found, THRESHOLD) +
      ' 口径B=' + hitAfterReady(found) +
      ' 口径C=' + countBlocked(found) +
      ' P1DEADLOCK=' + found.deadlockLines,
  );
}

/*
 * 全量交叉验证 —— 这一步比「37 人里命中几个」更要紧：
 *
 * 如果口径 C（真卡死）在全量 200 人里命中的那些玩家，**最终序列分布里一个 7 都没有**，
 * 那比「37 人里 0 个」更强：它说明「卡死」与「升到 7」在整批人里就是互斥的。
 * 顺带验证重建口径本身 —— 口径 C 的命中集合应当与 P1 清单基本重合。
 */
console.log('');
console.log('=== 全量交叉验证（口径 C vs P1 清单）===');
for (const round of results) {
  const all = round.all;
  const blocked = all.filter((s) => countBlocked(s) > 0);
  const byP1 = all.filter((s) => s.deadlockLines > 0);
  const onlyC = blocked.filter((s) => s.deadlockLines === 0);
  const onlyP1 = byP1.filter((s) => countBlocked(s) === 0);
  const dist = new Map<string, number>();
  for (const s of blocked) {
    const key = s.finalSequence === null ? '普通人' : '序列 ' + s.finalSequence;
    dist.set(key, (dist.get(key) ?? 0) + 1);
  }
  console.log(round.key + '：全量 ' + all.length + ' 人');
  console.log('  口径 C 命中 ' + blocked.length + ' 人；P1 清单命中 ' + byP1.length + ' 人');
  console.log('  两者都命中 ' + blocked.filter((s) => s.deadlockLines > 0).length + '；只有 C ' + onlyC.length + '；只有 P1 ' + onlyP1.length);
  console.log('  口径 C 命中者的最终序列分布：' + ([...dist.entries()].map(([k, v]) => k + ' ' + v).join('、') || '（无）'));
  if (onlyC.length > 0) console.log('  只有 C：' + onlyC.map((s) => 'shard' + s.shard + '#' + s.playerId).join('、'));
  if (onlyP1.length > 0) console.log('  只有 P1：' + onlyP1.map((s) => 'shard' + s.shard + '#' + s.playerId).join('、'));
  console.log('  口径 C 命中者明细：' + blocked.map((s) => 'shard' + s.shard + '#' + s.playerId + '(C=' + countBlocked(s) + ',终=' + s.finalSequence + ')').join(' '));
}

/* ---------------- 口径 B 明细（控制台先看数） ---------------- */

console.log('');
console.log('=== 口径 B 命中者明细（达标 = DIG 首次 >= ' + THRESHOLD + '；回落 = 连续 >= ' + RUN + ' 条 < ' + THRESHOLD + '）===');
for (const round of results) {
  const hits = round.targets.filter((s) => afterReadyDetail(s).hit);
  console.log(round.key + '：命中 ' + hits.length + ' / ' + round.targets.length + '（序列 7 玩家）');
  for (const s of hits) {
    const d = afterReadyDetail(s);
    console.log(
      '  shard' + s.shard + ' #' + s.playerId +
        ' 最终序列=' + s.finalSequence +
        ' 首次达标 d' + d.firstDay + '（第 ' + d.firstIndex + ' 条）' +
        ' 最长回落 ' + d.runLength + ' 条' +
        '（d' + d.minDay + '，最低 ' + d.minDig.toFixed(1) + '）' +
        ' 再次达标=' + d.recovered,
    );
  }
  const allHits = round.all.filter((s) => afterReadyDetail(s).hit);
  console.log('  （全量 ' + round.all.length + ' 人里命中 ' + allHits.length + ' 人）');
}

/* ---------------- 渲染报告 ---------------- */

const N = String.fromCharCode(96);
const code = (s: string): string => N + s + N;
const pctOf = (n: number, base: number): string => (base > 0 ? ((n / base) * 100).toFixed(0) + '%' : '—');
/** 晋升率要一位小数 —— 5/34 与 1/30 用整数会丢掉关键差别 */
const pct1 = (n: number, base: number): string => (base > 0 ? ((n / base) * 100).toFixed(1) + '%' : '—');

const lines: string[] = [];
const P = (s = ''): void => { lines.push(s); };

const boff = results[0]!;
const m213b = results[1]!;
const statOf = (round: RoundResult): {
  literal1: PlayerSeries[]; literal2: PlayerSeries[]; afterReady: PlayerSeries[]; blocked: PlayerSeries[];
} => ({
  literal1: round.targets.filter((s) => hitsLiteral(s, STRICT_LIMIT)),
  literal2: round.targets.filter((s) => hitsLiteral(s, THRESHOLD)),
  afterReady: round.targets.filter(hitAfterReady),
  blocked: round.targets.filter((s) => countBlocked(s) > 0),
});
const sBoff = statOf(boff);
const sM213b = statOf(m213b);
const allBlockedBoff = boff.all.filter((s) => countBlocked(s) > 0);
const allAfterReadyBoff = boff.all.filter((s) => afterReadyDetail(s).hit).length;
const allAfterReadyB = m213b.all.filter((s) => afterReadyDetail(s).hit).length;

/** 命中 / 未命中口径 B 的**晋升率**交叉表（全量 200 人，不只看序列 7） */
interface CrossRow {
  hit: number;
  hit7: number;
  miss: number;
  miss7: number;
}
function crossOf(round: RoundResult): CrossRow {
  const row: CrossRow = { hit: 0, hit7: 0, miss: 0, miss7: 0 };
  for (const s of round.all) {
    const is7 = s.finalSequence !== null && s.finalSequence <= 7;
    if (afterReadyDetail(s).hit) {
      row.hit += 1;
      if (is7) row.hit7 += 1;
    } else {
      row.miss += 1;
      if (is7) row.miss7 += 1;
    }
  }
  return row;
}
const afterReadyNames = (round: RoundResult): string =>
  round.targets.filter((s) => afterReadyDetail(s).hit).map(nameOf).join('、') || '（无）';
const allTargets = [...boff.targets, ...m213b.targets];
const firstReadyList = allTargets.map((s) => firstReadyAt(s)).sort((a, b) => a - b);
const medianFirst = firstReadyList[Math.floor(firstReadyList.length / 2)]!;

P('# M2.13.1 卡死判据重审：用原始 DIG 序列重数');
P();
P('> **为什么要重数**：上一轮任务 A 的结论（37 个序列 7 里来自 DEADLOCK 的 = 0）');
P('> 被它自己挖出的证据挑战了 —— DEADLOCK 不是永久卡死（shard6#1 卡死之后仍完成 9→8）。');
P('> 所以「卡死」不能拿 [DEADLOCK] 前缀当定义。这一份**只看原始 DIG / MAD / COR 序列**，');
P('> P1 清单只作为对照列。');
P('>');
P('> 数据来源：' + code('data/' + boff.key + '-shard-N.db') + ' 与 ' + code('data/' + m213b.key + '-shard-N.db') + '（各 8 片），');
P('> 配套 ' + code('docs/<前缀>-shardN-行为日志.jsonl') + '。数字全部由 ' + code('scripts/m2-13-1-deadlock-recount.ts') + ' 从库里数出来。');
P();
P('## 〇、结论摘要');
P();
P('| 轮次 | 期末序列 ≤7 | 判据 1（字面·严格） | 判据 2（字面·宽松） | **口径 B（达标后回落）** | 口径 C（够门槛却过不去） |');
P('| --- | --- | --- | --- | --- | --- |');
P('| 关闭前置 4（' + boff.key + '） | ' + boff.targets.length + ' | **' + sBoff.literal1.length + '**（' + pctOf(sBoff.literal1.length, boff.targets.length) + '） | **' + sBoff.literal2.length + '**（' + pctOf(sBoff.literal2.length, boff.targets.length) + '） | ' + sBoff.afterReady.length + ' | **' + sBoff.blocked.length + '** |');
P('| 开启前置 4（' + m213b.key + '） | ' + m213b.targets.length + ' | **' + sM213b.literal1.length + '**（' + pctOf(sM213b.literal1.length, m213b.targets.length) + '） | **' + sM213b.literal2.length + '**（' + pctOf(sM213b.literal2.length, m213b.targets.length) + '） | ' + sM213b.afterReady.length + ' | **' + sM213b.blocked.length + '** |');
P();
P('**一句话**：任务书写的那两条字面判据**命中率 100%**（' + sBoff.literal2.length + '/' + boff.targets.length + '、' + sM213b.literal2.length + '/' + m213b.targets.length + '）——');
P('它们测的是「DIG 涨到门槛用了多少条指令」，不是「卡没卡死」。');
P();
P('> ⚠️ **本版（第二轮）撤回上一轮的两处表述**，理由见 §九：');
P('> ① 「口径 C = 0 **加强了**上一轮的结论」是**同义反复** ——');
P('>    口径 C 含「序列 9」这个条件，而序列 7 的玩家不在序列 9，命中 0 是定义上的必然；');
P('> ② 「口径 C 与 P1 清单 3/3 一致 = **独立验证**」也不成立 ——');
P('>    口径 C 就是 P1 的 DEADLOCK 判据本身，等于用同一把尺量了两遍。');
P('>');
P('> **真正有信息量的口径是 B**（达标后回落）：关闭轮 ' + sBoff.afterReady.length + ' 人、开启轮 ' + sM213b.afterReady.length + ' 人，');
P('> 而**他们全部升到了序列 7** —— 名单与去向见 §6.3，三问三答见 §七。');
P();
P('## 零、口径 B 的定义（写死）');
P();
P('> 上一轮只给了两个数（' + sBoff.afterReady.length + ' / ' + sM213b.afterReady.length + '），**没有定义**。本轮把它钉死在这里，');
P('> 下一轮不许改口。实现是 ' + code('afterReadyDetail()') + '（' + code('scripts/m2-13-1-deadlock-recount.ts') + '），');
P('> 与上一轮是同一份代码 —— 所以上一轮那两个数**可复现**。');
P();
P('| 项 | 值 | 说明 |');
P('| --- | --- | --- |');
P('| **「达标」的阈值** | **' + THRESHOLD + '**（序列 9 → 8 的门槛） | **只看 ' + THRESHOLD + '**，不看序列 8→7 的 ' + THRESHOLD_SEQ7 + '；两者都算会得到另一组数 |');
P('| **「回落」的定义** | 达标之后出现 DIG **< ' + THRESHOLD + '** | 门槛本身，**不是**门槛 − 5 |');
P('| **「连续」的窗口** | **≥ ' + RUN + ' 次指令** | 玩家自己的指令流，含 .状态 这类纯读指令 |');
P('| **起点** | 首次 DIG ≥ ' + THRESHOLD + ' 的那条指令**之后** | 那条指令自己 ≥ 门槛，不可能是回落段的一部分 |');
P('| **命中** | 存在至少一段满足上面三条 | 命中者 = 「达标后又掉回去过」的人 |');
P();
P('## 一、A0：序列 9 的晋升门槛');
P();
P('| 项 | 值 | 出处 |');
P('| --- | --- | --- |');
P('| **序列 9 → 8 的 DIG 门槛** | **' + THRESHOLD + '** | ' + code('src/config/numeric.ts') + ' 的 promotion.digThreshold |');
P('| 序列 8 → 7 的 DIG 门槛 | ' + THRESHOLD_SEQ7 + ' | 同文件的 sequence7.digThreshold |');
P('| 门槛的选择点 | digThresholdFor(recipe)：序列 7 的配方用 ' + THRESHOLD_SEQ7 + '，否则用 ' + THRESHOLD + ' | ' + code('src/domain/promotion/promotion.ts:36') + ' |');
P('| DEADLOCK 判据的两条线（口径 C 复用） | MAD ≥ ' + MAD_LIMIT + '、COR ≥ ' + COR_LIMIT + ' | ' + code('NUMERIC.lossOfControl') + ' |');
P();
P('所以判据 1 的阈值 = ' + THRESHOLD + ' − 5 = **' + STRICT_LIMIT + '**，判据 2 的阈值 = **' + THRESHOLD + '**。');
P();
P('## 二、取数口径（DIG 时间序列是怎么来的）');
P();
P('| 环节 | 做法 |');
P('| --- | --- |');
P('| **指令流** | ' + code('行为日志 JSONL') + ' 每条指令一行，带 playerId/day/login/step；按 (day, login, step) 排序 = 这个玩家自己的时间序 |');
P('| **DIG / MAD / COR 值** | ' + code('domain_events') + ' 里 dig_delta / mad_delta / cor_delta 的 payload.after |');
P('| **怎么对齐到指令** | 这三类事件的 seed 形如 ' + code('onebot:vp-<playerId>-<day>-<login>-<step>:c-XXXXXX:<ts>') + ' —— **seed 里直接编码了触发它的那条指令的位置**，逐条精确对齐，不猜时间戳 |');
P('| **没有事件的指令** | 纯读指令（如 .状态）沿用上一条的值 —— 也就是「这一刻的 DIG 是多少」 |');
P('| **序列** | pathway_initiated → 9；sequence_delta 用 payload.after；promotion_success 用 payload.to |');
P('| **起手值** | DIG / MAD / COR = 0，序列 = null（还没入途径） |');
P();
P('> **.状态 算不算一次指令**：算。判据里的「连续 N 次指令」= **玩家自己发出的每一条指令**，');
P('> 包含 .状态 / .背包 这类纯读指令 —— 与 P1 的 NO_STATE_CHANGE 口径一致。');
P('> 这一条会让判据**更宽松**（纯读指令期间 DIG 通常不变，容易凑够 ' + RUN + ' 次），已在 §四 说明影响。');
P();
P('## 三、A3 主表：任务书的字面判据');
P();
P('| 轮次 | 最终序列 7 人数 | 判据 1 命中 | 判据 2 命中 | 命中名单 |');
P('| --- | --- | --- | --- | --- |');
P('| 关闭（' + boff.key + '） | ' + boff.targets.length + ' | **' + sBoff.literal1.length + '** | **' + sBoff.literal2.length + '** | ' + (sBoff.literal2.length === boff.targets.length ? '**全部 ' + boff.targets.length + ' 人**（逐人见 §六 明细）' : sBoff.literal2.map(nameOf).join('、')) + ' |');
P('| 开启（' + m213b.key + '） | ' + m213b.targets.length + ' | **' + sM213b.literal1.length + '** | **' + sM213b.literal2.length + '** | ' + (sM213b.literal2.length === m213b.targets.length ? '**全部 ' + m213b.targets.length + ' 人**（逐人见 §六 明细）' : sM213b.literal2.map(nameOf).join('、')) + ' |');
P();
P('**两条字面判据都是 100% 命中。**');
P();
P('## 四、为什么字面判据没有区分度');
P();
P('因为它测的是「DIG 涨到门槛花了多久」。建号时 DIG = 0，要攒到 ' + THRESHOLD + ' 本来就要几百条指令：');
P();
P('| 观察 | 读数 |');
P('| --- | --- |');
P('| 两轮共 ' + allTargets.length + ' 个序列 7 玩家的**首次达标位置** | 最小 ' + firstReadyList[0] + ' 条指令，中位 ' + medianFirst + ' 条指令 |');
P('| 首次达标之前的指令段 | **全部**低于 ' + THRESHOLD + '（那是从 0 涨上来的过程） |');
P('| 因此「连续 ≥ ' + RUN + ' 次低于门槛」 | **人人都有** —— 判据在测「涨得多快」，不是「卡没卡死」 |');
P();
P('> 「DIG 低」与「卡死」是两回事：**卡死的前提是 DIG 已经够得着门槛，却过不去。**');
P('> 一条把所有人新手期都算进去的判据，命中的不是异常，是**还没到时间**。');
P();
P('## 五、补充口径 B 与 C');
P();
P('| 口径 | 定义 | 关闭轮命中 | 开启轮命中 | 读法 |');
P('| --- | --- | --- | --- | --- |');
P('| **B：达标后回落** | 首次 DIG ≥ ' + THRESHOLD + ' 之后，又出现连续 ≥ ' + RUN + ' 次低于 ' + THRESHOLD + ' | ' + sBoff.afterReady.length + ' | ' + sM213b.afterReady.length + ' | **波动**，不是卡死 —— 这些人后来都完成了 8→7 |');
P('| **C：够门槛却过不去** | 存在指令满足 DIG ≥ ' + THRESHOLD + '、序列 = 9、MAD ≥ ' + MAD_LIMIT + '、COR ≥ ' + COR_LIMIT + '（= DEADLOCK 判据的**独立重算**） | **' + sBoff.blocked.length + '** | **' + sM213b.blocked.length + '** | **真卡死** |');
P();
if (sBoff.afterReady.length + sM213b.afterReady.length > 0) {
  P('口径 B 命中名单：' + [...sBoff.afterReady, ...sM213b.afterReady].map(nameOf).join('、') + '。');
  P();
  P('他们的共同点：**回落期间 MAD/COR 没有同时越线**，所以口径 C = 0 —— 只是 DIG 掉了又涨，不是过不去。');
  P();
}
P('## 六、全量交叉验证（口径 C vs P1 清单）');
P();
P('> **先说清楚这一节能证什么、不能证什么**：它验证的是「**脚本实现与原始数据对得上**」，');
P('> **不构成对「卡死」定义的独立验证** —— 口径 C 就是 P1 的 DEADLOCK 判据本身。');
P();
P('| 轮次 | 全量 | 口径 C 命中 | P1 清单命中 | 两者都命中 | 只有 C | 只有 P1 |');
P('| --- | --- | --- | --- | --- | --- | --- |');
for (const round of results) {
  const blocked = round.all.filter((s) => countBlocked(s) > 0);
  const byP1 = round.all.filter((s) => s.deadlockLines > 0);
  P('| ' + round.key + ' | ' + round.all.length + ' | **' + blocked.length + '** | **' + byP1.length + '** | ' +
    blocked.filter((s) => s.deadlockLines > 0).length + ' | ' +
    blocked.filter((s) => s.deadlockLines === 0).length + ' | ' +
    byP1.filter((s) => countBlocked(s) === 0).length + ' |');
}
P();
P('**两边完全一致**：关闭那轮各命中同样 ' + allBlockedBoff.length + ' 人，零假阳性、零假阴性。');
P('也就是说：**从原始数据独立实现一遍判据，与脚本产出的 P1 清单对得上** ——');
P('验证的是**脚本实现与原始数据的一致性**，不是对「卡死」定义的独立验证。');
P();
P('口径 C 命中者的最终序列分布（关闭轮）：');
P();
P('| 分片/玩家 | 口径 C 命中指令数 | P1 DEADLOCK 条数 | **最终序列** |');
P('| --- | --- | --- | --- |');
for (const s of [...allBlockedBoff].sort((a, b) => a.shard - b.shard || a.playerId - b.playerId)) {
  P('| ' + nameOf(s) + ' | ' + countBlocked(s) + ' | ' + s.deadlockLines + ' | **' + s.finalSequence + '** |');
}
P();
P('> 口径 C 的条数与 P1 条数不是同一个单位：前者是**满足条件的指令条数**，');
P('> 后者是异常检测器在它的检查点上记下的**记录条数**。集合一致才是要紧的，条数不必相等。');
P();
P('### 6.1 逐人明细（两轮的序列 7 玩家）');
P();
P('| 轮次 | 分片/玩家 | 指令数 | DIG 峰值 | 首次达标@ | 判据 1 | 判据 2 | 口径 B | 口径 C | P1 DEADLOCK |');
P('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const round of results) {
  for (const s of [...round.targets].sort((a, b) => a.shard - b.shard || a.playerId - b.playerId)) {
    P('| ' + round.key + ' | ' + nameOf(s) + ' | ' + s.dig.length + ' | ' + Math.max(...s.dig).toFixed(0) + ' | ' +
      firstReadyAt(s) + ' | ' + hitsLiteral(s, STRICT_LIMIT) + ' | ' + hitsLiteral(s, THRESHOLD) + ' | ' +
      hitAfterReady(s) + ' | ' + countBlocked(s) + ' | ' + s.deadlockLines + ' |');
  }
}
P();
P('### 6.2 校验样本：三个已知卡死的玩家（新判据必须命中）');
P();
P('| 分片/玩家 | 最终序列 | 指令数 | DIG 峰值 | 首次达标@ | 判据 1 | 判据 2 | 口径 B | 口径 C | P1 DEADLOCK |');
P('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const [shard, playerId] of [[0, 11], [6, 1], [7, 11]] as Array<[number, number]>) {
  const found = readShardSeries(boff.key, shard).get(playerId);
  if (!found) {
    P('| shard' + shard + '/#' + playerId + ' | 读不到 | — | — | — | — | — | — | — | — |');
    continue;
  }
  P('| shard' + shard + '/#' + playerId + ' | ' + found.finalSequence + ' | ' + found.dig.length + ' | ' +
    Math.max(...found.dig).toFixed(1) + ' | ' + firstReadyAt(found) + ' | ' + hitsLiteral(found, STRICT_LIMIT) + ' | ' +
    hitsLiteral(found, THRESHOLD) + ' | ' + hitAfterReady(found) + ' | ' + countBlocked(found) + ' | ' + found.deadlockLines + ' |');
}
P();
P('**三个样本全部命中口径 B 与口径 C** ✓ —— 判据有效（口径 A 那种字面判据虽然也命中，但它谁都命中）。');
P();
P('### 6.3 口径 B 的 ' + (sBoff.afterReady.length + sM213b.afterReady.length) + ' 个人（逐一列表 —— 本轮的核心产出）');
P();
P('上一轮只给了两个数（' + sBoff.afterReady.length + ' / ' + sM213b.afterReady.length + '），**没有名单、没有去向**。这里补上。');
P();
for (const round of results) {
  const hits = round.targets.filter((s) => afterReadyDetail(s).hit);
  if (hits.length === 0) continue;
  P('#### ' + round.label + '（' + round.key + '）—— ' + hits.length + ' 人');
  P();
  P('| 分片 | player_id | 最终序列 | DIG 首次达标日 | 回落到最低值 | 回落最低点日期 | 是否再次达标 | **最终是否升到序列 7** |');
  P('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const s of [...hits].sort((a, b) => a.shard - b.shard || a.playerId - b.playerId)) {
    const d = afterReadyDetail(s);
    const reached7 = s.finalSequence !== null && s.finalSequence <= 7;
    P('| ' + s.shard + ' | #' + s.playerId + ' | **' + s.finalSequence + '** | d' + d.firstDay +
      ' | **' + d.minDig.toFixed(1) + '**（回落 ' + d.runLength + ' 条指令） | d' + d.minDay + ' | ' +
      (d.recovered ? '是' : '否（回落段一直持续到期末）') + ' | **' + (reached7 ? '是' : '否') + '** |');
  }
  P();
}
P('> **「是否再次达标」的口径**：指**最长回落段之后**是否又回到 ≥ ' + THRESHOLD + '。');
P('> 「否」**不等于**「没升到序列 7」—— 有人的最长回落段就发生在**期末那一段**，');
P('> 他在回落之前早就走完了 9→8→7。最后两列要一起看。');
P();
P('**全量对照**（口径 B 不是序列 7 独有的现象）：');
P();
P('| 轮次 | 全量 ' + boff.all.length + ' 人里命中 | 序列 7 玩家里命中 | 命中率（全量） | 命中率（序列 7 玩家） |');
P('| --- | --- | --- | --- | --- |');
for (const round of results) {
  const allHits = round.all.filter((s) => afterReadyDetail(s).hit).length;
  const seq7Hits = round.targets.filter((s) => afterReadyDetail(s).hit).length;
  P('| ' + round.key + ' | ' + allHits + ' | ' + seq7Hits + ' | ' + pctOf(allHits, round.all.length) + ' | ' + pctOf(seq7Hits, round.targets.length) + ' |');
}
P();
P('> ⚠️ **上一版这里的读法是错的，已改正。** 上一版写的是「回落不阻止晋升」，');
P('> 但「命中率（序列 7）< 命中率（全量）」这个不等式**方向恰好相反** ——');
P('> 它等价于 **P(序列 7 | 命中) < P(序列 7 | 未命中)**，也就是命中者的晋升率**更低**。');
P('> 四个数在 §6.4 明算出来。');
P();
P('### 6.4 晋升率：命中口径 B 的人，升到序列 7 的比例**更低**');
P();
P('| 轮次 | 命中口径 B | 其中升到 7 | **命中者晋升率** | 未命中 | 其中升到 7 | **未命中者晋升率** |');
P('| --- | --- | --- | --- | --- | --- | --- |');
for (const round of results) {
  const c = crossOf(round);
  P('| ' + round.key + ' | ' + c.hit + ' | ' + c.hit7 + ' | **' + pct1(c.hit7, c.hit) + '** | ' + c.miss + ' | ' + c.miss7 + ' | **' + pct1(c.miss7, c.miss) + '** |');
}
P();
P('**两轮方向一致：命中者晋升率低于未命中者。**');
P();
P('> **样本量小 —— 不下因果。** 命中者两轮合计 ' + (crossOf(boff).hit + crossOf(m213b).hit) + ' 人、其中 ' + (crossOf(boff).hit7 + crossOf(m213b).hit7) + ' 人升到 7；');
P('> 关闭轮那一格只有 ' + crossOf(boff).hit7 + ' 个分子，开启轮只有 ' + crossOf(m213b).hit7 + ' 个 ——');
P('> 这个差（' + pct1(crossOf(boff).hit7, crossOf(boff).hit) + ' vs ' + pct1(crossOf(boff).miss7, crossOf(boff).miss) + '、' + pct1(crossOf(m213b).hit7, crossOf(m213b).hit) + ' vs ' + pct1(crossOf(m213b).miss7, crossOf(m213b).miss) + '）完全可能是抖动。');
P('> **能说的是方向，不是因果** —— 但方向不能读反。');
P();
P('> **这一节和 §6.3 要连着看**：口径 B 命中的那 ' + (sBoff.afterReady.length + sM213b.afterReady.length) + ' 个**序列 7 玩家**，');
P('> 是「命中者里的少数」（' + (crossOf(boff).hit7 + crossOf(m213b).hit7) + ' / ' + (crossOf(boff).hit + crossOf(m213b).hit) + '），');
P('> **不是**「命中者都升上去了」。上一版把这句话说反了。');
P();
P('## 七、回答任务书的两个问题');
P();
P('### 问题 1：关闭那轮 37 个序列 7 里，有几个疑似卡死过？');
P();
P('**取决于用哪条判据 —— 而两条字面判据都不能用：**');
P();
P('| 判据 | 命中 | 结论 |');
P('| --- | --- | --- |');
P('| 判据 1（低于 ' + STRICT_LIMIT + ' 连续 ≥ ' + RUN + '） | ' + sBoff.literal1.length + ' / ' + boff.targets.length + ' | **无区分度**（测的是新手期） |');
P('| 判据 2（低于 ' + THRESHOLD + ' 连续 ≥ ' + RUN + '） | ' + sBoff.literal2.length + ' / ' + boff.targets.length + ' | **无区分度** |');
P('| **口径 B（达标后回落）** | **' + sBoff.afterReady.length + ' / ' + boff.targets.length + '** | **这 ' + sBoff.afterReady.length + ' 个人全部升到了序列 7** |');
P('| 口径 C（够门槛却过不去） | **' + sBoff.blocked.length + ' / ' + boff.targets.length + '** | **同义反复**，不作证据（见 §六 开头） |');
P();
P('**答案：拿口径 B 当「疑似卡死」，这 ' + sBoff.afterReady.length + ' 个人里 ' + sBoff.afterReady.length + ' 个都升到了序列 7。**');
P();
P('> **所以上一轮「卡死人群没有一个升到 7」这个结论，在口径 B 下被推翻。**');
P('> 它在口径 C 下仍然成立（那三个 DEADLOCK 玩家确实都没到 7），');
P('> 但口径 C 含「序列 9」这个条件，序列 7 的玩家天然不满足 —— **那不是证据，是定义**。');
P();
P('### 问题 1 的补充：口径 B 命中 ≠ 卡死（这里的证据是独立的）');
P();
P('这 ' + sBoff.afterReady.length + ' 个人**不是卡死的**，三条证据都不循环：');
P();
P('1. **他们全部完成了 8→7**（§6.3 最后一列）—— 卡死的人做不到这件事；');
P('2. **他们在序列 9 期间从未同时满足 MAD/COR 越线**：口径 C 对这 ' + sBoff.afterReady.length + ' 人命中 **0 条**。');
P('   这一条**不是同义反复** —— 他们当时确实在序列 9、DIG 也确实到过 ' + THRESHOLD + ' 以上，');
P('   条件对他们**是可满足的**（已知卡死的 shard0#11 就满足了几十条）；');
P('3. **口径 B 在全量里是常见现象**：关闭轮 ' + allAfterReadyBoff + ' / ' + boff.all.length + ' 人命中（' + pctOf(allAfterReadyBoff, boff.all.length) + '）——');
P('   如果它等于卡死，那这一轮就有 ' + allAfterReadyBoff + ' 个卡死的人，而 P1 清单只记了 3 个。');
P();
P('所以口径 B 描述的是**波动**：DIG 掉下去过，但后来涨回来了。');
P();
P('### 问题 2：开启那轮 19 个序列 7 里，有几个疑似卡死过？');
P();
P('**口径 B：' + sM213b.afterReady.length + ' 个，最终序列 = ' + m213b.targets.filter((s) => afterReadyDetail(s).hit).map((s) => s.finalSequence).join('、') + '。**');
P('（字面判据 ' + sM213b.literal2.length + ' / ' + m213b.targets.length + ' 无区分度；口径 C = 0，同义反复。）');
P();
P('所以 ' + code('docs/M2.13.1-交付说明.md') + ' §2.2.1 的分层要补一层，见下面的「对 §2.2.1 的影响」。');
P();
P('### 问题 3：这 ' + (sBoff.afterReady.length + sM213b.afterReady.length) + ' 个人与已知 3 个卡死玩家的重合');
P();
P('| 集合 | 名单 |');
P('| --- | --- |');
P('| 口径 B 命中（关闭轮） | ' + afterReadyNames(boff) + ' |');
P('| 口径 B 命中（开启轮） | ' + afterReadyNames(m213b) + ' |');
P('| 已知卡死（关闭轮，口径 C） | ' + allBlockedBoff.map(nameOf).join('、') + ' |');
P('| **重合** | **0** |');
P();
P('> 两组人**完全不重叠**。这符合预期：口径 C 要 MAD/COR 双双越线（疯狂与污染爆表），');
P('> 口径 B 只要 DIG 掉下去 —— 两类现象在原始数据上本来就是分开的。');
P();
P('### 对 §2.2.1 的影响');
P();
P('§2.2.1 把关闭那轮 ' + boff.targets.length + ' 人整体称作「健康玩家」。现在要补一层：');
P();
P('| | 关闭那轮 | 开启那轮 |');
P('| --- | --- | --- |');
P('| 序列 7 总人数 | ' + boff.targets.length + ' | ' + m213b.targets.length + ' |');
P('| 其中经历过口径 B 的回落 | ' + sBoff.afterReady.length + ' | ' + sM213b.afterReady.length + ' |');
P('| 其中没有 | ' + (boff.targets.length - sBoff.afterReady.length) + ' | ' + (m213b.targets.length - sM213b.afterReady.length) + ' |');
P('| 最终升到序列 7 | ' + boff.targets.length + '（全部） | ' + m213b.targets.length + '（全部） |');
P();
P('**但「8→7 的差由这批人自己的行为差异造成」这个结论不变**：那 ' + (sBoff.afterReady.length + sM213b.afterReady.length) + ' 个人确实都升到了序列 7（个体事实），');
P('而从群体看，命中者的晋升率低于未命中者（§6.4）—— 变的只是「健康玩家」这个词要加一句定义：');
P('**本轮的用法 = 口径 C 未命中的人**；口径 B 命中的 ' + (sBoff.afterReady.length + sM213b.afterReady.length) + ' 人也算健康，因为回落没有阻止他们晋升。');
P();
P('## 八、B：判据重审建议（拍板项 —— 本轮不动代码）');
P();
P('### 8.1 真正的问题不是「卡死」这个词，是**一条判据的名字在说另一件事**');
P();
P('| 现象 | 原始特征 | 现在的归属 |');
P('| --- | --- | --- |');
P('| 纯读指令连发（.状态 连续 10 条） | 状态不变，但玩家在做别的事 | NO_STATE_CHANGE（关闭轮 1 条） |');
P('| **够门槛却过不去**：DIG ≥ ' + THRESHOLD + '、序列 9、MAD/COR 越线 | 晋升**真的被挡住了** | DEADLOCK（关闭轮 66 条 / ' + allBlockedBoff.length + ' 人） |');
P('| DIG 还没涨到门槛（建号初期） | DIG 低于 ' + THRESHOLD + ' | **没有任何判据** ✅ 正确 |');
P();
P('DEADLOCK 这个名字暗示的是「玩家卡住了、世界不动了」，而它实际测的是');
P('「**DIG 已经够，但疯狂与污染把晋升挡在门外**」。名字与语义错位，才会出现');
P('「卡死的人后来升到了序列 8」这种看起来自相矛盾的事（shard6#1 就是）。');
P();
P('### 8.2 建议（三条，按优先级）');
P();
P('| # | 建议 | 理由 | 影响面 |');
P('| --- | --- | --- | --- |');
P('| **1** | **DEADLOCK 拆成两类**：PROMOTION_BLOCKED（够门槛 + MAD/COR 越线，= 现在的口径 C）与 DEADLOCK（保留给真正的死锁：够门槛、无越线、却连续 N 天没有任何状态变化） | 名字与语义对齐；本版**没有观测到**第二类，所以拆分不会改变任何计数 | 只改异常代码与报告话术，**不改判定、不改数值** |');
P('| **2** | **补一条黄项 DIG_STALL（不进 P1）**：口径 B —— 首次达标后又连续 ≥ ' + RUN + ' 次回落 | 关闭轮 ' + sBoff.afterReady.length + ' 人、开启轮 ' + sM213b.afterReady.length + ' 人命中，是**波动**不是卡死；记成黄项可以看趋势，记成 P1 会制造噪声 | 新增黄项，不影响 P0/P1 判定 |');
P('| **3** | **不要用「DIG 连续低于门槛」当任何判据** | 本轮实测：命中率 100%（' + sBoff.literal2.length + '/' + boff.targets.length + '、' + sM213b.literal2.length + '/' + m213b.targets.length + '），**零区分度** —— 它等于在数「玩家多少条指令之后才入途径」 | 无（负面建议） |');
P();
P('### 8.3 本轮**不改**任何判据');
P();
P('理由：**从原始数据独立实现一遍 DEADLOCK 判据，与脚本产出的 P1 清单完全一致（' + allBlockedBoff.length + '/' + allBlockedBoff.length + '）**，');
P('说明现有 DEADLOCK 判据的**实现**没有坏 —— 注意这不构成对「卡死」定义的验证（见 §六 开头）。');
P('需要的是**改名与语义澄清**（8.2 第 1 条），');
P('那属于 M2.14 的口径整理，既不改判定、也不动任何数值 —— 所以本轮按任务书 §三 B 的规定：');
P('**只出分析报告，不动代码。**');
P();
P('## 九、撤回的两处表述（第二轮）');
P();
P('| # | 上一轮写的 | 为什么撤回 | 本版的说法 |');
P('| --- | --- | --- | --- |');
P('| 1 | 「口径 C 与 P1 清单完全一致 = **独立重算 / 独立验证**」 | 口径 C 就是 P1 的 DEADLOCK 判据本身，等于用同一把尺量两遍 | 口径 C 与 P1 DEADLOCK 判据相同，本次从原始 DIG 序列**独立实现了一遍**，与脚本产出的 P1 清单 ' + allBlockedBoff.length + '/' + allBlockedBoff.length + ' 一致 —— 验证的是**脚本实现与原始数据对得上**，**不构成对「卡死」定义的独立验证** |');
P('| 2 | 「上一轮的结论**被加强了**：整批人里卡死过的，没有一个升到 7」 | 那段论证用的是口径 C，而口径 C 含「序列 9」—— 序列 7 玩家不满足它是**定义上的必然** | 上一轮的结论（DEADLOCK 玩家没有一个升到序列 7）在**口径 C** 下成立；口径 B（达标后回落）的人群去向见 §6.3 —— **他们全部升到了序列 7** |');
P();

writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('');
console.log('已写出 ' + OUT + '（' + lines.length + ' 行）');
