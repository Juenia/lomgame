#!/usr/bin/env node
/**
 * 分片跑虚拟玩家（M2.3 任务四 §6.2）。
 *
 *   # 跑第 0 片（主代理会把这个命令分给一个子代理）
 *   node scripts/vplayer-shard.ts --shard 0 --shards 4 --players 200 --days 14 \
 *     --seed vplayer-m23 --out data/vplayer-shards
 *
 *   # 只打印分片计划（把 4 条命令分给 4 个子代理时用）
 *   node scripts/vplayer-shard.ts --plan --shards 4 --players 200 --days 14 --seed vplayer-m23
 *
 * 为什么**按玩家分片、不按天分片**（任务书 §6.2）：
 *   按天分片会打断跨天状态依赖（DIG 累积、失控恢复、交易超时）；
 *   按玩家分片则每个人的判定链完整无缺，分片之间本来就不需要互相看见。
 *
 * 分片之间完全独立：独立进程、独立 SQLite、独立端口（cli.ts 自己挑空闲端口）、
 * **玩家行为 seed** 由 `<seed>:shard:<i>` 派生 —— 所以两片同时跑不会互相污染。
 *
 * M2.4 起**世界 seed 与分片无关**：WORLD_SEED 由 --world-seed 指定一次，
 * 4 片拿到的是**同一个值**（见 planShards 的 worldSeed）。
 * 这是「4 片跑同一时刻，世界状态逐字节一致」的前提，也是 M2.4 验收的核心证据：
 * 世界事件是 seed 派生的，4 片必须看到同一串事件。
 * 一句话口径：--seed 分片，--world-seed 不分片。
 */
import { inferTier, type BatchTierId } from '../src/config/batch-tiers.ts';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface ShardPlan {
  index: number;
  shards: number;
  players: number;
  days: number;
  /** M2.37 任务 1：这一批判退出码用的**档位**（透传给 cli.ts 的 --tier） */
  tier: BatchTierId;
  /** 玩家行为 seed（按片派生） */
  seed: string;
  /**
   * 世界 seed（**全片同一个**）：雾日 / 天气 / 世界事件的确定性来源。
   * 它**不含分片序号** —— 这是 M2.4 硬约束「世界 seed 全局一个」的落点。
   */
  worldSeed: string;
  jsonPath: string;
  reportPrefix: string;
  reportPath: string;
  /** M2.13：这一片用的 SQLite 文件（跑批留下来的那一个 —— 报告脚本读它） */
  dbPath: string;
}

export interface PlanInput {
  shards: number;
  players: number;
  days: number;
  seed: string;
  /** M2.37 任务 1：显式 `--tier`；不给就按 players/days 推断（`inferTier`） */
  tier?: BatchTierId;
  /** 世界 seed；不给时取环境变量 WORLD_SEED，再不给就是 'world' */
  worldSeed?: string;
  out: string;
}

/**
 * 玩家分配：整除余数分给前几片（200/4 = 每片 50；201/4 = 51/50/50/50）。
 * 分配只影响「每片生成几个玩家」，不影响玩家的 userId（每片都是 700000 起）——
 * 每片有自己的 DB，userId 重复无所谓；反过来让片内 userId 连续，
 * 片内的交易与组队才不会打到不存在的玩家身上。
 */
export function planShards(input: PlanInput): ShardPlan[] {
  const base = Math.floor(input.players / input.shards);
  const rest = input.players % input.shards;
  // 世界 seed 在这里算**一次**，循环里每片拿到的是同一个值（没有 index 参与）
  const worldSeed = input.worldSeed ?? process.env.WORLD_SEED ?? 'world';
  return Array.from({ length: input.shards }, (_, index) => {
    // M2.13.1：报告名也跟着库前缀走，否则同 seed 的第二轮会覆盖第一轮的日志与报告
    const reportPrefix = `${process.env.M213_DB_PREFIX ?? input.seed}-shard${index}`;
    return {
      index,
      shards: input.shards,
      players: base + (index < rest ? 1 : 0),
      days: input.days,
      // M2.37 任务 1：档位**全片同一个** —— 它是判定口径，不随片派生
      tier: input.tier ?? inferTier(input.players, input.days),
      // 分片 seed 的派生方式写死在报告里（口径声明要用）
      seed: `${input.seed}:shard:${index}`,
      // 世界 seed：4 片完全相同（M2.4 验收点）
      worldSeed,
      /*
       * M2.13.1 任务 D：**JSON 文件名必须带库前缀。**
       *
       * 原来叫 shard-N.json（不含前缀），而同 out 目录下每一轮都写同名文件 ——
       * 于是同 seed 的两轮（开/关前置 4）里，后跑的会把先跑的覆盖掉。
       * m213 那一轮就是这么没的，最后只能从行为日志 + 库重建
       * （过程见 docs/M2.13.1-交付说明.md §8.3）。
       *
       * 命名规则：**`<库前缀>-shard-<片号>.json`**，库前缀 = M213_DB_PREFIX ?? --seed，
       * 与 dbPath（`<库前缀>-shard-<片号>.db`）与报告前缀完全一致 ——
       * **一份分片结果只对应一个库、一份报告**，谁也覆盖不了谁。
       *
       * 第二道防线在 src/vplayer/cli.ts：显式 --json 指到 seed 不同的已有文件上会报错退出。
       */
      jsonPath: join(input.out, `${process.env.M213_DB_PREFIX ?? input.seed}-shard-${index}.json`),
      reportPrefix,
      reportPath: join(input.out, `${reportPrefix}报告.md`),
      /*
       * M2.13.1：**同 seed 跑两轮时库名会撞**（开/关前置 4 用的是同一个 seed），
       * 而复用同一个库会让幂等表把第二轮的每一条指令都静默挡回
       * （实测：P1 从 0 涨到 2000+，看着像产品 bug，其实是测试工具自己撞的）。
       * 所以库前缀可以用 M213_DB_PREFIX 覆盖。
       */
      dbPath: join('data', `${process.env.M213_DB_PREFIX ?? input.seed}-shard-${index}.db`),
    };
  });
}

