/**
 * **堕落生物**（M2.167）—— 人堕落之后变成了什么（纯函数，无 IO）。
 *
 * 用户口径：「NPC 堕落了应该堕落成非凡生物，会袭击人，教会组织等正神的组织会去清理堕落者。」
 * 设计依据见 docs/M2.167-堕落者-设计与原作依据.md（每条都标了原作出处）。
 *
 * ## 这个文件只做四件事
 *
 *   ① 判定「他这会儿撑不撑得住」（`npcMutationChance`）
 *   ② 挑他长成了哪一个形态（`pickFallenBeast` —— 复用 `pickLostForm`）
 *   ③ 把形态变成一只**生物**（`spawnOf` —— 交给 creatures 那套现成的世界实体）
 *   ④ 教会来清剿的结算（`cullOutcome` —— 复用猎杀资格闸与死亡档位表）
 *
 * ## 一条纪律：**能复用的一律复用，不新造数字**
 *
 * 「按原作设定走」不等于「另造一套数值」—— 原作没给数字的地方，接项目已有的口径：
 *
 *   异变概率   = `computeLossOfControlProbability`（玩家失控用的那条公式，见 character/rules.ts）
 *                NPC 没有 MAD，用 npc_life.corrupted 喂 cor —— 两者是同一个语义：污染度。
 *                序列 9 的闸门是 65、divisor 250 ⇒ 堕落度 70 的人 2%/小时、100 的人 14%/小时
 *                （约两三天到一周 —— 这是既有公式在极端输入下的自然结果，不是我拍的）。
 *   形态选择   = `pickLostForm`（22 条途径的形态池，顺序与权重都由它说了算）
 *   清剿资格   = `canHunt` / `huntChance`（打不过就不上，与 NPC 猎杀生物同一条闸）
 *   失手代价   = `deathChanceOf(序列, 'creature')`（上一轮做的死亡档位表）
 *
 * ## 原作给的四条依据（详见设计文档）
 *
 *   · 「序列 4 起可以主动展现神话生物形态，但**极易失控**」—— 所以序列越高越危险
 *   · 「晋升失败……**必然诞生危险的『尸王』**」—— 那一条是确定的，不掷骰
 *   · 神弃之地的黑暗「会让生物**堕落为怪物**」、血月「放出无数怪物」—— 环境会推
 *   · 因斯·赞格威尔是转途径者，形态同时表现出八腿魔狼与羽蛇 —— 所以形态要能**拼**
 */
import { computeLossOfControlProbability } from '../character/rules.ts';
import type { PathwayId, Rng } from '../character/types.ts';
import { pickLostForm, type LostForm } from '../character/lost-form.ts';
import { canHunt, huntChance } from './npc-calamity.ts';
import { parseCreatureSpecies } from '../creature/schema.ts';
import type { CreatureSpecies } from '../creature/types.ts';
import { deathChanceOf } from './npc-life.ts';
import type { FallenBeast } from './fallen-beast-schema.ts';

/* ---------------- ① 他撑不撑得住 ---------------- */

/**
 * **环境因子**：他此刻站在什么样的地方、天上是什么。
 *
 * 判定层不认识地点表与天气表（那条分法是全项目的），所以由调用方查好再传进来 ——
 * 与 `powerIndex` / `zoneIndex` 的用法一致。
 */
export interface MutationEnvironment {
  /** 站在堕落源上（神弃之地、深渊入口……）：原作里这些地方「让生物堕落为怪物」 */
  corruptionSource: boolean;
  /** 血月：原作里「放出无数难以言喻的怪物和恶灵」 */
  bloodMoon: boolean;
  /** 他晋升失败过几次：原作「晋升失败……必然诞生危险的尸王」 */
  promotionFails: number;
}

export const NO_ENVIRONMENT: MutationEnvironment = { corruptionSource: false, bloodMoon: false, promotionFails: 0 };

/**
 * 环境倍率 —— **显式表**（AGENTS §3.3：不写 `if (a && b)` 这种闭区间分支）。
 *
 * 三条各有出处，数值是项目设计（原作没给倍数）：
 *   堕落源 ×3 —— 那地方的黑暗「本身就有危险」
 *   血月  ×2 —— 但只在那一夜（血月是天气，不是常态）
 *   晋升失败 +0.5/次 —— 失败过的人本来就在往下滑
 */
