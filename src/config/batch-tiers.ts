/**
 * M2.35 任务 2：**跑批的三档规模 —— 唯一出处（K22）**。
 *
 * ## 为什么要分档（三个结构问题里的第三个）
 *
 * 在那之前跑批只有一档：**1 片 × 200 人 × 30 天、约 2.5 小时**。
 * 它同时被要求回答三个不同量级的问题 ——「链路通不通」「机制在不在跑」「达标没有」——
 * 而它的成本只对得起其中一个，那一个还是**方法本身就错**的那个（见下）。
 * 后果是每一轮都为「只想看一眼链路」付 2.5 小时，
 * 于是「顺手跑一批确认一下」变成一件需要下决心的事（M2.19—M2.34 十六轮的现场）。
 *
 * ## 三档
 *
 * | 档 | 规模 | 耗时 | 回答什么 | 验收线 |
 * | --- | --- | --- | --- | --- |
 * | 冒烟 | 1 片 × 20 人 × 3 天 | ~2 分钟 | 链路走得通 | **链路走得通，不报错**（不判任何数值） |
 * | 中批 | 1 片 × 50 人 × 15 天 | ~15 分钟 | 机制在跑、A/B 对照 | **机制在跑，A/B 对照有信号** |
 * | 诊断 | 1 片 × 200 人 × 30 天 | 2.5 小时 | 卡点分布（**可选**） | **卡点分布，不判定达标** |
 *
 * ## 取消的两样（M2.35 拍板：别再捡回来）
 *
 * 1. **定论级跑批** —— 不再有「跑一批 200 人 × 30 天去判定 ≥ N 达标」这一档。
 *    绝对门槛判定（「30 天 ≥ N 人」）**方法本身是错的**：
 *    它把一个同时受 seed 噪声、内容进度、vplayer 行为模型三重影响的读数，
 *    当成了机制的质量。M2.27 定的「标准对照轮 = 1 片 × 200 人」随之作废。
 * 2. **绝对门槛本身不作标定依据** —— 设计意图定值，跑批只验**可达性**。
 *    可达性由 `src/data/link-check.ts` 第 3 项**直接算**（不跑批）。
 *
 * ## 标准对照轮 = **中批**
 *
 * 门槛判定取消之后，标准对照轮剩下的用途是「A/B 对照有没有信号」——
 * 那件事在 50 人 × 15 天上就能看出来，200 人 × 30 天买到的是同一件事加上 10 倍成本。
 *
 * ⚠️ 三个数字是**规格**，不是实测值：它们是「这一档该多大」的设计意图。
 * 实测可达性由链路检查器现场算（同一份定义 ⇒ 两边不会漂，K22）。
 */

export type BatchTierId = 'smoke' | 'medium' | 'diagnostic';

export interface BatchTier {
  id: BatchTierId;
  /** 中文档名（报告与手册里用这个） */
  label: string;
  /** 全批总人数（`--players`，不是每片人数 —— 见 docs/跑批手册.md §3.0） */
  players: number;
  days: number;
  shards: number;
  /** 预期耗时（分钟），用来选档 */
  minutes: number;
  /** 这一档回答什么问题 */
  purpose: string;
  /** 验收线（M2.35 任务 5 **写死**在 docs/对照规范.md §四·补三，此处是它的代码落点） */
  acceptance: string;
}

export const BATCH_TIERS: readonly BatchTier[] = [
  {
    id: 'smoke',
    label: '冒烟',
    players: 20,
    days: 3,
    shards: 1,
    minutes: 2,
    purpose: '链路走得通',
    acceptance: '链路走得通，不报错。**不判任何数值**',
  },
  {
    id: 'medium',
    label: '中批',
    players: 50,
    days: 15,
    shards: 1,
    minutes: 15,
    purpose: '机制在跑、A/B 对照有信号',
    acceptance: '机制在跑，A/B 对照有信号。**不判「≥ N」达标**',
  },
  {
    id: 'diagnostic',
    label: '诊断',
    players: 200,
    days: 30,
    shards: 1,
    minutes: 150,
    purpose: '卡点分布（**可选**，只在需要分布诊断时跑）',
    acceptance: '卡点分布，**不判定达标**',
  },
];

