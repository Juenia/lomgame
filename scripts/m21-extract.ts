/**
 * 实测分布提取（M2.1 第一步）
 *
 *   # 从归档行为日志提（W7/W8 的服务端临时库跑完就被删了，只有日志留下来）
 *   node scripts/m21-extract.ts --logs docs/W8-虚拟玩家-行为日志.jsonl,docs/W8-虚拟玩家边界轮-行为日志.jsonl \
 *     --out data/measured-mad-cor.json
 *
 *   # 从 domain_events 提（服务端权威账本，--keep-db 跑出来的库）
 *   node scripts/m21-extract.ts --db data/loadtest-xxx.db --out data/measured-mad-cor.json
 */
import { writeFileSync } from 'node:fs';
import { fromBehaviorLogs, fromDomainEvents } from '../src/sim/measured.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const out = arg('out') ?? 'data/measured-mad-cor.json';
  const db = arg('db');
  const logs = arg('logs');
  if (!db && !logs) {
    console.error('用法：--logs <a.jsonl,b.jsonl> 或 --db <sqlite>，可多个 --logs 叠加');
    process.exit(1);
  }

  const distribution = db
    ? fromDomainEvents(db)
    : await fromBehaviorLogs(logs!.split(',').map((entry) => entry.trim()));

  writeFileSync(out, JSON.stringify(distribution, null, 2), 'utf8');
  console.log('已写入 ' + out);
  console.log(
    '窗口：' + distribution.window.characters + ' 角色 × ' + distribution.window.days + ' 天，' +
      distribution.samples.length + ' 个角色天，回执 ' + distribution.diagnostics.records + ' 条（resync ' +
      distribution.diagnostics.resync + ' 次）',
  );
  for (const stats of distribution.byPersona) {
    console.log(
      '  ' + stats.persona.padEnd(14) + ' n=' + String(stats.characters).padStart(3) +
        ' 天=' + String(stats.days).padStart(2) + ' MAD 均' + String(stats.madMean).padStart(6) +
        ' P90 ' + String(stats.madP90).padStart(5) + ' 最大 ' + String(stats.madMax).padStart(3) +
        ' | COR 均' + String(stats.corMean).padStart(6) + ' | 死循环 ' + (stats.deadlockShare * 100).toFixed(1) + '%',
    );
  }
}

main().catch((error) => {
  console.error('提取失败：', error);
  process.exit(1);
});