export function mutationMultiplier(env: MutationEnvironment): number {
  let m = 1;
  if (env.corruptionSource) m *= 3;
  if (env.bloodMoon) m *= 2;
  m *= 1 + 0.5 * Math.max(0, env.promotionFails);
  return m;
}

/**
 * **他这会儿撑不撑得住**（每小时一次）。
 *
 * 直接复用玩家失控那条公式：NPC 没有 MAD，用 `corrupted` 喂 cor。
 * 返回值 0 有两种含义，都合法：
 *   ① 他还没到 `fallen`（**没到堕落这一档的人根本不会异变** —— 这是反向自检的落点）；
 *   ② 到了，但这一档的闸门还没被顶开（序列高的人闸门低一点）。
 */
export function npcMutationChance(input: {
  corrupted: number;
  sequence: number;
  env?: MutationEnvironment;
}): number {
  const env = input.env ?? NO_ENVIRONMENT;
  const base = computeLossOfControlProbability({ mad: 0, cor: input.corrupted, sequence: input.sequence });
  if (base <= 0) return 0;
  return Math.min(1, base * mutationMultiplier(env));
}

/* ---------------- ② 他长成了哪一个形态 ---------------- */

/**
 * 挑形态：**按他的途径与序列**（复用 `pickLostForm` 的权重与 min_seq 口径）。
 *
 * 转途径者（`pathways` 有多条）按顺序试每一条 —— 第一条能给出形态的就算他的形态。
 * 这与原作那句「形态取决于自我认知与晋升序列」同一个意思：**主要走的那条说了算**。
 *
 * 返回 null 的三种情形都不是错误（内容未落地 / 序列够不着 / 这个形态还没有生物数据），
 * 调用方要能接受：那时他**不变**，下一小时再掷 —— 而不是降级成别的什么东西。
 */
export function pickFallenBeast(input: {
  beasts: readonly FallenBeast[];
  forms: readonly LostForm[];
  pathways: readonly string[];
  sequence: number;
  rng: Rng;
}): { beast: FallenBeast; form: LostForm } | null {
  for (const pathway of input.pathways) {
    const form = pickLostForm(input.forms, pathway as PathwayId, input.sequence, input.rng);
    if (form === null) continue;
    const beast = input.beasts.find((b) => b.formId === form.id);
    if (beast === undefined) continue;
    return { beast, form };
  }
  return null;
}

/**
 * **混合形态**（原作：因斯·赞格威尔同时表现出八腿魔狼与羽蛇的特征）。
 *
 * 返回**别的途径**给他的形态名（最多两条）—— 运行时拼进播报，
 * 拼出来就是「长着八条腿和白色羽毛的怪物」那种句子。
 * 只有一条途径的人返回空数组（那不是混合）。
 */
export function hybridTraits(input: {
  forms: readonly LostForm[];
  pathways: readonly string[];
  primaryPathway: string;
  sequence: number;
}): string[] {
  const others: string[] = [];
  for (const pathway of input.pathways) {
    if (pathway === input.primaryPathway) continue;
    const candidates = input.forms.filter((f) => f.pathway === pathway && input.sequence <= f.minSeq);
    if (candidates.length === 0) continue;
    // 同一途径多个形态时取 minSeq 最长（最严格）的那一个 —— 它是这条途径「最深的那一面」
    const deepest = candidates.reduce((a, b) => (a.minSeq <= b.minSeq ? a : b));
    others.push(deepest.name);
    if (others.length >= 2) break;
  }
  return others;
}

/* ---------------- ③ 把形态变成一只生物 ---------------- */

/** 一只堕落生物的成因（用来写播报，也用来统计「这个世界是怎么坏掉的」） */
export const MUTATION_CAUSES = ['corruption', 'advancement_failed', 'environment', 'form_shown'] as const;
export type MutationCause = (typeof MUTATION_CAUSES)[number];

export const MUTATION_CAUSE_LABELS: Readonly<Record<MutationCause, string>> = {
  corruption: '被一点点侵蚀到底',
  advancement_failed: '晋升失败',
  environment: '身处堕落之地',
  form_shown: '展现了不该展现的形态',
};

/**
 * 把一个堕落形态转成**物种的原始形状**（交给既有的 `parseCreatureSpecies` 解析）。
 *
 * 为什么不自己拼一个 CreatureSpecies 对象：`behaviors` 在 YAML 里是「单键 map 的数组」
 * （`- stalk: {...}`），而领域类型是扁平的 `{ kind, trigger, chance }` —— 那个转换在
 * `parseCreatureSpecies` 里已经写好了（还带着「一条行为只能有一个键」的校验）。
 * 再写一遍就是第二份实现，而两份实现迟早会在边角上分叉（铁律 7）。
 *
 * ⚠️ `habitat: []` 是**有意的**：它没有出生点，世界不会自己刷出它（见 schema 的注释）。
 * 它只由「某个人撑不住」产生 —— 那一刻的所在地点由调用方写进实例（creatures.location_id）。
 */
