#!/usr/bin/env node
/**
 * M2.17 任务 A：seed 波动校正 —— M2.15 代码（7bde097）× m217 seed 对照 M2.17 第 0 步的 A 版。
 *
 * 用法：node scripts/m2-17-seed-correction.ts
 *
 * 两批的唯一差别是**被跑的代码版本**：
 *   m215x = M2.15 worktree（.wt-m215，detached 7bde097）
 *   m217a = M2.17 第 0 步的 A 版（4b5d3ec，含 M2.16）
 * 玩家 seed（m217:shard:i）、世界 seed（world）、200 人 × 30 天 × 8 片**完全相同**。
 *
 * 指标口径与 scripts/m2-17-attribution.ts **逐条相同**（同一批 SQL），否则两批不可比。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SHARDS = 8;

interface Row {
  shard: number;
  characters: number;
  initiated: number;
  seq8: number;
  seq7: number;
  play: number;
  explore: number;
  churchActions: number;
}

function readShard(dir: string, prefix: string, shard: number): Row {
  const row: Row = { shard, characters: 0, initiated: 0, seq8: 0, seq7: 0, play: 0, explore: 0, churchActions: 0 };
  const path = join(dir, prefix + '-shard-' + shard + '.db');
  if (!existsSync(path)) return row;
  const db = new DatabaseSync(path, { readOnly: true });
  const one = (sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);
  row.characters = one('SELECT COUNT(*) AS n FROM characters');
  row.initiated = one('SELECT COUNT(*) AS n FROM characters WHERE sequence IS NOT NULL');
  row.seq8 = one('SELECT COUNT(*) AS n FROM characters WHERE sequence = 8');
  row.seq7 = one('SELECT COUNT(*) AS n FROM characters WHERE sequence IS NOT NULL AND sequence <= 7');
  row.play = one("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'dig_delta' AND reason LIKE '%扮演%'");
  row.explore = one("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'ap_delta' AND reason LIKE '%探索%'");
  row.churchActions = one("SELECT COUNT(*) AS n FROM domain_events WHERE type IN ('church_join','church_contribute')");
  db.close();
  return row;
}

const PREFIXES: Array<{ key: string; prefix: string; dir: string; label: string }> = [
  { key: 'm215x', prefix: 'm215x', dir: 'data', label: 'M2.15 代码（7bde097）' },
  { key: 'm217a', prefix: 'm217a', dir: 'data', label: 'M2.17 第 0 步 A 版（4b5d3ec，现状）' },
  { key: 'm217b', prefix: 'm217b', dir: 'data', label: 'M2.17 第 0 步 B 版（M217_CHURCH=off）' },
  { key: 'm217d', prefix: 'm217d', dir: 'data', label: 'M2.17 第 0 步 D 版（M217_CHURCH_DRAIN=on）' },
];

const data = new Map<string, Row[]>();
for (const p of PREFIXES) {
  data.set(p.key, Array.from({ length: SHARDS }, (_, i) => readShard(p.dir, p.prefix, i)));
}

const sum = (rows: Row[], pick: (r: Row) => number): number => rows.reduce((a, r) => a + pick(r), 0);
const rate = (rows: Row[]): number => {
  const base = sum(rows, (r) => r.initiated);
  return base > 0 ? (sum(rows, (r) => r.seq8) / base) * 100 : 0;
};
const per = (rows: Row[], pick: (r: Row) => number): number => sum(rows, pick) / rows.length;
const f1 = (v: number): string => v.toFixed(1);

const out: string[] = [];
const P = (s = ''): void => { out.push(s); };

P('### 汇总（8 片合计）');
P();
P('| 批 | 代码 | 角色 | 入途径 | 序列 8 | **入途径→8** | ≤7 | 8→7（占 8） | 扮演/片 | 探索/片 | 教会动作 |');
P('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const p of PREFIXES) {
  const rows = data.get(p.key)!;
  const initiated = sum(rows, (r) => r.initiated);
  const seq8 = sum(rows, (r) => r.seq8);
  const seq7 = sum(rows, (r) => r.seq7);
  P(`| ${p.key} | ${p.label} | ${sum(rows, (r) => r.characters)} | ${initiated} | ${seq8} | **${f1(rate(rows))}%** | ${seq7} | ${seq8 > 0 ? f1((seq7 / seq8) * 100) : '-'}% | ${f1(per(rows, (r) => r.play))} | ${f1(per(rows, (r) => r.explore))} | ${sum(rows, (r) => r.churchActions)} |`);
}
P();
P('### 差（m215x − m217a）');
P();
const a = data.get('m215x')!;
const b = data.get('m217a')!;
const bOff = data.get('m217b')!;
P(`- 入途径→8（对 A 版）：**${f1(rate(a))}% − ${f1(rate(b))}% = ${f1(rate(a) - rate(b))} pp**`);
P(`- 入途径→8（对 B 版＝关教会行为）：**${f1(rate(a))}% − ${f1(rate(bOff))}% = ${f1(rate(a) - rate(bOff))} pp**`);
P(`- 入途径：${sum(a, (r) => r.initiated)} − ${sum(b, (r) => r.initiated)} = ${sum(a, (r) => r.initiated) - sum(b, (r) => r.initiated)}`);
P(`- 序列 8：${sum(a, (r) => r.seq8)} − ${sum(b, (r) => r.seq8)} = ${sum(a, (r) => r.seq8) - sum(b, (r) => r.seq8)}`);
P();
P('### 逐片：入途径 → 8');
P();
P('| 批 | 片0 | 片1 | 片2 | 片3 | 片4 | 片5 | 片6 | 片7 |');
P('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const p of PREFIXES) {
  const rows = data.get(p.key)!;
  P(`| ${p.key} | ${rows.map((r) => (r.initiated > 0 ? f1((r.seq8 / r.initiated) * 100) : '0.0') + '%').join(' | ')} |`);
}
P();
P('| 批 | 片0 | 片1 | 片2 | 片3 | 片4 | 片5 | 片6 | 片7 |');
P('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
P(`| m215x 入途径 | ${a.map((r) => r.initiated).join(' | ')} |`);
P(`| m217a 入途径 | ${b.map((r) => r.initiated).join(' | ')} |`);
P(`| m215x 序列8 | ${a.map((r) => r.seq8).join(' | ')} |`);
P(`| m217a 序列8 | ${b.map((r) => r.seq8).join(' | ')} |`);
P();
P('### 逐片：扮演量（动作挤占的载体）');
P();
P('| 批 | 片0 | 片1 | 片2 | 片3 | 片4 | 片5 | 片6 | 片7 | 均值 |');
P('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const p of PREFIXES) {
  const rows = data.get(p.key)!;
  P(`| ${p.key} | ${rows.map((r) => r.play).join(' | ')} | ${f1(per(rows, (r) => r.play))} |`);
}
P();
P('### 逐片：教会动作（M2.15 代码应当恒为 0）');
P();
P(`- m215x：${a.map((r) => r.churchActions).join(' / ')}（合计 ${sum(a, (r) => r.churchActions)}）`);
P(`- m217a：${b.map((r) => r.churchActions).join(' / ')}（合计 ${sum(b, (r) => r.churchActions)}）`);
P();
P('### 原始 JSON');
P();
P('```json');
P(JSON.stringify({ m215x: a, m217a: b }, null, 2));
P('```');

console.log(out.join('\n'));
