#! /usr/bin/env node
/**
 * 批次逐条比对（M2.21 任务 1 的配套工具，跑批手册 §5.3 引用）。
 *
 * 用途有两件，判据完全不同 —— 脚本把两者都报出来：
 *
 *   1. **复跑核对**：同代码 + 同参数重跑一个批次，应当**逐条相同**。
 *      任何一片不同都要当事故查（M2.20 任务 0.5：8/8 片、约 14 万条事件逐条一致）。
 *   2. **定位差异来源**：不同代码的两批之间，**第一个分歧点**的位置与事件类型
 *      就是差异来自哪里的入口。M2.20 就是靠它发现「第一个分歧在第 3—5 行、
 *      事件类型 item_gain、两边 seed 字符串却完全相同」⇒ 只能是 loot 表变了。
 *
 * 比三样：domain_events（逐条）、characters（逐行）、inventory（逐行）。
 *
 * 用法：
 *   node scripts/compare-batch.ts --a m221a --b m221a-re
 *   node scripts/compare-batch.ts --a m221a --b m223b --shards 8 --limit 3
 *
 * 读的是 data/<前缀>-shard-<i>.db（只读打开，不改任何库）。
 */
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const A = argOf('a', '');
const B = argOf('b', '');
const SHARDS = Number(argOf('shards', '8'));
const LIMIT = Number(argOf('limit', '3'));

if (!A || !B) {
  console.error('用法：node scripts/compare-batch.ts --a <前缀A> --b <前缀B> [--shards 8] [--limit 3]');
  process.exit(2);
}

interface EventRow {
  character_id: string;
  type: string;
  payload: string;
  reason: string;
  seed: string | null;
  created_at: number;
}

/** 事件的比对键：不含自增 id（它每跑一次都从 1 开始，不是判定的一部分） */
function eventKey(row: EventRow, withTime: boolean): string {
  const parts = [row.character_id, row.type, row.payload ?? '', row.reason ?? '', row.seed ?? ''];
  if (withTime) parts.push(String(row.created_at));
  return parts.join(' | ');
}

interface ShardData {
  events: EventRow[];
  characters: string[];
  inventory: string[];
}

function load(prefix: string, shard: number): ShardData | null {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync('data/' + prefix + '-shard-' + shard + '.db', { readOnly: true });
  } catch {
    return null;
  }
  try {
    const events = db
      .prepare('SELECT character_id, type, payload, reason, seed, created_at FROM domain_events ORDER BY id')
      .all() as unknown as EventRow[];
    const characters = (db.prepare('SELECT * FROM characters ORDER BY id').all() as unknown as Array<Record<string, unknown>>).map(
      (row) => JSON.stringify(row),
    );
    const inventory = (
      db.prepare('SELECT * FROM inventory ORDER BY character_id, item_id').all() as unknown as Array<Record<string, unknown>>
    ).map((row) => JSON.stringify(row));
    return { events, characters, inventory };
  } catch (error) {
    console.error('读 ' + prefix + ' 片 ' + shard + ' 失败：' + String(error));
    return null;
  } finally {
    db.close();
  }
}

/** 找第一个不同的下标；相同返回 -1 */
function firstDiff(xs: readonly string[], ys: readonly string[]): number {
  const n = Math.min(xs.length, ys.length);
  for (let i = 0; i < n; i += 1) if (xs[i] !== ys[i]) return i;
  return xs.length === ys.length ? -1 : n;
}

interface ShardResult {
  shard: number;
  ok: boolean;
  missing: boolean;
  detail: string;
}

const results: ShardResult[] = [];

console.log('=== 批次逐条比对 ===');
console.log('A = ' + A + '　B = ' + B + '　片数 = ' + SHARDS);
console.log('比对的键：domain_events（character_id / type / payload / reason / seed / created_at）');
console.log('　　　　　characters、inventory（整行 JSON，按主键排序后逐行比）');
console.log('');