/** 标准对照轮 = **中批**（M2.35：M2.27 的「1 片 × 200 人」作废） */
export const STANDARD_TIER_ID: BatchTierId = 'medium';

export function batchTierOf(id: BatchTierId): BatchTier {
  const tier = BATCH_TIERS.find((row) => row.id === id);
  if (!tier) throw new Error('没有这一档跑批规模：' + id + '（只有 ' + BATCH_TIERS.map((r) => r.id).join(' / ') + '）');
  return tier;
}

/** 标准对照轮（引用 `STANDARD_TIER_ID`，不另写一份规模） */
export const STANDARD_TIER: BatchTier = batchTierOf(STANDARD_TIER_ID);

/**
 * 按规模**推断**档位 —— 只在**没给 `--tier`** 时兜底（M2.37 任务 1）。
 *
 * ⚠️ **这是兜底，不是推荐路径。** K12 的形状是「缺一个参数只会给你另一批数据」，
 * 而这里缺的是**判定口径**：推断错了不报错，只让退出码按另一档算。
 * ⇒ 凡是指定规模的地方**都要同时写 `--tier`**（手册 §3.0.1 的三条命令已经带上）。
 *
 * **匹配不上任何一档时返回 `diagnostic`（最严）** —— 那正是 M2.37 之前的行为，
 * 于是**历史命令的退出码口径一个字节都没变**（8 片 × 200 人 × 30 天也落在这里）。
 */
export function inferTier(players: number, days: number): BatchTierId {
  const exact = BATCH_TIERS.find((tier) => tier.players === players && tier.days === days);
  return exact ? exact.id : 'diagnostic';
}

export interface BatchCommandOptions {
  tier: BatchTier;
  /** `--seed`：决定玩家画像。批号（前缀）与它是两个参数（K12） */
  seed: string;
  /** `M213_DB_PREFIX`：决定产物名。省略则等于 seed */
  prefix?: string;
  /** 产物目录，默认 docs */
  out?: string;
  /** 只跑第几片；省略则打印覆盖全部分片的循环命令 */
  shard?: number;
}

/**
 * 生成**可复制**的完整命令（四件齐全：seed / prefix / players / days —— K12）。
 *
 * ⚠️ 报告正文里那条命令**不是**完整命令（它缺 prefix、而且 `--players` 是单片口径，见手册 §1.2）。
 * 所以本函数只从这一处生成，别手抄。
 */
export function batchCommandOf(options: BatchCommandOptions): string {
  const { tier, seed, prefix, out = 'docs', shard } = options;
  const env = '$env:M213_DB_PREFIX=' + String.fromCharCode(39) + (prefix ?? seed) + String.fromCharCode(39) +
    '; $env:WORLD_SEED=' + String.fromCharCode(39) + 'world' + String.fromCharCode(39);
  const args = (i: number): string =>
    '--shard ' + i + ' --shards ' + tier.shards + ' --players ' + tier.players +
    ' --days ' + tier.days + ' --seed ' + seed + ' --out ' + out;
  if (shard !== undefined) {
    return env + String.fromCharCode(10) + 'node scripts/vplayer-shard.ts ' + args(shard);
  }
  if (tier.shards === 1) {
    return env + String.fromCharCode(10) + 'node scripts/vplayer-shard.ts ' + args(0);
  }
  return env + String.fromCharCode(10) + '0..' + (tier.shards - 1) +
    ' | ForEach-Object { node scripts/vplayer-shard.ts ' +
    '--shard $_ --shards ' + tier.shards + ' --players ' + tier.players +
    ' --days ' + tier.days + ' --seed ' + seed + ' --out ' + out + ' }';
}

/** 只打印分片计划（核参数最便宜的一步，手册 §3.7） */
export function batchPlanCommandOf(options: Omit<BatchCommandOptions, 'shard'>): string {
  const { tier, seed, out = 'docs' } = options;
  return 'node scripts/vplayer-shard.ts --plan --shards ' + tier.shards + ' --players ' + tier.players +
    ' --days ' + tier.days + ' --seed ' + seed + ' --out ' + out;
}
