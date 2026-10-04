import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC, applyNumericOverrides, resetNumeric } from '../src/config/numeric.ts';
import { loadLocations } from '../src/data/loader.ts';
import { dayStartOf, worldClock } from '../src/domain/world/clock.ts';
import {
  WEATHER_IDS,
  bonusDropChanceWith,
  combineDangerMultiplier,
  initialWeatherState,
  isEpicWeather,
  neighborsOf,
  normalizeWeather,
  rollWeatherAt,
  tickWeather,
  weatherEffectLines,
  weatherLabel,
  weatherRow,
  weatherDurationAt,
  weatherWeight,
  weatherWeightContext,
  worldModifiers,
  type WeatherId,
  type WeatherState,
} from '../src/domain/world/weather.ts';
import { createSeededRng } from '../src/domain/rng.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const LOCATIONS = loadLocations().locations;

function at(y: number, m: number, d: number, hour = 0): number {
  return Date.UTC(y, m - 1, d, hour - 8);
}

function stateOf(locationId: string, weather: WeatherId, now: number, until: number): WeatherState {
  return { locationId, weather, since: now, until, pendingWeather: null, pendingAt: null };
}

test('天气：八种天气齐全，影响表六个维度都有值（探索危险/掉落/扮演/魔药/失控/事件池）', () => {
  assert.equal(WEATHER_IDS.length, 8);
  assert.deepEqual(
    WEATHER_IDS.map((id) => weatherLabel(id)).sort(),
    ['晴', '雾', '雨', '雷暴', '灰雾潮', '血月', '静默', '灵界渗透'].sort(),
  );
  for (const id of WEATHER_IDS) {
    const row = weatherRow(id);
    for (const key of ['exploreDanger', 'drop', 'playMad', 'playDig', 'potionSuccess', 'lossOfControl'] as const) {
      assert.equal(typeof row[key], 'number', `${id}.${key} 必须是数字`);
      assert.ok(Number.isFinite(row[key]), `${id}.${key} 必须有限`);
    }
    assert.ok(row.exploreDanger > 0 && row.drop > 0, `${id} 的倍率必须为正`);
    assert.ok(row.potionSuccess > -1 && row.potionSuccess < 1, `${id} 的成功率增量必须在 ±100% 内`);
    assert.ok(Array.isArray(row.eventPool), `${id} 必须有事件池字段`);
    assert.ok(weatherEffectLines(id).length >= 6, `${id} 的影响文案至少 6 行`);
    assert.ok(weatherLabel(id).length > 0);
  }
  // 显著天气（要全群播报 + 提前预告）就是血月与灵界渗透
  assert.deepEqual(WEATHER_IDS.filter((id) => isEpicWeather(id)).sort(), ['blood_moon', 'spirit_creep']);
  // 未知值一律归一化成晴（库里存了脏数据也不能崩）
  assert.equal(normalizeWeather('nonsense'), 'clear');
  assert.equal(normalizeWeather(null), 'clear');
});

test('天气：生成权重受时段 / 季节 / 世界状态影响', () => {
  const night = { timeOfDay: 'night' as const, season: 'autumn' as const, fullMoon: false, foggy: false };
  const day = { timeOfDay: 'day' as const, season: 'autumn' as const, fullMoon: false, foggy: false };
  assert.ok(
    weatherWeight('blood_moon', night) > weatherWeight('blood_moon', day) * 5,
    '血月在夜晚的权重必须远高于白天',
  );
  assert.ok(
    weatherWeight('spirit_creep', night) > weatherWeight('spirit_creep', day),
    '灵界渗透夜里更容易出现',
  );
  // 月圆抬血月、雾日抬雾与灰雾潮
  const fullMoon = { ...night, fullMoon: true };
  assert.equal(weatherWeight('blood_moon', fullMoon), weatherWeight('blood_moon', night) * 5);
  const foggy = { ...day, foggy: true };
  assert.ok(weatherWeight('fog', foggy) > weatherWeight('fog', day) * 2);
  assert.ok(weatherWeight('greyfog_tide', foggy) > weatherWeight('greyfog_tide', day) * 2);
  // 季节
  const summer = { ...day, season: 'summer' as const };
  assert.ok(weatherWeight('storm', summer) > weatherWeight('storm', day));
});