/** 单片 CLI 参数（导出出来是为了让测试能断言「每片的 seed 与玩家数」） */
export function shardArgs(plan: ShardPlan): string[] {
  return [
    'src/vplayer/cli.ts',
    '--players', String(plan.players),
    '--days', String(plan.days),
    /*
     * M2.37 任务 1：档位**显式传**。
     * 不传的话 cli.ts 会按**这一片的人数**推断（25 人 / 30 天），而档位规格是按**全批**定的 ——
     * 那正是 K12 的形状：少传一个参数，不报错，只让退出码按另一档算。
     */
    '--tier', plan.tier,
    '--seed', plan.seed,
    // 世界 seed 也显式传一遍：即使调用方忘了设环境变量，
    // 4 片拿到的仍然是同一个值（不靠「碰巧继承到同样的 shell 环境」）
    '--world-seed', plan.worldSeed,
    // 分片轮不是验收轮：每片只有 50 人，走不完「200 人 ≥50 晋升」那条包线
    '--no-strict',
    '--report-prefix', plan.reportPrefix,
    '--out', plan.reportPath,
    '--json', plan.jsonPath,
    '--shard', String(plan.index),
    '--shards', String(plan.shards),
    /*
     * M2.13：**把库留下来。**
     *
     * 不传 --db 时 `src/vplayer/cli.ts` 会在跑完之后 `cleanupDb` 掉服务端的临时库
     * （`keepDb = options.keepDb || options.dbPath !== undefined`）——
     * 而 M2.13 的三份报告（封印物覆盖 / advantage 拆表 / 长链路两段）全都要读它。
     * 实测踩过一次：8 片跑完 17 分钟，报告脚本一个库都找不到。
     *
     * 命名沿用 M2.12 的口径：`<seed 去掉 :shard:>-shard-<片号>.db` → `m213-shard-0.db`。
     */
    '--db', plan.dbPath,
  ];
}

function argOf(argv: readonly string[], name: string, fallback: string): string {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

export async function runShard(plan: ShardPlan, cwd = process.cwd()): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, shardArgs(plan), {
      cwd,
      // M2.4：世界 seed 显式钉死在子进程环境里 —— 4 片同一个值，且不受调用者 shell 影响。
      // （服务端进程还会再把 WORLD_SEED 传给真正跑判定的那个 node 进程，见 loadtest/harness.ts）
      env: { ...process.env, WORLD_SEED: plan.worldSeed },
      // inherit：分片日志直接进各自的子代理输出，主代理不汇总日志只汇总 JSON
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // M2.37 任务 1：显式 --tier（不给就在 planShards 里按规模推断）
  const tierArg = argOf(argv, 'tier', '');
  const input: PlanInput = {
    shards: Number(argOf(argv, 'shards', '4')),
    players: Number(argOf(argv, 'players', '200')),
    days: Number(argOf(argv, 'days', '14')),
    seed: argOf(argv, 'seed', 'vplayer-m23'),
    ...(tierArg ? { tier: tierArg as BatchTierId } : {}),
    // 4 片必须在命令行上写同一个世界 seed（默认 world，与服务端默认一致）
    worldSeed: argOf(argv, 'world-seed', process.env.WORLD_SEED ?? 'world'),
    out: argOf(argv, 'out', join('data', 'vplayer-shards')),
  };
  const plans = planShards(input);

  if (argv.includes('--plan')) {
    console.log(`分片计划：${input.players} 玩家 × ${input.days} 天，分 ${input.shards} 片`);
    for (const plan of plans) {
      console.log(
        `  片 ${plan.index}：${plan.players} 人，seed=${plan.seed}，世界 seed=${plan.worldSeed}\n` +
          `    node scripts/vplayer-shard.ts --shard ${plan.index} --shards ${plan.shards} ` +
          `--players ${input.players} --days ${input.days} --seed ${input.seed} ` +
          `--tier ${plan.tier} ` +
          `--world-seed ${plan.worldSeed} --out ${input.out}`,
      );
    }
    return;
  }

  const index = Number(argOf(argv, 'shard', '0'));
  const plan = plans[index];
  if (!plan) throw new Error(`没有第 ${index} 片（共 ${input.shards} 片）`);
  mkdirSync(input.out, { recursive: true });
  console.log(`开始分片 ${plan.index}/${plan.shards}：${plan.players} 玩家 × ${plan.days} 天，seed=${plan.seed}`);
  const started = Date.now();
  const code = await runShard(plan);
  console.log(
    `分片 ${plan.index} 结束：退出码 ${code}，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s，结果 ${plan.jsonPath}`,
  );
  if (code !== 0) process.exitCode = code;
}

const entry = process.argv[1] ? new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href : '';
if (import.meta.url === entry) {
  main().catch((error) => {
    console.error('分片失败：', error);
    process.exit(1);
  });
}
