/**
 * 模拟器 CLI（W5）
 *
 * 用法：
 *   node src/sim/cli.ts --characters 1000 --days 30 --seed w5 --strategy all --out docs/W5-模拟报告.md
 *   node src/sim/cli.ts --characters 300 --days 30 --sweep lossOfControl.divisor=380,430,500
 *
 * --sweep 用 applyNumericOverrides 临时拧旋钮（只影响本次进程），用来试参数；
 * 确认后的终值写在 config/numeric.ts 里，并在文件里注明依据。
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { NUMERIC, applyNumericOverrides, resetNumeric } from '../config/numeric.ts';
import { checkTargets, renderMarkdown, renderOneLine } from './report.ts';
import { runSimulation, type SimConfig, type SimReport } from './simulator.ts';
import { STRATEGY_IDS, STRATEGIES, type StrategyId } from './strategy.ts';

export interface CliOptions {
  characters: number;
  days: number;
  seed: string;
  strategies: StrategyId[];
  out?: string;
  sweep?: { key: string; values: number[] };
  json: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    characters: 1000,
    days: 30,
    seed: 'w5',
    strategies: [...STRATEGY_IDS],
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === '--characters' && next) options.characters = Number(next);
    else if (arg === '--days' && next) options.days = Number(next);
    else if (arg === '--seed' && next) options.seed = next;
    else if (arg === '--out' && next) options.out = next;
    else if (arg === '--json') options.json = true;
    else if (arg === '--strategy' && next) {
      options.strategies = next === 'all' ? [...STRATEGY_IDS] : [next as StrategyId];
    } else if (arg === '--sweep' && next) {
      const [key, values] = next.split('=');
      options.sweep = { key: key ?? '', values: (values ?? '').split(',').map(Number) };
    }
  }
  return options;
}

function overridePath(key: string, value: number): Record<string, unknown> {
  const [group, field] = key.split('.');
  if (!group || !field) throw new Error(`--sweep 需要 group.field=值 形式，收到 ${key}`);
  return { [group]: { [field]: value } };
}

export function runAll(options: CliOptions): SimReport[] {
  return options.strategies.map((strategy) =>
    runSimulation({
      characterCount: options.characters,
      days: options.days,
      seed: `${options.seed}-${strategy}`,
      strategy,
    } satisfies SimConfig),
  );
}

export function buildDocument(options: CliOptions, reports: SimReport[]): string {
  const lines: string[] = [];
  lines.push('# W5 数值模拟报告');
  lines.push('');
  lines.push(`- 生成命令：\`node src/sim/cli.ts --characters ${options.characters} --days ${options.days} --seed ${options.seed} --strategy all --out docs/W5-模拟报告.md\``);
  lines.push(`- 规模：${options.characters} 虚拟角色 × ${options.days} 天 × 3 种策略`);
  lines.push(`- 复现：同一条命令必然产出同一份报告（每个角色、每一天、每个动作的 seed 都由 config.seed 派生）`);
  lines.push('- 规则来源：模拟器只调用真实纯函数（resolvePlay / resolveExplore / resolveBrew / resolveDrink / resolvePromotion / planCharacterTick / planRest / planPurify / apply），背包规则与 InventoryRepo 共用同一份纯函数');
  lines.push('');
  lines.push('## 一、终值一览（写进 src/config/numeric.ts 的值与依据）');
  lines.push('');
  lines.push('| 旋钮 | 终值 | 依据 |');
  lines.push('|---|---|---|');
  lines.push(
    '| `lossOfControl.divisor` | ' + NUMERIC.lossOfControl.divisor +
      ' | M2.1 按实测分布回灌重定（W5 旧值 430）；扫参与依据见 docs/M2-失控重定报告.md |',
  );
  lines.push(
    '| `lossOfControl.madThreshold / corThreshold` | ' + NUMERIC.lossOfControl.madThreshold + ' / ' +
      NUMERIC.lossOfControl.corThreshold +
      ' | 公式形状不变（只统计超出阈值的部分）；W5 旧闸门 80/70 在实测分布下是空闸门 |',
  );
  lines.push('| `play.exposureChance` | 0.38 | 0.30 时 MAD 涨不起来（30 天期末 MAD≈0.2）；0.45 时激进型失控率 41.8% 超上限 |');
  lines.push('| `promotion.madPenalty` | 0.30 | 0.15 时激进型晋升成功率 82%（目标 50%—70%）；0.30 后落到 61.6% |');
  lines.push('| `promotion.corPenalty` | 0.15 | 与 madPenalty 同步调高，保证 COR 也是晋升阻力 |');
  lines.push('| `potion.madOnDrink` | 6 | 8 时激进型失控率与死循环双双超线；6 让「喝魔药」保持代价但可控 |');
  lines.push('| `recovery.purify.mad` | -8 | 只压污染时，双阈值卡死比例下不来（6.2%）；同时压疯狂后降到 4.6% |');
  lines.push('| `recovery.purify.materials` | 圣盐 ×1 | 原本要圣盐+银粉，会和魔药抢材料导致净化用不起（死循环 7.5%） |');
  lines.push('| `explore.bonusDropChance` | 0.06 | 0.35 时材料产出是消耗的 3 倍（比值 0.05）；0.06 后 0.81—0.87 |');
  lines.push('| 配方材料数 | 主材料 + 辅助材料各 1 | 三件材料（主+2 辅）时同时凑齐概率过低，材料只进不出（比值 0.44） |');
  lines.push('| 夜香草 | 材料 → 消耗品（MAD-3） | 配方简化后它没有消耗方，会让材料产出虚高且变成死内容 |');
  lines.push('');
  lines.push('## 二、三策略结果');
  lines.push('');
  for (const report of reports) {
    lines.push(renderMarkdown(report, {
      title: `${report.config.strategyName}（${report.config.characterCount} 角色 × ${report.config.days} 天，seed=${report.config.seed}）`,
    }));
    lines.push('');
  }
  lines.push('## 三、目标区间总核对');
  lines.push('');
  lines.push('| 策略 | 目标 | 实测 | 结论 |');
  lines.push('|---|---|---|---|');
  for (const report of reports) {
    for (const check of checkTargets(report)) {
      lines.push(`| ${report.config.strategyName} | ${check.name}（${check.target}） | ${check.actual} | ${check.pass ? '达标' : '未达标'} |`);
    }
  }
  lines.push('');
  lines.push('## 四、死循环口径说明');
  lines.push('');
  lines.push('死循环 = 期末仍是序列 9 **且** DIG 已达门槛 **且** MAD ≥ 80 且 COR ≥ 70（双阈值之上）。');
  lines.push('这类角色每天都可能失控，又拿不到晋升收益，是真正被代价拖死的状态。');
  lines.push('报告里同时给出分档（只超 COR / 只超 MAD / 双超），便于判断这个比例从哪来。');
  lines.push('');
  lines.push('## 五、策略定义');
  lines.push('');
  for (const strategy of Object.values(STRATEGIES)) {
    lines.push(`- **${strategy.name}**：${strategy.description}`);
  }
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  if (options.sweep) {
    for (const value of options.sweep.values) {
      resetNumeric();
      applyNumericOverrides(overridePath(options.sweep.key, value));
      for (const report of runAll({ ...options, strategies: options.strategies })) {
        console.log(`${options.sweep.key}=${value} ${renderOneLine(report)}`);
      }
    }
    resetNumeric();
    return;
  }

  const reports = runAll(options);
  if (options.json) {
    console.log(JSON.stringify(reports.map((report) => report.summary), null, 2));
  } else if (options.out) {
    writeFileSync(options.out, buildDocument(options, reports), 'utf8');
    console.log(`报告已写入 ${options.out}`);
    for (const report of reports) console.log(renderOneLine(report));
  } else {
    for (const report of reports) {
      console.log(renderMarkdown(report));
      console.log(renderOneLine(report));
      console.log('');
    }
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entry) main();
