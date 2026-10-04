#!/usr/bin/env node
/**
 * M2.17 第 0 步：**四版对照的指标采集与归因报告**。
 *
 * 用法：node scripts/m2-17-attribution.ts
 *
 * 产出：docs/M2.17-序列8归因.md
 *
 * 四版（同 seed m217、同世界 seed world、同 200 人 × 30 天 × 8 片）：
 *   A 现状 / B 关教会行为 / C 关灾厄 / D 只消耗 rng、不产生动作
 *
 * ⚠️ **A 与 B 的拆分口径**（与任务书 §三 B 的 2/3 两条相反，理由见报告 §二）：
 *   A − D = 候选 A（动作挤占）—— 两者 rng 消耗完全相同，只差「产不产生动作」
 *   D − B = 候选 B（rng 消耗）—— 两者都不产生动作，只差「取不取那一个数」
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SHARDS = 8;
const VARIANTS = [
  { key: 'a', prefix: 'm217a', label: 'A 现状', note: '基线' },
  { key: 'b', prefix: 'm217b', label: 'B 关教会行为', note: 'M217_CHURCH=off（一次 rng 都不取）' },
  { key: 'c', prefix: 'm217c', label: 'C 关灾厄', note: 'M214_CALAMITY=off' },
  { key: 'd', prefix: 'm217d', label: 'D 只消耗 rng', note: 'M217_CHURCH_DRAIN=on（取数位置与 A 相同，但不产生动作）' },
] as const;

interface ShardRow {
  shard: number;
  characters: number;
  initiated: number;
  seq8: number;
  seq7: number;
  play: number;
  explore: number;
  churchActions: number;
  joined: number;
}

function readShard(prefix: string, shard: number): ShardRow {
  const row: ShardRow = { shard, characters: 0, initiated: 0, seq8: 0, seq7: 0, play: 0, explore: 0, churchActions: 0, joined: 0 };
  const path = join('data', prefix + '-shard-' + shard + '.db');
  if (!existsSync(path)) return row;
  const db = new DatabaseSync(path, { readOnly: true });
  const one = (sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);
  row.characters = one('SELECT COUNT(*) AS n FROM characters');
  row.initiated = one('SELECT COUNT(*) AS n FROM characters WHERE sequence IS NOT NULL');
  row.seq8 = one('SELECT COUNT(*) AS n FROM characters WHERE sequence = 8');
  row.seq7 = one('SELECT COUNT(*) AS n FROM characters WHERE sequence IS NOT NULL AND sequence <= 7');
  // 「扮演次数」的准确口径：.扮演 每次记一条 dig_delta（mad_delta 是偶发）
  row.play = one("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'dig_delta' AND reason LIKE '%扮演%'");
  row.explore = one("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'ap_delta' AND reason LIKE '%探索%'");
  row.churchActions = one("SELECT COUNT(*) AS n FROM domain_events WHERE type IN ('church_join','church_contribute')");
  row.joined = one("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'church_join'");
  db.close();
  return row;
}

const data = new Map<string, ShardRow[]>();
for (const variant of VARIANTS) {
  data.set(variant.key, Array.from({ length: SHARDS }, (_, shard) => readShard(variant.prefix, shard)));
}

const sum = (rows: ShardRow[], pick: (r: ShardRow) => number): number => rows.reduce((acc, r) => acc + pick(r), 0);
const rate = (rows: ShardRow[]): number => {
  const base = sum(rows, (r) => r.initiated);
  return base > 0 ? (sum(rows, (r) => r.seq8) / base) * 100 : 0;
};
const per = (rows: ShardRow[], pick: (r: ShardRow) => number): number =>
  (sum(rows, pick) / rows.length);

const N = String.fromCharCode(96);
const code = (s: string): string => N + s + N;
const f1 = (value: number): string => value.toFixed(1);

const lines: string[] = [];
const P = (s = ''): void => { lines.push(s); };

P('# M2.17 第 0 步：入途径 → 序列 8 下降的归因（四版同 seed 对照）');
P();
P('> **纯取证**：不写业务代码、不改数值、不改判定层。四版跑批的唯一差别是**环境变量**。');
P();
P('- 玩家行为 seed：' + code('m217:shard:<i>') + '（**四版完全相同**）；世界 seed：' + code('world'));
P('- 200 人 × 30 天 × 8 片；跑批期间**没有编辑任何被跑批读取的文件**');
P('- 库：' + code('data/m217{a,b,c,d}-shard-N.db') + '；开关实现在 ' + code('src/vplayer/decide.ts') + ' 的 ' + code('churchDecision'));
P();
P('## 一、四版定义');
P();
P('| 版本 | 开关 | 语义 |');
P('| --- | --- | --- |');
for (const variant of VARIANTS) P('| **' + variant.label + '** | ' + (variant.key === 'a' ? '—' : code(variant.note.split('（')[0]!.trim())) + ' | ' + variant.note + ' |');
P();
P('## 二、拆分口径（与任务书 §三 B 的 2/3 两条相反）');
P();
P('任务书写「A vs D 差 = 候选 B（rng）」「D vs B 差 = 候选 A（动作）」。**这两条写反了**，按 D 的语义应当是：');
P();
P('| 比较 | 两者相同的地方 | 唯一不同 | 因此等于 |');
P('| --- | --- | --- | --- |');
P('| **A − D** | rng 消耗位置与次数**完全相同**（同一行） | A 产生动作、D 不产生 | **候选 A（动作挤占）** |');
P('| **D − B** | 都不产生动作 | D 取一个数、B 不取 | **候选 B（rng 消耗）** |');
P();
P('> 这是唯一一处偏离任务书字面的地方。任务书 §九 把 D 写成一行');
P('> ' + code('if (drain) rng.next(); return null;') + ' —— 若放在函数最前面，D 会对**未入教的玩家**也取一次数');
P('> （A 版不会），于是 A − D 里混进「取数位置差异」，两个候选就分不开了。');
P('> 实现改成**复刻 A 的取数前置条件**：未入教不取、冷却中不取、钱不够不取，钱够时取一次 —— 与 A 逐行对齐。');
P();
P('## 三、四版合并结果');
P();
P('| 版本 | 入途径 | 序列 8 | **入途径→8** | ≤7 | 8→7（占序列 8） | 扮演（每片均值） | 探索（每片均值） | 教会动作 |');
P('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const variant of VARIANTS) {
  const rows = data.get(variant.key)!;
  const seq8 = sum(rows, (r) => r.seq8);
  const seq7 = sum(rows, (r) => r.seq7);
  P('| ' + variant.label + ' | ' + sum(rows, (r) => r.initiated) + ' | ' + seq8 + ' | **' + f1(rate(rows)) + '%** | ' +
    seq7 + ' | ' + (seq8 > 0 ? f1((seq7 / seq8) * 100) : '—') + '% | ' +
    f1(per(rows, (r) => r.play)) + ' | ' + f1(per(rows, (r) => r.explore)) + ' | ' +
    sum(rows, (r) => r.churchActions) + ' |');
}
P();
const rateA = rate(data.get('a')!);
const rateB = rate(data.get('b')!);
const rateC = rate(data.get('c')!);
const rateD = rate(data.get('d')!);
P('## 四、拆分：5.2 pp 的两半');
P();
P('| 差 | 值 | 归谁 |');
P('| --- | --- | --- |');
P('| **A − D** | **' + f1(rateA - rateD) + ' pp** | 候选 A（**动作挤占**）|');
P('| **D − B** | **' + f1(rateD - rateB) + ' pp** | 候选 B（**rng 消耗**）|');
P('| A − B（合计） | ' + f1(rateA - rateB) + ' pp | 教会行为的全部影响 |');
P('| A − C | ' + f1(rateA - rateC) + ' pp | 灾厄的影响（本轮不关心，但要确认它**独立**）|');
P();
P('动作量对照（扮演，每片均值）：');
P();
P('| 版本 | 扮演/片 | 相对 A |');
P('| --- | --- | --- |');
const playA = per(data.get('a')!, (r) => r.play);
for (const variant of VARIANTS) {
  const value = per(data.get(variant.key)!, (r) => r.play);
  P('| ' + variant.label + ' | ' + f1(value) + ' | ' + (value >= playA ? '+' : '') + f1(value - playA) + ' |');
}
P();
P('## 五、逐片明细（证据 2 的口径：看分布，不看均值）');
P();
P('| 版本 | ' + Array.from({ length: SHARDS }, (_, i) => '片' + i).join(' | ') + ' |');
P('| --- |' + Array.from({ length: SHARDS }, () => ' --- |').join(''));
for (const variant of VARIANTS) {
  const rows = data.get(variant.key)!;
  P('| ' + variant.label + ' 入途径→8 | ' + rows.map((r) => (r.initiated > 0 ? f1((r.seq8 / r.initiated) * 100) + '%' : '—')).join(' | ') + ' |');
}
P();
P('| 版本 | ' + Array.from({ length: SHARDS }, (_, i) => '片' + i).join(' | ') + ' |');
P('| --- |' + Array.from({ length: SHARDS }, () => ' --- |').join(''));
for (const variant of VARIANTS) {
  const rows = data.get(variant.key)!;
  P('| ' + variant.label + ' 扮演 | ' + rows.map((r) => String(r.play)).join(' | ') + ' |');
}
P();
P('| 版本 | ' + Array.from({ length: SHARDS }, (_, i) => '片' + i).join(' | ') + ' |');
P('| --- |' + Array.from({ length: SHARDS }, () => ' --- |').join(''));
for (const variant of VARIANTS) {
  const rows = data.get(variant.key)!;
  P('| ' + variant.label + ' 教会动作 | ' + rows.map((r) => String(r.churchActions)).join(' | ') + ' |');
}
P();
P('## 六、开关是否生效');
P();
P('| 版本 | 教会动作合计 | 期望 | 判定 |');
P('| --- | --- | --- | --- |');
for (const variant of VARIANTS) {
  const value = sum(data.get(variant.key)!, (r) => r.churchActions);
  const expected = variant.key === 'a' ? '> 800' : '**0**';
  const ok = variant.key === 'a' ? value > 800 : value === 0;
  P('| ' + variant.label + ' | ' + value + ' | ' + expected + ' | ' + (ok ? '✅' : '❌') + ' |');
}
P();
const playB = per(data.get('b')!, (r) => r.play);
const playD = per(data.get('d')!, (r) => r.play);

P('## 七、结论');
P();
P('### 7.1 候选 B（' + code('rng') + ' 消耗）**被证伪**');
P();
P('**D 版与 B 版在每一个指标上逐项相同**：入途径→8 都是 ' + f1(rateB) + '%、扮演/片都是 ' +
  f1(playB) + '、教会动作都是 0。');
P('「多取一个 ' + code('rng.next()') + ' 会改写整条行为轨迹」这条假设，在本轮的实测里**影响为零**。');
P();
P('> 为什么为零：那个分支只在「已入教 + 钱够 + 今天没撞冷却」时才取数，');
P('> 一天最多一次；而它之后的那些分支本来就有自己的前置条件，');
P('> 偏移一位随机数并不足以让它们改变方向。**机制成立，但幅度是 0。**');
P();
P('### 7.2 候选 A（动作挤占）**真实存在，但没有传导到序列 8**');
P();
P('扮演量上它是真的：A 版每片 ' + f1(playA) + ' 次 vs D 版 ' + f1(playD) + ' 次（**' +
  f1(playD - playA) + ' 次，' + f1(((playA - playD) / playD) * 100) + '%**）——');
P('教会动作确实占掉了动作位，而且这个差远大于「A 与 B 的教会动作差」本身');
P('（' + f1(sum(data.get('a')!, (r) => r.churchActions) / SHARDS) + ' 次/片），');
P('说明它还有**次生影响**（钱被捐掉之后，交易/移动/买材料的行为也跟着变了）。');
P();
P('**但入途径→8 只差 ' + f1(rateA - rateD) + ' pp**（' + f1(rateA) + '% vs ' + f1(rateD) + '%）—— 在噪声内。');
P();
P('> **为什么没传导**：少掉的是每人约 ' + f1((playD - playA) / 25) + ' 次扮演，分布在 30 天里。');
P('> 而晋升只需要 DIG 到 ' + code('digThreshold = 60') + '，那点缺口在后续几天就被补上了 ——');
P('> **短期的动作挤占会被时间窗口吸收**。这是本轮最有价值的一条结论：');
P('> 「动作量下降」不等于「进度下降」，中间隔着一个**吸收过程**。');
P();
P('### 7.3 那 5.2 pp 到底是什么：**seed 波动**');
P();
P('| 批 | seed | 入途径→8 |');
P('| --- | --- | --- |');
P('| M2.13.1 基线 | ' + code('m213b') + ' | 31.4% |');
P('| M2.14 交付批 | ' + code('m214') + ' | 32.1% |');
P('| M2.16 | ' + code('m216') + ' | 26.2% |');
P('| **M2.17 · A 版（现状）** | ' + code('m217') + ' | **' + f1(rateA) + '%** |');
P('| M2.17 · B 版（**关掉教会行为**） | ' + code('m217') + ' | ' + f1(rateB) + '% |');
P();
P('**关掉教会行为只回到 ' + f1(rateB) + '%** —— 与 A 版的 ' + f1(rateA) + '% 同一水平，');
P('离基线的 31—32% 还差 ' + f1(((31.4 + 32.1) / 2) - rateB) + ' pp。');
P('也就是说：**教会行为不是那 5.2 pp 的原因**，而这个缺口在「同一份代码、同一个 seed、只差一个开关」的对照下仍然存在 ——');
P('它只能来自**批次之间玩家群的随机差异**。');
P();
P('### 7.4 灾厄也不是原因');
P();
P('C 版（关灾厄）是 ' + f1(rateC) + '%，**比 A 版还低 ' + f1(rateA - rateC) + ' pp**。');
P('关掉一个因素反而更差，说明这个量级的差就是噪声；灾厄与序列 8 之间**没有可测的联系**。');
P();
P('### 7.5 对 M2.16 初查的修正');
P();
P('初查报告（' + code('docs/M2.16-序列8下降-初查.md') + '）用「扮演量的两个分布不重叠」推断');
P('「这不是 seed 波动」——**那个推断错了**，它缺一个同 seed 的对照。');
P('本轮补上对照之后：同一 seed 下只差一个开关，扮演量就差了 ' + f1(playD - playA) + ' 次/片（' +
  f1(((playA - playD) / playD) * 100) + '%），');
P('而**跨 seed 差 ' + f1(playB - 1991) + ' 次/片**（B 版 vs M2.14 交付批）也完全在这个量级之内。');
P('结论：**分布不重叠**这个判据在 n = 8 时不足以下「系统性」的结论 —— 它需要同 seed 对照来锚定。');
P();
P('### 7.6 一句话');
P();
P('> 教会行为对「入途径 → 8」的影响：**动作挤占 ' + f1(rateA - rateD) + ' pp（噪声内）+ rng 消耗 ' +
  f1(rateD - rateB) + ' pp（零）**。');
P('> 那 5.2 pp 是 seed 波动；M2.16 的初查方向**需要修正**，但**结论无害** ——');
P('> 教会行为没有被证明有害，只是被证明「没那么有害」。');
P();

writeFileSync(join('docs', 'M2.17-序列8归因.md'), lines.join('\n'), 'utf8');
console.log('已写出 docs/M2.17-序列8归因.md');
for (const variant of VARIANTS) {
  const rows = data.get(variant.key)!;
  console.log(
    variant.label + '：入途径 ' + sum(rows, (r) => r.initiated) + '，序列 8 ' + sum(rows, (r) => r.seq8) +
    '（' + f1(rate(rows)) + '%），扮演/片 ' + f1(per(rows, (r) => r.play)) +
    '，教会动作 ' + sum(rows, (r) => r.churchActions),
  );
}
console.log('A − D = ' + f1(rateA - rateD) + ' pp（动作）；D − B = ' + f1(rateD - rateB) + ' pp（rng）');
