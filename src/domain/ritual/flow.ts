/**
 * **晋升仪式流程（M2.87）** —— 把仪式要求从「等 N 天」改成「走完一条任务链」。
 *
 * ## 为什么废掉计时
 *
 * 我上一版做了 `seclusion.ts`：解析出「三百年」，折算成 39 个游戏日，让玩家等着。
 * **用户否掉了，而且否得对**：
 *
 * > 「39个游戏日也不对，拿现实时间去要求就是纯折磨，而是应该设计一个剧情流程，
 * >  让他去完成流程，达成仪式，也有可能被破坏，仪式失败，以此类推所有的仪式」
 *
 * 等着不是玩法。而且**计时器天然不可破坏** —— `sabotage.ts` 里那套「交恶的半神在
 * 融合那一刻伸手」在计时模型下无处安放：一个在闭关的人，别人怎么搅他？
 *
 * ## 原作文本本来就写的是**步骤**，不是天数
 *
 * ```
 * apothecary_1   制作替身 → 让它活动不被拆穿 → 被大量生物记住 → 自身躺棺材深埋地底
 * arbiter_2      结束一片大陆的纷乱 → 让各势力取得能维持百年的平衡
 * sleepless_2    断绝所有社会关系 → 不试图影响他人 → 于黑暗寂静中孤独地生活
 * corpse_collector_4  寻找受死亡侵染的地下河 → 河畔完成葬礼 → 与魔药共同埋葬
 * ```
 *
 * **「三百年」不是要你罚站三百年，是「你已经不属于这个时代了」这件事的结果。**
 * 而「不属于这个时代」是可以被判定的一串条件：你从所有记录里消失了、
 * 认识你的人都不在了、你留下的东西成了文物。
 *
 * ## 五种步骤 —— 覆盖 132 条仪式里出现的全部要求形态
 *
 * | kind | 要玩家做什么 | 可失败 | 可被破坏 |
 * | --- | --- | --- | --- |
 * | `isolate` | 切断某种联系（社会关系 / 教会 / 同伴）| 是 | **是**（别人把你拉回去）|
 * | `travel` | 去某个地方（地点由文本指定或就近取材）| 是 | **是**（路上被截）|
 * | `perform` | 在某条件下完成一件事（葬礼 / 立誓 / 杀人）| 是 | **是** |
 * | `sustain` | **在做别的事时**反复判定，累计撑过 N 次 | 是 | **是** |
 * | `offering` | 献出指定物品或状态 | 是 | 否 |
 *
 * ⚠️ **`sustain` 是这里最要紧的一个** —— 它是「三百年 / 三年 / 一百年」的正确解法：
 * **不是等，是每次游玩时掷一次**。玩家继续做日常、探索、战斗，每一次都在推进，
 * 而每一次都可能失败。**时长要求变成了节奏要求。**
 *
 * 这样：
 *   · 玩家不用罚站（符合「不要拿现实时间折磨」）
 *   · 长仪式仍然「长」（因为要累积判定次数）
 *   · 期间别的玩家/NPC 能伸手（sabotage 有地方落）
 *   · 失败要重来（符合「仪式失败」）
 */

/** 步骤类型 */
export type RitualStepKind = 'isolate' | 'travel' | 'perform' | 'sustain' | 'offering';

export const RITUAL_STEP_LABELS: Readonly<Record<RitualStepKind, string>> = {
  isolate: '切断',
  travel: '前往',
  perform: '完成',
  sustain: '维持',
  offering: '献出',
};

export interface RitualStep {
  kind: RitualStepKind;
  /** 这一步要什么（从仪式原文里摘出来的短语，给玩家看的） */
  what: string;
  /**
   * 需要累计的次数。
   *
   * `isolate` / `travel` / `perform` / `offering` 恒为 1（做一次就够）。
   * `sustain` 是**判定次数** —— 由原作的时长折算而来，但计的是「玩了多少次」而不是「等了多久」。
   */
  times: number;
  /** 单次判定的成功率（0—1）。由难度档给，项目派生值 */
  chance: number;
}

/**
 * `sustain` 的判定次数：**原作时长 → 要玩多少次**。
 *
 * ⚠️ **项目派生值**，不是原作数据。原作写的是「三百年」；
 * 这里回答的是「那三百年在游戏里表现为多少次判定」。
 *
 * 依据：
 *   · 一次判定 = 玩家主动做一件事（探索 / 战斗 / 日常），一天大概发生 3—8 次；
 *   · 一次晋升仪式的手感目标是**跨 3—6 次上线**，而不是跨 3—6 周；
 *   · 所以 `次数 = clamp(4, 24, round(log2(年数) * 4))` —— 年数翻倍只多 4 次，
 *     「三百年」与「三年」拉开差距但都不至于变成苦工。
 */