export function fallenSpeciesRaw(input: {
  beast: FallenBeast;
  formName: string;
  pathway: string;
}): Record<string, unknown> {
  return {
    species: 'fallen:' + input.beast.formId,
    name: input.formName,
    baseSequence: input.beast.baseSequence,
    habitat: [],
    pathwayAffinity: input.pathway === '' ? [] : [input.pathway],
    drops: input.beast.drops,
    behaviors: input.beast.behaviors,
    habits: [],
    tickRate: 'hourly',
    baseHp: input.beast.baseHp,
    flavor: input.beast.flavor,
    perception: input.beast.perception,
    battle: input.beast.battle,
  };
}

/**
 * **把堕落生物并进物种表** —— 启动与热重载共用这一处（两处各写一遍迟早会漂）。
 *
 * 合并进去的物种 `habitat: []`（见 fallenSpeciesRaw 的注释）：生态 tick 的初始播种
 * 按「栖息地 × 物种」跑、补充池按地点取物种，两处都自然把它们排除在外 ——
 * 所以「世界不会自己刷出怪物」这件事**不需要额外开关**，它是 habitat 为空的直接后果。
 *
 * 找不到形态的条目直接跳过（那是数据问题，由 `checkFallenBeastRefs` 在加载期报错）。
 */
export function withFallenSpecies(
  base: readonly CreatureSpecies[],
  beasts: readonly FallenBeast[],
  forms: readonly LostForm[],
): CreatureSpecies[] {
  const extra: CreatureSpecies[] = [];
  for (const beast of beasts) {
    const form = forms.find((f) => f.id === beast.formId);
    if (form === undefined) continue;
    const parsed = parseCreatureSpecies(fallenSpeciesRaw({ beast, formName: form.name, pathway: form.pathway }));
    if (parsed.ok) extra.push(parsed.species);
  }
  return [...base, ...extra];
}

/** 生物的显示名：**形态名（他原本是谁）** —— 保留名字是这一整套设计的恐怖点 */
export function beastNameOf(formName: string, npcName: string): string {
  return formName + '（' + npcName + '）';
}

/** 播报那一句（玩家读到的） */
export function mutationLineOf(npcName: string, formName: string, traits: readonly string[]): string {
  const hybrid = traits.length === 0 ? '' : '它身上还带着' + traits.join('与') + '的样子。';
  return npcName + '不再是人了 —— 他成了一只「' + formName + '」。' + hybrid;
}

/**
 * 变成生物之后的强度：**取更强的那个**（序列号越小越强）。
 *
 * 序列 4 的人堕落，比序列 9 的人堕落更难缠 —— 但他也不会比这个形态本身更强。
 */
export function beastSequenceOf(npcSequence: number, beast: FallenBeast): number {
  return Math.min(npcSequence, beast.baseSequence);
}

/* ---------------- ④ 教会来清剿 ---------------- */

/**
 * **它多久动一次手**：8%/小时 —— 约每十二小时一次袭击。
 *
 * 项目设计（原作没给频率）：它是「它在吃东西」这件事的时间尺度 ——
 * 比低语频繁（那是日常），比复活频繁得多（那是奇迹）。饥饿时翻倍。
 */
export const BEAST_ATTACK_PER_HOUR = 0.08;

/** 清剿的结果。三档都有代价，没有「无事发生」这一档 */
export type CullOutcome = 'success' | 'injury' | 'death';

export const CULL_OUTCOME_LABELS: Readonly<Record<CullOutcome, string>> = {
  success: '清掉了',
  injury: '受了伤回来',
  death: '没能回来',
};