test('天气：按 tick 键抽取是纯函数（同 seed 同地点同时刻 → 同结果）', () => {
  const ctx = weatherWeightContext(worldClock(at(2026, 3, 1, 23)));
  const a = rollWeatherAt({ seed: 'world', locationId: 'tingen', rollAt: 1_000_000, ctx });
  const b = rollWeatherAt({ seed: 'world', locationId: 'tingen', rollAt: 1_000_000, ctx });
  assert.equal(a, b, '同输入必须同输出');
  // 不同地点 / 不同时刻会得到不同序列（不要求必然不同，但换个 seed 必须能变）
  const other = rollWeatherAt({ seed: 'beta', locationId: 'tingen', rollAt: 1_000_000, ctx });
  assert.equal(typeof other, 'string');
  assert.ok(WEATHER_IDS.includes(a));
});

test('天气：不同地点的节拍会散开，不会永远同步（定点刷新不是演化）', () => {
  /*
   * 这条守的是 M2.53 的核心修复，起因是世界面板上的一眼：
   * 58 个地点的「持续到」**全是同一个时刻**、时长**全是 6 小时** ——
   * 全服整点一起换天气。那不是世界在演化，那是钟表在响。
   *
   * 下游全被带着走：环境播报的判据是「这个地点当前天气的 since 落在本小时」，
   * 于是血月/灵界渗透/灰雾潮会在同一刻被几个地点一起抽中，一个整点刷出三条、
   * 而整个白天其余时间一条都没有；扩散（+2 小时）同样是全服一起落地。
   */
  const ids = LOCATIONS.slice(0, 12).map((location) => location.id);
  const t0 = at(2026, 3, 1, 0);

  // 冷启动就该错开：相位由 (seed, 地点) 派生，落在 [0, 基准时长) 里
  const start = ids.map((id) => initialWeatherState(id, t0, 'world'));
  assert.ok(new Set(start.map((state) => state.until)).size > 1, '冷启动的相位没有错开');
  assert.deepEqual(
    ids.map((id) => initialWeatherState(id, t0, 'world').until),
    start.map((state) => state.until),
    '相位必须是确定性的：同 seed 同地点同起点 → 同一个相位',
  );

  // 跑满一天之后，到期时刻仍然要散落在多个小时里
  let states: readonly WeatherState[] = start;
  for (let hour = 0; hour < 24; hour += 1) {
    const now = t0 + (hour + 1) * HOUR;
    states = tickWeather({
      states,
      locations: LOCATIONS,
      now,
      seed: 'world',
      ctx: weatherWeightContext(worldClock(now, 'world')),
    }).states;
  }
  const hours = new Set(states.map((state) => Math.floor(state.until / HOUR)));
  assert.ok(
    hours.size >= 3,
    '跑了一天之后 12 个地点的到期时刻只落在 ' + hours.size + ' 个小时里 —— 那还是定点刷新，不是演化',
  );
});

