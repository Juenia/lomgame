#! /usr/bin/env node
/**
 * M2.18 · 批次取数（**主表**）。
 *
 * 四层：
 *   1. 主链路：入途径 / 序列 8 / 8→7（主验收线 ≥ 25）+ 材料齐人数（E1 的效果层）
 *   2. church_taboo_violation 按 tabooId（看 no_striking_mortal 有没有落）
 *   3. 动作量（总 / 探索 / 挑战 / 扮演 / 交易 / 队伍）—— 分层对照
 *
 * 用法（**换批次号不需要改代码**）：
 *   node scripts/m2-18-m220-report.ts --batches m219c,m220a
 *   node scripts/m2-18-m220-report.ts --batches m220a,m221a --shards 8
 *
 * 约定：**第一个是上一轮（对照），最后一个是本轮（主批）** ——
 * 差值段与动作量段一律从这一个数组派生，脚本里不再有第二个批次来源
 * （铁律 10：报告脚本与产物一起改；铁律 11：数字只有一个出处）。
 *
 * 数据来源两处，各有各的边界（不是「同一份数据用两种读法」，是两种产物各自的家）：
 *   · 主链路 / 材料 / 教义 -> data/<批>-shard-<i>.db（SQLite）
 *   · 动作量                -> docs/<批>-shard<i>-行为日志.jsonl（vplayer 落的行为日志）
 * 后者缺文件时**会报出来**（换了批次号之后最容易踩的就是这个：静默全 0 看起来像「没动作」）。
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadContent } from '../src/data/loader.ts';

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const index = argv.indexOf('--' + name);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
};
const BATCHES = argOf('batches', 'm219c,m220a')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
const SHARDS = Number(argOf('shards', '8'));
if (BATCHES.length === 0) {
  console.error('至少要给一个批次号：--batches m219c,m220a');
  process.exit(2);
}
const BASE = BATCHES[0]!;
const MAIN = BATCHES[BATCHES.length - 1]!;

const content = loadContent();

interface Row { chars: number; initiated: number; seq8: number; seq7: number; matReady: number; missing1: number }
const data: Record<string, Row> = {};
const tabooById: Record<string, Map<string, number>> = {};
interface Acts { total: number; explore: number; challenge: number; play: number; trade: number; party: number }
const actData: Record<string, Acts> = {};
const missingLogs: string[] = [];
const missingShards: string[] = [];

for (const prefix of BATCHES) {
  const row: Row = { chars: 0, initiated: 0, seq8: 0, seq7: 0, matReady: 0, missing1: 0 };
  const byTaboo = new Map<string, number>();
  let opened = 0;
  for (let i = 0; i < SHARDS; i += 1) {
    let db: DatabaseSync;
    try { db = new DatabaseSync('data/' + prefix + '-shard-' + i + '.db', { readOnly: true }); } catch {
      missingShards.push(prefix + '-' + i);
      continue;
    }
    opened += 1;
    const one = (sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);
    row.chars += one('SELECT COUNT(*) AS n FROM characters');
    row.initiated += one('SELECT COUNT(*) AS n FROM characters WHERE sequence IS NOT NULL');
    row.seq8 += one('SELECT COUNT(*) AS n FROM characters WHERE sequence = 8');
    row.seq7 += one('SELECT COUNT(*) AS n FROM characters WHERE sequence IS NOT NULL AND sequence <= 7');
    const violations = db.prepare("SELECT payload FROM domain_events WHERE type = 'church_taboo_violation'").all() as unknown as Array<{ payload: string }>;
    for (const v of violations) {
      let id = '?';
      try { id = String((JSON.parse(v.payload) as { tabooId?: string }).tabooId ?? '?'); } catch { /* keep */ }
      byTaboo.set(id, (byTaboo.get(id) ?? 0) + 1);
    }
    // 材料齐人数：序列 8 里「本途径 8→7 配方的主材料 × 2 都够」的人（期末持有量口径）
    const seq8Rows = db.prepare('SELECT id, pathway FROM characters WHERE sequence = 8').all() as unknown as Array<{ id: string; pathway: string }>;
    for (const c of seq8Rows) {
      const recipe = content.recipes.find((r) => r.pathway === c.pathway && r.seq === 8);
      if (!recipe) continue;
      let missing = 0;
      for (const need of recipe.main) {
        const owned = Number((db.prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM inventory WHERE character_id = ? AND item_id = ?').get(c.id, need.itemId) as { n: number }).n);
        if (owned < need.qty * NUMERIC.promotion.mainMaterialMultiplier) missing += 1;
      }
      if (missing === 0) row.matReady += 1;
      else if (missing === 1) row.missing1 += 1;
    }
    db.close();
  }
  if (opened === 0) {
    console.error('批次 ' + prefix + ' 一个分片都没打开（data/' + prefix + '-shard-0.db 不存在？）—— 先确认批次号。');
    process.exit(2);
  }
  data[prefix] = row;
  tabooById[prefix] = byTaboo;
}