/**
 * **清剿不是猎杀** —— 这一条与 `canHunt` 的分别必须说清楚，否则它永远不触发。
 *
 * `canHunt` 是「NPC **自己愿不愿意**去」：要稳赢才出手（差 2 档以上），
 * 那是「有智慧」与「不让低序列刷功绩」的落点。
 *
 * 而清剿是**职责**：值夜者面对城里的失控者会去处理，哪怕打不过。
 * 原作里就是这么回事 —— 邓恩·史密斯死在邪神子嗣那件事里，
 * 洛薇雅的小队队员疯掉之后「被清除」。**清剿本来就会死人。**
 *
 * ⚠️ 第一版复用了 `canHunt`，实测结果：45 天里一次清剿都没有 ——
 *    因为「序列 8 的值夜者 vs 序列 8 的堕落者」永远过不了「差 2 档」那道闸。
 *    把一个**职责**接在一把「稳赢才上」的闸上，机制就会静默地永不触发。
 */
export function cullChance(cullerSequence: number, beastSequence: number): number {
  const margin = beastSequence - cullerSequence;   // > 0 = 清剿者更强
  if (margin >= 0) return Math.min(0.9, 0.55 + margin * 0.1);
  // 比它弱还去（职责），于是这一步很危险 —— 0.1 是「几乎回不来」
  return Math.max(0.1, 0.35 + margin * 0.1);
}

/**
 * 差得太远就**不上**（等精英）—— 但这一档比 `canHunt` 宽得多。
 *
 * 一个序列 9 的修女面对序列 3 的东西不会去送死；而序列 7 的红手套会。
 * 等的那段时间里它还在吃人 —— 「清剿来得太迟」这件事是有代价的。
 */
export function willEngage(cullerSequence: number, beastSequence: number): boolean {
  /*
   * ⚠️ 方向：`cullerSequence - beastSequence` 是「**清剿者比它弱多少**」（正数 = 更弱）。
   *
   * 第一版写成了反的（`beastSequence - cullerSequence`），于是「序列 9 的修女面对序列 3 的
   * 东西」也算成「差距不大，上」—— 她会去送死。m2-167 那条断言当场抓到。
   */
  return cullerSequence - beastSequence <= 3;
}

/**
 * **清剿结算**：清掉了 / 受伤抬回来 / 没能回来（三档都有代价，没有「无事发生」）。
 *
 * 失手之后按**既有的死亡档位表**结算（`deathChanceOf(序列, 'creature')`：
 * 凡人 50%、天使 4%）—— 与怪物吃人是同一条路，没有第二份公式。
 */
export function cullOutcome(input: {
  cullerSequence: number;
  beastSequence: number;
  rng: Rng;
}): CullOutcome | null {
  if (!willEngage(input.cullerSequence, input.beastSequence)) return null;
  if (input.rng.next() < cullChance(input.cullerSequence, input.beastSequence)) return 'success';
  return input.rng.next() < deathChanceOf(input.cullerSequence, 'creature') ? 'death' : 'injury';
}

/**
 * 清剿的资格：谁能去。
 *
 * 三条来自原作（`04-神明与教会/七正神.yaml`）：
 *   ① 只有**有非凡编制**的教会会做这件事 —— 值夜者 / 代罚者 / 机械之心 / 净化者
 *      （其余三家原作没给编制，所以它们不来 —— 这是「按原作」的落点，不是我漏了）
 *   ② 编制有**最低序列**：红手套「最低要求序列 7」
 *   ③ 打不过就等精英 —— 等的那段时间里，那只东西还在吃人
 */
export const CULL_SQUADS: Readonly<Record<string, { squad: string; elite: string; eliteMinSeq: number }>> = {
  night_goddess: { squad: '值夜者', elite: '红手套', eliteMinSeq: 7 },
  storm_lord: { squad: '代罚者', elite: '代罚者', eliteMinSeq: 6 },
  god_of_steam: { squad: '机械之心', elite: '机械之心', eliteMinSeq: 6 },
  eternal_blazing_sun: { squad: '净化者', elite: '净化者', eliteMinSeq: 6 },
};

/** 这家教会会不会来清剿（有编制才会来） */
export function willCull(churchId: string): boolean {
  return CULL_SQUADS[churchId] !== undefined;
}

/** 这家教会的编制名（播报用）；没有编制返回 null —— 调用方那时**不该派队** */
export function squadOf(churchId: string): string | null {
  return CULL_SQUADS[churchId]?.squad ?? null;
}

export function cullLineOf(cullerName: string, squad: string, beastName: string, outcome: CullOutcome): string {
  if (outcome === 'success') return squad + '处理了城里的那件事 —— 「' + beastName + '」已经不在了。（' + cullerName + '）';
  if (outcome === 'injury') return cullerName + '从那条街上被抬了回来。东西还在那儿。';
  return cullerName + '没能回来。（' + squad + '）';
}

