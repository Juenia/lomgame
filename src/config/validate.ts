/**
 * 配置校验（W5 运维项）：启动时检查 config/numeric.ts 的取值是否自洽。
 * 数值写错（负数、概率越界、上下限颠倒）不该等到玩家踩到才发现。
 */
import { NUMERIC } from './numeric.ts';
import { COND_FIELDS } from '../domain/event/trigger.ts';

export interface ConfigIssue {
  level: 'error' | 'warn';
  path: string;
  message: string;
}

function checkProb(issues: ConfigIssue[], path: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    issues.push({ level: 'error', path, message: `概率必须在 0—1，当前 ${value}` });
  }
}

function checkPositive(issues: ConfigIssue[], path: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    issues.push({ level: 'error', path, message: `必须为正数，当前 ${value}` });
  }
}

function checkRange(
  issues: ConfigIssue[],
  path: string,
  value: number,
  min: number,
  max: number,
): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    issues.push({ level: 'error', path, message: `必须在 ${min}—${max}，当前 ${value}` });
  }
}

export function validateNumeric(numeric = NUMERIC): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  checkProb(issues, 'play.exposureChance', numeric.play.exposureChance);
  checkPositive(issues, 'playScore.tagDailyCap', numeric.playScore.tagDailyCap);
  checkRange(issues, 'playScore.diversityMax', numeric.playScore.diversityMax, 1, 10);

  checkPositive(issues, 'digWeights.matchScore', numeric.digWeights.matchScore);
  checkRange(issues, 'promotion.base', numeric.promotion.base, 0, 1);
  checkRange(
    issues,
    'promotion.floor/ceil',
    numeric.promotion.ceil - numeric.promotion.floor,
    0,
    1,
  );
  checkRange(issues, 'promotion.digThreshold', numeric.promotion.digThreshold, 0, 100);
  checkPositive(issues, 'promotion.mainMaterialMultiplier', numeric.promotion.mainMaterialMultiplier);
  checkRange(
    issues,
    'promotion.failStreakBonus',
    numeric.promotion.failStreakBonus,
    0,
    0.5,
  );

  checkPositive(issues, 'lossOfControl.divisor', numeric.lossOfControl.divisor);
  checkRange(issues, 'lossOfControl.madThreshold', numeric.lossOfControl.madThreshold, 0, 100);
  checkRange(issues, 'lossOfControl.corThreshold', numeric.lossOfControl.corThreshold, 0, 100);

  checkPositive(issues, 'explore.dailyCapPerLocation', numeric.explore.dailyCapPerLocation);
  checkProb(issues, 'explore.bonusDropChance', numeric.explore.bonusDropChance);
  checkProb(issues, 'explore.dangerTriggerBase', numeric.explore.dangerTriggerBase);

  checkPositive(issues, 'potion.mpCost', numeric.potion.mpCost);
  checkProb(issues, 'potion.corPenaltyWeight', numeric.potion.corPenaltyWeight);
  checkRange(issues, 'potion.successFloor/Ceil', numeric.potion.successCeil - numeric.potion.successFloor, 0, 1);

  checkProb(issues, 'trade.taxRate', numeric.trade.taxRate);
  checkPositive(issues, 'trade.timeoutMs', numeric.trade.timeoutMs);
  checkPositive(issues, 'trade.weeklyVolumeCap', numeric.trade.weeklyVolumeCap);
  checkPositive(issues, 'trade.maxQuantity', numeric.trade.maxQuantity);

  checkPositive(issues, 'inventory.pageSize', numeric.inventory.pageSize);
  checkPositive(issues, 'inventory.maxStack', numeric.inventory.maxStack);

  checkPositive(issues, 'tick.mpRestore', numeric.tick.mpRestore);
  if (numeric.tick.lostControlHpMin > numeric.tick.lostControlHpMax) {
    issues.push({ level: 'error', path: 'tick.lostControlHp', message: 'HP 损失下限不能大于上限' });
  }

  checkPositive(issues, 'recovery.purify.dailyLimit', numeric.recovery.purify.dailyLimit);
  if (numeric.recovery.purify.materials.length === 0) {
    issues.push({ level: 'warn', path: 'recovery.purify.materials', message: '净化不消耗材料，失控会太好治' });
  }

  checkPositive(issues, 'divination.mpCost', numeric.divination.mpCost);
  checkPositive(issues, 'divination.dailyLimit', numeric.divination.dailyLimit);
  checkPositive(issues, 'divination.cooldownMs', numeric.divination.cooldownMs);

  checkRange(issues, 'party.maxMembers', numeric.party.maxMembers, 2, 20);
  checkPositive(issues, 'drop.rarityBands', numeric.drop.rarityBands.length);
  /* ---------------- M2.2：世界时钟 + 地区天气 ---------------- */
  const world = numeric.world;
  const clock = world.clock;
  // 时段边界必须严格递增（黎明 < 白天 < 黄昏 < 夜晚），否则时段会互相吞掉
  if (!(clock.dawnStartHour < clock.dayStartHour && clock.dayStartHour < clock.duskStartHour && clock.duskStartHour < clock.nightStartHour)) {
    issues.push({
      level: 'error',
      path: 'world.clock.*StartHour',
      message: '时段边界必须递增，当前 ' + clock.dawnStartHour + '/' + clock.dayStartHour + '/' + clock.duskStartHour + '/' + clock.nightStartHour,
    });
  }
  checkRange(issues, 'world.clock.*StartHour', clock.nightStartHour, 0, 23);
  checkPositive(issues, 'world.clock.moonCycleDays', clock.moonCycleDays);
  checkRange(issues, 'world.clock.fullMoonDay', clock.fullMoonDay, 1, clock.moonCycleDays);
  checkPositive(issues, 'world.clock.fogGapMinDays', clock.fogGapMinDays);
  checkPositive(issues, 'world.clock.fogDurationDays', clock.fogDurationDays);
  if (clock.fogGapMinDays > clock.fogGapMaxDays) {
    issues.push({ level: 'error', path: 'world.clock.fogGap*', message: '雾日间隔下限不能大于上限' });
  }

  for (const [slot, multiplier] of Object.entries(world.timeOfDay.exploreDangerMultiplier)) {
    checkPositive(issues, `world.timeOfDay.exploreDangerMultiplier.${slot}`, multiplier);
  }
  checkPositive(issues, 'world.timeOfDay.sleeplessNightDigMultiplier', world.timeOfDay.sleeplessNightDigMultiplier);
  checkRange(issues, 'world.timeOfDay.nightPlayMad', world.timeOfDay.nightPlayMad, 0, 50);
  checkPositive(issues, 'world.timeOfDay.foggyExploreDangerMultiplier', world.timeOfDay.foggyExploreDangerMultiplier);
  checkRange(issues, 'world.timeOfDay.fullMoonBrewSuccessBonus', world.timeOfDay.fullMoonBrewSuccessBonus, 0, 1);
  checkPositive(issues, 'world.timeOfDay.fullMoonLossOfControlMultiplier', world.timeOfDay.fullMoonLossOfControlMultiplier);

  const weather = world.weather;
  checkPositive(issues, 'world.weather.durationMs', weather.durationMs);
  checkPositive(issues, 'world.weather.diffusionDelayMs', weather.diffusionDelayMs);
  checkPositive(issues, 'world.weather.forecastLeadMs', weather.forecastLeadMs);
  checkPositive(issues, 'world.weather.lightTickMs', weather.lightTickMs);
  checkPositive(issues, 'world.weather.maxCatchUpLight', weather.maxCatchUpLight);
  checkPositive(issues, 'world.weather.maxCatchUpHeavy', weather.maxCatchUpHeavy);
  if (weather.forecastLeadMs >= weather.durationMs) {
    issues.push({ level: 'error', path: 'world.weather.forecastLeadMs', message: '预告提前量不能大于一次天气的持续时间' });
  }
  if (weather.diffusionDelayMs >= weather.durationMs) {
    issues.push({ level: 'error', path: 'world.weather.diffusionDelayMs', message: '扩散延迟不能大于一次天气的持续时间，否则扩散到的永远是过期天气' });
  }
  if (weather.lightTickMs > weather.durationMs) {
    issues.push({ level: 'error', path: 'world.weather.lightTickMs', message: '轻 tick 间隔不能大于天气持续时间，否则天气来不及刷新' });
  }

  const weatherIds = Object.keys(weather.effects) as Array<keyof typeof weather.effects>;
  if (weatherIds.length !== 8) {
    issues.push({ level: 'error', path: 'world.weather.effects', message: `天气必须正好 8 种，当前 ${weatherIds.length} 种` });
  }
  const tiers = new Set<string>();
  for (const id of weatherIds) {
    const row = weather.effects[id];
    const path = `world.weather.effects.${id}`;
    checkPositive(issues, `${path}.weight`, row.weight);
    checkPositive(issues, `${path}.exploreDanger`, row.exploreDanger);
    checkPositive(issues, `${path}.drop`, row.drop);
    checkPositive(issues, `${path}.lossOfControl`, row.lossOfControl);
    checkPositive(issues, `${path}.playDig`, row.playDig);
    checkRange(issues, `${path}.playMad`, row.playMad, -50, 50);
    checkRange(issues, `${path}.potionSuccess`, row.potionSuccess, -1, 1);
    if (!Array.isArray(row.eventPool)) {
      issues.push({ level: 'error', path: `${path}.eventPool`, message: '事件池必须是数组' });
    }
    tiers.add(String(row.tier));
  }
  if (!tiers.has('epic')) {
    issues.push({ level: 'error', path: 'world.weather.effects.*.tier', message: '至少要有一档显著天气（epic）' });
  }
  const seasonMonths = Object.values(weather.seasons).flat();
  if (new Set(seasonMonths).size !== 12 || seasonMonths.length !== 12) {
    issues.push({
      level: 'error',
      path: 'world.weather.seasons',
      message: `12 个月必须不重不漏地归属四季，当前 ${seasonMonths.length} 项 / ${new Set(seasonMonths).size} 个不同月份`,
    });
  }

  // M2.4 公共事件流：播报频率与生成窗口必须自洽
  const events = world.events;
  checkRange(issues, 'world.events.maxPerHour', events.maxPerHour, 1, 20);
  checkRange(issues, 'world.events.rumorMinPerDay', events.rumorMinPerDay, 0, 24);
  if (events.rumorMinPerDay > events.rumorMaxPerDay) {
    issues.push({ level: 'error', path: 'world.events.rumor*PerDay', message: '传闻条数下限不能大于上限' });
  }
  if (events.rumorMaxPerDay > events.maxPerHour * 24) {
    issues.push({ level: 'error', path: 'world.events.rumorMaxPerDay', message: '每天传闻上限不能超过「每小时上限 × 24」' });
  }
  checkProb(issues, 'world.events.discoveryChance', events.discoveryChance);
  checkPositive(issues, 'world.events.discoveryFoggyMultiplier', events.discoveryFoggyMultiplier);
  checkPositive(issues, 'world.events.ttlMs', events.ttlMs);
  checkRange(issues, 'world.events.quietFromHour', events.quietFromHour, 0, 24);
  checkRange(issues, 'world.events.quietToHour', events.quietToHour, 0, 24);
  if (events.quietToHour - events.quietFromHour >= 24) {
    issues.push({ level: 'error', path: 'world.events.quiet*Hour', message: '安静时段不能覆盖一整天，否则世界永远不说话' });
  }
  if (events.quietToHour - events.quietFromHour < 0) {
    issues.push({ level: 'error', path: 'world.events.quiet*Hour', message: '安静时段起点不能晚于终点' });
  }
  checkRange(issues, 'world.events.maxOptions', events.maxOptions, 1, 9);
  if (events.environmentWeathers.length === 0) {
    issues.push({ level: 'error', path: 'world.events.environmentWeathers', message: '至少要指定一种触发环境播报的天气' });
  }
  for (const id of events.environmentWeathers) {
    if (!weatherIds.includes(id as (typeof weatherIds)[number])) {
      issues.push({ level: 'error', path: `world.events.environmentWeathers.${id}`, message: '指向了不存在的天气 id' });
    }
  }

  /* ---------------- M2.7.6 / M2.85：普通人阶段与途径获得 ---------------- */
  const initiation = numeric.initiation;
  checkProb(issues, 'initiation.clueChance', initiation.clueChance);
  // M2.85：initiation.clueMaterialMultiplier 已删除（只剩一条入途径路径，材料量由配方决定）
  /*
   * 线索保底（M2.85）：至少要给玩家留出「正常玩两天」的空间再兜底 ——
   * 设成 1 的话第一次探索就必出线索，5% 的概率就失去意义了。
   */
  checkRange(issues, 'initiation.cluePityDays', initiation.cluePityDays, 2, 30);
  checkProb(issues, 'initiation.factionPriority.primary', initiation.factionPriority.primary);
  checkProb(issues, 'initiation.factionPriority.secondary', initiation.factionPriority.secondary);

  /*
   * **保护期的唯一不变式**：普通人的 MAD/COR 上限必须低于失控闸门。
   *
   * 这一条不是洁癖 —— 保护期就是靠它成立的：低于闸门 = 失控概率恒为 0，
   * 于是「普通人不会失控」是结构性事实，而不是散在判定里的一个 if。
   * 有人把 mortalCaps.mad 调到 70 的那一刻，这个测试必须拦住他。
   */
  const mortalCaps = initiation.mortalCaps;
  if (
    mortalCaps.mad >= numeric.lossOfControl.madThreshold ||
    mortalCaps.cor >= numeric.lossOfControl.corThreshold
  ) {
    issues.push({
      level: 'error',
      path: 'initiation.mortalCaps',
      message:
        `普通人的 MAD/COR 上限（${mortalCaps.mad}/${mortalCaps.cor}）必须低于失控闸门` +
        `（${numeric.lossOfControl.madThreshold}/${numeric.lossOfControl.corThreshold}），否则保护期不成立`,
    });
  }
  checkPositive(issues, 'initiation.mortalCaps.hp', mortalCaps.hp);
  checkPositive(issues, 'initiation.mortalCaps.mp', mortalCaps.mp);
  checkPositive(issues, 'initiation.mortalExplore.dangerMultiplier', initiation.mortalExplore.dangerMultiplier);
  checkPositive(issues, 'initiation.mortalExplore.dropMultiplier', initiation.mortalExplore.dropMultiplier);
  if (numeric.mortalEvents.pool.length === 0) {
    issues.push({ level: 'error', path: 'mortalEvents.pool', message: '普通人事件池是空的' });
  } else if (numeric.mortalEvents.pool.length < 10 || numeric.mortalEvents.pool.length > 15) {
    // 任务书 §5.5 要求 10—15 张；超出范围是内容层的问题，但不该拦启动
    issues.push({
      level: 'warn',
      path: 'mortalEvents.pool',
      message: `普通人事件池建议 10—15 张，当前 ${numeric.mortalEvents.pool.length} 张`,
    });
  }

  /* ---------------- M2.14 / M2.15：灾厄 ---------------- */
  checkProb(issues, 'calamity.scopeChance', numeric.calamity.scopeChance);
  /*
   * 「不跨窗口」是**参数依赖的**约束：最长灾厄不能超过窗口长度，
   * 否则 calamityAt 的运行时断言会把那些灾厄整片挡掉 ——
   * 症状是「灾厄莫名其妙变少了」，而不是报错。
   * （test/numeric-freeze.test.ts 里对同一件事也钉了一次。）
   */
  const longestCalamity = Math.max(...Object.values(numeric.calamity.durationDays));
  if (longestCalamity > numeric.calamity.intervalDays) {
    issues.push({
      level: 'error',
      path: 'calamity.durationDays',
      message:
        `最长灾厄 ${longestCalamity} 天超过了窗口长度 ${numeric.calamity.intervalDays} 天` +
        '（跨进下一个窗口的那一段会凭空消失）',
    });
  }

  /* ---------------- M2.15：正神教会的动态据点 ---------------- */
  checkPositive(issues, 'church.territoryIntervalDays', numeric.church.territoryIntervalDays);
  checkProb(issues, 'church.expansionChance', numeric.church.expansionChance);
  // 本轮没有 contractionChance：据点只做加法（理由见 NUMERIC.church 的段注释与交付说明 §3.2）

  /* ---------------- M2.16：教内等级与捐献 ---------------- */
  checkPositive(issues, 'church.donation.pennyPerContribution', numeric.church.donation.pennyPerContribution);
  checkProb(issues, 'church.donation.maxShareOfHolding', numeric.church.donation.maxShareOfHolding);
  if (numeric.church.donation.maxShareOfHolding <= 0) {
    issues.push({
      level: 'error',
      path: 'church.donation.maxShareOfHolding',
      message: '单次捐献上界必须大于 0，否则谁也捐不了',
    });
  }
  const thresholds = numeric.church.ranks.contributionThreshold;
  const gates = numeric.church.ranks.sequenceGate;
  /*
   * 两个数组**必须等长**：churches.yaml 的档位数是按它的长度校验的
   * （loader 里的那条 error），这里再钉一次是因为改 NUMERIC 的人未必会想到内容表。
   */
  if (thresholds.length !== gates.length) {
    issues.push({
      level: 'error',
      path: 'church.ranks',
      message: `contributionThreshold（${thresholds.length}）与 sequenceGate（${gates.length}）必须等长`,
    });
  }
  /*
   * 门槛必须**严格递增**、序列门槛必须**单调不增**（越往上越严）。
   * 破了这两条，currentRank 就不再是单调函数 —— 症状是「捐了钱档位反而掉了」，
   * 而那种事在报告里只会表现为「档位分布有点怪」。
   */
  for (let i = 1; i < thresholds.length; i += 1) {
    if (thresholds[i]! <= thresholds[i - 1]!) {
      issues.push({
        level: 'error',
        path: 'church.ranks.contributionThreshold',
        message: `第 ${i + 1} 档的门槛（${thresholds[i]}）没有高于前一档（${thresholds[i - 1]}）`,
      });
      break;
    }
  }
  for (let i = 0; i < thresholds.length; i += 1) {
    checkRange(issues, `church.ranks.sequenceGate[${i}]`, gates[i] ?? 9, 0, 9);
  }
  for (let i = 1; i < gates.length; i += 1) {
    if (gates[i]! > gates[i - 1]!) {
      issues.push({
        level: 'error',
        path: 'church.ranks.sequenceGate',
        message: `第 ${i + 1} 档的序列门槛（${gates[i]}）比前一档（${gates[i - 1]}）更松`,
      });
      break;
    }
  }

  // 条件字段白名单必须覆盖模拟与事件卡里用到的字段
  if (COND_FIELDS.length === 0) {
    issues.push({ level: 'error', path: 'event.condFields', message: '条件字段白名单为空' });
  }

  return issues;
}

export function validateNumericOrThrow(numeric = NUMERIC): void {
  const errors = validateNumeric(numeric).filter((issue) => issue.level === 'error');
  if (errors.length > 0) {
    throw new Error(
      `配置校验失败（${errors.length} 项）：\n${errors.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n')}`,
    );
  }
}
