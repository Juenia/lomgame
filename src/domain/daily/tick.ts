/**
 * 每日 tick 的纯计算部分（W4）
 *
 * 顺序很重要：
 *   1) 先解除昨天留下的失控状态（失控持续 1 天）—— 处于失控中的角色当天不再重复判定，
 *      否则 MAD/COR 没降下来就会天天失控，变成死循环；
 *   2) 再恢复 MP；
 *   3) 最后做失控判定（只对「恢复后仍处于 active」的角色）。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { pickLostForm, type LostForm } from '../character/lost-form.ts';
import { computeLossOfControlProbability, rollLossOfControl } from '../character/rules.ts';
import type { CharacterState, Rng } from '../character/types.ts';
import { CLAMP, type EffectDelta } from '../effect/apply.ts';
import type { StatCaps } from '../ability/ability.ts';
import { randomInt } from '../random.ts';

export interface TickPlan {
  characterId: string;
  userId: string;
  name: string;
  deltas: EffectDelta[];
  status: CharacterState['status'];
  recoveredFrom: CharacterState['status'] | null;
  lostControl: {
    triggered: boolean;
    chance: number;
    roll: number;
    hpLoss: number;
    /*
     * M2.76：**这次进的是哪个堕落形态**，以及它实际落下去的后果。
     *
     * `formId` 为 null = 该途径没写形态 / 序列够不着 ⇒ 用的是 `NUMERIC.tick` 的全局缺省。
     * 保留 null 而不是拿一个「默认形态」顶上去：缺省与形态是**两件事**，
     * 混成一个会让「这条途径还没写形态」在库里看不出来（K19 的形状）。
     */
    formId: string | null;
    formName: string | null;
    /** 实际落下去的 MAD / COR（形态可覆盖全局缺省） */
    madGain: number;
    corGain: number;
    /** 形态自带的那句「你现在是什么样」；null = 用该途径的通用失控文本 */
    blurb: string | null;
    /**
     * 形态自带的群播报。
     *
     * ⚠️ **本轮没有读取点**：每日 tick 的通知通道是逐用户私聊（`TickNotification` 只有
     * `userId` + `text`），没有群播报这条边。字段先留着并在交付说明里登记，
     * 等接「群内可见的失控播报」时再消费 —— 不假装它已经生效。
     */
    group: string | null;
  } | null;
}

/**
 * M2.13：**被动物品对每日结算的影响**（缺省 = 中性 = 与 M2.4 的行为逐位一致）。
 *
 * `madPerDay` —— 占卜水晶：每天多一次耳鸣（sideEffect.mad 写的就是它）。
 *
 * ⚠️ M2.85：原 `apRecoveryHalved`（时间沙漏的「接下来几天 AP 恢复减半」代价）
 * 随行动值机制一并移除 —— 该字段与每日恢复分支都已删除。
 */
export interface DailyWonderInput {
  madPerDay?: number;
}