console.log('=== 1/2 主链路 + 材料（' + SHARDS + ' 片合计）===');
console.log('| 批 | 建号 | 入途径 | 序列 8 | **8→7** | 材料齐 | 只缺 1 种 |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const prefix of BATCHES) {
  const r = data[prefix]!;
  console.log('| ' + prefix + ' | ' + r.chars + ' | ' + r.initiated + ' | ' + r.seq8 + ' | **' + r.seq7 + '** | ' + r.matReady + ' | ' + r.missing1 + ' |');
}
if (BATCHES.length >= 2) {
  const a = data[BASE]!, b = data[MAIN]!;
  console.log('');
  console.log('差值（' + BASE + ' → ' + MAIN + '）：8→7 ' + (b.seq7 - a.seq7) + '（' + a.seq7 + ' → ' + b.seq7 + '，验收线 25）');
  console.log('                    材料齐 ' + (b.matReady - a.matReady) + '（' + a.matReady + ' → ' + b.matReady + '）');
}

console.log('');
console.log('=== 3 教义违反（按判据）===');
for (const prefix of BATCHES) {
  const m = tabooById[prefix]!;
  const total = [...m.values()].reduce((x, y) => x + y, 0);
  console.log('  ' + prefix + '：合计 ' + total + ' —— ' + ([...m.entries()].sort((x, y) => y[1] - x[1]).map(([k, n]) => k + '=' + n).join('、') || '（无）'));
}

console.log('');
console.log('=== 4 动作量（分层）===');
for (const prefix of BATCHES) {
  const c: Acts = { total: 0, explore: 0, challenge: 0, play: 0, trade: 0, party: 0 };
  for (let i = 0; i < SHARDS; i += 1) {
    let text = '';
    const file = 'docs/' + prefix + '-shard' + i + '-行为日志.jsonl';
    try { text = readFileSync(file, 'utf8'); } catch { missingLogs.push(file); continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let rec: { command?: string };
      try { rec = JSON.parse(line) as { command?: string }; } catch { continue; }
      c.total += 1;
      const cmd = String(rec.command ?? '');
      if (cmd.startsWith('.探索')) c.explore += 1;
      else if (cmd.startsWith('.挑战')) c.challenge += 1;
      else if (cmd.startsWith('.扮演')) c.play += 1;
      else if (cmd.startsWith('.交易')) c.trade += 1;
      else if (cmd.startsWith('.队伍')) c.party += 1;
    }
  }
  actData[prefix] = c;
}
const line = (label: string, pick: (acts: Acts) => number): string => {
  const cells = BATCHES.map((prefix) => prefix + '=' + String(pick(actData[prefix]!)).padStart(6));
  const first = pick(actData[BASE]!);
  const last = pick(actData[MAIN]!);
  const diff = first === 0 ? '—' : (((last - first) / first) * 100).toFixed(1) + '%';
  return '  ' + label.padEnd(10) + ' ' + cells.join('  ') + '  差 ' + diff;
};
console.log(line('总动作', (a) => a.total));
console.log(line('.探索', (a) => a.explore));
console.log(line('.挑战', (a) => a.challenge));
console.log(line('.扮演', (a) => a.play));
console.log(line('.交易', (a) => a.trade));
console.log(line('.队伍', (a) => a.party));

if (missingLogs.length > 0) {
  console.log('');
  console.log('⚠️ 以下行为日志不存在（动作量对应的分片按 0 计）：' + missingLogs.join('、'));
}
if (missingShards.length > 0) {
  console.log('');
  console.log('⚠️ 以下分片库不存在（主链路对应的分片按 0 计）：' + missingShards.join('、'));
}
