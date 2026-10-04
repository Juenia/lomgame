/**
 * 天气影响表生成器（M2.2 交付物之一）
 *
 *   node scripts/m22-weather-table.ts --out docs/M2.2-天气影响表.md
 *
 * 表由 `src/config/numeric.ts` 直接渲染 —— 数值只有一个出处，文档不会与代码漂移。
 */
import { writeFileSync } from 'node:fs';
import { NUMERIC } from '../src/config/numeric.ts';
import { WEATHER_IDS, weatherRow } from '../src/domain/world/weather.ts';

const NL = String.fromCharCode(10);
const pct = (value: number): string => ((value - 1) * 100 >= 0 ? '+' : '') + ((value - 1) * 100).toFixed(0) + '%';
const signed = (value: number, digits = 0): string => (value >= 0 ? '+' : '') + value.toFixed(digits);

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const TIER_LABEL: Record<string, string> = {
  common: '常见',
  uncommon: '少见',
  rare: '稀有',
  epic: '显著（全群播报 + 提前预告）',
};

const lines: string[] = [];
const push = (line: string): void => void lines.push(line);
const clock = NUMERIC.world.clock;
const tod = NUMERIC.world.timeOfDay;
const weather = NUMERIC.world.weather;

push('# M2.2 天气影响表');
push('');
push('> 本文件由 ' + '`node scripts/m22-weather-table.ts`' + ' 从 ' + '`src/config/numeric.ts`' + ' 直接渲染，');
push('> **数值的唯一出处是 numeric.ts**；改数值请改代码再重新生成，不要手改这张表。');
push('');
push('## 一、世界时钟参数');
push('');
push('| 项 | 值 | 说明 |');
push('|---|---|---|');
push('| 时区 | 东八区（UTC+' + clock.tzOffsetMinutes / 60 + '） | 与 `infra/date.ts` 的每日边界同一口径 |');
push('| 黎明 | ' + clock.dawnStartHour + ':00—' + clock.dayStartHour + ':00 | 探索危险 ×' + tod.exploreDangerMultiplier.dawn + ' |');
push('| 白天 | ' + clock.dayStartHour + ':00—' + clock.duskStartHour + ':00 | 基准 1.0 |');
push('| 黄昏 | ' + clock.duskStartHour + ':00—' + clock.nightStartHour + ':00 | 基准 1.0 |');
push('| 夜晚 | ' + clock.nightStartHour + ':00—' + clock.dawnStartHour + ':00 | 探索危险 ×' + tod.exploreDangerMultiplier.night + '；其他途径每次扮演 MAD +' + tod.nightPlayMad + '；不眠者消化 ×' + tod.sleeplessNightDigMultiplier + ' |');
push('| 月相周期 | ' + clock.moonCycleDays + ' 天 | 第 ' + clock.fullMoonDay + ' 日为月圆（农历十五） |');
push('| 月圆 | 调制成功率 +' + (tod.fullMoonBrewSuccessBonus * 100).toFixed(0) + ' 个百分点，失控概率 ×' + tod.fullMoonLossOfControlMultiplier + ' | — |');
push('| 雾日 | 每 ' + clock.fogGapMinDays + '—' + clock.fogGapMaxDays + ' 天一次，持续 ' + clock.fogDurationDays + ' 天 | 全服探索危险 ×' + tod.foggyExploreDangerMultiplier + ' |');
push('');
push('时段边界与系数一一对应，测试见 ' + '`test/world-clock.test.ts`' + ' 与 ' + '`test/weather.test.ts`' + '。');
push('');
push('## 二、八种天气总览');
push('');
push('| 天气 | 档位 | 基础权重 | 时段偏置 | 季节偏置 | 世界状态偏置 |');
push('|---|---|---|---|---|---|');
for (const id of WEATHER_IDS) {
  const row = weatherRow(id);
  const time = Object.entries(row.timeBias).map(([key, value]) => key + ' ×' + value).join('、') || '—';
  const season = Object.entries(row.seasonBias).map(([key, value]) => key + ' ×' + value).join('、') || '—';
  const world = Object.entries(row.worldBias).map(([key, value]) => key + ' ×' + value).join('、') || '—';
  push('| ' + row.label + '（`' + id + '`） | ' + (TIER_LABEL[row.tier] ?? row.tier) + ' | ' + row.weight + ' | ' + time + ' | ' + season + ' | ' + world + ' |');
}
push('');
push('生成权重 = 基础权重 × 时段偏置 × 季节偏置 × 世界状态偏置（月圆 / 雾日）。');
push('抽签按 tick 键派生随机流：`weather:{种子}:{地点}:{换天气时刻}` —— 因此「下一刻是什么天气」在任意时刻都能纯函数地算出来，');
push('极罕见天气的 2 小时预告与真正换天气用的是同一个答案（不会说谎）。');
push('');
push('## 三、影响表（每个地点的天气独立，八种各自一套系数）');
push('');
push('| 天气 | 探索危险 | 掉落 | 扮演消化 | 扮演疯狂 | 调制成功率 | 失控概率 | 事件池 |');
push('|---|---|---|---|---|---|---|---|');
for (const id of WEATHER_IDS) {
  const row = weatherRow(id);
  push('| ' + row.label + ' | ×' + row.exploreDanger.toFixed(2) + ' | ×' + row.drop.toFixed(2) + ' | ×' + row.playDig.toFixed(2) +
    ' | ' + signed(row.playMad) + '/次 | ' + signed(row.potionSuccess * 100) + '% | ×' + row.lossOfControl.toFixed(2) +
    ' | ' + (row.eventPool.length > 0 ? row.eventPool.join('、') : '—') + ' |');
}
push('');
push('字段口径：');
push('');
push('- **探索危险**：乘在 `dangerTriggerBase × 地点 danger × 能力倍率` 上（倍率相乘，不引入新公式）。');
push('- **掉落**：乘在「额外掉落判定」的概率上（`bonusDropChance × 倍率`，clamp 0—1）；掉落表权重不动。');
push('- **扮演消化 / 扮演疯狂**：消化倍率乘在本次增量上；疯狂是绝对值增量。');
push('- **调制成功率**：绝对百分点，加在 `computePotionSuccess` 之后，仍夹在 5%—95%。');
push('- **失控概率**：乘在 `computeLossOfControlProbability` 上（硬闸门保留：MAD/COR 都没过阈时连骰子都不掷）。');
push('- **事件池**：该天气把这几张卡**加进**探索候选池；它们自己的 cond / 地点限制照旧。');
push('');
push('## 四、事件池明细（天气只加不减）');
push('');
push('| 天气 | 注入的卡 |');
push('|---|---|');
for (const id of WEATHER_IDS) {
  const row = weatherRow(id);
  if (row.eventPool.length === 0) continue;
  push('| ' + row.label + ' | ' + row.eventPool.join('、') + ' |');
}
push('');
push('**普通日卡池不受天气影响**：这些卡只在对应天气生效时进池，晴（clear）的池子是空的；');
push('事件池只做「筛选」，不改卡权重、不改抽卡通道（`.探索` 仍是均匀抽）。');
push('');
push('## 五、机制参数');
push('');
push('| 参数 | 值 |');
push('|---|---|');
push('| 一次天气持续 | ' + weather.durationMs / 3600000 + ' 小时 |');
push('| 轻 tick 间隔 | ' + weather.lightTickMs / 3600000 + ' 小时（检查过期、刷新天气、落库） |');
push('| 相邻地点同步延迟 | ' + weather.diffusionDelayMs / 3600000 + ' 小时（源地点换天气后，邻居到点跟进；源天气已过期则不搬运） |');
push('| 极罕见天气预告 | 提前 ' + weather.forecastLeadMs / 3600000 + ' 小时 |');
push('| 启动补跑上限 | 轻 tick ' + weather.maxCatchUpLight + ' 格 / 重 tick ' + weather.maxCatchUpHeavy + ' 格 |');
push('');
push('## 六、与其他系统的边界');
push('');
push('| 系统 | 天气是否影响 | 说明 |');
push('|---|---|---|');
push('| 探索危险 / 掉落 | ✅ | 见第三节 |');
push('| 扮演消化 / 疯狂 | ✅ | 见第三节 |');
push('| 魔药调制 / 服用 | ✅ | 成功率增量与失控倍率 |');
push('| 事件卡池 | ✅（只加不减） | 见第四节 |');
push('| 普通日卡池 | ❌ | 天气不稀释、不替换 |');
push('| 晋升成功率 | ❌ | W5 定值不动 |');
push('| 暴露概率 | ❌ | W5 定值不动（0.38） |');
push('| 每日 tick 恢复量 | ❌ | W5 定值不动（AP 5 / MP 30） |');
push('');
push('## 七、复现');
push('');
push('```bash');
push('node scripts/m22-weather-table.ts --out docs/M2.2-天气影响表.md');
push('node --test test/world-clock.test.ts test/weather.test.ts test/world-tick.test.ts test/world-command.test.ts');
push('```');
push('');

writeFileSync(arg('out', 'docs/M2.2-天气影响表.md'), lines.join(NL), 'utf8');
console.log('已写入 ' + arg('out', 'docs/M2.2-天气影响表.md') + '（' + WEATHER_IDS.length + ' 种天气）');
