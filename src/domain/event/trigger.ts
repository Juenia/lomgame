/**
 * 事件条件解析器（W2 §3.2 / §6.3）
 *
 * 只用白名单解析，绝不 eval。支持四类写法：
 *   flag:joined_church      角色拥有该 flag
 *   location:贝克兰德       当前地点匹配
 *   mad>50 / cor<30 / seq<=8 数值比较（字段白名单 + 操作符白名单）
 * 未识别的条件返回 null，lint 阶段会直接报 error，运行期视为「不满足」。
 */
import { PATHWAY_LABELS } from '../character/rules.ts';
import { sequenceOrInitiate, type CharacterState, type PathwayId } from '../character/types.ts';

export interface TriggerContext {
  character: CharacterState;
  flags: ReadonlySet<string>;
  /** YYYY-MM-DD */
  date: string;
  /** 玩家当前地点；未提供时，带 location 限制的卡不参与抽取 */
  location?: string;
  /** 所在队伍规模；不在队伍里按 1（只有自己） */
  partySize?: number;
}

export type CondField = 'seq' | 'dig' | 'mad' | 'cor' | 'hp' | 'mp' | 'dp';
export type CondOperator = '>' | '>=' | '<' | '<=' | '==' | '!=';

export type ParsedCond =
  | { kind: 'compare'; field: CondField; operator: CondOperator; value: number }
  | { kind: 'flag'; flag: string }
  | { kind: 'location'; location: string }
  /** W4：队伍规模条件，写法 party:size>=2 */
  | { kind: 'party'; operator: CondOperator; value: number }
  /** W5：状态条件，写法 status:lost_control（失控专属卡用） */
  | { kind: 'status'; status: string }
  /**
   * M2.7.6：入途径状态条件，写法 pathway:mortal / pathway:initiated。
   *
   * 为什么需要它：普通人事件池（src/cards/mortal/*.yaml）必须**只**落到普通人头上，
   * 而「未入途径」这件事在 W2 的条件语法里表达不出来（seq 是数字，普通人没有序列）。
   * 做成一个白名单取值而不是自由字符串：写错的人会在 lint 阶段就拿到 error。
   */
  | { kind: 'pathway'; status: PathwayCondStatus }
  /**
   * M2.76：**具体途径**条件，写法 `pathway:seer` / `pathway:warrior` …
   *
   * 为什么与 `pathway:mortal / initiated` 分成两个 kind、而不是塞进同一份取值域：
   * 那两个答的是「**入没入途径**」，这一个答的是「**走的是哪一条**」。
   * 混进一个字段之后，读的人分不清 `pathway:seer` 与 `pathway:initiated`
   * 是不是同一个维度的取值 —— K19 的形状（分不清「设计值」与「另一类值」）。
   *
   * 取值域是 `PATHWAY_LABELS` 的键 —— **不抄第二份清单**（K16）：
   * 新途径落地时 `PATHWAY_LABELS` 会被 tsc 点出来，这里跟着自动生效。
   */
  | { kind: 'pathwayId'; pathway: PathwayId };

export const COND_FIELDS: readonly CondField[] = ['seq', 'dig', 'mad', 'cor', 'hp', 'mp', 'dp'];

/** pathway: 条件允许的取值（M2.7.6） */
export const COND_PATHWAYS = ['mortal', 'initiated'] as const;
export type PathwayCondStatus = (typeof COND_PATHWAYS)[number];

/** status: 条件允许的取值（与 CharacterStatus 对齐，lint 用它校验） */
export const COND_STATUSES: readonly string[] = [
  'active',
  'injured',
  'lost_control',
  'promoting',
  'in_battle',
  'trading',
  'banned',
];

const COMPARE_PATTERN = /^(seq|dig|mad|cor|hp|mp|dp)\s*(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)$/;
const PARTY_PATTERN = /^party:size\s*(>=|<=|==|!=|>|<)\s*(\d+)$/;

