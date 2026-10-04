/**
 * M2.12 前置 1：**异步时间尺度统一**。
 *
 * 这一批用例钉两件事，而且只钉这两件：
 *   1. 所有「与人相关的等待窗口」都住在 NUMERIC.timing 里，各段只是**引用**它
 *      （改一个地方就是改所有地方 —— 这正是 M2.11 暴露出来的问题：三个窗口各改各的）；
 *   2. **判定规则一个字节都没动**（战斗 / 交易 / 仪式的关键值逐项冻结）。
 *
 * 为什么值也要冻结：这一轮改的四个窗口每一个都对应一条实测依据
 * （写在 numeric.ts 的 TIMING 段里），后人要再动它就得先读那段依据 ——
 * 这与 test/numeric-freeze.test.ts 是同一个手法，只是对象换成了时间。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BATTLE, NUMERIC, PVP, TIMING } from '../src/config/numeric.ts';

/* ================================================================== *
 * 一、窗口只有一处出处
 * ================================================================== */

test('时间尺度：所有等待窗口都在 timing 段里，各段只是引用它', () => {
  const pairs: Array<[string, number, number]> = [
    ['PVP 回合超时', PVP.playerTimeoutMs, TIMING.pvpTurnTimeoutMs],
    ['PVE 回合超时', BATTLE.playerTimeoutMs, TIMING.pveTurnTimeoutMs],
    ['菜单有效期', NUMERIC.menu.ttlMs, TIMING.menuTtlMs],
    ['交易待确认', NUMERIC.trade.timeoutMs, TIMING.tradeTimeoutMs],
    ['仪式干扰窗口', NUMERIC.interference.windowMs, TIMING.ritualInterferenceWindowMs],
    ['仪式准备快照', NUMERIC.ritual.configTtlMs, TIMING.ritualConfigTtlMs],
    /*
     * M2.18：这条**不再比对 TIMING**。
     *
     * timing 段那一组是「**互动**窗口」（PVP 回合 / 交易确认 / 菜单有效期），
     * 它们的共同问题是「玩家在**一次会话内**反应不过来」；
     * 而仪式融合是**跨登录**动作（发起 → 下线 → 隔夜回来融合），性质不同，
     * 依据是「登录间隔」而不是「会话内反应时间」。所以它移到了 NUMERIC.ritual。
     *
     * 冻结值改成直接写死 12 小时 —— 它仍然被这条测试保护，只是不再跟 timing 联动。
     */
    ['仪式融合窗口（M2.18 起跨登录，冻结值）', NUMERIC.ritual.runTimeoutMs, 12 * 3600 * 1000],
    ['挑战冷却', PVP.challengeCooldownMs, TIMING.challengeCooldownMs],
    ['袭击冷却', NUMERIC.assault.cooldownMs, TIMING.assaultCooldownMs],
    ['世界事件有效期', NUMERIC.world.events.ttlMs, TIMING.worldEventTtlMs],
    ['通缉播报节流', NUMERIC.wanted.suspiciousBroadcastCooldownMs, TIMING.wantedBroadcastCooldownMs],
  ];
  for (const [label, actual, expected] of pairs) {
    assert.equal(actual, expected, label + ' 必须从 NUMERIC.timing 读');
  }
  /* M2.85：guidedDeadlineDays / offerTtlDays 两对冻结随引导玩法一并删除。 */
});

test('时间尺度：本轮改动的四个值（冻结）', () => {
  /*
   * PVP 超时 5 分钟 → **24 小时**。这个值不是拍出来的，是三档对照跑出来的（同 seed）：
   *   5 分钟 → 代打占比 73.3% ／ 12 小时 → 57.1% ／ 24 小时 → **28.2%**。
   * 12 小时只把代打压到 57.1%（目标 < 50% 没达到），24 小时才跨过目标线。
   * 依据与完整曲线见 NUMERIC.timing 的 pvpTurnTimeoutMs 注释与 docs/M2.12-时间尺度对照.md。
   */
  assert.equal(TIMING.pvpTurnTimeoutMs, 24 * 60 * 60 * 1000, 'PVP 一回合等 24 小时');
  // 交易 6 小时 → 24 小时。6 小时下 M2.11 实测 75% 过期
  assert.equal(TIMING.tradeTimeoutMs, 24 * 60 * 60 * 1000, '交易单挂 24 小时');
  // 菜单 5 分钟 → 30 分钟（«读菜单 + 想清楚 + 打字» 的实际时间）
  assert.equal(TIMING.menuTtlMs, 30 * 60 * 1000, '菜单 30 分钟');
  // 干扰窗口 10 分钟 → 30 分钟（同「一次登录内」）
  assert.equal(TIMING.ritualInterferenceWindowMs, 30 * 60 * 1000, '干扰窗口 30 分钟');
});

