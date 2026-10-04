import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ASCENSION_WAR,
  EPOCH,
  GENDER_CHANGE,
  INITIATION,
  MARRIAGE,
  MORTAL_EVENTS,
  NUMERIC,
} from '../src/config/numeric.ts';
import { validateNumeric } from '../src/config/validate.ts';

/**
 * 数值冻结（W6）：封测期 numeric.ts 不允许再改，除非有明确的决策依据。
 * 这份快照是当前终值；任何改动都必须同步更新对应报告与本快照，否则 CI 直接失败。
 *
 * 改动史：
 *   - W8：trade.timeoutMs 1 小时 → 6 小时（依据 docs/W8-交付说明.md）
 *   - M2.1：lossOfControl 闸门 80/70 → 50/45、divisor 430 → 90，并新增死循环固定尺子
 *     deadlockMadThreshold/deadlockCorThreshold（依据 docs/M2-失控重定报告.md）
 *   - M2.2：新增 world 段（时段边界 / 月相周期 / 雾日间隔 / 八种天气的影响表），
 *     依据 docs/M2.2-天气影响表.md；W5 的暴露概率、晋升惩罚、tick 恢复量一个都没动
 */
const FROZEN = {
  play: { exposureChance: 0.38, ritual: 0 },
  playScore: {
    coreWeight: 1,
    secondaryWeight: 0.5,
    forbiddenWeight: -0.5,
    tagDailyCap: 3,
    repeatDivisorBase: 1,
    diversityPerTag: 0.1,
    diversityMax: 1.3,
  },
  digWeights: { matchScore: 0.6, exposure: 0.3, ritual: 0.1, pollution: 0.5 },
  promotion: {
    base: 0.7,
    digBonus: 0.2,
    sequencePenalty: 0.05,
    madPenalty: 0.3,
    corPenalty: 0.15,
    floor: 0.05,
    ceil: 0.95,
    digThreshold: 60,
    mainMaterialMultiplier: 2,
    madOnSuccess: 5,
    corOnSuccess: 3,
    madOnFail: 5,
    corOnFail: 3,
    failStreakThreshold: 2,
    failStreakBonus: 0.1,
  },
  // M2.1 失控阈值重定：闸门 80/70 → 75/65、divisor 430 → 350（两轮实测校准，见 docs/M2-失控重定报告.md）
  lossOfControl: { divisor: 250, madThreshold: 65, corThreshold: 65, deadlockMadThreshold: 80, deadlockCorThreshold: 70 },
  explore: {
    // M2.85：explore.apCost（1）随行动值玩法一并删除
    dailyCapPerLocation: 3,
    dangerTriggerBase: 0.06,
    hpPerDanger: 3,
    madPerDanger: 1,
    bonusDropChance: 0.06,
  },
  potion: {
    corPenaltyWeight: 0.2,
    successFloor: 0.05,
    successCeil: 0.95,
    mpCost: 12,
    digOnDrink: 6,
    madOnDrink: 6,
    controlCheckOnDrink: true,
    controlMadBonus: 5,
    controlCorBonus: 3,
  },
  /*
   * 交易待确认超时：W8 是 1 小时 → 6 小时，M2.12 是 6 小时 → **24 小时**。
   * 两次改动都有实测依据，写在 NUMERIC.timing 的 tradeTimeoutMs 上：
   *   W7 实测 1,494 次 .确认/.取消 撞上「这笔交易已经结束」；
   *   M2.11 实测在 6 小时下**仍然 75% 过期**（172/229）。
   * 除它之外，这一段的其他值一个都没动。
   */
  trade: { taxRate: 0.05, timeoutMs: 86_400_000, weeklyVolumeCap: 5_000, maxQuantity: 99, maxPendingPerUser: 5 },
  inventory: { pageSize: 10, maxStack: 999 },
  tick: {
    // M2.85：tick.apRestoreTo（5）随行动值机制一并下线
    mpRestore: 30,
    lostControlHpMin: 10,
    lostControlHpMax: 30,
    lostControlMad: 5,
    lostControlDays: 1,
    eventRetentionDays: 30,
  },
  divination: { mpCost: 8, dailyLimit: 3, cooldownMs: 30_000 },
  party: { maxMembers: 4, teamCardThreshold: 2, taskDailyLimit: 1 },
} as const;

