/**
 * 探索判定（W3 硬约束：纯函数 —— f(state, location, rng) → 结果，无 IO、无副作用）
 *
 * 命令层负责：AP 先扣后执行、材料/物品落库、事件卡结算与渲染。
 * 这一层只负责「掷骰子 + 算账」。
 */
import { NUMERIC, rarityLabel } from '../../config/numeric.ts';
import { sequenceOrInitiate, type CharacterState, type Rng } from '../character/types.ts';
import type { EffectDelta } from '../effect/apply.ts';
import type { BindType } from '../item/bind.ts';
import { randomInt, rollChance, weightedPick } from '../random.ts';
import { sequenceAllowed, type LocationDef } from './location.ts';
import { loadRecipes } from '../../data/loader.ts';

export interface LootDrop {
  itemId: string;
  quantity: number;
  bindType: BindType;
  /** 该掉落条目在掉落表里的权重，用于稀有度文案 */
  weight: number;
  rarity: string;
}

export interface ExploreOutcome {
  ok: true;
  seed: string;
  rolls: {
    /** 掉落抽样值（0—1 之间归一化后的原始值），留档用于复现 */
    drops: number[];
    danger: number;
    /** 额外掉落判定 */
    bonus: number;
    event: number | null;
  };
  drops: LootDrop[];
  danger: { triggered: boolean; hp: number; mad: number };
  eventCardId: string | null;
  deltas: EffectDelta[];
  narrative: string[];
}

export interface ExploreRejected {
  ok: false;
  reason: string;
}

/**
 * 同一地点「还没开始递减」的次数（M2.85 起是**软上限**，不再是硬上限）。
 *
 * ⚠️ 名字里的 DailyCap 是历史遗留：它**不再**决定「能不能去」，只决定
 * 「从第几次开始收益递减」。菜单与 vplayer 都读它，所以保留这个名字。
 */
export function exploreDailyCap(): number {
  return NUMERIC.explore.dailyCapPerLocation;
}

/** 今天在这个地点探到第 N 次时，收益乘数与危险倍率（菜单显示用） */
export function overflowFactors(todayCount: number): { diminish: number; danger: number } {
  // ⚠️ 不是 +1：软上限是 3 意味着「前 3 次不衰减」——第 4 次才是第一次超出
  const overflow = Math.max(0, todayCount - NUMERIC.explore.dailyCapPerLocation + 1 - 1);
  if (overflow <= 0) return { diminish: 1, danger: 1 };
  return {
    diminish: Math.pow(NUMERIC.explore.diminishRate, overflow),
    danger: 1 + overflow * NUMERIC.explore.dangerGrowth,
  };
}

/*
 * M2.86：**材料 → 它属于哪个序列**（从配方表反查，只算一次）。
 *
 * 用户实机：「一个凡人探索一下得到了独眼巨人的脑袋？」—— 截图里掉的是
 * 「主材料·全知之页」，反查出来属于**序列 2**。
 *
 * 根因是 `rollDrop` 只按地点掉落表的权重抽，**没有「玩家序列」这一维** ——
 * 而五个大城市（拜朗 211 条 / 普利兹港 174 / 特里尔 171 / 贝克兰德 164 / 廷根市 117）
 * 把**全途径全序列**的材料都塞进了自己的表里（其余 149 个地点中位数只有 4 条）。
 * 于是序列 9 的凡人能抽到序列 2 的材料。
 *
 * 映射怎么来的：某材料出现在「序列 N 的配方」里，它就属于序列 N。
 * 同一件材料可能出现在多档配方里，取**最弱的那一档**（seq 最大）——
 * 因为「够得着」的判据是玩家序列 >= 材料序列（数字越大越弱）。
 */
let itemSeqCache: Map<string, number> | null = null;
function itemSeqOf(itemId: string): number | null {
  if (itemSeqCache === null) {
    itemSeqCache = new Map();
    for (const recipe of loadRecipes().recipes) {
      for (const part of [...recipe.main, ...recipe.aux]) {
        const prev = itemSeqCache.get(part.itemId);
        if (prev === undefined || recipe.seq > prev) itemSeqCache.set(part.itemId, recipe.seq);
      }
    }
  }
  return itemSeqCache.get(itemId) ?? null;
}

/**
 * 掷一次掉落：按权重选条目，再在 minQty—maxQty 之间取数量。
 *
 * `playerSeq` 给了就**只在本序列够得着的条目里抽**（M2.86）；
 * 不传 = 不过滤（老调用方与模拟器行为不变）。
 *
 * 一件材料都没资格抽时**不是空手**：兜底退回「不过滤」抽一次 ——
 * 地点表里总有便士这类无归属的东西，而空掉落是另一种「莫名其妙」。
 */