test('时间尺度：按「天」算的窗口一个都没动', () => {
  assert.deepEqual([...TIMING.wantedDurationDays], [3, 5, 7, 7]);
  assert.equal(NUMERIC.wanted[1].duration, 3 * 24 * 3600 * 1000, '1 级通缉 3 天');
  assert.equal(NUMERIC.wanted[2].duration, 5 * 24 * 3600 * 1000, '2 级通缉 5 天');
  assert.equal(NUMERIC.wanted[3].duration, 7 * 24 * 3600 * 1000, '3 级通缉 7 天');
  assert.equal(NUMERIC.wanted[4].duration, 7 * 24 * 3600 * 1000, '4 级通缉 7 天');
  assert.equal(NUMERIC.initiation.cluePityDays, 5, '线索保底仍然是 5 天（M2.85）');
  assert.equal(NUMERIC.tick.lostControlDays, 1, '失控持续 1 天');
});

test('时间尺度：PVE 与 PVP 的超时**故意不是同一个数**', () => {
  /*
   * 这一条不是可有可无的：两个值在 M2.9/M2.10 是一样的（都是 5 分钟），
   * 所以「它们为什么现在不一样」必须有一个地方说得清 —— 就在这条断言里。
   * 语义差别见 NUMERIC.timing 的 pveTurnTimeoutMs：PVE 的对手是 AI（永远在线），
   * 超时问的是「你多久没回」；PVP 的对手是人，问的是「他多久没回」。
   */
  assert.notEqual(TIMING.pveTurnTimeoutMs, TIMING.pvpTurnTimeoutMs);
  assert.equal(TIMING.pveTurnTimeoutMs, 5 * 60 * 1000, 'PVE 仍然是 5 分钟');
});

/* ================================================================== *
 * 二、判定规则一个字节都没改
 * ================================================================== */

test('时间尺度：战斗 / 交易 / 仪式的判定值全部未动（冻结）', () => {
  // 战斗（M2.9 / M2.10 / M2.11 定的值）
  assert.equal(BATTLE.maxRounds, 8);
  assert.equal(BATTLE.actions.attack.baseHit, 0.5);
  assert.equal(BATTLE.actions.attack.baseDamageMin, 30);
  assert.equal(BATTLE.actions.retreat.baseChance, 0.6);
  assert.equal(BATTLE.crit.chance, 0.15);
  assert.equal(BATTLE.creatureAi.berserkThreshold, 0.2);
  assert.equal(BATTLE.creatureAi.fleeThreshold, 0.3);
  assert.equal(BATTLE.creatureAi.callAllyThreshold, 0.5);
  assert.equal(BATTLE.creatureAi.evolveSurviveRatio, 0.15);
  assert.equal(PVP.lootPercent, 0.2);

  // 交易（W3 / M2.5）
  assert.equal(NUMERIC.trade.taxRate, 0.05);
  assert.equal(NUMERIC.trade.maxPendingPerUser, 5);

  // 仪式与干扰（M2.5）
  assert.equal(NUMERIC.ritual.stage1Base, 0.8);
  assert.equal(NUMERIC.ritual.stage2Base, 0.7);
  assert.equal(NUMERIC.ritual.stage3FailMad, 10);
  assert.equal(NUMERIC.interference.dailyLimit, 1);
  assert.equal(NUMERIC.interference.baseSuccess, 0.4);
  assert.equal(NUMERIC.interference.targetPenalty, -0.2);

  // 晋升（W4 / M2.5）
  assert.equal(NUMERIC.promotion.digThreshold, 60);
  assert.equal(NUMERIC.promotion.mainMaterialMultiplier, 2);
});
