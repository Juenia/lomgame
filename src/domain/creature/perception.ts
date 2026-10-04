/**
 * 感知分层（M2.8 最重要的一条）。
 *
 * 同一只生物，不同序列的玩家看到的东西**完全不同** ——
 * 序列正反馈不是「你更强了」，是「同一片雾里，你看到的东西变了」。
 *
 *   玩家弱 3 级及以上  「雾里有什么东西在动。你看不清，只觉得冷。」   只能撤退
 *   玩家弱 1—2 级      「一团模糊的轮廓，比人高。它没注意到你。」     观察（危险）/ 撤退
 *   同序列             「低语者。靠声音定位。核心在胸腔偏左。」       观察 / 对峙 / 互动
 *   玩家强 1—2 级      「一只低语者。它甚至没发现你。」               观察 / 互动 / 驱逐
 *   玩家强 3 级及以上  「灵界的游魂，序列很低。核心可采。」           观察本质 / 互动 / 取材料
 *
 * 两条硬性质（都有单测守着）：
 *   1. **普通人只看到最模糊的一层**，不管生物序列多低 —— 他连那是什么都不知道。
 *      这是 M2.7.6 的 pathway_status 字段的兑现：入途径的瞬间，同一片雾里的东西就有名字了。
 *   2. **看不见就是真的看不见**：blur / silhouette 两层的 visible 全是 null。
 *      「你看不清」不能只体现在文案里 —— 否则玩家能从「HP 12/40」反推出那是什么东西。
 *
 * 本文件全是纯函数：f(state, creature, world, rng) → 结果，无 IO、无副作用。
 * 种子由调用方派生（seedFrom）后传进来，所以同一条指令重放必然得到同一结果。
 */
import { CREATURE } from '../../config/numeric.ts';
import { sequenceOrInitiate, type CharacterState, type Rng } from '../character/types.ts';
import { rollChance, weightedPick } from '../random.ts';
import { behaviorTriggered } from './schema.ts';
import type {
  Creature,
  CreatureSpecies,
  PerceptionLayer,
  SightingAction,
  SightingResult,
  SightingWorld,
} from './types.ts';

/**
 * 感知层次：delta = **生物序列 - 玩家序列**（序列号越小越强）。
 *
 *   普通人          → 永远 blur（短路，不看 delta）
 *   delta <= -3     → blur      （玩家弱 3 级及以上）
 *   -2 <= delta < 0 → silhouette（弱 1—2 级）
 *   delta == 0      → full      （同序列）
 *   1 <= delta <= 2 → advantage （强 1—2 级）
 *   delta >= 3      → essence   （强 3 级及以上）
 */
export function perceptionLayerOf(input: {
  playerSequence: number;
  creatureSequence: number;
  /** 玩家还是普通人（pathway_status = mortal） */
  mortal: boolean;
}): PerceptionLayer {
  // 普通人：不管生物序列多低，他看到的都是最模糊的一层。
  // 这一条必须**短路在 delta 之前** —— 普通人按序列 9 参与地点准入（sequenceOrInitiate），
  // 而灰雾游魂也是序列 9，算出来 delta = 0 会让他"看清"一只游魂，那就本末倒置了。
  if (input.mortal) return 'blur';

  const delta = input.creatureSequence - input.playerSequence;
  const p = CREATURE.perception;
  if (delta <= p.weak3) return 'blur';
  if (delta < p.equal) return 'silhouette';
  if (delta === p.equal) return 'full';
  if (delta <= p.strong12) return 'advantage';
  return 'essence';
}

/**
 * 这一层允许的动作。
 *
 * 前四个是任务书 §4.2 的四个动作（观察 / 对峙 / 撤退 / 互动）；
 * hold 是**普通人专属**的「站着不动」——「观察」「对峙」「互动」对他没有意义，
 * 但「不退」这个选择得有落点（任务书 §4.3.3 给的正是「退回去 / 站着不动」两个选项）。
 *
 * ⚠️ 没有「攻击」。M2.8 不做战斗，那是 M2.9 的活。
 */
