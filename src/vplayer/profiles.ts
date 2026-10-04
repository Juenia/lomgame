/**
 * 玩家画像（W7）：5 种画像 × 4 种目标。
 * 全部由 seed 派生，保证「同一 seed 输出一致」。
 */
import { createSeededRng, seedFrom } from '../domain/rng.ts';
import { OPEN_PATHWAYS } from '../domain/character/rules.ts';
import type { Gender, PathwayId } from '../domain/character/types.ts';
import type { Goal, Persona, PlayerProfile } from './types.ts';

interface PersonaSpec {
  persona: Persona;
  /** 每天登录次数区间 */
  logins: [number, number];
  /** 每次登录指令数区间 */
  actions: [number, number];
  riskAppetite: [number, number];
  patience: [number, number];
  /** 目标权重：promote / explore / social / casual */
  goalWeights: [number, number, number, number];
  description: string;
}

export const PERSONA_SPECS: readonly PersonaSpec[] = [
  {
    persona: 'steady',
    logins: [2, 3],
    actions: [5, 7],
    riskAppetite: [0.1, 0.3],
    patience: [0.75, 0.95],
    goalWeights: [5, 3, 2, 1],
    description: '稳健：固定作息、每天上线两三次，DIG 攒够再晋升，失控风险低',
  },
  {
    persona: 'aggressive',
    logins: [3, 5],
    actions: [7, 9],
    riskAppetite: [0.7, 0.95],
    // 目标坚持度：他们是来冲序列 8 的，会连着几天盯着消化度刷；
    // 真正的「乱漂」由 chaotic（0.1—0.4）承担，两者要有区分度才测得出东西
    patience: [0.6, 0.85],
    goalWeights: [9, 1, 1, 0],
    description: '激进：为晋升连刷几天（每次上线都盯着消化度），MAD/COR 高也不停',
  },
  {
    persona: 'chaotic',
    logins: [2, 4],
    actions: [3, 6],
    riskAppetite: [0.5, 1],
    patience: [0.1, 0.4],
    goalWeights: [4, 3, 2, 3],
    description: '混乱：目标随机漂移、不做恢复，用来压失控与死循环边界',
  },
  {
    persona: 'light',
    logins: [1, 2],
    actions: [2, 4],
    riskAppetite: [0.1, 0.4],
    patience: [0.5, 0.8],
    goalWeights: [1, 3, 2, 4],
    description: '轻量：每天几条就走，主要验证短会话玩家的行为分布',
  },
  {
    persona: 'perfectionist',
    logins: [3, 4],
    actions: [6, 8],
    riskAppetite: [0.05, 0.2],
    patience: [0.88, 1],
    goalWeights: [9, 1, 1, 0],
    description: '完美主义：先净化再晋升、材料必须齐全、消化度多攒一截再动手',
  },
  /*
   * M2.17（B5）：secular（世俗者）。
   *
   * ⚠️ **五项参数与 steady 逐项相同**（登录 / 动作 / 风险 / 耐心 / 目标权重）——
   * 这不是偷懒，是对照组的要求：两个画像之间**只允许差一个变量**
   * （那个变量在 decide.ts 的 churchDecision 第一行：secular 直接 return null）。
   * 参数也不一样的话，「入教带来的差」与「画像带来的差」就分不开了。
   *
   * 本轮（M2.17）它**不参与跑批对照** —— 对照用 M217_CHURCH=off 那个开关跑（同画像、同 seed，
   * 比跨画像干净）。secular 画像进 vplayer 的用途是 M2.18 的对抗层：
   * 那时「永久不入教」才第一次成为一个**有收益的选择**（隐秘组织 / 学会）。
   */
  {
    persona: 'secular',
    logins: [2, 3],
    actions: [5, 7],
    riskAppetite: [0.1, 0.3],
    patience: [0.75, 0.95],
    goalWeights: [5, 3, 2, 1],
    description: '世俗者：参数与稳健者逐项相同，只差「不进任何教会」这一条（对抗组的对照组）',
  },
];

export const GOALS: Goal[] = ['promote', 'explore', 'social', 'casual'];

