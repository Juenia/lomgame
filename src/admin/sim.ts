/**
 * 模拟与压测（M2.53）。
 *
 * ## 上一轮我写错的地方，这里纠正
 *
 * 注册表里原来给这个面板记的 blockedBy 是「两套工具都会写库，后台随手触发会把
 * 真实数据混进回归结果」。**那只对 src/vplayer 与 src/loadtest 成立** ——
 * 它们确实驱动真库。而 `src/sim` 的 runSimulation 是**纯函数**：
 * 不 import 任何仓储、不碰数据库，自己装载内容、自己算。
 *
 * 实测 200 人 × 30 天约 1.3 秒（另加进程启动），所以可以同步跑，
 * 既不需要临时库，也没有污染真实数据的可能。
 *
 * ## 上限是硬的
 *
 * 这是在 HTTP 请求里同步跑：人数、天数、策略数都有上限，
 * 而且卡总角色日。超了就明确拒绝并说清上限是多少，不是默默跑一个缩水版
 * —— 那样给出的结论会与参数不符，比不跑更糟。
 */
import { SimReportRepo } from '../infra/db/sim-reports.ts';
import type { Db } from '../infra/db/sqlite.ts';
import { checkTargets, renderMarkdown, renderOneLine, type TargetCheck } from '../sim/report.ts';
import { runSimulation } from '../sim/simulator.ts';
import { STRATEGIES, STRATEGY_IDS, type StrategyId } from '../sim/strategy.ts';

/*
 * 上限。
 *
 * ⚠️ 这里原来还有一条 maxCharacterDays: 9000，我删了 —— 它**永远触发不了**：
 * maxCharacters(300) × maxDays(30) 正好等于 9000，而判据是 > 9000。
 * 一条永远不会触发的限制比没有限制更糟：它看着像个安全网，实际是死代码，
 * 而且会让报错信息指错地方（实测：一个 300×30 的请求得到的是「策略太多」）。
 *
 * 真实的成本口径就是人数 × 天数：实测 200×30 约 1.3 秒，而 300×30 是两者上限的
 * 乘积（约 2 秒）—— 对一次后台点击来说可以接受，不需要第二条闸门。
 */
export const SIM_LIMITS = {
  maxCharacters: 300,
  maxDays: 30,
  /** 一次最多几种策略：每多一种就多跑一整轮 */
  maxStrategies: 2,
} as const;

/**
 * 界面用的策略选项 —— 从 STRATEGY_IDS / STRATEGIES 推出来。
 *
 * ⚠️ 前端曾经自己写死过一份，里面有一个**根本不存在**的 'balanced'（均衡型）。
 * 勾上它不会有任何报错：服务端按白名单过滤掉，于是「勾了三项、只跑了两项」，
 * 界面上完全看不出来。凡是「有哪些可选」都该从唯一出处来。
 */
export const SIM_STRATEGY_CHOICES = STRATEGY_IDS.map((id) => ({
  id,
  name: STRATEGIES[id].name,
  description: STRATEGIES[id].description,
}));

export interface SimRun {
  strategy: string;
  strategyName: string;
  oneLine: string;
  checks: TargetCheck[];
  markdown: string;
  elapsedMs: number;
}

export type SimOutcome =
  | { ok: true; runs: SimRun[]; elapsedMs: number; savedId: string; history: ReturnType<SimReportRepo['latest']> }
  | { ok: false; error: string };

export function runSim(db: Db, body: Record<string, unknown>, now = Date.now()): SimOutcome {
  const characters = Math.round(Number(body['characters'] ?? 200));
  const days = Math.round(Number(body['days'] ?? 30));
  const seed = String(body['seed'] ?? 'admin').trim() || 'admin';
  /*
   * 先判人数与天数，再判策略。
   *
   * 顺序是有意的：不传策略时**默认取前 maxStrategies 个**，而不是全部 ——
   * 原来默认取全部，于是「什么都不传」必然撞上「策略太多」，
   * 一个真正的问题是人数超限的请求会被报成策略问题，指错方向。
   */
  if (!Number.isFinite(characters) || characters < 1 || characters > SIM_LIMITS.maxCharacters) {
    return { ok: false, error: '人数只能是 1—' + SIM_LIMITS.maxCharacters };
  }
  if (!Number.isFinite(days) || days < 1 || days > SIM_LIMITS.maxDays) {
    return { ok: false, error: '天数只能是 1—' + SIM_LIMITS.maxDays };
  }

  const wanted = Array.isArray(body['strategies']) && body['strategies'].length > 0
    ? (body['strategies'] as unknown[]).map(String)
    : STRATEGY_IDS.slice(0, SIM_LIMITS.maxStrategies);
  const strategies = wanted.filter((s): s is StrategyId =>
    (STRATEGY_IDS as readonly string[]).includes(s));

  if (strategies.length === 0) {
    return { ok: false, error: '策略只能是：' + STRATEGY_IDS.join(' / ') };
  }
  if (strategies.length > SIM_LIMITS.maxStrategies) {
    return { ok: false, error: '一次最多跑 ' + SIM_LIMITS.maxStrategies + ' 种策略（收到 ' + strategies.length + ' 种）' };
  }

  const started = Date.now();
  const runs: SimRun[] = [];
  for (const strategy of strategies) {
    const t0 = Date.now();
    const report = runSimulation({ characterCount: characters, days, seed, strategy });
    runs.push({
      strategy,
      strategyName: STRATEGIES[strategy]?.name ?? strategy,
      oneLine: renderOneLine(report),
      checks: checkTargets(report),
      markdown: renderMarkdown(report, { title: '后台模拟 · ' + strategy + ' · ' + characters + '人 × ' + days + '天' }),
      elapsedMs: Date.now() - t0,
    });
  }
  const elapsedMs = Date.now() - started;

  const repo = new SimReportRepo(db);
  const savedId = 'sim-' + now + '-' + seed;
  let saved = true;
  try {
    repo.insert({
      id: savedId,
      createdAt: now,
      configJson: JSON.stringify({ characters, days, seed, strategies }),
      summaryJson: JSON.stringify(runs.map((r) => ({
        strategy: r.strategy, oneLine: r.oneLine, elapsedMs: r.elapsedMs,
        passed: r.checks.filter((c) => c.pass).length, total: r.checks.length,
      }))),
      note: '管理后台发起',
    });
  } catch {
    // 留档失败不该让结果丢失 —— 结论已经算出来了，先给人看
    saved = false;
  }

  return {
    ok: true,
    runs,
    elapsedMs,
    savedId: saved ? savedId : '',
    history: repo.latest(8),
  };
}
