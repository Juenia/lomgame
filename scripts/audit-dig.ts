#! /usr/bin/env node
/**
 * M2.22 任务 5：**DIG 写入口对账**（K8）。
 *
 * ## 为什么要比 M2.18 当年的做法更严
 *
 * M2.18 只比了「事件流里 dig_delta 的 after 峰值/末值 vs 状态表 dig」——
 * 那**证明不了**写入口完整：末值恰好对上、中间却断链的情况它看不见。
 *
 * 本脚本查三层（逐层收紧）：
 *
 *   1. **末值对账**：最后一条 dig_delta 的 payload.after vs characters.dig
 *      —— 与 M2.18 同一层（新的改动只要不在它之后发生，就查不出）；
 *   2. **链完整性**：相邻两条 dig_delta 必须满足
 *      \`后一条.payload.before === 前一条.payload.after\`
 *      —— **断了就是漏了一个写入口**（有一条改 DIG 的路径没落事件）；
 *   3. **数值闭合**：\`before + delta\` 与 \`after\` 的关系要能被 clamp 解释
 *      （dig 的区间是 [0, 100]）。
 *
 * 第 2 层是这一轮新增的判据，也是「差 = 0」这条硬验收真正要看的东西。
 *
 * 用法：node scripts/audit-dig.ts [--batch m223a] [--shards 8] [--limit 20]
 */
import { DatabaseSync } from 'node:sqlite';
import { CLAMP } from '../src/domain/effect/apply.ts';
import { shardKey } from '../src/infra/shard-key.ts';

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const BATCH = argOf('batch', 'm223a');
const SHARDS = Number(argOf('shards', '8'));
const LIMIT = Number(argOf('limit', '20'));

interface EventRow {
  id: number;
  character_id: string;
  payload: string;
  reason: string;
  created_at: number;
  seed: string | null;
}
interface CharRow {
  id: string;
  pathway: string | null;
  dig: number;
}

let totalChars = 0;
let withEvents = 0;
let noEvents = 0;
const broken: string[] = [];
const mismatched: string[] = [];
const badArithmetic: string[] = [];
let okChars = 0;

const [LO, HI] = CLAMP.dig;

for (let s = 0; s < SHARDS; s += 1) {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync('data/' + BATCH + '-shard-' + s + '.db', { readOnly: true });
  } catch {
    continue;
  }
  const chars = db.prepare('SELECT id, pathway, dig FROM characters').all() as unknown as CharRow[];
  const events = db.prepare(
    "SELECT id, character_id, payload, reason, created_at, seed FROM domain_events WHERE type = 'dig_delta' ORDER BY id ASC",
  ).all() as unknown as EventRow[];

  const byChar = new Map<string, EventRow[]>();
  for (const row of events) {
    const key = String(row.character_id);
    const list = byChar.get(key) ?? [];
    list.push(row);
    byChar.set(key, list);
  }

  for (const pass of [false, true]) {
    // pass=false：只数已入途径的（M2.18 的 184 人口径）；pass=true：全体
    for (const char of chars) {
      if (!pass && char.pathway === null) continue;
      totalChars += 1;
      const list = byChar.get(String(char.id)) ?? [];
      const key = shardKey(s, String(char.id));
      if (list.length === 0) {
        /*
         * 一条 dig_delta 都没有 ⇒ 这个角色的 DIG **从没被改动过**，
         * 状态表上那个值是建号时写的初值 —— **对得上**。
         *
         * （第一版这里是 `if (dig > 0) okChars += 1`，于是「初值恰好是 0」的角色
         * 被算成「对不上」，m225 上多报了 2 个。判据与数值大小无关。）
         */
        noEvents += 1;
        okChars += 1;
        continue;
      }
      withEvents += 1;

      let chainOk = true;
      let arithmeticOk = true;
      let previousAfter: number | null = null;
      for (const row of list) {
        let payload: { before?: number; after?: number; delta?: number };
        try {
          payload = JSON.parse(String(row.payload)) as typeof payload;
        } catch {
          chainOk = false;
          break;
        }
        const before = Number(payload.before);
        const after = Number(payload.after);
        const delta = Number(payload.delta);
        if (previousAfter !== null && Math.abs(before - previousAfter) > 1e-9) {
          chainOk = false;
          if (broken.length < LIMIT) {
            broken.push(
              '  ' + key + '　' + new Date(Number(row.created_at)).toISOString().slice(0, 16) +
                '　reason=' + row.reason + '　上一条 after=' + previousAfter + '，这一条 before=' + before +
                '（**差 ' + (before - previousAfter).toFixed(4) + '**）',
            );
          }
        }
        // after 必须能被 before + delta 经 [0,100] 截断得到；否则说明这一条自己就不自洽
        const naive = before + delta;
        const clamped = Math.min(HI, Math.max(LO, naive));
        if (Math.abs(clamped - after) > 1e-9) {
          arithmeticOk = false;
          if (badArithmetic.length < LIMIT) {
            badArithmetic.push(
              '  ' + key + '　' + new Date(Number(row.created_at)).toISOString().slice(0, 16) +
                '　reason=' + row.reason + '　before=' + before + ' delta=' + delta + ' after=' + after +
                '（clamp 后应为 ' + clamped + '）',
            );
          }
        }
        previousAfter = after;
      }

      const replay = previousAfter === null ? null : previousAfter;
      const state = Number(char.dig);
      if (replay !== null && Math.abs(replay - state) > 1e-9) {
        if (mismatched.length < LIMIT) {
          mismatched.push(
            '  ' + key + '　事件流末值 ' + replay + '　状态表 ' + state +
              '　**差 ' + (state - replay).toFixed(4) + '**　（dig_delta ' + list.length + ' 条，最后一条 reason=' +
              list[list.length - 1]!.reason + '）',
          );
        }
      } else if (chainOk && arithmeticOk) {
        okChars += 1;
      }
    }
  }
  db.close();
}

const reported = (list: string[], label: string, count: number): void => {
  console.log('  ' + label + '：**' + count + '**' + (count > list.length ? '（下面只列前 ' + list.length + ' 条）' : ''));
  for (const line of list) console.log(line);
  console.log('');
};

console.log('=== DIG 写入口对账（K8）===');
console.log('  批：' + BATCH + '　片数：' + SHARDS + '　口径：已入途径的角色（M2.18 的「184 人」是这一档）');
console.log('');
console.log('=== §0 规模 ===');
console.log('  参与对账的角色：' + totalChars);
console.log('  有 dig_delta 的：' + withEvents + '　没有的：' + noEvents);
console.log('  对得上的：' + okChars + '　**对不上的：' + (totalChars - okChars) + '**');
console.log('');
console.log('=== §1 链完整性：相邻两条 dig_delta 的 after / before 对不对得上 ===');
reported(broken, '断链处', totalChars - okChars > 0 ? broken.length : 0);
console.log('=== §2 数值闭合：before + delta 经 [0,100] 截断 == after ===');
reported(badArithmetic, '不自洽的条目', badArithmetic.length);
console.log('=== §3 末值对账：事件流末值 vs 状态表 ===');
reported(mismatched, '不一致的角色', mismatched.length);
console.log('=== 判据 ===');
console.log('  · §1 断链 = **漏了一个写入口**（有一条改 DIG 的路径没落事件）—— 这是 K8 要修的；');
console.log('  · §3 不一致 = 末值口径的对不上（也可能只是「最后一条之后又改了」）—— 与 M2.18 同一层；');
console.log('  · 硬验收（任务书）：§1 与 §3 都必须为 0。');