export function rollDrop(location: LocationDef, rng: Rng, playerSeq?: number): { drop: LootDrop; roll: number } {
  let pool = location.loot;
  if (playerSeq !== undefined) {
    const allowed = location.loot.filter((loot) => {
      const need = itemSeqOf(loot.itemId);
      /*
       * ⚠️ **序列数字越大越弱**（9 = 凡人，1 = 天使）。
       *
       * 所以「够得着」的判据是 `need >= playerSeq`：材料所在的序列**不比玩家强**。
       *   玩家 9 → 只拿得到 seq 9 的材料；
       *   玩家 5 → 能拿 seq 5~9 的（都是他已经走过的路）。
       *
       * 第一版写成了 `playerSeq >= need` —— 大小关系整个反了：
       * 凡人（9）去拿序列 2 的材料时 `9 >= 2` 恒真，过滤等于没做。
       * 而当时注释里那句话**也写反了**，两处一致地错，所以看起来毫无破绽。
       *
       * 不属于任何配方的（便士 / 杂物）不设限：它们本来就没有序列属性。
       */
      return need === null || need >= playerSeq;
    });
    if (allowed.length > 0) pool = allowed;
  }
  const entry = weightedPick(pool, (loot) => loot.weight, rng);
  const roll = rng.next();
  if (!entry) {
    // 掉落表为空时兜底：不该发生（schema 要求 min(1)），但纯函数不抛异常
    return {
      drop: { itemId: '便士', quantity: 1, bindType: 'unbound', weight: 0, rarity: '常见' },
      roll,
    };
  }
  return {
    drop: {
      itemId: entry.itemId,
      quantity: randomInt(rng, entry.minQty, entry.maxQty),
      bindType: entry.bindType,
      weight: entry.weight,
      rarity: rarityLabel(entry.weight),
    },
    roll,
  };
}

/** 危险判定：概率 = dangerTriggerBase × 地点 danger */
export function rollDanger(
  location: LocationDef,
  rng: Rng,
  /** 能力给的倍率：0.8 = 危险触发概率降 20%（不眠者序列 8） */
  dangerMultiplier = 1,
): { triggered: boolean; hp: number; mad: number; roll: number } {
  const roll = rng.next();
  const chance = NUMERIC.explore.dangerTriggerBase * location.danger * dangerMultiplier;
  const triggered = roll < chance;
  return {
    triggered,
    roll,
    hp: triggered ? -NUMERIC.explore.hpPerDanger * location.danger : 0,
    mad: triggered ? NUMERIC.explore.madPerDanger * location.danger : 0,
  };
}

/**
 * 世界侧对探索的影响（M2.2）：全部由 config/numeric.ts 的 world 段算出，判定层只读。
 * 不传 = 中性值（旧行为与模拟器完全不受影响）。
 */
export interface ExploreWorldInput {
  /** 时段 × 雾日 × 天气的危险倍率 */
  exploreDangerMultiplier: number;
  /** 掉落倍率（作用在额外掉落判定上） */
  dropMultiplier: number;
}