test('天气 tick：过期地点换新天气，没过期的地点一动不动', () => {
  const now = at(2026, 3, 1, 10);
  const states = [
    stateOf('tingen', 'rain', now - 6 * HOUR, now), // 正好过期
    stateOf('backlund', 'fog', now - HOUR, now + 5 * HOUR), // 还早
  ];
  const out = tickWeather({
    states,
    locations: LOCATIONS,
    now,
    seed: 'world',
    ctx: weatherWeightContext(worldClock(now, 'world')),
  });
  const tingen = out.states.find((state) => state.locationId === 'tingen')!;
  const backlund = out.states.find((state) => state.locationId === 'backlund')!;
  assert.equal(backlund.weather, 'fog', '没过期的地点不该变');
  assert.equal(backlund.since, now - HOUR);
  assert.equal(tingen.since, now, '换天气的时刻就是原 until');
  /*
   * ⚠️ 这里**不能**再断言 until === since + durationMs —— 那是旧契约。
   *
   * 时长恒为 6 小时，配合冷启动时所有地点从同一个整点起步，58 个地点就永远
   * 同步换天气。现在时长按 (seed, 地点, 起点) 确定性抖动，落在 [3h, 9h]。
   */
  const span = tingen.until - tingen.since;
  const lo = NUMERIC.world.weather.durationMs * (1 - NUMERIC.world.weather.durationJitter);
  const hi = NUMERIC.world.weather.durationMs * (1 + NUMERIC.world.weather.durationJitter);
  assert.ok(span >= lo && span <= hi, '时长必须落在抖动区间里，实际 ' + span);
  assert.equal(span, weatherDurationAt('world', 'tingen', now), '同一 (seed, 地点, 起点) 必须给同一个时长');
  assert.equal(out.changes.length, 1);
  assert.equal(out.changes[0]!.reason, 'expire');

  // 同一个 now 再跑一遍：状态机已经推进过，什么都不发生（幂等的底层保证）
  const again = tickWeather({
    states: out.states,
    locations: LOCATIONS,
    now,
    seed: 'world',
    ctx: weatherWeightContext(worldClock(now, 'world')),
  });
  assert.equal(again.changes.length, 0, '同一时刻重复推进不得重复结算');
});

test('天气扩散：相邻地点 2 小时后同步，隔一层的邻居不会直接抄到', () => {
  const now = at(2026, 3, 1, 10);
  const weathers: WeatherId[] = WEATHER_IDS;
  const states = LOCATIONS.map((location) =>
    stateOf(location.id, 'clear', now - HOUR, location.id === 'tingen' ? now : now + 5 * HOUR),
  );
  void weathers;

  const first = tickWeather({
    states,
    locations: LOCATIONS,
    now,
    seed: 'world',
    ctx: weatherWeightContext(worldClock(now, 'world')),
  });
  const source = first.states.find((state) => state.locationId === 'tingen')!;
  const neighbors = neighborsOf('tingen', LOCATIONS);
  assert.ok(neighbors.length >= 2, '廷根市必须有邻居');
  for (const id of neighbors) {
    const neighbor = first.states.find((state) => state.locationId === id)!;
    assert.equal(neighbor.pendingWeather, source.weather, `${id} 应当排队等扩散`);
    assert.equal(neighbor.pendingAt, now + NUMERIC.world.weather.diffusionDelayMs, '扩散延迟必须是 2 小时');
    assert.notEqual(neighbor.weather, source.weather, '2 小时之内还不会同步');
  }
  // 隔一层的地点（廷根的邻居的邻居）此刻不该拿到 pending
  const distant = LOCATIONS.map((l) => l.id).filter(
    (id) => id !== 'tingen' && !neighbors.includes(id),
  );
  for (const id of distant) {
    const state = first.states.find((s) => s.locationId === id)!;
    if (state.pendingWeather === null) continue;
    assert.ok(!neighbors.includes(id));
  }

  // 2 小时后：扩散落地
  const later = tickWeather({
    states: first.states,
    locations: LOCATIONS,
    now: now + NUMERIC.world.weather.diffusionDelayMs,
    seed: 'world',
    ctx: weatherWeightContext(worldClock(now + NUMERIC.world.weather.diffusionDelayMs, 'world')),
  });
  for (const id of neighbors) {
    const neighbor = later.states.find((state) => state.locationId === id)!;
    assert.equal(neighbor.weather, source.weather, `${id} 应当在 2 小时后同步`);
    assert.equal(neighbor.pendingWeather, null);
  }
  assert.ok(later.changes.some((change) => change.reason === 'diffusion'));
  // 源地点在扩散时还没过期，不该被顺带换掉
  assert.equal(later.states.find((state) => state.locationId === 'tingen')!.weather, source.weather);
});

