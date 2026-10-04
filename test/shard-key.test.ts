/**
 * M2.19 任务 4：ShardKey 的打字机守卫。
 *
 * 三组：
 *   §A 构造与解析（格式、片号 0、非法输入）
 *   §B 从外部字符串收窄（裸 id 被拒 —— K3/K5 的拦截点）
 *   §C **编译期**：裸 id 传不进收 ShardKey 的函数（靠 @ts-expect-error，由 tsc 把关）
 *      —— 这一组是本任务真正的验收：类型层挡住，不靠人记住。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ShardKeyError,
  asShardKey,
  indexOf,
  isShardKey,
  parseShardKey,
  shardKey,
  shardOf,
  type ShardKey,
  type ShardKeyMap,
} from '../src/infra/shard-key.ts';

/* ==================== §A 构造与解析 ==================== */

test('ShardKey：构造器给出「片号:片内 id」，片号 0 不会被当成空值', () => {
  assert.equal(shardKey(0, 'c-700000'), '0:c-700000');
  assert.equal(shardKey(7, 'c-700023'), '7:c-700023');
  assert.equal(shardKey(3, 12), '3:12');
  // 片号 0 是最容易踩的那一个（falsy）：它必须与「没给片号」区分开
  assert.equal(shardOf(shardKey(0, 'x')), 0);
  assert.equal(indexOf(shardKey(0, 'x')), 'x');
});

test('ShardKey：解析是往返一致的', () => {
  for (const pair of [[0, 'c-700000'], [5, 'test:12'], [12, 'c-1']] as Array<[number, string]>) {
    const key = shardKey(pair[0], pair[1]);
    assert.deepEqual(parseShardKey(key), { shard: pair[0], index: pair[1] });
  }
  // 片内 id 允许含冒号：解析按**第一个**冒号分割，所以仍然往返一致
  assert.deepEqual(parseShardKey(shardKey(0, 'a:b')), { shard: 0, index: 'a:b' });
});

test('ShardKey：非法片号与空 id 被拒', () => {
  assert.throws(() => shardKey(-1, 'c-1'), ShardKeyError);
  assert.throws(() => shardKey(1.5, 'c-1'), ShardKeyError);
  assert.throws(() => shardKey(0, ''), ShardKeyError);
});

/* ==================== §B 从外部字符串收窄 ==================== */

test('ShardKey：asShardKey 接受合法 key，拒裸 id（K3/K5 的拦截点）', () => {
  assert.equal(asShardKey('0:c-700000'), '0:c-700000');
  assert.equal(asShardKey('3:test:12'), '3:test:12');

  // 裸 character_id / user_id —— 没有片号，跨片用它就会串人
  assert.throws(() => asShardKey('c-700000'), ShardKeyError);
  assert.throws(() => asShardKey('700000'), ShardKeyError);
  // 片号必须是数字：'test:1' 含冒号但不是跨片 key
  assert.throws(() => asShardKey('test:1'), ShardKeyError);
  assert.throws(() => asShardKey(':c-1'), ShardKeyError);
  assert.throws(() => asShardKey('0:'), ShardKeyError);
});

test('ShardKey：错误信息要说清「为什么不能是裸 id」', () => {
  try {
    asShardKey('c-700000');
    assert.fail('应当抛错');
  } catch (error) {
    assert.ok(error instanceof ShardKeyError);
    assert.ok(error.message.includes('跨片 key'), '要点名「跨片 key」');
    assert.ok(error.message.includes('K3/K5'), '要指到踩坑清单');
  }
});

test('ShardKey：isShardKey 是 asShardKey 的不抛错版本，两者判定一致', () => {
  for (const value of ['0:c-1', 'c-1', 'test:1', '', '0:', '9:a:b']) {
    let accepts = true;
    try { asShardKey(value); } catch { accepts = false; }
    assert.equal(isShardKey(value), accepts, '两者对 ' + JSON.stringify(value) + ' 的判定必须一致');
  }
});

/* ==================== §C 编译期：裸 id 传不进去 ==================== */

/** 一个只收 ShardKey 的跨片聚合函数 —— 它的签名就是这道防线 */
function countInto(map: ShardKeyMap<number>, key: ShardKey): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/*
 * 下面这个函数**故意不被调用**：它只在编译期有意义。
 *
 * 为什么不做成「直接写在用例里」—— @ts-expect-error 只影响**类型检查**，那一行在运行时照样会跑
 * （比如 shardKey('0', ...) 会真的抛 ShardKeyError）。放进一个不调用的函数，两个层面都干净：
 * tsc 检查它，运行时碰不到它。
 *
 * 若 tsc 报「Unused '@ts-expect-error' directive」，说明防线失效了 —— 那正是这条要抓的回归。
 */
function compileTimeGuards(map: ShardKeyMap<number>): void {
  countInto(map, shardKey(0, 'c-700000'));            // ✅ 唯一正确写法
  countInto(map, asShardKey('1:c-700000'));           // ✅ 外部字符串走收窄入口

  // @ts-expect-error 裸 character_id 没有片号
  countInto(map, 'c-700000');
  // @ts-expect-error 手写的「片:index」字面量也不行，必须走构造器
  countInto(map, '0:c-700000');
  // @ts-expect-error 片号必须是 number，不能是字符串
  countInto(map, shardKey('0', 'c-700000'));
}
void compileTimeGuards;   // 只为了让「未被调用」不触发别的检查 —— 它的价值在编译期

test('ShardKey：裸 id 在**类型层**传不进跨片函数（@ts-expect-error 由 tsc 把关）', () => {
  const tally: ShardKeyMap<number> = new Map();
  countInto(tally, shardKey(0, 'c-700000'));
  countInto(tally, asShardKey('1:c-700000'));
  assert.equal(tally.size, 2, '只有构造器与收窄入口这两条路能进 map');
});

test('ShardKey：K5 的形状被固化成对照 —— 裸 id 会把八个人并成一个', () => {
  const correct: ShardKeyMap<number> = new Map();
  const naive = new Map<string, number>();
  for (let shard = 0; shard < 8; shard += 1) {
    countInto(correct, shardKey(shard, 'c-700000'));
    // 这是 M2.18 真踩过的那一行（K5）：八个片都叫 c-700000，于是被并成一个人
    naive.set('c-700000', (naive.get('c-700000') ?? 0) + 1);
  }
  assert.equal(correct.size, 8, '带片号：八个人是八个人');
  assert.equal(naive.size, 1, '裸 id：八个人被并成一个 —— 这就是 K3/K5 的形状');
});
