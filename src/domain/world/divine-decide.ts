/**
 * **神明的决策引擎**（M2.97）—— 「高度智能」与「不随随便便显现」都落在这里。
 *
 * ## 用户的两条硬要求
 *
 *   ① 「神明不是随随便便就显现的，邪神也一样，这点要**严格遵守**」
 *   ② 「神明拥有高度的智能，这是**底层代码**需要你做到的」
 *
 * 项目不用 LLM（`vplayer/decide.ts` 立的规矩：规则 + 权重 + 目标驱动，完全可复现）。
 * 所以「智能」不是靠模型，是靠**四层结构**（见 `divine-throne.ts`）：
 * 资源 → 目标 → 手段库 → 对局势的反应。这个文件把四层拧成一个决定。
 *
 * ## 稀有性是怎么保证的（不是靠「概率写小一点」）
 *
 * ```
 * ① 基础出手率   每小时 0.1% —— 一位神平均 1000 小时动一次手
 * ② 沉寂期       出手之后 48 小时内**完全不考虑**再动（先出手者不能连击）
 * ③ 状态因子     空位的神（陨落者留下的后手）只有 15%；被争夺的 60%
 * ④ 显现另算     「亲自显现」要 urge 超过 0.05，而且还要再掷一次 1/20 ——
 *                也就是说：**绝大多数神明行动都是间接的**（派主教、做梦、让机器坏掉），
 *                神亲自下场是几十次里才有一次的事。
 * ```
 *
 * 24 位神 × 每小时 0.1% ⇒ 整个世界**平均每 40—60 小时**才有一次神明出手。
 * 而每一次都被局势放大（玩家在祂的地盘挖封印物 ⇒ ×4）—— 于是它稀有，但不死寂。
 *
 * ## 智能在哪
 *
 * ```
 * · 手段必须**服务于自己的目标**（`goal` 对不上的手段直接被排除）
 * · 局势匹配时，`responses[].prefer` 的那一条手段权重 ×5（针对性，不是随机）
 * · 资源不够的手段选不了（没有教会就派不出主教）
 * · 冷却中的手段选不了
 * · 玩家的位置与序列会改变祂会不会看过来（`reach` 够得到 + 序列越高越显眼）
 * ```
 */
import type { DivineMethod, DivineThrone, GazeAct } from './divine-throne.ts';

/** 基础出手率：每小时 0.1%（一位神平均 1000 小时动一次手） */
export const BASE_URGE_PER_HOUR = 0.001;
/** 出手之后的沉寂（小时）—— 神不会连着出手 */
export const SILENCE_AFTER_ACT = 48;
/*
 * 「亲自显现」的 urge 门槛（过了它还要再掷一次 1/20）。
 *
 * ⚠️ 这个值第一版拍的是 0.05 —— 而 urge 的**上限**只有：
 *     0.001（基础）× 1（在位）× 1.4（满资源）× 4（局势命中）× 1.5（玩家在祂地盘）= 0.0084
 *   ⇒ 那条分支**永远不会走到**（一万小时实测：显现 0 次）。
 *   死分支不会被任何「显现率 < 8%」的断言抓住 —— 0 也满足那个断言。
 *
 * 现在取 0.005：只有在「局势命中 + 玩家就在祂眼皮底下」时才可能过线，
 * 过了还要再掷 1/20 ⇒ 大约每次行动 2—4% 是祂亲自来。
 */
export const MANIFEST_URGE = 0.005;
/** 显现的概率折扣：过了门槛之后，二十次里才有一次是祂亲自来 */
export const MANIFEST_ODDS = 1 / 20;
/** 局势命中时手段权重的放大倍数 */
export const RESPONSE_BOOST = 5;

/** 世界此刻的局势（关键词与表里的 `responses[].when` / `gaze[].when` 对应） */
export interface WorldSituation {
  /** 世界级的局势关键词 */
  keys: readonly string[];
  /** 玩家个人的局势关键词（`gaze` 用） */
  playerKeys: readonly string[];
  /** 玩家此刻在哪座城市（决定「伸手够不够得到」） */
  playerCity: string;
  /** 玩家序列（越接近 0 越显眼） */
  playerSequence: number;
}