export function allowedActionsOf(layer: PerceptionLayer, mortal: boolean): readonly SightingAction[] {
  /*
   * ⚠️ M2.87：普通人**多了一个「看一眼」**。
   *
   * 原来这里是 `return ['retreat', 'hold']` —— 两个零效果选项，于是凡人的遭遇
   * 100% 是白开水（用户：「事件白开水等于游戏是废的」）。而**每个新号都是普通人**，
   * 也就是说每个玩家开局的前 N 天都在读没有任何后果的散文。
   *
   * 加 `observe` 的世界观依据：**凡人看不清，但看得见、记得住**。
   * 他不知道自己遇到的是什么，但那个画面会留在他脑子里 —— 这本身就是一种积累，
   * 也是凡人被卷入非凡世界的第一种方式（原作里普通人反复这么描述）。
   *
   * 注意顺序：**观察排在最前**。凡人此刻最自然的反应是「那是什么？」——
   * 转身走反而是第二反应。
   */
  if (mortal) return ['observe', 'retreat', 'hold'];
  switch (layer) {
    case 'blur':
      // 「只能撤退」—— 连退两步都未必跑得掉，但至少没有别的选择
      return ['retreat'];
    case 'silhouette':
      // 观察是**有代价的**：看清一点就要多担一点 MAD（见 actions.observe.madGain）
      return ['observe', 'retreat'];
    case 'full':
      return ['observe', 'confront', 'interact'];
    case 'advantage':
      return ['observe', 'confront', 'interact'];
    case 'essence':
      // 强 3 级及以上：观察本质（= 采集）/ 互动。没有对峙 —— 不值得。
      return ['observe', 'interact'];
    default:
      return ['retreat'];
  }
}

/** 这一层能不能看见具体数值。blur / silhouette 看不见 —— 这是硬性质，有单测守着。 */
export function visibilityOf(layer: PerceptionLayer): boolean {
  return layer === 'full' || layer === 'advantage' || layer === 'essence';
}

/**
 * 遭遇概率（任务书 §4.7 encounter）。
 *
 * baseChance × 时段 × 雾天 × 途径亲和
 *
 * 时段这一项**只对夜行生物生效**（habits 里有 nocturnal）：
 *   夜行生物  夜晚 ×nightMultiplier，白天 ÷nightMultiplier
 *   其它生物  ×1（不受时段影响）
 * 为什么不让全局都 ×1.5：那样 habits.nocturnal 就没有落点了，
 * 而「只在夜晚出现」是任务书 §4.5 明确写下来的特性（深海凝视者）。
 * 把倍率交给习性，一个旋钮管一件事。
 */
export function encounterChance(input: {
  species: CreatureSpecies;
  pathway: string | null;
  night: boolean;
  foggy: boolean;
}): number {
  const e = CREATURE.encounter;
  let chance = e.baseChance;
  if (input.species.habits.includes('nocturnal')) {
    chance = input.night ? chance * e.nightMultiplier : chance / e.nightMultiplier;
  }
  if (input.foggy) chance *= e.fogMultiplier;
  if (input.pathway !== null && input.species.pathwayAffinity.includes(input.pathway)) {
    chance *= e.pathwayAffinityMultiplier;
  }
  // 概率封顶 1：乘数叠起来可能超过 1，但「必然遇到」不该由乘法意外达成
  return Math.min(1, Math.max(0, chance));
}

/** 一只候选生物（实例 + 它的物种模板） */
export interface EncounterCandidate {
  creature: Creature;
  species: CreatureSpecies;
}

/**
 * 掷一次遭遇：这次探索有没有撞见东西，撞见的是哪一只。
 *
 * 两步：
 *   1. 该地点此刻的候选生物按 encounterChance 算出总概率？—— 不。**先掷一次总概率，
 *      再从候选里按权重抽一只**。这样「遇到生物」与「遇到哪一只」是两个独立的随机事件，
 *      候选数量不会反过来抬高遭遇率（否则生物越多的地方越危险，与设计意图不符）。
 *   2. 抽中的权重用 encounterChance：亲和途径的那只更可能被撞见。
 */