function pickWeighted<T>(items: readonly T[], weights: readonly number[], rng: { next(): number }): T {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = rng.next() * total;
  for (let i = 0; i < items.length; i += 1) {
    roll -= weights[i] ?? 0;
    if (roll < 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

function intIn(rng: { next(): number }, [min, max]: [number, number]): number {
  return min + Math.floor(rng.next() * (max - min + 1));
}

function floatIn(rng: { next(): number }, [min, max]: [number, number]): number {
  return min + rng.next() * (max - min);
}

export interface BuildProfilesOptions {
  players: number;
  seed: string;
  /** 只生成指定画像（默认全部） */
  personas?: Persona[];
}

export function buildProfiles(options: BuildProfilesOptions): PlayerProfile[] {
  const allowed = options.personas && options.personas.length > 0 ? options.personas : PERSONA_SPECS.map((spec) => spec.persona);
  const specs = PERSONA_SPECS.filter((spec) => allowed.includes(spec.persona));
  const profiles: PlayerProfile[] = [];

  for (let index = 0; index < options.players; index += 1) {
    const seed = seedFrom(['vplayer', options.seed, index]);
    const rng = createSeededRng(seed);
    const spec = specs[index % specs.length]!;
    const goal = pickWeighted(GOALS, spec.goalWeights, rng);
    /*
     * M2.26 任务 0（P0）：**途径池必须与 OPEN_PATHWAYS 同步。**
     *
     * 这里原来写死的是一条**三条途径**的列表（`['seer','warrior','sleepless']`）——
     * M2.19 实现 `sailor` 之后**没有人回来加它**，于是：
     *   · vplayer 抽不到 sailor；
     *   · 一个 sailor 玩家只能靠「材料恰好齐了」偶然产生（实测 m224：**7 人 / 3.5%**）；
     *   · ⇒ **内容做了，行为层验不到** —— 三途径实现后会是同一个坑的三倍。
     *
     * 改成从 `OPEN_PATHWAYS` 取（那是「已实现途径」的**唯一权威清单**，
     * 见 `src/domain/character/rules.ts:17`），于是**以后加途径不用再回来改这里**。
     * 测试 `test/m2-26-pathway-pool.test.ts` 守着「池子 == OPEN_PATHWAYS」。
     *
     * ⚠️ **权重目前是等权**（每条 1/n）。要改成有偏的，就在这里显式写一张权重表 ——
     * 但那时要同时更新那条测试的「等权」断言。
     *
     * ⚠️ **池子大小会改变 rng 序列**：`pickWeighted` 之后还跟着性别 / 登录次数 /
     * 指令数等一串派生，所以**同一个 seed 在不同池子大小下会产出完全不同的一批玩家**
     * （不是「只多了一条途径」）。这正是「三批必须不同轮实现」的第二个理由。
     */
    const pathway: PathwayId = pickWeighted(OPEN_PATHWAYS, OPEN_PATHWAYS.map(() => 1), rng);
    // M2.7.6：性别 50/50（由同一个 rng 派生，所以整批画像仍然完全可复现）
    const gender: Gender = rng.next() < 0.5 ? 'male' : 'female';
    profiles.push({
      id: index,
      userId: String(700000 + index),
      name: `${personaName(spec.persona)}${index}`,
      persona: spec.persona,
      goal,
      pathway,
      gender,
      loginTimesPerDay: intIn(rng, spec.logins),
      actionsPerLogin: intIn(rng, spec.actions),
      riskAppetite: Number(floatIn(rng, spec.riskAppetite).toFixed(3)),
      patience: Number(floatIn(rng, spec.patience).toFixed(3)),
      seed,
      fleetSize: options.players,
    });
  }
  return profiles;
}

export function personaName(persona: Persona): string {
  switch (persona) {
    case 'steady':
      return '稳健者';
    case 'aggressive':
      return '激进者';
    case 'chaotic':
      return '混乱者';
    case 'light':
      return '轻量者';
    case 'perfectionist':
      return '完美者';
    case 'secular':
      return '世俗者';
  }
}

export function personaSpec(persona: Persona): PersonaSpec {
  const spec = PERSONA_SPECS.find((entry) => entry.persona === persona);
  if (!spec) throw new Error(`未知画像：${persona}`);
  return spec;
}