export interface DivineStanceInput {
  throne: DivineThrone;
  situation: WorldSituation;
  /** 距上一次出手多少小时（第一次传一个很大的数） */
  hoursSinceLastAct: number;
  /** 各手段上次使用的时刻（毫秒）；没冷却就不传 */
  methodUsedAt?: Readonly<Record<string, number>>;
  /**
   * **祂想过之后的结果**（M2.98，`divine-mind.ts` 的 `divineThink`）。
   *
   * 给了它就用它的排序（第一个候选就是祂会做的），没给就退回本文件内部的权重抽 ——
   * 既有调用点与测试因此完全不受影响。
   */
  mind?: { options: Array<{ method: DivineMethod }>; reason: string };
  now: number;
  rng: { next(): number };
}

export interface DivineStance {
  /** 这次算出来的出手欲望（调试与日志用 —— 它是「为什么没动」的答案） */
  urge: number;
  /** 选中的手段（null = 这次什么都不做） */
  method: DivineMethod | null;
  /** 是不是祂**亲自**显现（极稀有；大多数行动都是间接的） */
  manifest: boolean;
  /** 决策理由（进日志，也是测试的判据） */
  reasons: string[];
}

/** 资源总量（0—1 的粗略度量）—— 教会与天使是最值钱的，财力次之 */
function resourceScore(throne: DivineThrone): number {
  const r = throne.resources;
  const raw = r.churches.length * 0.25 + r.factions.length * 0.1 + r.artifacts.length * 0.2
    + r.angels * 0.08 + r.intel * 0.04 + r.wealth * 0.04;
  return Math.min(1, raw);
}

/** 状态因子：空位的神只剩「后手」，被争夺的位置还没坐稳 */
function stateFactor(throne: DivineThrone): number {
  if (throne.state === 'occupied') return 1;
  if (throne.state === 'contested') return 0.6;
  if (throne.state === 'sealed') return 0.25;
  return 0.15;
}

/** 这位神此刻的出手欲望（不含掷骰）—— 拆出来是为了能单独断言「为什么它这么低」 */
export function divineUrge(throne: DivineThrone, situation: WorldSituation, hoursSinceLastAct: number): { urge: number; reasons: string[] } {
  const reasons: string[] = [];
  const silence = SILENCE_AFTER_ACT * stateFactor(throne);
  if (hoursSinceLastAct < silence) {
    return { urge: 0, reasons: ['沉寂期（' + Math.round(hoursSinceLastAct) + '/' + Math.round(silence) + ' 小时）'] };
  }
  const res = resourceScore(throne);
  const matched = throne.responses.filter((r) => situation.keys.includes(r.when));
  const situationFactor = matched.length > 0 ? 4 : 1;
  if (matched.length > 0) reasons.push('局势命中：' + matched.map((m) => m.when).join('、') + '（×4）');
  const reachesPlayer = situation.playerCity !== '' && throne.resources.reach.includes(situation.playerCity);
  const reachFactor = reachesPlayer ? 1.5 : 1;
  if (reachesPlayer) reasons.push('玩家在祂够得到的地方（×1.5）');
  const urge = BASE_URGE_PER_HOUR * stateFactor(throne) * (0.4 + res) * situationFactor * reachFactor;
  reasons.push('资源 ' + res.toFixed(2) + '　状态 ×' + stateFactor(throne));
  return { urge, reasons };
}

/** 冷却中的手段选不了；资源不够的也选不了 */
function availableMethods(input: DivineStanceInput): DivineMethod[] {
  const { throne, now, methodUsedAt } = input;
  const goals = new Map(throne.goals.map((g) => [g.id, g.weight]));
  return throne.methods.filter((m) => {
    // ① 目标对不上 ⇒ 直接排除（这就是「手段服务于目标」）
    if (m.goal !== '' && !goals.has(m.goal)) return false;
    // ② 冷却
    const used = methodUsedAt?.[m.id];
    if (used !== undefined && now - used < m.cooldown_hours * 3_600_000) return false;
    // ③ 前提
    for (const need of m.needs) {
      if (need === 'church' && throne.resources.churches.length === 0) return false;
      if (need === 'angel' && throne.resources.angels === 0) return false;
      if (need === 'intel' && throne.resources.intel === 0) return false;
      if (need === 'wealth' && throne.resources.wealth === 0) return false;
      if (need === 'artifact' && throne.resources.artifacts.length === 0) return false;
    }
    // ④ 代价付得起吗（代价按 1—5 的等级读，付不起就选不了）
    for (const [key, value] of Object.entries(m.cost)) {
      if (key === 'intel' && throne.resources.intel < value) return false;
      if (key === 'wealth' && throne.resources.wealth < value) return false;
      if (key === 'angels' && throne.resources.angels < value) return false;
    }
    return true;
  });
}