for (let shard = 0; shard < SHARDS; shard += 1) {
  const a = load(A, shard);
  const b = load(B, shard);
  if (!a || !b) {
    const which = !a && !b ? 'A 与 B 都缺' : !a ? 'A 缺' : 'B 缺';
    console.log('片 ' + shard + '：**' + which + '库** —— 跳过');
    results.push({ shard, ok: false, missing: true, detail: which });
    continue;
  }

  const aKeys = a.events.map((row) => eventKey(row, true));
  const bKeys = b.events.map((row) => eventKey(row, true));
  const aKeysLoose = a.events.map((row) => eventKey(row, false));
  const bKeysLoose = b.events.map((row) => eventKey(row, false));

  const diffStrict = firstDiff(aKeys, bKeys);
  const diffLoose = firstDiff(aKeysLoose, bKeysLoose);
  const diffChars = firstDiff(a.characters, b.characters);
  const diffInv = firstDiff(a.inventory, b.inventory);

  const same =
    diffStrict === -1 && diffChars === -1 && diffInv === -1 && a.characters.length === b.characters.length && a.inventory.length === b.inventory.length;

  console.log(
    '片 ' + shard + '：事件 ' + a.events.length + ' / ' + b.events.length +
      '　characters ' + a.characters.length + '/' + b.characters.length +
      '　inventory ' + a.inventory.length + '/' + b.inventory.length +
      '　—— ' + (same ? '**逐条相同**' : '**不同**'),
  );

  if (!same) {
    if (diffStrict >= 0) {
      console.log('  第一个分歧在**第 ' + (diffStrict + 1) + ' 条事件**（之前 ' + diffStrict + ' 条相同）');
      for (const [side, data] of [[A, a], [B, b]] as const) {
        const row = data.events[diffStrict];
        console.log(
          '    ' + side + '：' + (row ? row.type + '　reason=' + (row.reason ?? '') + '　seed=' + (row.seed ?? '（无）') : '（没这一条）'),
        );
        if (row) console.log('         payload=' + row.payload + '　created_at=' + row.created_at);
      }
      console.log('  读法：分歧点**之前**的事件全部相同 ⇒ 差异来自「到这一刻为止还没生效」的某个改动；');
      console.log('        两边的 seed 字符串若相同却掉了不同的东西 ⇒ 只可能是**内容表**变了（判定层同 seed 必同结果）。');
    } else if (diffLoose >= 0) {
      console.log('  事件内容相同，**只有 created_at 不同**（第 ' + (diffLoose + 1) + ' 条起）—— 时钟差异，不是判定差异。');
    } else if (a.events.length !== b.events.length) {
      console.log('  前 ' + Math.min(a.events.length, b.events.length) + ' 条逐条相同，之后**条数不同**（' + a.events.length + ' vs ' + b.events.length + '）。');
    }
    if (diffChars >= 0 && diffChars < Math.max(a.characters.length, b.characters.length)) {
      console.log('  characters 第一个不同在第 ' + (diffChars + 1) + ' 行：');
      console.log('    ' + A + '：' + a.characters[diffChars]);
      console.log('    ' + B + '：' + b.characters[diffChars]);
    }
    if (diffInv >= 0 && diffInv < Math.max(a.inventory.length, b.inventory.length)) {
      console.log('  inventory 第一个不同在第 ' + (diffInv + 1) + ' 行：');
      console.log('    ' + A + '：' + a.inventory[diffInv]);
      console.log('    ' + B + '：' + b.inventory[diffInv]);
    }
  }

  results.push({ shard, ok: same, missing: false, detail: '' });
  if (results.filter((r) => !r.ok).length > LIMIT && LIMIT > 0) {
    console.log('  （不同的片已超过 ' + LIMIT + ' 个，后面只报一行结论）');
  }
}

const ok = results.filter((r) => r.ok).length;
const missing = results.filter((r) => r.missing).length;
console.log('');
console.log('=== 汇总 ===');
console.log('  逐条相同：' + ok + '/' + SHARDS + ' 片' + (missing > 0 ? '（另有 ' + missing + ' 片缺库）' : ''));
if (ok === SHARDS) {
  console.log('  结论：**可复现** —— 同代码同参数重跑得到同一批数据。');
  console.log('  ⚠️ 数据相同 != 退出码相同：M2.20 复跑时分片 0 的退出码是 1 而原批是 0，数据却逐条相同。');
} else {
  console.log('  结论：**不可直接当同一批** —— 先看第一个分歧点在哪里、是什么事件类型。');
}
process.exitCode = ok === SHARDS ? 0 : 1;
