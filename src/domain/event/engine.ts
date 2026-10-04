/**
 * 事件卡引擎（W2 §3.2）
 *
 * 流程：过滤（cond / 序列区间 / 地点 / 每日去重 / 冷却）→ 权重随机 → 结算。
 * 随机只用注入的 Rng（seed 化），所以「同一 seed 复现同一次判定」成立。
 */
import type { Effect, EventCard, Trigger } from '../../cards/schema.ts';
import { sequenceOrInitiate, type CharacterState, type Rng } from '../character/types.ts';
import { apply, type ApplyResult, type EffectDelta } from '../effect/apply.ts';
import { weightedPick } from '../random.ts';
import { evalConds, type TriggerContext } from './trigger.ts';

export interface PickOptions {
  /** YYYY-MM-DD，用于每日去重 */
  date: string;
  /**
   * **今天每张卡已经出过几次**（卡 id → 次数）。
   *
   * M2.69：在此之前它是一个 `Set`（"今天出过没有"），
   * 于是卡顶层的 `daily_limit` —— 65 张全写、从 W2 起就在那里 —— **运行期没人读**，
   * 每日上限实际恒为 1。改成次数之后，`daily_limit: 2` 的卡真的能出两次，
   * 而 `daily_limit: 0` 有了一种表达「今天别出我」的方式（不必把卡从内容里删掉）。
   */
  triggeredToday?: ReadonlyMap<string, number>;
  /** 冷却判定，返回 true 表示该卡还在冷却中 */
  inCooldown?: (card: EventCard) => boolean;
  /** 只从这几类触发器里抽（daily / random / hidden / ...）；不填表示全池 */
  types?: Array<Trigger['type']>;
  /** 当前地点，用于 location 限制 */
  location?: string;
}

export interface CardApplication {
  result: ApplyResult;
  /** 卡效果里要写入的 flag（走 flags 表，不属于数值改动） */
  flagsToSet: string[];
}

export class EventEngine {
  #cards: readonly EventCard[];

  constructor(cards: readonly EventCard[]) {
    this.#cards = cards;
  }

  get size(): number {
    return this.#cards.length;
  }

  get cards(): readonly EventCard[] {
    return this.#cards;
  }

  byType(type: Trigger['type']): EventCard[] {
    return this.#cards.filter((card) => card.trigger.type === type);
  }

  byTypes(types: Array<Trigger['type']>): EventCard[] {
    return this.#cards.filter((card) => types.includes(card.trigger.type));
  }

  byId(id: string): EventCard | null {
    return this.#cards.find((card) => card.id === id) ?? null;
  }

  /** 通过全部硬性过滤、可以参与抽取的卡 */
  eligible(ctx: TriggerContext, options: PickOptions): EventCard[] {
    return this.#cards.filter((card) => {
      if (options.types && !options.types.includes(card.trigger.type)) return false;
      /*
       * M2.69：**每日上限**（`daily_limit` 的读取点，全仓唯一一处）。
       *
       * 0 读作「今天不许出」（而不是「不限次」）：它是**上限**，
       * 而一个「写 0 反而不限次」的口径会让最该被关掉的那张卡变成最常出的那张。
       * 本版 65 张卡都写着 ≥1，所以这一条只影响未来的内容。
       */
      const used = options.triggeredToday?.get(card.id) ?? 0;
      if (used >= card.daily_limit) return false;
      if (options.inCooldown?.(card) === true) return false;

      const location = options.location ?? ctx.location;
      if (card.trigger.location && card.trigger.location.length > 0) {
        if (!location || !card.trigger.location.includes(location)) return false;
      }

      // M2.7.6：普通人没有序列。按「序列 9 的新人」参与 min_seq/max_seq 过滤，
      // 于是要求 seq<=8 的卡不会落到普通人头上（他没有那个能力触发它们）
      const seq = sequenceOrInitiate(ctx.character);
      const { min_seq: minSeq, max_seq: maxSeq } = card.trigger;
      if (minSeq !== undefined && seq < minSeq) return false;
      if (maxSeq !== undefined && seq > maxSeq) return false;

      return evalConds(card.trigger.cond, { ...ctx, location });
    });
  }

  /** 权重随机抽一张；无可选卡返回 null */
  pick(ctx: TriggerContext, rng: Rng, options: PickOptions): EventCard | null {
    const pool = this.eligible(ctx, options);
    if (pool.length === 0) return null;

    return weightedPick(pool, (card) => card.trigger.weight, rng);
  }

  /** 卡效果 → 唯一数值入口的 delta 列表（flag 单独返回） */
  static toDeltas(card: EventCard): { deltas: EffectDelta[]; flagsToSet: string[] } {
    const deltas: EffectDelta[] = [];
    const flagsToSet: string[] = [];

    for (const effect of card.effects) {
      for (const field of ['dig', 'cor', 'mad', 'hp', 'mp', 'dp'] as const) {
        const value = effect[field];
        if (value !== undefined && value !== 0) deltas.push({ type: field, value });
      }
      if (effect.item) {
        deltas.push({ type: 'item', itemId: effect.item, quantity: effect.n ?? 1 });
      }
      if (effect.flag) flagsToSet.push(effect.flag);
    }

    return { deltas, flagsToSet };
  }

  /** 结算一张卡；数值一律走 apply()，保证事件日志与幂等口径一致 */
  static applyCard(
    state: CharacterState,
    card: EventCard,
    options: { now: number; seed?: string },
  ): CardApplication {
    const { deltas, flagsToSet } = EventEngine.toDeltas(card);
    const result = apply(state, deltas, `事件卡:${card.id}`, options.now, options.seed);
    return { result, flagsToSet };
  }
}

export type { Effect };