export function sustainChecksFor(years: number): number {
  if (years <= 0) return 3;
  const raw = Math.round(Math.log2(years + 1) * 1.6);
  /*
   * ⚠️ 上限从 24 压到 **8**：
   *
   * 第一版给 `clamp(4, 24, …)`，实机点了几下才意识到 —— 24 步 × 45% 成功率
   * 等于**期望要点 53 次**。那不是「走一条剧情流程」，那是把玩家按在椅子上。
   *
   * 用户否掉计时模型的原话是「拿现实时间去要求就是纯折磨」；
   * **而「点 53 次」是同一件事换了个形式** —— 都是拿玩家的时间当门槛。
   *
   * 一条终局仪式该有的手感是「几件大事」，所以上限 8 ——
   * 每一下都是一次有戏的判定，而不是一次无意义的点击。
   */
  return Math.max(3, Math.min(8, raw));
}

/**
 * 单次判定的成功率：**越长的仪式越难一次过**，但难度上限压住，
 * 免得「三百年」变成几十次全部失败。
 *
 * ⚠️ 项目派生值。
 */
export function sustainChanceFor(times: number): number {
  /*
   * 3 次 → 0.9；8 次 → 0.7，线性插值。
   *
   * 比第一版（0.85 → 0.45）**宽松得多**，理由同上：
   * 这一步判定的是「你有没有撑住」，不是「你打不打得过」。
   * 失败要有分量（所以不是 1.0），但不该让它变成一道要刷的关。
   */
  const t = Math.max(0, Math.min(1, (times - 3) / 5));
  return Number((0.9 - t * 0.2).toFixed(2));
}

/* ═══════════ 从仪式原文拆步骤 ═══════════ */

/** 分句：按中文标点切开，丢掉过短的碎片 */
function clauses(text: string): string[] {
  return text
    .split(/[，。；、（）()【】「」“”]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
}

/**
 * 从一条仪式原文里拆出步骤。
 *
 * ## 口径
 *
 * **能从文本看出来的才拆** —— 拆不出来就返回空数组，由调用方说「原作未载具体步骤」。
 * 这条比「凑出几步」重要：编出来的步骤会让玩家去做一件原作没要求的事。
 */
export function parseRitualSteps(ritual: string): RitualStep[] {
  const steps: RitualStep[] = [];
  /*
   * ⚠️ 三类**必须先剔掉**的句子（都在真数据里撞到过）：
   *
   *   ① 「该仪式**不需要**仪式举行者占据主导地位」—— 这是**说明**，不是要求。
   *      第一版把它拆成了一个 `perform` 步骤，玩家会去做一件原作没要求的事。
   *   ② 「顶替濒死者或三年内会死去的人，仪式**无效**」—— 反例条件。
   *   ③ 「两次杀人之间，至少**间隔**三天」—— 间隔约束，不是步骤。
   *
   * 判据一句话：**读起来像「说明它是什么」的，不是步骤；像「要你去做什么」的，才是。**
   */
  const isCommentary = (c: string): boolean =>
    /不需要|不是必须|无需|并不需要|注：|同理|例如|参见|不算|无效|失效|重置/.test(c);
  /** 同一个时长在一条仪式里只该产生一个 sustain */
  let sawDuration = false;
  for (const c of clauses(ritual)) {
    if (isCommentary(c)) continue;
    // 时长 → sustain：这一句里带年/天，且不是「无效条件」或「间隔约束」
    const dur = /([0-9一二两三四五六七八九十百千万]+)\s*(年|天)(?!使|才|然|空)/.exec(c);
    if (dur !== null && !sawDuration && !/无效|失效|重置/.test(c) && !/间隔|之间/.test(c)) {
      sawDuration = true;
      const raw = cnToNum(dur[1]!);
      if (raw !== null) {
        // 「天」按 360 天一年折算成年数 —— 只是为了让多次判定有个统一的量纲
        const years = dur[2] === '年' ? raw : Math.max(1, Math.round(raw / 360));
        const times = sustainChecksFor(years);
        steps.push({ kind: 'sustain', what: c.slice(0, 40), times, chance: sustainChanceFor(times) });
        continue;
      }
    }
    // 切断 / 断绝 / 脱离 → isolate
    if (/断绝|脱离|离开|放弃|不再|切断|抹去|遗忘|取代|替代|顶替/.test(c)) {
      steps.push({ kind: 'isolate', what: c.slice(0, 40), times: 1, chance: 0.7 });
      continue;
    }
    // 前往某地 → travel
    if (/前往|抵达|寻找|找到|进入|前往|于.{0,6}(河畔|地底|棺|陵寝|墓)/.test(c)) {
      steps.push({ kind: 'travel', what: c.slice(0, 40), times: 1, chance: 0.75 });
      continue;
    }
    // 完成某事 → perform
    /*
     * ⚠️ 动词表是**从真数据反推**的，不是想当然写的。
     *
     * 第一版只写了「完成/举行/杀死/献祭…」，于是 63 条仪式拆不出任何步骤 ——
     * 而它们的原文里明明写着要做什么，只是用的动词不在表里：
     *
     *   建立 / 愚弄 / 解决 / 布置 / 搏杀 / 斩杀 / 宣誓效忠 / 修建 / 降服 /
     *   让…重回 / 让…永眠 / 带去厄难 / 摆放 / 获得 / 通过 / 使用 / 抵达
     *
     * 补表的时候顺手看了一遍剩下的：**这 63 条里有 43 条是「一句话目标」**
     * （「愚弄一次时间、历史或者命运」），它们本来就只有一步 ——
     * 那不是解析失败，是那些仪式的流程本身就只有一件事。
     */
    if (/完成|举行|杀死|谋杀|献祭|立誓|宣誓|确立|制作|制造|打败|搏杀|斩杀|结束|取得|获得|预言|见证|践行|维持|保全|拯救|摧毁|破坏|搜集|积累|培养|驯化|建立|修建|布置|摆放|解决|愚弄|降服|穿越|通过|使用|抵达|让/.test(c)) {
      steps.push({ kind: 'perform', what: c.slice(0, 40), times: 1, chance: 0.6 });
      continue;
    }
    // 献出某物 → offering
    if (/服食|服用|献出|付出|用作|填充|吞下|饮下|化作|转变为/.test(c)) {
      steps.push({ kind: 'offering', what: c.slice(0, 40), times: 1, chance: 0.9 });
      continue;
    }
  }
  return steps;
}

const CN_DIGITS: Readonly<Record<string, number>> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  十: 10, 百: 100, 千: 1000, 万: 10000,
};