test('天气：显著天气（血月 / 灵界渗透）进播报，极罕见天气提前 2 小时预告', () => {
  const now = at(2026, 3, 1, 23);
  const snapshot = JSON.parse(JSON.stringify(NUMERIC.world.weather.effects)) as Record<string, { weight: number }>;
  // 把所有天气的权重清零，只留灵界渗透 —— 这样"抽到什么"是确定的，断言才有意义
  for (const id of WEATHER_IDS) applyNumericOverrides({ world: { weather: { effects: { [id]: { weight: 0 } } } } });
  applyNumericOverrides({ world: { weather: { effects: { spirit_creep: { weight: 1 } } } } });
  try {
    const states = [stateOf('tingen', 'clear', now - 6 * HOUR, now), stateOf('backlund', 'clear', now - HOUR, now + 5 * HOUR)];
    const out = tickWeather({
      states,
      locations: LOCATIONS,
      now,
      seed: 'world',
      ctx: weatherWeightContext(worldClock(now, 'world')),
    });
    assert.equal(out.states.find((state) => state.locationId === 'tingen')!.weather, 'spirit_creep');
    assert.equal(out.broadcasts.length, 1, '显著天气开始要全群播报');
    assert.equal(out.broadcasts[0]!.to, 'spirit_creep');

    // 2 小时预告：进入 until - 2h 的窗口时给出预告
    const until = out.states.find((state) => state.locationId === 'tingen')!.until;
    const atForecast = tickWeather({
      states: out.states,
      locations: LOCATIONS,
      now: until - NUMERIC.world.weather.forecastLeadMs,
      seed: 'world',
      ctx: weatherWeightContext(worldClock(until - NUMERIC.world.weather.forecastLeadMs, 'world')),
    });
    assert.ok(
      atForecast.forecasts.some((entry) => entry.locationId === 'tingen' && entry.weather === 'spirit_creep'),
      '极罕见天气必须提前 2 小时预告',
    );
  } finally {
    resetNumeric();
    for (const [id, row] of Object.entries(snapshot)) {
      applyNumericOverrides({ world: { weather: { effects: { [id]: { weight: row.weight } } } } });
    }
    resetNumeric();
  }
});

test('时段影响：探索危险 黎明 -10% / 夜晚 +10%，雾日全服 +20%', () => {
  const cfg = NUMERIC.world.timeOfDay;
  assert.deepEqual(cfg.exploreDangerMultiplier, { dawn: 0.9, day: 1, dusk: 1, night: 1.1 });
  assert.equal(cfg.foggyExploreDangerMultiplier, 1.2);

  const dawn = worldClock(at(2026, 3, 1, 7));
  const day = worldClock(at(2026, 3, 1, 12));
  const night = worldClock(at(2026, 3, 1, 23));
  assert.equal(worldModifiers({ clock: dawn, weather: 'clear' }).exploreDangerMultiplier, 0.9);
  assert.equal(worldModifiers({ clock: day, weather: 'clear' }).exploreDangerMultiplier, 1);
  assert.equal(worldModifiers({ clock: night, weather: 'clear' }).exploreDangerMultiplier, 1.1);

  // 雾日：全服 ×1.2（叠在时段之上）
  const foggyNight = { ...night, foggy: true };
  assert.ok(
    Math.abs(worldModifiers({ clock: foggyNight, weather: 'clear' }).exploreDangerMultiplier - 1.1 * 1.2) <
      1e-9,
  );
  // 天气的危险倍率再乘一层
  assert.equal(
    worldModifiers({ clock: day, weather: 'storm' }).exploreDangerMultiplier,
    weatherRow('storm').exploreDanger,
  );
  // 与能力的倍率相乘（不眠者序列 8 的 0.8）
  assert.ok(Math.abs(combineDangerMultiplier(1.1, 0.8) - 1.1 * 0.8) < 1e-12);
});

