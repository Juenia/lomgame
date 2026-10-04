/**
 * 模拟器策略（W5）：三种玩家画像。
 * 策略只决定「什么时候做什么」，所有判定一律调用真实纯函数。
 */
export type StrategyId = 'steady' | 'aggressive' | 'chaotic';

export interface StrategyDef {
  id: StrategyId;
  name: string;
  description: string;
  /** 每日扮演次数 */
  playsPerDay: number;
  /** 每日探索次数（受 AP 限制） */
  exploresPerDay: number;
  /** 每日休息次数（受 AP 与每日 1 次限制） */
  restsPerDay: number;
  /** COR 达到该值就去净化（undefined = 从不净化） */
  purifyWhenCorAtLeast?: number;
  /** 每日调制魔药次数上限（材料不足会被自动挡下） */
  brewsPerDay: number;
  /** 调到就喝 */
  drinkImmediately: boolean;
  /** 晋升时机：DIG ≥ digThreshold + margin */
  promoteDigMargin: number;
  /** 混乱型：每天随机行动次数区间 */
  randomActions?: readonly [number, number];
  /** 混乱型：各类行动的权重 */
  actionWeights?: { play: number; explore: number; brew: number; drink: number; promote: number };
  /** 混乱型：随机挑行动，不休息不净化 */
  randomOnly?: boolean;
  /** 扮演用词风格：契合 / 混合 / 乱写 */
  playStyle: 'matched' | 'mixed' | 'random';
}

export const STRATEGIES: Record<StrategyId, StrategyDef> = {
  steady: {
    id: 'steady',
    name: '稳健型',
    description: '每日扮演 2 次、探索 2 次、休息 1 次；DIG 超出门槛 15 点才晋升',
    playsPerDay: 2,
    exploresPerDay: 2,
    restsPerDay: 1,
    // 材料够就调，最多 2 次/天（材料不够时自动被挡下）
    brewsPerDay: 2,
    drinkImmediately: true,
    promoteDigMargin: 10,
    playStyle: 'matched',
  },
  aggressive: {
    id: 'aggressive',
    name: '激进型',
    description: '每日扮演 5 次、探索 3 次、调制 1 次；COR ≥ 30 就净化；DIG 刚达标就晋升',
    playsPerDay: 5,
    exploresPerDay: 3,
    restsPerDay: 0,
    purifyWhenCorAtLeast: 20,
    brewsPerDay: 1,
    drinkImmediately: true,
    promoteDigMargin: 0,
    playStyle: 'mixed',
  },
  chaotic: {
    id: 'chaotic',
    name: '混乱型',
    description: '每天随机 0—6 个行动，不休息不净化，用来压失控边界',
    playsPerDay: 0,
    exploresPerDay: 0,
    restsPerDay: 0,
    brewsPerDay: 0,
    drinkImmediately: false,
    promoteDigMargin: 0,
    randomActions: [2, 7],
    actionWeights: { play: 45, explore: 20, brew: 15, drink: 10, promote: 10 },
    randomOnly: true,
    playStyle: 'random',
  },
};

/**
 * M2.1 结论之一（写在注释里防后人重复踩）：
 * 这三套策略是 **W5 的假设输入**，不是实测行为。模拟器里激进型 30 天会把 MAD 刷到 93.5，
 * 而 W7/W8 实测激进型 14 天 MAD 均值只有 41 / P90 76（晋升之后玩家就不刷了）。
 * 所以 M2.1 **没有**把闸门值建立在这三套策略上，而是另建了实测回灌的经验投影
 * （src/sim/empirical.ts + docs/M2-失控重定报告.md）；这三套策略继续留在模拟器里当压力测试与对照，
 * 也正是「闸门不能单独调」的活证据：同样的新闸门，套在这套假设上会得到 93% 的失控率。
 */
export function strategyOf(id: StrategyId): StrategyDef {
  return STRATEGIES[id];
}

export const STRATEGY_IDS: StrategyId[] = ['steady', 'aggressive', 'chaotic'];