/**
 * **这一次世界 tick，这位神做什么。**
 *
 * 返回 `method: null` 是**绝大多数情况下的正确答案** —— 神不是在后台刷事件的机器。
 */
export function divineStance(input: DivineStanceInput): DivineStance {
  const { throne, situation, hoursSinceLastAct, rng } = input;
  const { urge, reasons } = divineUrge(throne, situation, hoursSinceLastAct);
  if (urge <= 0) return { urge, method: null, manifest: false, reasons };
  if (rng.next() >= urge) return { urge, method: null, manifest: false, reasons };

  /*
   * M2.98：**想过之后再动**。
   *
   * `mind` 是 `divineThink` 的结果（目标 → 步骤链 → 逐条评估后的排序）。
   * 它管「动什么」，这里管「动不动」—— 稀有性四道门仍然在它下游生效。
   */
  if (input.mind !== undefined) {
    const top = input.mind.options[0];
    if (top === undefined) {
      reasons.push('出手了，但祂想过之后没有可用的手段：' + input.mind.reason);
      return { urge, method: null, manifest: false, reasons };
    }
    reasons.push(input.mind.reason);
    const manifest0 = urge >= MANIFEST_URGE && rng.next() < MANIFEST_ODDS;
    if (manifest0) reasons.push('**亲自显现**');
    return { urge, method: top.method, manifest: manifest0, reasons };
  }

  const candidates = availableMethods(input);
  if (candidates.length === 0) {
    reasons.push('出手了，但没有一条手段可用（资源 / 冷却 / 前提）');
    return { urge, method: null, manifest: false, reasons };
  }
  // 局势命中的那一条手段权重 ×5（针对性，不是随机抽）
  const preferred = new Set(
    throne.responses.filter((r) => situation.keys.includes(r.when)).map((r) => r.prefer),
  );
  const weights = candidates.map((m) => (preferred.has(m.id) ? RESPONSE_BOOST : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng.next() * total;
  let picked = candidates[0]!;
  for (let i = 0; i < candidates.length; i += 1) {
    roll -= weights[i]!;
    if (roll <= 0) { picked = candidates[i]!; break; }
  }
  if (preferred.has(picked.id)) reasons.push('选了局势命中的那一条：' + picked.id);
  /*
   * 「亲自显现」：urge 要先过门槛，然后**再掷一次** 1/20。
   * 两道门叠起来 ⇒ 神亲自下场是几十次行动里才有一次的事。
   */
  const manifest = urge >= MANIFEST_URGE && rng.next() < MANIFEST_ODDS;
  if (manifest) reasons.push('**亲自显现**');
  return { urge, method: picked, manifest, reasons };
}

/**
 * **祂会不会把视线投到某个玩家身上**（用户那一问的落点）。
 *
 * 与 `divineStance` 分开、而且**更稀有**（再乘 0.3），理由：
 * 神看一个人是**私事**，不该每小时都在发生；而它一旦发生，玩家会记住很久。
 */
export interface GazeResult {
  act: GazeAct;
  text: string;
  effect: Record<string, number>;
  flag: string;
}

export function divineGaze(input: DivineStanceInput): GazeResult | null {
  const { throne, situation, rng } = input;
  if (situation.playerKeys.length === 0) return null;
  // 够不到就别看（`reach` 是「伸手够得到的城市」）
  if (situation.playerCity !== '' && throne.resources.reach.length > 0 && !throne.resources.reach.includes(situation.playerCity)) return null;
  const hits = throne.gaze.filter((g) => situation.playerKeys.includes(g.when));
  if (hits.length === 0) return null;
  // 玩家序列越高越显眼：序列 9 几乎不会被看见，序列 1 是三倍
  const visibility = 1 + Math.max(0, 9 - situation.playerSequence) * 0.25;
  const urge = BASE_URGE_PER_HOUR * 0.3 * visibility;
  if (rng.next() >= urge) return null;
  const total = hits.reduce((sum, g) => sum + g.weight, 0);
  let roll = rng.next() * total;
  let picked = hits[0]!;
  for (const hit of hits) { roll -= hit.weight; if (roll <= 0) { picked = hit; break; } }
  return { act: picked.act, text: picked.text, effect: picked.effect, flag: picked.flag };
}
