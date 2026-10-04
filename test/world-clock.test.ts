import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import {
  clockLabel,
  dayIndexOf,
  dayStartOf,
  fogGapDays,
  isFoggy,
  isFullMoon,
  moonPhase,
  moonPhaseLabel,
  nextFogDay,
  seasonOf,
  timeOfDay,
  worldClock,
} from '../src/domain/world/clock.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** 东八区的某个「年月日 时:分」→ 时间戳（测试里全部用注入的时钟，绝不读 Date.now()） */
function at(y: number, m: number, d: number, hour = 0, minute = 0): number {
  return Date.UTC(y, m - 1, d, hour - 8, minute);
}

test('世界时钟：时段边界与数值表一致（黎明 6—9 / 白天 9—18 / 黄昏 18—21 / 夜晚 21—6）', () => {
  const cases: Array<[number, string]> = [
    [6, 'dawn'], [8, 'dawn'],
    [9, 'day'], [17, 'day'],
    [18, 'dusk'], [20, 'dusk'],
    [21, 'night'], [23, 'night'],
    [0, 'night'], [5, 'night'],
  ];
  for (const [hour, expected] of cases) {
    assert.equal(timeOfDay(at(2026, 5, 1, hour)), expected, `${hour} 点应当是 ${expected}`);
  }
  // 边界与 numeric 里的旋钮一致（防止有人只改一处）
  const cfg = NUMERIC.world.clock;
  assert.equal(cfg.dawnStartHour, 6);
  assert.equal(cfg.dayStartHour, 9);
  assert.equal(cfg.duskStartHour, 18);
  assert.equal(cfg.nightStartHour, 21);
});

test('世界时钟：月相 30 天一周，第 15 日为月圆', () => {
  assert.equal(NUMERIC.world.clock.moonCycleDays, 30);
  assert.equal(NUMERIC.world.clock.fullMoonDay, 15);

  // 周期锚在日序号 0（1970-01-01）：第 1 天新月，第 15 天月圆
  const epoch = dayStartOf(0) + 12 * HOUR;
  assert.equal(moonPhase(epoch), 1);
  assert.equal(isFullMoon(epoch + 14 * DAY), true);
  assert.equal(moonPhase(epoch + 14 * DAY), 15);
  assert.equal(isFullMoon(epoch + 13 * DAY), false);
  assert.equal(moonPhase(epoch + 29 * DAY), 30);
  assert.equal(moonPhase(epoch + 30 * DAY), 1);

  // 任意一天都满足 phase = dayIndex % 30 + 1；30 天里恰好一次月圆
  const base = at(2026, 1, 1);
  const baseDay = dayIndexOf(base);
  for (let offset = 0; offset < 60; offset += 1) {
    assert.equal(moonPhase(base + offset * DAY), (((baseDay + offset) % 30) + 30) % 30 + 1);
  }
  let fullMoons = 0;
  for (let offset = 0; offset < 30; offset += 1) if (isFullMoon(base + offset * DAY)) fullMoons += 1;
  assert.equal(fullMoons, 1, '30 天周期里只能有一次月圆');

  assert.equal(moonPhaseLabel(15), '月圆');
  assert.equal(moonPhaseLabel(1), '新月');
  // 天序号与月相口径一致（同一个 dayIndex 必然同一个 phase）
  assert.equal(moonPhase(base + 30 * DAY), moonPhase(dayStartOf(baseDay + 30) + HOUR));
});

test('世界时钟：雾日每 3—7 天一次、持续 1 天，同 seed 完全可复现', () => {
  const cfg = NUMERIC.world.clock;
  for (let index = 0; index < 20; index += 1) {
    const gap = fogGapDays('world', index);
    assert.ok(gap >= cfg.fogGapMinDays && gap <= cfg.fogGapMaxDays, `间隔 ${gap} 越界`);
    assert.equal(gap, fogGapDays('world', index), '同 seed 同 index 必须同间隔');
  }

  const start = at(2026, 3, 1);
  const fogDays: number[] = [];
  for (let offset = 0; offset < 200; offset += 1) {
    if (isFoggy(start + offset * DAY, 'world')) fogDays.push(dayIndexOf(start) + offset);
  }
  assert.ok(fogDays.length > 20, '200 天里应当有 30 次上下的雾日');

  // 雾日成段出现，段长 = fogDurationDays（1 天）
  const starts: number[] = [];
  for (let i = 0; i < fogDays.length; i += 1) {
    if (i === 0 || fogDays[i]! !== fogDays[i - 1]! + 1) starts.push(fogDays[i]!);
  }
  for (const begin of starts) {
    const run = fogDays.filter((day) => day >= begin && day < begin + cfg.fogDurationDays).length;
    assert.equal(run, cfg.fogDurationDays, '一次雾日的持续天数必须是 1');
  }
  // 相邻两次雾日的间隔落在 3—7 天
  for (let i = 1; i < starts.length; i += 1) {
    const gap = starts[i]! - starts[i - 1]!;
    assert.ok(gap >= cfg.fogGapMinDays && gap <= cfg.fogGapMaxDays, `雾日间隔 ${gap} 越界`);
  }

  // 同一天反复调用结果一致；换个 seed 排布不同
  const probe = start + 40 * DAY;
  assert.equal(isFoggy(probe, 'world'), isFoggy(probe, 'world'));
  const other = Array.from({ length: 200 }, (_, i) => isFoggy(start + i * DAY, 'beta'));
  const mine = Array.from({ length: 200 }, (_, i) => isFoggy(start + i * DAY, 'world'));
  assert.notDeepEqual(other, mine, '不同 seed 应当排出不同的雾日');
});

test('世界时钟：worldClock 一次给全（时段 / 月相 / 雾日 / 季节）', () => {
  const now = at(2026, 9, 21, 22, 30);
  const clock = worldClock(now, 'world');
  assert.equal(clock.timeOfDay, 'night');
  assert.equal(clock.hour, 22);
  assert.equal(clock.season, 'autumn');
  assert.equal(seasonOf(at(2026, 1, 15)), 'winter');
  assert.equal(seasonOf(at(2026, 4, 15)), 'spring');
  assert.equal(seasonOf(at(2026, 7, 15)), 'summer');
  assert.ok(clock.nextFogDay >= clock.dayIndex, '下一个雾日不会早于今天');
  assert.equal(clockLabel(now), '22:30');
});

test('雾日：下一个雾日一定在 3—7 天内，且当天不是雾日', () => {
  const start = at(2026, 6, 1);
  for (let offset = 0; offset < 120; offset += 1) {
    const now = start + offset * DAY;
    const day = dayIndexOf(now);
    if (isFoggy(now, 'world')) continue;
    const next = nextFogDay('world', day);
    assert.ok(next > day, '下一个雾日必须在今天之后');
    assert.ok(
      next - day <= NUMERIC.world.clock.fogGapMaxDays,
      `下一个雾日太远：${next - day} 天`,
    );
  }
});
