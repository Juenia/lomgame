#!/usr/bin/env node
/**
 * M2.17 任务 A 的**事件级**一致性验证：M2.15 代码（m215x）与「M2.17 代码＋关掉教会行为」（m217b）
 * 是否产生了**同一串域事件**。
 *
 * 口径：每条事件取 (character_id, type, reason, seed, payload)，按字典序排序后拼串做 sha256。
 * 排除 id 与 created_at —— 前者是自增行号（受迁移/写入批次影响），后者是**真实时钟**（不是判定的一部分）。
 * 保留 seed 列：M2.16 的约定是「新事件类型显式 seed=null」，这里是它是否被写进库的实证。
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SHARDS = 8;
const BATCHES = [
  { key: 'm215x', dir: 'data', label: 'M2.15 代码（无教会系统）' },
  { key: 'm217b', dir: 'data', label: 'M2.17 代码 + M217_CHURCH=off' },
  { key: 'm217d', dir: 'data', label: 'M2.17 代码 + M217_CHURCH_DRAIN=on' },
  { key: 'm217a', dir: 'data', label: 'M2.17 代码（现状）' },
] as const;

interface Row { character_id: string | null; type: string; reason: string | null; seed: string | null; payload: string | null }

function digest(dir: string, prefix: string, shard: number): { n: number; hash: string } {
  const path = join(dir, prefix + '-shard-' + shard + '.db');
  if (!existsSync(path)) return { n: -1, hash: '（无库）' };
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db.prepare('SELECT character_id, type, reason, seed, payload FROM domain_events').all() as unknown as Row[];
  db.close();
  const keys = rows.map((r) => [r.character_id ?? '', r.type, r.reason ?? '', r.seed ?? '', r.payload ?? ''].join('\u0001')).sort();
  return { n: rows.length, hash: createHash('sha256').update(keys.join('\u0002')).digest('hex').slice(0, 16) };
}

const out: string[] = [];
out.push('| 批 | ' + Array.from({ length: SHARDS }, (_, i) => '片' + i).join(' | ') + ' |');
out.push('| --- |' + Array.from({ length: SHARDS }, () => ' --- |').join(''));
for (const b of BATCHES) {
  const cells = Array.from({ length: SHARDS }, (_, i) => {
    const d = digest(b.dir, b.key, i);
    return d.hash + '（' + d.n + '）';
  });
  out.push('| ' + b.key + ' | ' + cells.join(' | ') + ' |');
}
out.push('');
out.push('### 事件条数与摘要（逐片）');
out.push('');
out.push('| 批 | ' + Array.from({ length: SHARDS }, (_, i) => '片' + i).join(' | ') + ' | 合计 |');
out.push('| --- |' + Array.from({ length: SHARDS }, () => ' --- |').join('') + ' --- |');
for (const b of BATCHES) {
  const ds = Array.from({ length: SHARDS }, (_, i) => digest(b.dir, b.key, i));
  out.push('| ' + b.key + ' | ' + ds.map((d) => String(d.n)).join(' | ') + ' | ' + ds.reduce((a, d) => a + Math.max(d.n, 0), 0) + ' |');
}
console.log(out.join('\n'));