test('数值冻结：W5 定稿的终值一个都没变', () => {
  for (const [group, expected] of Object.entries(FROZEN)) {
    const actual = (NUMERIC as unknown as Record<string, Record<string, unknown>>)[group];
    assert.ok(actual, `numeric.${group} 不存在`);
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(actual[key], value, `numeric.${group}.${key} 被改动了（封测期不允许）`);
    }
  }
});

test('数值冻结：恢复与净化数值与 W5 报告一致', () => {
  // M2.85：recovery.rest.apCost（1）随行动值玩法一并删除
  assert.deepEqual(NUMERIC.recovery.rest, { mad: -5, hp: 20, dailyLimit: 1 });
  assert.deepEqual(NUMERIC.recovery.purify.materials, [{ itemId: '辅助材料·圣盐', qty: 1 }]);
  assert.equal(NUMERIC.recovery.purify.cor, -15);
  assert.equal(NUMERIC.recovery.purify.mad, -8);
  assert.equal(NUMERIC.recovery.purify.dailyLimit, 1);
});

test('数值冻结：配置校验仍然全绿', () => {
  assert.deepEqual(validateNumeric().filter((issue) => issue.level === 'error'), []);
});

test('M2.2 世界数值：时段边界 / 月相周期 / 雾日间隔按任务书锁死', () => {
  const clock = NUMERIC.world.clock;
  assert.equal(clock.dawnStartHour, 6);
  assert.equal(clock.dayStartHour, 9);
  assert.equal(clock.duskStartHour, 18);
  assert.equal(clock.nightStartHour, 21);
  assert.equal(clock.moonCycleDays, 30);
  assert.equal(clock.fullMoonDay, 15);
  assert.equal(clock.fogGapMinDays, 3);
  assert.equal(clock.fogGapMaxDays, 7);
  assert.equal(clock.fogDurationDays, 1);

  const tod = NUMERIC.world.timeOfDay;
  assert.deepEqual(tod.exploreDangerMultiplier, { dawn: 0.9, day: 1, dusk: 1, night: 1.1 });
  assert.equal(tod.sleeplessNightDigMultiplier, 1.2);
  assert.equal(tod.nightPlayMad, 1);
  assert.equal(tod.fullMoonBrewSuccessBonus, 0.15);
  assert.equal(tod.fullMoonLossOfControlMultiplier, 1.1);
  assert.equal(tod.foggyExploreDangerMultiplier, 1.2);

  const weather = NUMERIC.world.weather;
  // M2.2 复算结论：世界时钟单独就把差距拉开了，补偿旋钮必须保持关闭
  assert.equal(NUMERIC.play.escalation.madPerExtraPlay, 0, '扮演加压旋钮应当是关闭的（见 docs/M2.2-失控复算报告.md）');
  assert.equal(Object.keys(weather.effects).length, 8);
  assert.equal(weather.diffusionDelayMs, 2 * 60 * 60 * 1000);
  assert.equal(weather.forecastLeadMs, 2 * 60 * 60 * 1000);
  assert.equal(weather.lightTickMs, 60 * 60 * 1000);
  assert.deepEqual(validateNumeric().filter((issue) => issue.level === 'error'), []);
});

/**
 * 长期设计意图的冻结（M2.7 追加）。
 *
 * 与 promotion.sequenceGating.planned 同一性质：**本版没有任何代码读它**，
 * 但它是后续任务书（序列 5→0 阶段）会引用的常量。
 * 冻结的理由很具体：这两个数看着「没用」，最容易被后续某一轮顺手改掉；
 * 而它们一旦漂移，README 里那一整节写下的设计意图就与代码对不上了 ——
 * 那份文档是这一轮唯一的交付物，不能让它悄悄失真。
 */