export function resolveExplore(input: {
  state: CharacterState;
  location: LocationDef;
  rng: Rng;
  seed: string;
  /** 今日已探索该地点的次数 */
  todayCount: number;
  /** 该地点绑定的事件卡里，当前可触发（cond 通过）的候选 */
  candidateEventIds?: readonly string[];
  /** 能力提供的危险度倍率 */
  dangerMultiplier?: number;
  /** M2.2：世界时钟与天气给的倍率 */
  world?: ExploreWorldInput;
  /**
   * M2.65：**主动行动留下的产出倍率**（`.行动` 写的 `loot` 标记）。
   *
   * 作用在**掉落的件数**上，不是掉率也不是权重：原文口径是「产出 ×2 / ×3」
   *（mother.seedKeep / perfect.sequencingOrder），乘件数才是那句话的字面意思。
   * 不传 = 1 ⇒ 既有行为与模拟器逐位不变。
   */
  lootMultiplier?: number;
  /**
   * M2.65：**这一次不出事件卡**（`warrior.intimidate` 威慑的 `eventDelay` 标记）。
   *
   * 「本地点今日事件延后一格」的落点：这一次探索安静地过去，什么也没发生。
   * 不掷事件骰 —— 与「不该掷骰时不掷」同一条纪律（否则同 seed 下后面的判定会漂）。
   */
  skipEvent?: boolean;
}): ExploreOutcome | ExploreRejected {
  const { state, location, rng, seed, todayCount } = input;

  // M2.7.6：普通人没有序列，按序列 9 参与地点准入（他确实是"什么都不会的新人"）
  const seq = sequenceOrInitiate(state);
  if (!sequenceAllowed(location, seq)) {
    return { ok: false, reason: `${location.name}不是序列 ${seq} 能去的地方。` };
  }
  /*
   * ⚠️ **这里是硬上限改软上限的地方**
   *（用户拍板：「探索每日三次是不合理的机制，起码在 QQ 群文字游戏里」）。
   *
   * 原来：到 3 次就**不让去** —— 在异步的 QQ 群里，玩家想起来发一句，
   * 却被一句「换个地方吧」挡回去，而他的城市可能就那么几个地点。
   *
   * 现在：**越刷越亏**，而不是越刷越不让刷 ——
   *   · 第 4 次起，收益按 diminishRate 连乘衰减（60% / 36% / 21.6% …）
   *   · 同时危险按 dangerGrowth 线性上涨（收益掉、风险涨，这是递减的对价）
   *   · 只有到 hardCapPerLocation 才真的拒绝（防脚本无限刷）
   */
  const softCap = NUMERIC.explore.dailyCapPerLocation;
  const hardCap = NUMERIC.explore.hardCapPerLocation;
  if (todayCount >= hardCap) {
    return {
      ok: false,
      reason: '今天已经在' + location.name + '待了 ' + todayCount + ' 次 —— 这一带能翻的地方都翻遍了，歇一天再来。',
    };
  }
  // 前 softCap 次不衰减：第 softCap+1 次才是「第一次超出」
  const overflow = Math.max(0, todayCount - softCap);
  /** 收益衰减（1 = 不衰减） */
  const diminishFactor = overflow <= 0 ? 1 : Math.pow(NUMERIC.explore.diminishRate, overflow);
  /** 危险放大（1 = 不放大） */
  const dangerFactor = overflow <= 0 ? 1 : 1 + overflow * NUMERIC.explore.dangerGrowth;

  /*
   * M2.65：**产出倍率**（行动标记）。乘在件数上、四舍五入、至少 1 件 ——
   * 「×3」在 minQty=1 的条目上永远拿得到 3 件，不会因为取整变成 0。
   * 不传时是 1，逐位等于本条改动之前。
   */
  // M2.85：**超出软上限之后收益递减**（越刷越亏，而不是不让刷）
  const lootMultiplier = (input.lootMultiplier ?? 1) * diminishFactor;
  const scaleDrop = (drop: LootDrop): LootDrop =>
    lootMultiplier === 1
      ? drop
      : { ...drop, quantity: Math.max(1, Math.round(drop.quantity * lootMultiplier)) };

  const drops: LootDrop[] = [];
  const dropRolls: number[] = [];
  const first = rollDrop(location, rng, seq);
  drops.push(scaleDrop(first.drop));
  dropRolls.push(first.roll);

  // M2.2：天气的掉落倍率作用在「额外掉落」的概率上（掉落表权重不动）
  const bonusChance = Math.min(
    1,
    Math.max(0, NUMERIC.explore.bonusDropChance * (input.world?.dropMultiplier ?? 1)),
  );
  const bonusRoll = rng.next();
  if (bonusRoll < bonusChance) {
    const extra = rollDrop(location, rng, seq);
    drops.push(scaleDrop(extra.drop));
    dropRolls.push(extra.roll);
  }

  // 能力倍率 × 世界（时段 / 雾日 / 天气）倍率
  const dangerMultiplier =
    (input.dangerMultiplier ?? 1) * (input.world?.exploreDangerMultiplier ?? 1) * dangerFactor;
  const danger = rollDanger(location, rng, dangerMultiplier);

  const candidates = input.skipEvent === true ? [] : (input.candidateEventIds ?? []);
  const eventRoll = candidates.length > 0 ? rng.next() : null;
  const eventCardId =
    eventRoll === null ? null : (candidates[Math.floor(eventRoll * candidates.length)] ?? null);

  const deltas: EffectDelta[] = [];
  if (danger.hp !== 0) deltas.push({ type: 'hp', value: danger.hp });
  if (danger.mad !== 0) deltas.push({ type: 'mad', value: danger.mad });

  const narrative: string[] = [`你在${location.name}待了一段时间。`];
  if (danger.triggered) {
    narrative.push(`这里的危险比你预想的更近：${location.name}不只是看起来阴森。`);
  }

  return {
    ok: true,
    seed,
    rolls: { drops: dropRolls, danger: danger.roll, bonus: bonusRoll, event: eventRoll },
    drops,
    danger: { triggered: danger.triggered, hp: danger.hp, mad: danger.mad },
    eventCardId,
    deltas,
    narrative,
  };
}

/** 只读展示用：地点危险度文案 */
export function dangerLabel(danger: number): string {
  if (danger >= 4) return '极危险';
  if (danger >= 3) return '危险';
  if (danger >= 2) return '不安';
  if (danger >= 1) return '尚可';
  return '安全';
}
