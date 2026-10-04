/**
 * 跨片聚合的打字机守卫（M2.19 任务 4）。
 *
 * ## 为什么需要它
 *
 * 分片跑批的每一片都是**独立的库**：user_id 都从 700000 起、character_id 都叫 c-700000。
 * 所以任何一个玩家标识**只在片内唯一** —— 跨片合并时必须带上片号。
 *
 * 这件事在本仓踩过两次（docs/架构铁律.md 的 K3 与 K5）：
 *   · K3：把 8 片的 user_id 合成一个集合去匹配行为日志 → 得到「序列 8 只有 20 人、材料地占 13.8%」
 *     这样**看起来完全合理**的假数（真实是 53 人 / 19.4%）；
 *   · K5：E3 的 trace 又用 character_id 做 key，八个片互相覆盖，读到的是「只剩最后一片那几个人」。
 *
 * 两次都不是「不小心写错」，而是**裸 id 在类型上完全合法**：
 * Map<string, T> 收 'c-700000' 和收 '0:c-700000' 一样顺。
 * 所以这条防线不能靠纪律（K5 的处置原话：「K3/K5 现在只能靠纪律守，这是最弱的一层」），
 * 得让**裸 id 传不进去**。
 *
 * ## 怎么用
 *
 *     const map = new Map<ShardKey, Rec>();          // 而不是 Map<string, Rec>
 *     map.set(shardKey(shard, characterId), rec);    // 唯一的构造方式
 *
 * 从**外部字符串**（JSON、命令行参数、日志）拿到的 key 必须过 asShardKey：
 * 它是唯一的收窄入口，而且**会校验格式**（裸 id 会被拒）。
 *
 * ## 边界（这是类型守卫，不是数据迁移）
 *
 * · 它防的是「忘了带片号」，不防「故意 as ShardKey 强转」—— 后者要靠 review；
 * · 它不改任何既有数据、不改 schema、不做迁移；
 * · 片内聚合**不需要**它：片内 id 本来就唯一，用裸 id 是对的。
 */

declare const ShardBrand: unique symbol;

/**
 * 跨片语境下的玩家标识：形如 片号:片内id（例：0:c-700000、3:test:12）。
 *
 * 它是 string 的**子类型** —— 可以直接当字符串用（打印、拼 SQL、写日志），
 * 但反过来不行：裸 string **不能**赋给 ShardKey，这正是这道防线的工作方式。
 */
export type ShardKey = string & { readonly [ShardBrand]: true };

/** 跨片聚合的 Map：key 只收 ShardKey（写成别名，是为了让「这里该带片号」在签名上一眼可见） */
export type ShardKeyMap<V> = Map<ShardKey, V>;

/** 片号是**非负整数**（\\d+ 只能吃数字，所以解析时按第一个冒号分割是唯一的），片内 id 非空。 */
const KEY_PATTERN = /^(\d+):(.+)$/;

/** 构造（**首选入口**）：片号 + 片内 id。 */
export function shardKey(shard: number, index: string | number): ShardKey {
  if (!Number.isInteger(shard) || shard < 0) {
    throw new ShardKeyError('片号必须是非负整数，收到 ' + String(shard));
  }
  const text = String(index);
  if (text.length === 0) throw new ShardKeyError('片内 id 不能是空串');
  /*
   * 片内 id **允许**含冒号：解析按**第一个**冒号分割（\\d+ 吃不下非数字），
   * 所以 shardKey(0, 'a:b') 与 parseShardKey 仍然往返一致。
   * 本仓的片内 id 实际是 c-700000 这类；这条宽松只是为了让构造器**不比校验器更严** ——
   * 「校验能过、构造抛错」是最难查的一种不一致。
   */
  return (shard + ':' + text) as ShardKey;
}

/** 格式校验（不抛异常的那一半） */
export function isShardKey(value: string): value is ShardKey {
  return typeof value === 'string' && KEY_PATTERN.test(value);
}

/**
 * 从**外部字符串**收窄成 ShardKey —— 唯一的入口，**会校验**。
 *
 * 裸 id（c-700000，没有片号）会在这里被拒，而不是在统计出假数之后才被发现。
 * 这就是 K3/K5 那条「看起来完全合理的假数」的拦截点。
 */
export function asShardKey(value: string): ShardKey {
  if (!isShardKey(value)) {
    throw new ShardKeyError(
      '不是合法的跨片 key：' + JSON.stringify(value) +
      '（要的是「片号:片内 id」，例：0:c-700000）—— 裸 id 只在片内唯一，跨片用它会串人（K3/K5）',
    );
  }
  return value;
}

/** 拆开：片号与片内 id */
export function parseShardKey(key: ShardKey): { shard: number; index: string } {
  const matched = KEY_PATTERN.exec(key);
  if (!matched) throw new ShardKeyError('不是合法的跨片 key：' + JSON.stringify(key));
  return { shard: Number(matched[1]), index: String(matched[2]) };
}

export function shardOf(key: ShardKey): number {
  return parseShardKey(key).shard;
}

export function indexOf(key: ShardKey): string {
  return parseShardKey(key).index;
}

/** 跨片 key 的构造 / 校验失败 */
export class ShardKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShardKeyError';
  }
}