test('长期设计意图：纪元与争神之战的常量被冻结（本版无代码读取）', () => {
  assert.equal(NUMERIC.epoch.durationDays, 90, '纪元默认周期被改动了');
  assert.equal(NUMERIC.epoch.minDurationDays, 30);
  assert.equal(NUMERIC.epoch.maxDurationDays, 180);
  assert.equal(NUMERIC.ascensionWar.triggerBeforeEndDays, 7, '争神之战的提前量被改动了');
  assert.equal(NUMERIC.ascensionWar.minSeqToChallenge, 1);
  assert.equal(NUMERIC.ascensionWar.witnessAll, true);
  assert.equal(NUMERIC.ascensionWar.worldEventLevel, 'epoch');

  // 别名必须与 NUMERIC 指向同一份数据（防止有人只改一处）
  assert.equal(EPOCH.durationDays, NUMERIC.epoch.durationDays);
  assert.equal(ASCENSION_WAR.triggerBeforeEndDays, NUMERIC.ascensionWar.triggerBeforeEndDays);

  // 自洽：默认值必须落在运营可调的区间里，且争神之战必须开始于纪元结束之前
  assert.ok(
    EPOCH.minDurationDays <= EPOCH.durationDays && EPOCH.durationDays <= EPOCH.maxDurationDays,
    '默认周期必须落在 [min, max] 内',
  );
  assert.ok(
    ASCENSION_WAR.triggerBeforeEndDays < EPOCH.minDurationDays,
    '争神之战必须在最短的纪元里也来得及打完',
  );
});

/**
 * M2.7.6 的冻结（任务书补充 §6：婚姻与性别变化两个常量要加冻结断言，
 * 防止后续被顺手改掉 —— 它们看着「没用」，而 README 里那一整节设计意图
 * 就建立在它们的取值上）。
 */
test('长期设计意图：婚姻与性别变化的常量被冻结（本版无代码读取）', () => {
  assert.equal(NUMERIC.marriage.proposalCooldownMs, 24 * 3600 * 1000, '求婚冷却被改动了');
  assert.equal(NUMERIC.marriage.divorceCooldownMs, 7 * 24 * 3600 * 1000, '离婚冷却被改动了');
  assert.equal(NUMERIC.marriage.witnessRequired, true);
  assert.equal(NUMERIC.marriage.ceremonyCostPenny, 1000);
  assert.equal(NUMERIC.marriage.partnerBonus.exploreDanger, 0.9);
  assert.equal(NUMERIC.marriage.partnerBonus.ritualWitness, 0.08);
  assert.equal(NUMERIC.marriage.divorcePenalty.mad, 10);
  assert.equal(NUMERIC.marriage.divorcePenalty.cor, 5);

  assert.equal(NUMERIC.genderChange.acceptBonus, 0.2);
  assert.equal(NUMERIC.genderChange.rejectPenalty, 0.3);
  assert.equal(NUMERIC.genderChange.irreversible, true);

  // 别名必须与 NUMERIC 指向同一份数据（防止有人只改一处）
  assert.equal(MARRIAGE.ceremonyCostPenny, NUMERIC.marriage.ceremonyCostPenny);
  assert.equal(GENDER_CHANGE.acceptBonus, NUMERIC.genderChange.acceptBonus);
});