export function rollEncounter(input: {
  state: CharacterState;
  candidates: readonly EncounterCandidate[];
  /**
   * `rateMultiplier` 是 M2.88 加的：**当地权柄的遭遇倍率**（不传就是 1）。
   *
   * 「战争」（红祭司 ×1.8）让这一带到处是东西，「风暴」（暴君 ×1.5）同理；
   * 反过来某些权柄能压下去。玩家不用读播报 —— 走两趟就知道这里不对。
   */
  world: Pick<SightingWorld, 'night' | 'foggy'> & { rateMultiplier?: number };
  rng: Rng;
}): { hit: boolean; picked: EncounterCandidate | null; chance: number; roll: number } {
  if (input.candidates.length === 0) {
    return { hit: false, picked: null, chance: 0, roll: 1 };
  }
  // 总概率取候选里**最高的那一只**再乘一个「这里有东西」的基数？
  // 不 —— 取候选的平均概率。理由：地点里生物越多，单只被撞见的概率摊得越薄，
  // 总遭遇率不该随生物数量线性上涨（那样生态 tick 繁衍几次就变成刷怪场）。
  const chances = input.candidates.map((candidate) =>
    encounterChance({
      species: candidate.species,
      pathway: input.state.pathway,
      night: input.world.night,
      foggy: input.world.foggy,
    }),
  );
  const base = chances.reduce((sum, value) => sum + value, 0) / chances.length;
  /*
   * 倍率乘在**平均之后**：权柄改的是「这一带有多容易撞上东西」，
   * 不是「每一种生物各自的可见度」—— 后者会被候选数量摊薄，权柄的效果就不稳定了。
   * clamp 到 [0, 1]：概率不能越界（越界会让 `roll >= chance` 的判定反过来）。
   */
  const chance = Math.max(0, Math.min(1, base * (input.world.rateMultiplier ?? 1)));
  const roll = input.rng.next();
  if (roll >= chance) return { hit: false, picked: null, chance, roll };

  const picked = weightedPick(
    input.candidates,
    (candidate) =>
      encounterChance({
        species: candidate.species,
        pathway: input.state.pathway,
        night: input.world.night,
        foggy: input.world.foggy,
      }),
    input.rng,
  );
  return { hit: picked !== null, picked, chance, roll };
}

/**
 * 行为旁白（任务书 §4.3.4 的 behaviors）。
 *
 * 只有满足 trigger 的行为才有资格被掷到；命中的那个给一句旁白。
 * ⚠️ 这些行为在 M2.8 里**只是旁白**，不产生战斗效果 —— 战斗是 M2.9 的活。
 */
function rollBehavior(input: {
  species: CreatureSpecies;
  creature: Creature;
  state: CharacterState;
  world: SightingWorld;
  rng: Rng;
}): { kind: string; text: string } | null {
  const { species, creature, state, world, rng } = input;
  if (species.behaviors.length === 0) return null;
  const playerSequence = sequenceOrInitiate(state);
  const context = {
    hpLow: creature.hp <= creature.maxHp / 2,
    night: world.night,
    foggy: world.foggy,
    hungry: creature.status === 'hungry',
    // 「它察觉到威胁」= 玩家序列比它小（更强）
    threatened: playerSequence < creature.sequence,
  };
  const eligible = species.behaviors.filter((behavior) => behaviorTriggered(behavior, context));
  if (eligible.length === 0) return null;
  const chosen = weightedPick(eligible, (behavior) => behavior.chance, rng);
  if (chosen === null) return null;
  return { kind: chosen.kind, text: behaviorText(chosen.kind) };
}

/**
 * 行为名 → 旁白。内容侧可以只用这些常见行为名，也可以用原文兜底。
 *
 * ⚠️ M2.66：**兜底那一句会把英文行为名念给玩家听**（「它做了些什么（lurk）。」）。
 * 实测有两条内容行为没有专属旁白（`lurk` 潮底潜伏者 / `chant` 骨唱诗班），
 * 于是这两只生物的旁白一直是半句英文。
 * 现在由 `checkCreatureBehaviors`（link-check 第 4 项）守着：内容表里出现的每一个
 * 行为名都必须在这里有一条 —— 缺了就是 error，服务端起不来。
 */
const BEHAVIOR_TEXT: Readonly<Record<string, string>> = {
  flee: '它退开了半步，但没有走远。',
  howl: '雾里传来一声长啸，隔着很远，又像是就在背后。',
  hunt: '它低下头，像是在闻什么。',
  stalk: '它跟着你走了一段，你没回头。',
  mimic: '它张嘴，发出的是你自己的声音。',
  vanish: '你眨了一下眼，它就不在原地了。',
  stare: '它没有眼睛，但你知道它在看你。',
  feed: '它在吃什么。你没有看清那是什么。',
  /* M2.66 补齐的两条：这两只生物本来念的是英文行为名 */
  lurk: '它沉下去了一点。水面没有动，但你知道它还在那里。',
  chant: '它们换了一个调子 —— 还是同一段，只是比刚才更近。',
  /*
   * M2.76：序列 4/3 那一批新物种带来的六个行为。
   *
   * ⚠️ 这张表**住在代码里**，所以「加一个行为名」= 改代码 —— 与内容层那条
   * 「加内容不改代码」的方向相反。这正是 M2.76 交付说明「未接线」里登记的那一条：
   * 它该搬进内容层（一张 behavior → 旁白 的 YAML），本轮先按既有做法补行。
   */
  wait: '它没有动。它在等你先动。',
  guard: '它把重心压低了，挡在门口，不打算让开。',
  charge: '它开始加速，铁片互相撞在一起。',
  drag: '水往上漫了一寸，你的鞋底开始打滑。',
  record: '它又写了一行。你听见笔尖压过纸的声音。',
  erase: '它把刚写的那一行划掉了，划得很用力。',
};