export function planCharacterTick(input: {
  state: CharacterState;
  rng: Rng;
  /** M2.13：不传 = 中性（模拟器与既有用例行为不变） */
  wonder?: DailyWonderInput;
  /*
   * M2.76：**堕落形态池**（`deps.lostControlPool.forms`）。
   *
   * ⚠️ 不传或传空 = **与 M2.76 之前逐位一致** —— 包括 **rng 的消耗次数**。
   * 这不是顺手写的兼容：抽形态本身要掷一次骰，若在空池时也掷，
   * 所有既有失控用例的随机序列都会平移，而症状是「一堆看起来无关的用例开始飘」。
   */
  forms?: readonly LostForm[];
  /*
   * M2.85：恢复类 delta 要按**上限**算 —— 缺省用 CLAMP（[0,100]）。
   * 调用方（infra/tick.ts）传真实 caps：能力加成会把上限抬到 100 以上；
   * 不传也不会算错，只是「已满」的判定会保守一点。
   */
  caps?: StatCaps;
}): TickPlan {
  const { state, rng } = input;
  const wonder = input.wonder ?? {};
  const deltas: EffectDelta[] = [];
  let status = state.status;
  let recoveredFrom: CharacterState['status'] | null = null;
  let lostControl: TickPlan['lostControl'] = null;

  // 1) 失控自然解除
  if (status === 'lost_control') {
    recoveredFrom = 'lost_control';
    status = 'active';
  }

  // 2) 恢复
  //    M2.85：行动值机制移除 —— 不再有每日 AP 恢复（时间沙漏的恢复减半代价随之失效）。
  //    ⚠️ **满了就不再写那一条**：否则每天都会多出一笔被 clamp 掉的账
  //    （tick.test.ts 的「MP 已满时不产生多余的 delta」就是这条判据）。
  const mpCap = (input.caps ?? CLAMP).mp ?? CLAMP.mp;
  if (NUMERIC.tick.mpRestore > 0 && state.mp < mpCap[1]) {
    deltas.push({ type: 'mp', value: NUMERIC.tick.mpRestore });
  }
  //    M2.13：占卜水晶的每日代价
  if ((wonder.madPerDay ?? 0) !== 0) deltas.push({ type: 'mad', value: wonder.madPerDay! });

  // 3) 失控判定（与 W2/W3 共用 rollLossOfControl）
  //    注意：刚从失控里恢复的角色当天不再判定，避免「没降 MAD/COR 就天天失控」的死循环
  if (status === 'active' && recoveredFrom === null) {
    const probeRolls: number[] = [];
    const probe: Rng = {
      next: () => {
        const value = rng.next();
        probeRolls.push(value);
        return value;
      },
    };
    // M2.33（P5）：闸门按**角色自己的序列**取（9—7 冻结 65，6—4 → 60，3—1 → 55，0 → 50）
    const gate = { mad: state.mad, cor: state.cor, sequence: state.sequence };
    const triggered = rollLossOfControl(gate, probe);
    const roll = probeRolls[0] ?? 0;
    const chance = computeLossOfControlProbability(gate);
    if (triggered) {
      /*
       * M2.76：先按途径 + 序列抽形态（**只在触发时抽**，铁律 6），
       * 再由它决定这次失控的后果；没有形态就回落全局缺省。
       */
      const formPool = input.forms ?? [];
      const form =
        formPool.length > 0 && state.pathway !== null
          ? pickLostForm(formPool, state.pathway, state.sequence ?? 9, rng)
          : null;
      const hpLoss = randomInt(
        rng,
        form?.hpLossMin ?? NUMERIC.tick.lostControlHpMin,
        form?.hpLossMax ?? NUMERIC.tick.lostControlHpMax,
      );
      const madGain = form?.madGain ?? NUMERIC.tick.lostControlMad;
      const corGain = form?.corGain ?? 0;
      deltas.push({ type: 'hp', value: -hpLoss });
      deltas.push({ type: 'mad', value: madGain });
      // COR 只在形态真的加了它时才落一条 delta —— 否则每个失控都会多一条值为 0 的账
      if (corGain !== 0) deltas.push({ type: 'cor', value: corGain });
      status = 'lost_control';
      lostControl = {
        triggered: true,
        chance,
        roll,
        hpLoss,
        formId: form?.id ?? null,
        formName: form?.name ?? null,
        madGain,
        corGain,
        blurb: form?.blurb ?? null,
        group: form?.group ?? null,
      };
    } else {
      lostControl = {
        triggered: false,
        chance,
        roll,
        hpLoss: 0,
        formId: null,
        formName: null,
        madGain: 0,
        corGain: 0,
        blurb: null,
        group: null,
      };
    }
  }

  return {
    characterId: state.id,
    userId: state.userId,
    name: state.name,
    deltas,
    status,
    recoveredFrom,
    lostControl,
  };
}