test('M2.7.6：普通人阶段的数值按任务书锁死', () => {
  assert.equal(INITIATION.cluePityDays, 5, '线索保底天数被改动了（M2.85：满 5 天必出）');
  assert.equal(INITIATION.clueChance, 0.05, '配方线索概率被改动了');
  // M2.85：clueMaterialMultiplier 已删除（势力引导下线后只剩一条路）

  assert.deepEqual(INITIATION.mortalCaps, { hp: 100, mp: 50, mad: 20, cor: 10 });
  assert.deepEqual(INITIATION.mortalExplore, {
    dangerMultiplier: 1.3,
    dropMultiplier: 0.4,
    eventPool: 'mortal',
  });
  assert.deepEqual(INITIATION.factionPriority, { primary: 0.7, secondary: 0.3 });

  // 别名与 NUMERIC 同源
  assert.equal(MORTAL_EVENTS.pool, NUMERIC.mortalEvents.pool);
  assert.equal(INITIATION.cluePityDays, NUMERIC.initiation.cluePityDays);

  // 保护期的核心不变式（与 validateNumeric 同一口径，这里再守一道）
  assert.ok(
    INITIATION.mortalCaps.mad < NUMERIC.lossOfControl.madThreshold &&
      INITIATION.mortalCaps.cor < NUMERIC.lossOfControl.corThreshold,
    '普通人的 MAD/COR 上限必须低于失控闸门',
  );
  assert.ok(
    INITIATION.cluePityDays >= 2,
    '线索保底至少 2 天 —— 1 天等于「创建当天探索就必出」，保底失去意义（validate 同一口径）',
  );
  assert.ok(
    MORTAL_EVENTS.pool.length >= 10 && MORTAL_EVENTS.pool.length <= 15,
    '普通人事件池 10—15 张',
  );
});

test('M2.14 灾厄：窗口 / 概率 / 等级权重 / 时长 / 淡入淡出按第 1 步任务书锁死', () => {
  const cfg = NUMERIC.calamity;
  assert.equal(cfg.enabled, true, '灾厄默认必须是开着的（对照批才用 M214_CALAMITY=off 关它）');
  assert.equal(cfg.intervalDays, 6, '窗口长度（天）—— 6 天一个窗口，30 天 5 个窗口');
  assert.equal(cfg.chancePerBucket, 0.6, '每窗口开出灾厄的概率');
  assert.deepEqual(cfg.levelWeights, { 1: 0.5, 2: 0.35, 3: 0.15 }, '等级权重：一级最多');
  assert.deepEqual(cfg.durationDays, { 1: 1, 2: 2, 3: 2 }, '各等级持续几天');
  assert.equal(cfg.maxLevel, 3, '等级上限（factor 的分母）');
  assert.equal(cfg.rampDays, 0.5, '淡入淡出各占多少天');
  /*
   * 「不跨窗口」是**参数依赖的约束**：最长灾厄不能超过窗口长度，
   * 否则 calamityAt 的断言会把那些灾厄整片挡掉 —— 症状是「灾厄莫名其妙变少了」。
   * 运行时兜底在 calamityAt 里（返回 null），这里把参数层的约束也钉住。
   */
  const longest = Math.max(...Object.values(cfg.durationDays));
  assert.ok(longest <= cfg.intervalDays, '最长灾厄时长不能超过窗口长度（' + longest + ' > ' + cfg.intervalDays + '）');

  // 三个影响系数：都是「factor × 它」的形式（factor 0—1，所以它是满值时的最大改变量）
  assert.deepEqual(
    cfg.effects,
    { exploreDropPenalty: 0.6, strayBoost: 2, replenishBoost: 1 },
    '灾厄对探索掉落 / 迁移漂移 / 世界补充的影响系数',
  );
  assert.deepEqual(
    NUMERIC.drop.calamity,
    {
      // 主路径：灾厄期每次探索（合计 ≈ 6.2%）—— 样本量 1398，是能撑起 20% 的那一条
      explore: { sealed: 0.008, wonder: 0.02, charm: 0.035 },
      // 次路径：灾厄期战斗胜利（合计 ≈ 30.2%）—— 样本少，观测项，不参与主验收
      battle: { sealed: 0.03, wonder: 0.1, charm: 0.2 },
    },
    '灾厄产出的掉落率（两段：主路径每次探索 / 次路径战斗胜利）',
  );
  assert.deepEqual(validateNumeric().filter((issue) => issue.level === 'error'), []);
});