/** 中文数字 → 数字（「三百」→ 300）。解析不了返回 null */
export function cnToNum(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  let section = 0;
  let pending = 0;
  for (const ch of raw) {
    if (/[一二两三四五六七八九]/.test(ch)) pending = CN_DIGITS[ch] ?? 0;
    else if ('十百千万'.includes(ch)) {
      section += (pending === 0 ? 1 : pending) * (CN_DIGITS[ch] ?? 0);
      pending = 0;
    } else return null;
  }
  const total = section + pending;
  return total > 0 ? total : null;
}

/* ═══════════ 流程进度 ═══════════ */

export interface RitualProgress {
  riteId: string;
  /** 每一步已完成的次数，索引对应 steps */
  done: number[];
  startedAt: number;
}

export type StepOutcome =
  | { kind: 'advanced'; progress: RitualProgress; stepIndex: number }
  | { kind: 'failed'; progress: RitualProgress; stepIndex: number }
  | { kind: 'complete'; progress: RitualProgress };

/**
 * 推进一次判定。
 *
 * `roll` 由调用方给（可复现的 seed 派生），所以这个函数是纯的、可测的。
 * **失败不清零**（那太狠），只消耗这一次机会 —— 玩家继续做，继续掷。
 */
export function advanceStep(
  steps: readonly RitualStep[],
  progress: RitualProgress,
  stepIndex: number,
  roll: number,
): StepOutcome {
  const step = steps[stepIndex];
  if (step === undefined) return { kind: 'complete', progress };
  if (roll >= step.chance) {
    // 失败：这一步的计数不动，但流程留在原地（不清零、不倒退）
    return { kind: 'failed', progress, stepIndex };
  }
  const done = [...progress.done];
  done[stepIndex] = (done[stepIndex] ?? 0) + 1;
  const next: RitualProgress = { ...progress, done };
  if ((done[stepIndex] ?? 0) >= step.times) {
    const allDone = steps.every((s, i) => (done[i] ?? 0) >= s.times);
    if (allDone) return { kind: 'complete', progress: next };
  }
  return { kind: 'advanced', progress: next, stepIndex };
}

/** 整个流程是否走完 */
export function isFlowComplete(steps: readonly RitualStep[], progress: RitualProgress): boolean {
  return steps.every((s, i) => (progress.done[i] ?? 0) >= s.times);
}

/** 当前该推哪一步（第一个没走完的） */
export function currentStepIndex(steps: readonly RitualStep[], progress: RitualProgress): number {
  for (let i = 0; i < steps.length; i += 1) {
    if ((progress.done[i] ?? 0) < steps[i]!.times) return i;
  }
  return steps.length;
}

/** 面向玩家的一行进度 */
export function flowLine(steps: readonly RitualStep[], progress: RitualProgress): string {
  const parts: string[] = [];
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i]!;
    const d = progress.done[i] ?? 0;
    const mark = d >= s.times ? '✓' : d > 0 ? '◐' : '○';
    parts.push(mark + RITUAL_STEP_LABELS[s.kind] + (s.times > 1 ? ' ' + d + '/' + s.times : ''));
  }
  return parts.join('　');
}