/** 有专属旁白的行为名（link-check 与测试都读它，不再各写一份） */
export const NARRATED_BEHAVIORS: readonly string[] = Object.keys(BEHAVIOR_TEXT);

export function behaviorText(kind: string): string {
  return BEHAVIOR_TEXT[kind] ?? `它做了些什么（${kind}）。`;
}

/**
 * 遭遇判定：玩家遇到「此时此刻的这只」时，看到什么、能做什么。
 *
 * 这是任务书 §4.2 要求的那条纯函数 —— 无 IO、无副作用，判定 seed 由调用方派生。
 */
export function resolveSighting(input: {
  state: CharacterState;
  creature: Creature;
  species: CreatureSpecies;
  world: SightingWorld;
  rng: Rng;
  seed: string;
}): SightingResult {
  const { state, creature, species, world, rng, seed } = input;
  const mortal = state.pathwayStatus !== 'initiated';
  const playerSequence = sequenceOrInitiate(state);

  const layerRoll = rng.next();
  const layer = perceptionLayerOf({
    playerSequence,
    creatureSequence: creature.sequence,
    mortal,
  });
  const allowedActions = allowedActionsOf(layer, mortal);
  const visible = visibilityOf(layer);

  const behavior = rollBehavior({ species, creature, state, world, rng });

  return {
    ok: true,
    seed,
    creatureId: creature.id,
    speciesId: species.id,
    layer,
    text: species.perception[layer],
    allowedActions,
    visible: {
      name: visible ? species.name : null,
      sequence: visible ? creature.sequence : null,
      hp: visible ? creature.hp : null,
      status: visible ? creature.status : null,
    },
    rolls: { layer: layerRoll },
    behavior,
  };
}

/**
 * 观察本质时的采集（M2.8 唯一一条生物 → 物品的路）。
 *
 * 两道判定叠乘：harvest.baseChance（能不能采到）× 掉落的 chance（它身上有没有这样东西）。
 * 返回采到的物品 id 列表（可能为空 —— 空手而回是正常的，不该每次都有收获）。
 */
export function rollHarvest(input: {
  species: CreatureSpecies;
  rng: Rng;
}): { itemId: string; }[] {
  const { species, rng } = input;
  const got: { itemId: string }[] = [];
  for (const drop of species.drops) {
    const roll = rng.next();
    if (roll < CREATURE.harvest.baseChance * drop.chance) {
      got.push({ itemId: drop.itemId });
    }
  }
  return got;
}

/** 动作的中文名（菜单渲染用）。advantage 层的 confront 是「驱逐」—— 同一件事实，说法不同。 */
export function actionLabel(action: SightingAction, layer: PerceptionLayer): string {
  switch (action) {
    case 'observe':
      return layer === 'essence' ? '观察本质' : '观察';
    case 'confront':
      return layer === 'advantage' ? '驱逐' : '对峙';
    case 'retreat':
      return '撤退';
    case 'interact':
      return '互动';
    case 'hold':
      return '站着不动';
    default:
      return action;
  }
}

/** 感知层次的中文名（报告与审计用）。 */
export const LAYER_LABELS: Readonly<Record<PerceptionLayer, string>> = {
  blur: '模糊（弱 3 级及以上）',
  silhouette: '轮廓（弱 1—2 级）',
  full: '完整（同序列）',
  advantage: '占优（强 1—2 级）',
  essence: '本质（强 3 级及以上）',
};

/** 这一层是不是「看见本质」 = 能不能采集 */
export function canHarvest(layer: PerceptionLayer): boolean {
  return layer === 'essence';
}

/** 遭遇概率的工具出口，报告与虚拟玩家预判共用 */
export function encounterChanceOf(candidate: EncounterCandidate, state: CharacterState, world: Pick<SightingWorld, 'night' | 'foggy'>): number {
  return encounterChance({
    species: candidate.species,
    pathway: state.pathway,
    night: world.night,
    foggy: world.foggy,
  });
}

/** 概率命中（转出，供命令层统一口径） */
export { rollChance };