/** 条件字段名 → CharacterState 读写器。注意 seq 对应的是 sequence。 */
const FIELD_READERS: Record<CondField, (character: CharacterState) => number> = {
  // M2.7.6：普通人没有序列，按 9 读 —— 于是 seq<=8 这类条件对普通人恒为 false
  seq: (character) => sequenceOrInitiate(character),
  dig: (character) => character.dig,
  mad: (character) => character.mad,
  cor: (character) => character.cor,
  hp: (character) => character.hp,
  mp: (character) => character.mp,
  dp: (character) => character.dp,
};

export function parseCond(cond: string): ParsedCond | null {
  const text = cond.trim();
  if (!text) return null;

  if (text.startsWith('flag:')) {
    const flag = text.slice('flag:'.length).trim();
    return flag ? { kind: 'flag', flag } : null;
  }
  if (text.startsWith('location:')) {
    const location = text.slice('location:'.length).trim();
    return location ? { kind: 'location', location } : null;
  }

  if (text.startsWith('pathway:')) {
    const status = text.slice('pathway:'.length).trim();
    if ((COND_PATHWAYS as readonly string[]).includes(status)) {
      return { kind: 'pathway', status: status as PathwayCondStatus };
    }
    /*
     * M2.76：具体途径。用 hasOwnProperty 而不是 `in` ——
     * 后者会把 `pathway:toString` / `pathway:constructor` 这类原型链上的键
     * 判成合法途径，于是「写错一个词」不会在 lint 阶段报错，而是静默恒 false。
     */
    if (Object.prototype.hasOwnProperty.call(PATHWAY_LABELS, status)) {
      return { kind: 'pathwayId', pathway: status as PathwayId };
    }
    return null;
  }

  if (text.startsWith('status:')) {
    const status = text.slice('status:'.length).trim();
    return status ? { kind: 'status', status } : null;
  }

  if (text.startsWith('party:')) {
    const party = PARTY_PATTERN.exec(text);
    if (!party) return null;
    return { kind: 'party', operator: party[1] as CondOperator, value: Number(party[2]) };
  }

  const matched = COMPARE_PATTERN.exec(text);
  if (!matched) return null;
  return {
    kind: 'compare',
    field: matched[1] as CondField,
    operator: matched[2] as CondOperator,
    value: Number(matched[3]),
  };
}

export function isValidCond(cond: string): boolean {
  return parseCond(cond) !== null;
}

export function evalCond(cond: string, ctx: TriggerContext): boolean {
  const parsed = parseCond(cond);
  if (!parsed) return false;

  if (parsed.kind === 'flag') return ctx.flags.has(parsed.flag);
  if (parsed.kind === 'location') return ctx.location === parsed.location;
  if (parsed.kind === 'party') return compare(ctx.partySize ?? 1, parsed.operator, parsed.value);
  if (parsed.kind === 'status') return ctx.character.status === parsed.status;
  if (parsed.kind === 'pathway') {
    // 缺省按 pathway 推断：老角色（M2.7.6 之前建的）没有 pathway_status 字段
    const status = ctx.character.pathwayStatus ?? (ctx.character.pathway ? 'initiated' : 'mortal');
    return status === parsed.status;
  }
  /*
   * M2.76：具体途径。普通人 `pathway` 是 null ⇒ 恒 false，
   * 所以途径专属卡**不需要**再搭一条 `pathway:initiated` 兜底 ——
   * 搭了就是同一件事写两遍（lint 的「重复表达」那条 warn 也在管这个形状）。
   */
  if (parsed.kind === 'pathwayId') return ctx.character.pathway === parsed.pathway;

  return compare(FIELD_READERS[parsed.field](ctx.character), parsed.operator, parsed.value);
}

function compare(actual: number, operator: CondOperator, value: number): boolean {
  switch (operator) {
    case '>':
      return actual > value;
    case '>=':
      return actual >= value;
    case '<':
      return actual < value;
    case '<=':
      return actual <= value;
    case '==':
      return actual === value;
    case '!=':
      return actual !== value;
    default:
      return false;
  }
}

export function evalConds(conds: readonly string[], ctx: TriggerContext): boolean {
  return conds.every((cond) => evalCond(cond, ctx));
}