test('M2.15 正神教会：据点窗口 / 扩张 / 收缩按任务书 §五 锁死', () => {
  const cfg = NUMERIC.church;
  assert.equal(cfg.territoryIntervalDays, 30, '据点演化窗口（天）');
  assert.equal(cfg.expansionChance, 0.3, '每窗口扩张概率');
  /*
   * **本轮没有收缩**。M2.15 第一版做的是三区间（扩张 / 收缩 / 不动），
   * M2.16 前置降为两区间（扩张 / 不动）—— 三条理由见交付说明 §3.2 与偏差登记第 3 条。
   * 这条断言防的是「顺手把 contractionChance 加回来」：
   * 加它的人必须先回答「M2.16 的城市级入教怎么办」。
   */
  assert.equal(
    (cfg as Record<string, unknown>).contractionChance,
    undefined,
    '据点本轮只做加法：收缩是 M2.17「势力争夺输了丢一块地」的语义',
  );
  /*
   * M2.15 任务 D 的尾巴：地点级灾厄的覆盖概率。
   * **1 = 全部地点都覆盖**，也就是「灾厄是全服的」这条 M2.14 口径一字不改 ——
   * 它不是「调出来的最优值」，而是「不动既有口径」的表达
   * （依据与被证伪的替代值写在 NUMERIC.calamity.scopeChance 的注释里）。
   */
  assert.equal(NUMERIC.calamity.scopeChance, 1, '地点级灾厄的覆盖面：1 = 与 v1「全服」口径一致');
  assert.deepEqual(validateNumeric().filter((issue) => issue.level === 'error'), []);
});

test('M2.16 正神教会：教内等级与捐献按拍板锁死', () => {
  const cfg = NUMERIC.church;
  /*
   * 六档等比 ×5。量级由 M2.14 交付批的实测收入定的（P50 = 126 便士 / 30 天），
   * 被证伪的替代值是 [0, 100, 500]（第 2 档要 1000 便士 = 中位数玩家 8 倍的全部收入）。
   */
  assert.deepEqual(cfg.ranks.contributionThreshold, [0, 5, 25, 125, 625, 3125], '六档门槛');
  // 前两档不卡序列：M2.16 的入教玩家大部分在序列 9，卡住就没人升得动
  assert.deepEqual(cfg.ranks.sequenceGate, [9, 9, 9, 8, 8, 7], '序列门槛');
  assert.equal(cfg.donation.pennyPerContribution, 10, '10 便士 = 1 点贡献');
  assert.equal(cfg.donation.cooldownMs, 24 * 3600 * 1000, '捐献每日一次');
  assert.equal(cfg.donation.maxShareOfHolding, 0.5, '单次不超过当前持有的一半');

  // 门槛严格递增、序列门槛单调不增 —— 破了两条中的任何一条，currentRank 就不再单调
  for (let i = 1; i < cfg.ranks.contributionThreshold.length; i += 1) {
    assert.ok(
      cfg.ranks.contributionThreshold[i]! > cfg.ranks.contributionThreshold[i - 1]!,
      '贡献门槛必须严格递增',
    );
  }
  for (let i = 1; i < cfg.ranks.sequenceGate.length; i += 1) {
    assert.ok(cfg.ranks.sequenceGate[i]! <= cfg.ranks.sequenceGate[i - 1]!, '序列门槛必须越往上越严');
  }
  // M2.17+ 的字段不许提前长出来（与 M2.15 的 contractionChance 同一手法）
  assert.equal((cfg as Record<string, unknown>)['exitCooldownMs'], undefined);
  assert.equal((cfg as Record<string, unknown>)['membershipLimit'], undefined);
  assert.deepEqual(validateNumeric().filter((issue) => issue.level === 'error'), []);
});

test('M2.2 不动 W5 已定的旋钮：暴露概率 / 晋升惩罚 / tick 恢复量原样', () => {
  assert.equal(NUMERIC.play.exposureChance, 0.38);
  assert.equal(NUMERIC.promotion.madPenalty, 0.3);
  assert.equal(NUMERIC.promotion.corPenalty, 0.15);
  assert.equal(NUMERIC.promotion.base, 0.7);
  assert.equal(NUMERIC.tick.lostControlMad, 5);
  assert.equal(NUMERIC.recovery.rest.mad, -5);
  assert.equal(NUMERIC.recovery.purify.mad, -8);
  assert.equal(NUMERIC.recovery.purify.cor, -15);
});