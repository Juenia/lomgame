#!/usr/bin/env node
/**
 * 合并分片报告（M2.3 任务四 §6.4）。
 *
 *   node scripts/vplayer-merge.ts \
 *     --shards "data/vplayer-shards/*.json" \
 *     --social data/vplayer-social/social.json \
 *     --out docs/M2.3-回归报告.md
 *
 * 合并逻辑全在 src/vplayer/merge.ts（纯函数、有单测），这里只是命令行外壳：
 * 展开通配、读文件、调合并、写报告。**手动拼数字在这条链路上没有任何入口。**
 */
import { globSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mergeShards, renderMergedReport, METRIC_PROVENANCE } from '../src/vplayer/merge.ts';
import { SHARD_SCHEMA, type ShardJson } from '../src/vplayer/shard-json.ts';

function argOf(argv: readonly string[], name: string, fallback?: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

function readShard(path: string): ShardJson {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as ShardJson;
  if (raw.schema !== SHARD_SCHEMA) {
    throw new Error(`${path} 不是 ${SHARD_SCHEMA} 口径（读到 ${raw.schema}）`);
  }
  return raw;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const pattern = argOf(argv, 'shards');
  if (!pattern) throw new Error('必须给 --shards "<glob>"');
  const out = argOf(argv, 'out', 'docs/M2.3-回归报告.md')!;
  /*
   * M2.17：`--ci <分片 JSON 路径>` —— 把 20×3 CI 那批的社交指标填进报告的社交一节。
   *
   * 为什么需要这个参数：分片跑的社交数字是失真的（交易与组队只在片内发生），
   * 所以报告里那一节永远来自**不分片小轮**（20 人 × 3 天的那一次 CI）。
   * 以前要靠人手把 `--social <path>` 传对；而 CI 那批的产物是同一种分片 JSON，
   * 用 `--ci` 说清它的**身份**（这是 CI 那一批）比 `--social` 更不容易传错。
   *
   * 两者语义相同（都读 shard.social），`--ci` 优先，`--social` 保留向后兼容。
   */
  const stage = argOf(argv, 'stage', 'M2.3')!;
  const socialPath = argOf(argv, 'social');
  // 实际墙钟（秒）：由分派方记录「四条命令同时起 → 最后一条结束」的真实跨度。
  // 不给就退化成「最慢那片自己的耗时」—— 那不含进程启动与并行排队，会略微低估。
  const wallClockSec = argOf(argv, 'wall-clock');

  const paths = globSync(pattern).map((path) => resolve(path)).sort();
  if (paths.length === 0) throw new Error(`没有匹配到任何分片结果：${pattern}`);
  const shards = paths.map(readShard);
  shards.sort((a, b) => a.shard - b.shard);

  const ciPath = argOf(argv, 'ci');
  const socialRef = ciPath ?? socialPath;
  const social = socialRef ? readShard(socialRef) : undefined;
  const merged = mergeShards(shards, {
    ...(social ? { social } : {}),
    ...(wallClockSec ? { wallClockMs: Number(wallClockSec) * 1000 } : {}),
  });
  const commandLine =
    `node scripts/vplayer-merge.ts --shards "${pattern}"` +
    (ciPath ? ` --ci ${ciPath}` : '') +
    (!ciPath && socialPath ? ` --social ${socialPath}` : '') +
    (wallClockSec ? ` --wall-clock ${wallClockSec}` : '') +
    ` --out ${out}`;

  const report = renderMergedReport(merged, {
    commandLine,
    stage,
    ...(socialRef ? { socialSource: socialRef } : {}),
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, report, 'utf8');

  const p0 = merged.anomalies.filter((anomaly) => anomaly.level === 'P0').length;
  const p1 = merged.anomalies.length - p0;
  console.log(`已合并 ${merged.shards} 片：${merged.players} 玩家 × ${merged.days} 天`);
  const chain = merged.coverage.longChain;
  console.log(
    `动作 ${merged.analysis.totalActions} 条、P0 ${p0}、P1 ${p1}、` +
      `长链路两段：入途径→8 ${chain.toSeq8.count} 人（≥ ${chain.toSeq8.required}）、` +
      `8→7 ${chain.toSeq7.count} 人（≥ ${chain.toSeq7.required}）、` +
      `墙钟 ${(merged.wallClockMs / 60000).toFixed(1)} 分钟`,
  );
  // M2.4：世界一致性是分片验收最要紧的一条，必须在控制台就看得见（不能只躺在报告里）
  console.log(
    `世界一致性：世界 seed ${merged.world.worldSeedAgreed ? '一致' : '**不一致**'}` +
      `（${merged.world.worldSeeds.join(' / ')}）；` +
      `事件序列 ${merged.world.idsAgreed ? '逐条一致' : '**分叉**'}` +
      `（摘要 ${merged.world.digests.join(' / ')}）` +
      `；各片条数 ${merged.world.countPerShard.join(' / ')}`,
  );
  console.log(`指标来源：${METRIC_PROVENANCE.filter((entry) => entry.source === 'shard').length} 项来自分片、${METRIC_PROVENANCE.filter((entry) => entry.source === 'single').length} 项来自不分片小轮`);
  if (!social) console.warn('警告：没有给 --ci / --social，报告里的社交指标一节会是空的（口径不完整）');
  console.log(`报告已写入：${out}`);
}

const entry = process.argv[1] ? new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href : '';
if (import.meta.url === entry) {
  main().catch((error) => {
    console.error('合并失败：', error);
    process.exit(1);
  });
}
