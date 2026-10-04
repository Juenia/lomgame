/**
 * M2.9 战斗覆盖报告（4 分片 200×14）。
 *
 * 用法：node scripts/m29-battle-report.ts [片数]（默认 4）
 *
 * 报告要回答的是**「同一场战斗两次不一样」这条硬指标**（任务书 §五）：
 * 三个维度（回合数 / 生物行为 / 战斗结果）的分布都必须散开 ——
 * 如果三个都是单点（8 回合 100%、攻击 100%、胜 100%），那说明战斗是伪随机的。
 * 所以本脚本除了列表，还会显式算一个「是不是单点」的判定。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../src/infra/db/sqlite.ts';
import { BattleRepo } from '../src/infra/db/battles.ts';
import { CreatureRepo } from '../src/infra/db/creatures.ts';

const SHARDS = Number(process.argv[2] ?? 4);
const OUT = process.argv[3] ?? join('docs', 'M2.9-战斗覆盖.md');

interface Totals {
  battles: number;
  rounds: number;
  status: Map<string, number>;
  roundDist: Map<number, number>;
  playerActions: Map<string, number>;
  creatureActions: Map<string, number>;
  flags: Map<string, number>;
  statuses: Map<string, number>;
  bySpecies: Map<string, number>;
  ecosystem: Map<string, number>;
  creaturesAlive: number;
  evolved: number;
}

function add(target: Map<string, number>, source: Map<string, number>): void {
  for (const [key, value] of source) target.set(key, (target.get(key) ?? 0) + value);
}

function collect(): Totals {
  const totals: Totals = {
    battles: 0,
    rounds: 0,
    status: new Map(),
    roundDist: new Map(),
    playerActions: new Map(),
    creatureActions: new Map(),
    flags: new Map(),
    statuses: new Map(),
    bySpecies: new Map(),
    ecosystem: new Map(),
    creaturesAlive: 0,
    evolved: 0,
  };
  for (let index = 0; index < SHARDS; index += 1) {
    const path = join('data', 'm29-shard-' + index + '.db');
    let db;
    try {
      db = openDatabase(path);
    } catch {
      continue;
    }
    const battles = new BattleRepo(db);
    const creatures = new CreatureRepo(db);
    totals.battles += battles.count();
    totals.rounds += battles.countRounds();
    add(totals.status, battles.statusDistribution());
    add(totals.playerActions, battles.playerActionDistribution());
    add(totals.creatureActions, battles.creatureActionDistribution());
    add(totals.flags, battles.flagTotals());
    // ⚠️ 用 statusTriggerTotals（从回合记录数**触发次数**），
    //    不是 statusApplyDistribution（那只看得见战斗结束时的残留状态，
    //    会把「第 2 回合挂上、第 5 回合到期」的状态全部漏掉）
    add(totals.statuses, battles.statusTriggerTotals());
    add(totals.ecosystem, creatures.tickTotals());
    for (const [rounds, count] of battles.roundCountDistribution()) {
      totals.roundDist.set(rounds, (totals.roundDist.get(rounds) ?? 0) + count);
    }
    for (const summary of battles.summaries()) {
      totals.bySpecies.set(summary.speciesId, (totals.bySpecies.get(summary.speciesId) ?? 0) + 1);
    }
    totals.evolved += battles.evolvedInBattle();
    totals.creaturesAlive += creatures.count();
    db.close();
  }
  return totals;
}

function rows(entries: Array<[string | number, number]>): string {
  if (entries.length === 0) return '（无数据）';
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => '| ' + key + ' | ' + value + ' | ' + ((value / total) * 100).toFixed(1) + '% |')
    .join('\n');
}

const t = collect();
const avgRounds = t.battles > 0 ? (t.rounds / t.battles).toFixed(2) : '0';
const dims = {
  rounds: t.roundDist.size,
  creature: t.creatureActions.size,
  outcome: [...t.status.keys()].filter((key) => key !== 'active').length,
};
const passed = dims.rounds >= 3 && dims.creature >= 3 && dims.outcome >= 2;

const lines: string[] = [];
lines.push('# M2.9 战斗覆盖（200×14，4 分片）');
lines.push('');
lines.push('> 数据来源：' + SHARDS + ' 个分片库（data/m29-shard-0.db … data/m29-shard-' + (SHARDS - 1) + '.db）。');
lines.push('> 口径：每一场战斗落一行 battles，每一个回合落一行 battle_rounds（带 seed）。');
lines.push('');
lines.push('## 一、战斗总览');
lines.push('');
lines.push('| 指标 | 值 |');
lines.push('| --- | --- |');
lines.push('| 战斗场次 | ' + t.battles + ' |');
lines.push('| 总回合数 | ' + t.rounds + ' |');
lines.push('| 平均回合数 | ' + avgRounds + ' |');
lines.push('| 战斗里进化过的生物 | ' + t.evolved + ' |');
lines.push('| 跑批结束时的世界现存生物 | ' + t.creaturesAlive + ' |');
lines.push('');
lines.push('## 二、战斗结果分布（维度三）');
lines.push('');
lines.push('| 结局 | 场次 | 占比 |');
lines.push('| --- | --- | --- |');
lines.push(rows([...t.status.entries()]));
lines.push('');
lines.push('## 三、回合数分布（维度一：**同一场战斗两次不一样**）');
lines.push('');
lines.push('| 打了几个回合 | 场次 | 占比 |');
lines.push('| --- | --- | --- |');
lines.push(rows([...t.roundDist.entries()]));
lines.push('');
lines.push('## 四、玩家动作分布');
lines.push('');
lines.push('| 动作 | 次数 | 占比 |');
lines.push('| --- | --- | --- |');
lines.push(rows([...t.playerActions.entries()]));
lines.push('');
lines.push('## 五、生物行为分布（维度二：**同一场战斗两次不一样**）');
lines.push('');
lines.push('| 行为 | 次数 | 占比 |');
lines.push('| --- | --- | --- |');
lines.push(rows([...t.creatureActions.entries()]));
lines.push('');
lines.push('## 六、状态触发分布');
lines.push('');
lines.push('| 状态 | 被挂上过的次数 |');
lines.push('| --- | --- |');
lines.push([...t.statuses.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => '| ' + k + ' | ' + v + ' |').join('\n') || '（无）');
lines.push('');
lines.push('> 口径：统计的是**触发次数**（来自 battle_rounds 的 result_json.appliedStatuses），');
lines.push('> 不是终局残留 —— 一个第 2 回合挂上、第 5 回合到期的「恐惧」，');
lines.push('> 在战斗结束时早就不在 battles.status_json 里了，用它统计会得出「0 次」的假结论。');
lines.push('');
lines.push('## 七、回合内的可统计事件');
lines.push('');
lines.push('| 事件 | 次数 |');
lines.push('| --- | --- |');
lines.push([...t.flags.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => '| ' + k + ' | ' + v + ' |').join('\n') || '（无）');
lines.push('');
lines.push('## 八、战斗对手分布');
lines.push('');
lines.push('| 物种 | 场次 |');
lines.push('| --- | --- |');
lines.push([...t.bySpecies.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => '| ' + k + ' | ' + v + ' |').join('\n'));
lines.push('');
lines.push('## 九、生态 tick（世界自己做了什么）');
lines.push('');
lines.push('| 行为 | 次数 |');
lines.push('| --- | --- |');
for (const key of ['migrate', 'feed', 'evolve', 'birth', 'replenish', 'death']) {
  lines.push('| ' + key + ' | ' + (t.ecosystem.get(key) ?? 0) + ' |');
}
lines.push('');
lines.push('> replenish 是 M2.9 前置 1 的**世界补充**（任务书 §一）—— 它与繁衍是两条不同的流：');
lines.push('> 繁衍是生物自己生，补充是**世界**往空下来的地点放一只。混在一起就回答不了「补充到底有没有生效」。');
lines.push('');
lines.push('## 十、验收判定：三个维度都散开了吗');
lines.push('');
lines.push('| 维度 | 不同取值的个数 | 判定 |');
lines.push('| --- | --- | --- |');
lines.push('| 回合数 | ' + dims.rounds + ' | ' + (dims.rounds >= 3 ? '散开' : '**单点（伪随机）**') + ' |');
lines.push('| 生物行为 | ' + dims.creature + ' | ' + (dims.creature >= 3 ? '散开' : '**单点（伪随机）**') + ' |');
lines.push('| 战斗结果 | ' + dims.outcome + ' | ' + (dims.outcome >= 2 ? '散开' : '**单点（伪随机）**') + ' |');
lines.push('');
lines.push(
  passed
    ? '**结论：三个维度都不止一个取值 —— 「同一场战斗两次不一样」成立。**'
    : '**结论：有维度退化成了单点，战斗是伪随机的，必须查清原因。**',
);
lines.push('');

writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('已写出 ' + OUT);
