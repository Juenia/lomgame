/**
 * **教会的命运**（M2.169）—— 神倒下之后，祂的教会会怎么样（纯函数）。
 *
 * 原作给了三种结局，这里照着落：
 *
 *   intact    如常     —— 祂还在，教会照旧
 *   crippled  失了庇护 —— 高序列者撤离、封印物调走，遇事没人管了（原作：神战后撤出鲁恩）
 *   absorbed  被吞并   —— **动手的那一位（或祂的盟友）接管了它**
 *              （原作：「战神陨落后黑夜女神教会彻底控制战神教会」）
 *
 * ⚠️ 三种里只有 `absorbed` 需要「接管者」—— 而邪神往往**没有教会**，
 * 所以祂掀翻一位正神之后，那位正神的教会只会 `crippled`：没人接手，只是塌了。
 * 这一条是设计上的重点：**不同的赢家留下不同的局面**。
 */

export const CHURCH_FATES = ['intact', 'crippled', 'absorbed'] as const;
export type ChurchFate = (typeof CHURCH_FATES)[number];

export const CHURCH_FATE_LABELS: Readonly<Record<ChurchFate, string>> = {
  intact: '如常',
  crippled: '失了庇护',
  absorbed: '被吞并',
};

export interface ChurchState {
  churchId: string;
  fate: ChurchFate;
  controlledBy: string;
  since: number;
  by: string;
  note: string;
}

/**
 * **一位神倒下之后，祂的教会变成什么**。
 *
 * 规则只有一条，但它是原作的形状：**谁能接手，取决于动手的那一位有没有教会**。
 *   · 发起者有教会（比如黑夜女神对战神）⇒ 吞并（absorbed，controlled_by = 发起者的教会）
 *   · 发起者没有教会（邪神 / 外神）⇒ 只是塌了（crippled）—— 没人接手
 */
export function fateAfterFall(input: {
  /** 目标神的教会（可能不止一家） */
  targetChurches: readonly string[];
  /** 发起者的教会 */
  schemerChurches: readonly string[];
  /** 同谋里有没有人有教会（盟友也能接手） */
  allyChurches: readonly string[];
  at: number;
  by: string;
  targetName: string;
  schemerName: string;
}): ChurchState[] {
  const taker = input.schemerChurches[0] ?? input.allyChurches[0] ?? '';
  const states: ChurchState[] = [];
  for (const churchId of input.targetChurches) {
    if (taker === '') {
      states.push({
        churchId,
        fate: 'crippled',
        controlledBy: '',
        since: input.at,
        by: input.by,
        note: input.targetName + '倒下之后，这家教会再没有人撑腰 —— 高序列的走了，封印物也被调走了。',
      });
      continue;
    }
    states.push({
      churchId,
      fate: 'absorbed',
      controlledBy: taker,
      since: input.at,
      by: input.by,
      note: input.schemerName + '的人接手了' + input.targetName + '的教会 —— 神职还是那些人，念的已经不是同一位了。',
    });
  }
  return states;
}

/**
 * **这家教会还管不管事**（清剿池与教会援助读它）。
 *
 * 被吞并的教会还管事（换了个主人而已）；失了庇护的不管了 ——
 * 于是那座城里的怪物**没人清理**，而这是玩家能直接感觉到的后果。
 */
export function stillActive(fate: ChurchFate): boolean {
  return fate !== 'crippled';
}

/** 玩家读到的那一句 */
export function churchFateLineOf(churchName: string, state: ChurchState, takerName: string): string {
  if (state.fate === 'intact') return churchName + '照旧。';
  if (state.fate === 'crippled') return churchName + '失了庇护 —— ' + state.note;
  return churchName + '已经被' + (takerName === '' ? '别人' : takerName) + '接手。';
}