test('时段影响：不眠者夜晚消化 +20%，其他途径夜晚每次扮演 MAD +1', () => {
  const night = worldClock(at(2026, 3, 1, 23));
  const day = worldClock(at(2026, 3, 1, 12));
  const cfg = NUMERIC.world.timeOfDay;

  const sleepless = worldModifiers({ clock: night, weather: 'clear', path: 'sleepless' });
  assert.equal(sleepless.playDigMultiplier, cfg.sleeplessNightDigMultiplier);
  assert.equal(sleepless.playMad, 0, '不眠者夜里不加 MAD');

  const seer = worldModifiers({ clock: night, weather: 'clear', path: 'seer' });
  assert.equal(seer.playMad, cfg.nightPlayMad);
  assert.equal(seer.playDigMultiplier, 1);

  // 白天两条途径都没有加成
  assert.equal(worldModifiers({ clock: day, weather: 'clear', path: 'seer' }).playMad, 0);
  assert.equal(worldModifiers({ clock: day, weather: 'clear', path: 'sleepless' }).playDigMultiplier, 1);
});

test('月圆：仪式成功率 +15 个百分点、失控概率 ×1.1；天气事件池只加不减', () => {
  const cfg = NUMERIC.world.timeOfDay;
  assert.equal(cfg.fullMoonBrewSuccessBonus, 0.15);
  assert.equal(cfg.fullMoonLossOfControlMultiplier, 1.1);

  // 月圆日 = 日序号 % 30 === 14
  const fullMoon = worldClock(dayStartOf(14) + 12 * HOUR, 'world');
  assert.equal(fullMoon.fullMoon, true);
  const brew = worldModifiers({ clock: fullMoon, weather: 'clear' });
  assert.equal(brew.potionSuccessBonus, cfg.fullMoonBrewSuccessBonus);
  assert.equal(brew.lossOfControlMultiplier, cfg.fullMoonLossOfControlMultiplier);

  // 普通日没有月圆加成
  const plain = worldClock(dayStartOf(3) + 12 * HOUR, 'world');
  assert.equal(plain.fullMoon, false);
  assert.equal(worldModifiers({ clock: plain, weather: 'clear' }).potionSuccessBonus, 0);

  // 事件池：晴不注入任何卡（普通日卡池不受影响）
  assert.deepEqual(worldModifiers({ clock: plain, weather: 'clear' }).eventPool, []);
  assert.ok(weatherRow('blood_moon').eventPool.length > 0);
  // 掉落倍率 → 概率（clamp 到 1）
  assert.equal(bonusDropChanceWith(1), NUMERIC.explore.bonusDropChance);
  assert.equal(bonusDropChanceWith(3), Math.min(1, NUMERIC.explore.bonusDropChance * 3));
  assert.equal(bonusDropChanceWith(0), 0);
});

test('天气扩散图：相邻关系是双向的，且指到的地点都存在', () => {
  const ids = new Set(LOCATIONS.map((location) => location.id));
  for (const location of LOCATIONS) {
    assert.ok(location.adjacent.length > 0, `${location.id} 没有邻居，天气没法扩散`);
    for (const id of location.adjacent) {
      assert.ok(ids.has(id), `${location.id} 指向了不存在的地点 ${id}`);
      const other = LOCATIONS.find((entry) => entry.id === id)!;
      assert.ok(
        other.adjacent.includes(location.id),
        `${location.id} ↔ ${id} 的相邻关系必须双向声明`,
      );
    }
  }
  assert.ok(neighborsOf('tingen', LOCATIONS).length >= 2);
});

test('天气：完整一天里每个地点的天气都会变化，且始终是八种之一', () => {
  const start = at(2026, 3, 1, 0);
  let states = LOCATIONS.map((location) => stateOf(location.id, 'clear', start, start + 6 * HOUR));
  const seen = new Set<WeatherId>();
  const rng = createSeededRng('weather-sweep');
  for (let hour = 1; hour <= 72; hour += 1) {
    const now = start + hour * HOUR;
    const out = tickWeather({
      states,
      locations: LOCATIONS,
      now,
      seed: 'world',
      ctx: weatherWeightContext(worldClock(now, 'world')),
    });
    states = out.states;
    for (const state of states) {
      assert.ok(WEATHER_IDS.includes(state.weather), `出现未知天气 ${state.weather}`);
      assert.ok(state.until > state.since, '天气的结束时刻必须晚于开始时刻');
      seen.add(state.weather);
    }
  }
  assert.ok(seen.size >= 3, `72 小时里应当出现多种天气，实际 ${seen.size} 种`);
  void rng;
});
