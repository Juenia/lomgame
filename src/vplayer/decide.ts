/**
 * 决策引擎（W7）：规则 + 权重，目标驱动，**不依赖 LLM**，因此完全可复现。
 *
 * 每个决策只依赖三样东西：
 *   1) 画像（persona / goal / riskAppetite / patience）
 *   2) 玩家自己能看到的快照（等价于 .状态 / .背包 的输出）
 *   3) 由 profile.seed 派生的随机源
 */
import { createSeededRng, seedFrom } from '../domain/rng.ts';
import { CURRENCY_ITEM_ID } from '../domain/item/item.ts';
import { parseCurrency } from '../domain/currency/index.ts';
import { PATHWAY_TAGS, type PathwayTags } from '../domain/play/tags.ts';
import { NUMERIC } from '../config/numeric.ts';
import { FREEFORM_KEY } from '../domain/menu/types.ts';
import { birthCityOf } from '../domain/geo/index.ts';
import { digThresholdForSeq } from '../domain/promotion/promotion.ts';
import { skillEffectOf, skillsFor } from '../domain/battle/skills.ts';
import type { CharacterState, PathwayId } from '../domain/character/types.ts';
import { commandNameOf } from './coverage.ts';
import type { Decision, DecisionContext, MenuChoice, WorldKnowledge } from './types.ts';

const PATHWAY_LABELS: Record<string, string> = { seer: '愚者', warrior: '战士', sleepless: '不眠者' };

/**
 * 玩家模型参数（W7）。这里**不是游戏数值**——游戏数值全部来自 config/numeric.ts，
 * 且已冻结；这些常数只回答「一个有目标的玩家会怎么安排自己的动作」：
 *   - 晋升前多攒多少消化度（留出失败重试的余地）
 *   - 疯狂/污染到多少就先降下来（晋升成功率公式里 MAD/COR 是负项）
 *   - 疯狂多高时不再喝魔药（喝一瓶 +6 疯狂）
 */
export const PLAYER_MODEL = {
  /** 晋升前的消化度缓冲（digThreshold + buffer） */
  digBuffer: { steady: 8, aggressive: 6, chaotic: 0, light: 0, perfectionist: 10 } as Record<string, number>,
  /**
   * 疯狂到这条线先 .休息（80 以上才开始有失控判定）。
   * 按画像区分正是「压边界」的来源：完美主义/稳健会提前处理，
   * 激进与混乱会一直顶到闸门附近——失控与死循环的边界就靠他们压出来。
   */
  madRestAt: { steady: 60, aggressive: 90, chaotic: 999, light: 75, perfectionist: 55 } as Record<string, number>,
  /** 污染到这条线先 .净化 */
  corPurifyAt: { steady: 50, aggressive: 72, chaotic: 999, light: 65, perfectionist: 45 } as Record<string, number>,
  /** 疯狂高于这条线就先不喝魔药 */
  madDrinkLimit: { steady: 65, aggressive: 88, chaotic: 95, light: 70, perfectionist: 60 } as Record<string, number>,
  /** 单日最多用几次 .扮演 刷消化度（受 tagDailyCap 限制，再多也是白搭） */
  maxPlaysPerDay: 30,
} as const;

function command(text: string, reason: string): Decision {
  return { command: text, reason };
}

/**
 * M2.9：遭遇里出现「动手」时，各画像真的会动手的概率。
 *
 * 为什么按画像分而不是一刀切：动手是遭遇菜单里**唯一一个会把你拖进多回合状态**的选项，
 * 真人不会一看见什么都打 —— 稳健型先观察、完美主义先掂量，激进型才顺手就打。
 * 但也不能只有激进型会打：M2 里「看清到有轮廓」的遭遇只占三成多，
 * 再叠一个 20% 的画像占比，战斗样本会少到分布看不出形状
 *（而「三个维度都散开」正是 M2.9 的验收硬指标）。
 */
const FIGHT_APPETITE: Record<string, number> = {
  aggressive: 0.75,
  chaotic: 0.65,
  perfectionist: 0.35,
  steady: 0.3,
  light: 0.25,
  // M2.17：secular 照抄 steady —— 两张表是 Record<string, number>，编译器不会提醒漏了谁，
  // 而漏了的后果是 undefined 参与比较（恒 false），表现为「这个画像从不打架」这种静默偏差。
  secular: 0.3,
};

/**
 * M2.9：**低于这个血量就不动手**（先回去休息）。
 *
 * 60 的来处：一场战斗平均 4—6 个回合，而对手每回合能打掉 13—24 点 ——
 * 60 点血刚好够你把一场架打完（或者打完之前就撤得掉）。
 * 更低的话会出现「进场一回合就触发了撤退规则」，那种战斗在报告里
 * 只会表现为一堆「1 回合结束」，看不出任何东西。
 */
const FIGHT_MIN_HP = 50;

/**
 * M2.10：各画像**发起挑战**的概率（任务书 §4.9 给的分布）。
 *
 * 明显比 PVE 的动手意愿低一档（0.75/0.65/0.35/0.3/0.25）——
 * 这符合直觉：打雾里的东西是自己的事，而挑战另一个人是**社交行为**，
 * 真人要掂量的东西多得多（他会不会记仇、我打不打得过、别人怎么看）。
 */
const CHALLENGE_APPETITE: Record<string, number> = {
  aggressive: 0.3,
  chaotic: 0.25,
  perfectionist: 0.1,
  steady: 0.05,
  light: 0.05,
  // M2.17：secular 照抄 steady（同 FIGHT_APPETITE 的理由）
  secular: 0.05,
};

/**
 * M2.9：血量低于这条线就先去休息（回血是把架打得起来的**前提**，见 decide 的 3.2）。
 * 45 与 FIGHT_MIN_HP（50）差 5 —— 一次 `.休息` 回 20 点，正好能把人从「打不了」送回「打得动」。
 */
const HEAL_BELOW_HP = 45;

/** 扮演词汇前缀：轮换着说，避免每次都一模一样 */
const PLAY_PREFIXES = ['我', '我继续', '我在', '我试着', '我照例'];

/**
 * 第 index 次 .扮演 该说什么（纯函数，完全由 index 决定 → 可复现）。
 *
 * 依据 config/numeric.ts 的打分规则（**不改数值，只是把它当成玩家已知的规则**）：
 *   - 一个契合标签就给满 raw = 1.0（coreWeight 1.0），所以一次只押一个标签最划算；
 *   - 同一标签每日最多计入 tagDailyCap(=3) 次，所以每个契合标签用满 3 次就换下一个；
 *   - 契合标签用完之后改用「沾边 + 沾边」（0.5 + 0.5 = 1.0），继续推消化度。
 */
export function playTextAt(pathway: PathwayId, index: number): string {
  const tags = PATHWAY_TAGS[pathway];
  const uses = Math.max(1, NUMERIC.playScore.tagDailyCap);
  const prefix = PLAY_PREFIXES[Math.max(0, index) % PLAY_PREFIXES.length]!;
  const coreSpan = tags.core.length * uses;

  if (index < coreSpan) {
    const tag = tags.core[Math.floor(index / uses) % tags.core.length]!;
    return `${prefix}${tag}`;
  }

  const after = index - coreSpan;
  const pairSpan = uses * 2;
  const pairIndex = Math.floor(after / pairSpan);
  const first = tags.secondary[(pairIndex * 2) % tags.secondary.length]!;
  const second = tags.secondary[(pairIndex * 2 + 1) % tags.secondary.length];
  return second ? `${prefix}${first}，顺便${second}` : `${prefix}${first}`;
}

function rngFor(ctx: DecisionContext): { next(): number } {
  return createSeededRng(seedFrom([ctx.profile.seed, 'd', ctx.day, 's', ctx.step]));
}

function has(snapshot: { inventory: Array<{ itemId: string; quantity: number }> }, itemId: string): number {
  return snapshot.inventory.filter((slot) => slot.itemId === itemId).reduce((sum, slot) => sum + slot.quantity, 0);
}

/** 能拿去交易的物品：绑定物品挂单必然被拒（"可交易的数量不足"），不要浪费指令 */
function tradeableItem(
  snapshot: DecisionContext['snapshot'],
  world: WorldKnowledge,
): { itemId: string; quantity: number } | null {
  return (
    snapshot.inventory.find(
      (slot) => slot.quantity > 0 && slot.bindType !== 'bound' && world.itemKinds[slot.itemId] !== 'currency',
    ) ?? null
  );
}

/**
 * 这个人此刻该调的那份配方。
 *
 * M2.7.7 修：途径取**实际入的那条**（snapshot.pathwayId），不是画像里的偏好（profile.pathway）。
 *
 * 两者从 M2.7.6 起可以不一致 —— 玩家走哪条路由势力引导或配方线索决定，
 * 而画像里的 pathway 只是「他本来想走哪条」。用错那一个的后果很具体：
 * 一个入了愚者的人会去发「.魔药 warrior_9」，收到「warrior_9 属于战士途径，你是愚者。」，
 * 然后**一整天反复发同一条**（那句句式当时不在拒绝话术表里，换招机制拉不动）。
 * 这是 M2.7.6 那 5 条 P1 里 4 条的直接成因。
 */
function recipeOf(world: WorldKnowledge, ctx: DecisionContext) {
  const pathway = ctx.snapshot.pathwayId ?? ctx.profile.pathway;
  return world.recipes.find(
    (recipe) => recipe.pathway === pathway && recipe.seq === ctx.snapshot.sequence,
  );
}

/**
 * M2.7：只留**自己脚下这座城市**的地点。
 *
 * 服务端的 .探索 只认本城（那是「移动不是传送」的唯一强制点），
 * 虚拟玩家不知道这一点的话，每一次探索都会被拒：地点覆盖率归零、
 * 而 CI 的硬门「新号可达地点没被探索过」会直接判红。
 *
 * 缺信息时不限制（老角色没有 currentCityId、地点没登记城市）——
 * 与菜单层的 inCurrentCity 同一个保守口径，退回 M2.6 的「地点是平的」行为。
 */
function nearbyLocations(ctx: DecisionContext, world: WorldKnowledge): WorldKnowledge['locations'] {
  const cityId = ctx.snapshot.currentCityId;
  if (!cityId) return world.locations;
  return world.locations.filter((location) => !location.city || location.city === cityId);
}

/** 地点今天还能不能再探索（每地点每日 3 次） */
function explorableToday(ctx: DecisionContext, world: WorldKnowledge, locationName: string): boolean {
  const id = world.locationIdByName[locationName];
  if (!id) return true;
  const used = ctx.snapshot.exploreCounts[id] ?? 0;
  // ⚠️ 这是**模拟玩家的自律**（一天探三次就收手），不是机制限制 —— 每日次数已是软上限
    return used < NUMERIC.explore.dailyCapPerLocation;
}

/** 找「能掉这件材料」的地点（玩家视角：知道去哪儿找），并挑今天还能进的 */
function locationFor(
  ctx: DecisionContext,
  world: WorldKnowledge,
  itemId: string,
  sequence: number,
  visited: Set<string>,
): string | null {
  const candidates = nearbyLocations(ctx, world).filter(
    (location) =>
      sequence <= location.minSeq &&
      sequence >= location.maxSeq &&
      location.loot.includes(itemId) &&
      explorableToday(ctx, world, location.name),
  );
  if (candidates.length === 0) return null;
  const fresh = candidates.filter((location) => !visited.has(location.name));
  return (fresh[0] ?? candidates[0])!.name;
}

function missingMaterial(world: WorldKnowledge, ctx: DecisionContext, needs: Array<{ itemId: string; qty: number }>): string | null {
  const missing = needs.find((need) => has(ctx.snapshot, need.itemId) < need.qty);
  return missing?.itemId ?? null;
}

/**
 * 找一个和自己不同的玩家 QQ，用于交易。
 * 只在「本批确实存在的玩家」里挑（fleetSize），否则会打出大量
 * 「对方还没有角色，无法交易」——那是测试脚本自己造的空转。
 */
function otherUserId(ctx: DecisionContext): string {
  const base = 700000;
  const size = Math.max(2, ctx.profile.fleetSize || 2000);
  const current = Number(ctx.profile.userId) - base;
  const offset = 1 + Math.floor(rngFor(ctx).next() * Math.min(6, size - 1));
  return String(base + ((current + offset) % size));
}

/**
 * 交易报价模型（M2.6 前置项二）。
 *
 * 为什么要有它：三层货币的解析器单测很全（12 种有效 + 9 种脏输入），
 * 但在此之前**虚拟玩家全程只发纯数字** —— `1g5s3p` 这类组合格式从未在
 * 真实 HTTP 链路上走过一遍。真人是会这么打的（"1 金镑 5 苏勒 3 便士"是最自然的写法），
 * 真人第一次发组合格式时如果挂了，我们无从预判。
 *
 * 组合样本的 penny 值**由 parseCurrency 现算、不手写**：解析器的进位一改，
 * 这里立刻跟着变，而不是留下一份悄悄对不上的副本。
 * 权重偏向 `2s`（24 便士）—— 虚拟玩家的对手大多没什么钱，
 * 报价太高会让 .确认 大面积撞「货币不足」，把交易链路本身的信号淹掉。
 */
export const TRADE_PRICE_MODEL = {
  /** 30% 的交易用组合格式报价 */
  comboChance: 0.3,
  comboSamples: ['2s', '1g', '1g5s3p'] as const,
  comboSampleWeights: [5, 3, 2] as const,
};

export interface TradePrice {
  /** 发出去的报价原文（纯数字或组合格式） */
  token: string;
  /** 按便士算的金额（断言用） */
  penny: number;
  combo: boolean;
}

/** 本次报价该用哪种格式（纯函数 + 注入 rng，可复现） */
export function tradePriceToken(rng: { next(): number }, basePenny: number): TradePrice {
  if (rng.next() < TRADE_PRICE_MODEL.comboChance) {
    const weights = TRADE_PRICE_MODEL.comboSampleWeights;
    let roll = rng.next() * weights.reduce((sum, weight) => sum + weight, 0);
    let index = 0;
    for (let i = 0; i < TRADE_PRICE_MODEL.comboSamples.length; i += 1) {
      roll -= weights[i]!;
      if (roll < 0) {
        index = i;
        break;
      }
    }
    const token = TRADE_PRICE_MODEL.comboSamples[index]!;
    const penny = parseCurrency(token);
    // 解析不出来就退回纯数字：宁可这一次不覆盖组合格式，也不要发一条必然被拒的指令
    if (penny !== null && penny >= 1) return { token, penny, combo: true };
  }
  return { token: String(basePenny), penny: basePenny, combo: false };
}

/**
 * 组一条 .交易 指令（价格格式由 tradePriceToken 决定）。
 *
 * ⚠️ 价格用的随机源**必须独立**，不能借用 rngFor(ctx)：
 * 后者的种子只含 (profile.seed, day, step)，同一个玩家在同一天的不同登录里、
 * 同一个 step 上会拿到完全相同的第一个随机数 —— 于是"30% 用组合格式"
 * 实际上变成"某几个 step 固定用、其余固定不用"。
 * 实测：连续五轮 20×3 的组合格式占比是 1/21、5/19、4/17、5/19、7/25，平均约 22%，
 * 明显低于 30%，而单测里同样的函数抽样 2000 次是 30.4%。
 * 把 login 与 itemId 拌进种子之后，每一次报价才是一次独立抽样。
 */
function tradeDecision(
  ctx: DecisionContext,
  target: string,
  itemId: string,
  basePenny: number,
  reason: string,
): Decision {
  const priceRng = createSeededRng(
    seedFrom([ctx.profile.seed, 'trade-price', ctx.day, ctx.login, ctx.step, itemId]),
  );
  const price = tradePriceToken(priceRng, basePenny);
  return command(
    '.交易 @' + target + ' ' + itemId + ' 1 ' + price.token,
    price.combo ? reason + '（三层货币组合格式报价）' : reason,
  );
}

/**
 * 加入「群里公告过的队伍」（方案 C）。
 * 队号从群消息里读来，比 otherUserId() 瞎猜 QQ 靠谱得多 —— 选哪个队由 seed 决定，保持可复现。
 */
function joinKnownParty(ctx: DecisionContext, reason: string): Decision {
  const rng = rngFor(ctx);
  const id = ctx.knownParties[Math.floor(rng.next() * ctx.knownParties.length)] ?? ctx.knownParties[0]!;
  return command(`.队伍 加入 ${id}`, reason);
}

/** 扮演文本：轮换契合标签，避开「同一标签每日 3 次」的上限 */
function playText(ctx: DecisionContext, tags: PathwayTags, step: number): string {
  const core = tags.core[step % tags.core.length] ?? tags.core[0]!;
  const secondary = tags.secondary[step % tags.secondary.length] ?? tags.secondary[0]!;
  return `我${core}，顺便${secondary}`;
}

/** 稀有指令注入：保证每条指令都被真实打到（覆盖率要求 ≥10 次/条） */
function coverageDecision(ctx: DecisionContext, world: WorldKnowledge, rng: { next(): number }): Decision | null {
  const snapshot = ctx.snapshot;
  const restUsed = snapshot.dailyCounters['rest'] ?? 0;
  const purifyUsed = snapshot.dailyCounters['purify'] ?? 0;
  const options: Array<{ weight: number; make: () => Decision }> = [
    { weight: 1, make: () => command('.状态', '覆盖率：查看角色卡') },
    { weight: 3, make: () => command('.帮助 faq', '覆盖率：查 FAQ') },
    { weight: 1, make: () => command('.帮助 规则', '覆盖率：看群规则') },
    { weight: 1, make: () => command('.帮助 公告', '覆盖率：看封测公告') },
    { weight: 2, make: () => command('.背包', '覆盖率：看背包') },
    { weight: 2, make: () => command('.反馈 虚拟玩家巡检：这条反馈来自实例测试', '覆盖率：提交反馈') },
    // M2.2：世界时钟与天气是纯读指令（不改任何角色状态），真实玩家会不时看一眼
    { weight: 3, make: () => command('.世界', '覆盖率：看世界时钟与各地点天气') },
    { weight: 1, make: () => command('.世界 廷根市', '覆盖率：看某地天气详情与预告') },
    // M2.3：.今日 是菜单过期后的重新开始入口，也是「不看 .世界 也知道今天什么天气」的落点。
    // 第一轮 200×14 分片回归里它 0 次 —— 因为菜单路径的玩家靠菜单回数字、
    // 而菜单打分表把「今日」记为 0 分（选它等于原地打转），于是这条指令从两个方向都被绕过了。
    // 现实里玩家**会**发它（菜单过期时系统就是这么教的），所以这里给它一条完整的覆盖路径。
    { weight: 3, make: () => command('.今日', '覆盖率：看今日摘要与选项（菜单过期时的重新开始入口）') },
    // M2.5：.仪式 与 .干扰 是新指令，得有人在实例测试里真的把它们打出去。
    // 只注入给偶数号（本来就是仪式路径的玩家），免得把两条晋升路径的对照实验搅浑。
    ...(ctx.profile.id % 2 === 0 && !snapshot.ritualPreparing && !snapshot.ritualRunning
      ? [{ weight: 2, make: () => command('.仪式 准备', '覆盖率：看仪式选项与成功率拆解') }]
      : []),
  ];

  if ((ctx.runningRituals?.length ?? 0) > 0) {
    const victims = ctx.runningRituals!;
    options.push({
      weight: 5,
      make: () =>
        command(`.干扰 ${victims[Math.floor(rng.next() * victims.length)]!}`, '覆盖率：有人在举行仪式，去搅一把'),
    });
  }

  options.push({ weight: 2, make: () => command('.事件', '覆盖率：打事件卡') });
  if (has(snapshot, '夜香草') > 0) {
    options.push({ weight: 5, make: () => command('.使用 夜香草', '覆盖率：用消耗品') });
  }
  if (has(snapshot, '安神药剂') > 0) {
    options.push({ weight: 4, make: () => command('.使用 安神药剂', '覆盖率：用消耗品') });
  }
  if (snapshot.mp >= NUMERIC.divination.mpCost && ctx.lastRejected !== '占卜') {
    options.push({ weight: 4, make: () => command('.占卜 我今天应该去哪里', '覆盖率：占卜') });
  }
  if (restUsed < NUMERIC.recovery.rest.dailyLimit && ctx.lastRejected !== '休息') {
    options.push({ weight: 2, make: () => command('.休息', '覆盖率：休息') });
  }
  if (
    purifyUsed < NUMERIC.recovery.purify.dailyLimit &&
    has(snapshot, '辅助材料·圣盐') > 0 &&
    ctx.lastRejected !== '净化'
  ) {
    options.push({ weight: 5, make: () => command('.净化', '覆盖率：净化（需要圣盐，凑齐 10 次不容易）') });
  }
  if (snapshot.partyId === null) {
    // 方案 C：先看群里公告过的队伍；没有公告才自己建（瞎猜 QQ 那条路留作兜底）
    if (ctx.knownParties.length > 0) {
      options.push({ weight: 4, make: () => joinKnownParty(ctx, '覆盖率：加入群里公告过的队伍') });
    } else {
      options.push({ weight: 3, make: () => command('.队伍 创建', '覆盖率：建队') });
    }
  } else {
    options.push({ weight: 3, make: () => command('.队伍 任务', '覆盖率：队伍任务') });
    options.push({ weight: 2, make: () => command('.队伍 离开', '覆盖率：离队') });
  }
  options.push({ weight: 2, make: () => command(`.队伍 加入 @${otherUserId(ctx)}`, '覆盖率：尝试加入他人队伍') });
  if (ctx.pendingTrades.length > 0) {
    const trade = ctx.pendingTrades[0]!;
    options.push({ weight: 4, make: () => command(`.确认 ${trade.id}`, '覆盖率：确认交易') });
    options.push({ weight: 1, make: () => command(`.取消 ${trade.id}`, '覆盖率：取消交易') });
  }
  const recipe = recipeOf(world, ctx);
  void recipe;
  const unbound = tradeableItem(snapshot, world);
  if (unbound) {
    options.push({
      weight: 2,
      make: () => tradeDecision(ctx, otherUserId(ctx), unbound.itemId, 5, '覆盖率：挂一笔交易（只挂非绑定物品）'),
    });
  }

  // ⚠️ **M2.6 的两个新指令刻意不进这张表**（试过，又撤了）。
  //
  // pickWeighted 是 roll = rng.next() × 权重总和，再按顺序累减。
  // 往表里加任何一项，**权重总和就变了**，同一个随机数会落到完全不同的选项上 ——
  // 不是"新选项分走一点流量"，而是整张表的映射整体平移。
  // 实测（20×3，seed=smoke）：加了 .袭击(3) + .举报(6) 之后，两轮的动作分布变成
  //   .交易 53 → 17、.占卜 48 → 88、.状态 53 → 83
  // —— 数字全变了，「与上一轮逐项对比」直接失效，而那是分片回归的主要读法。
  //
  // 所以这两条指令的覆盖交给 decide() 里各自独立的路径（3.7 举报 / 3.8 犯罪），
  // 它们命中时提前返回，不进这张权重表。这张表与 M2.5 逐字节一致。
  const picked = pickWeighted(options, rng);
  return picked ? picked.make() : null;
}

/**
 * 菜单路径（M2.3，任务书 §7）：收到菜单 → 按目标与状态选一项 → 回数字。
 *
 * 打分表只回答一个问题：「一个有目标的玩家看到这张菜单会先按哪一条」。
 * 分数为 0 的选项（典型是「今日」）永远不会被选 —— 选它等于原地打转。
 */
const MENU_BASE_SCORE: Record<string, number> = {
  服用: 90,
  晋升: 85,
  扮演: 60,
  探索: 55,
  净化: 40,
  休息: 35,
  事件: 30,
  占卜: 20,
  队伍: 15,
  使用: 15,
  交易: 10,
  /**
   * 纯读指令一律 0 分 —— 不是为了省动作，而是**为了让菜单在没有实质选项时返回 null**，
   * 从而回落到完整指令路径的决策逻辑（promoteChain 的 busywork：去交易 / 组队 / 占卜）。
   *
   * 第一轮把它们给了 2—4 分，后果是：DIG 顶格时「继续扮演」哪怕降到 5 分，
   * 仍然压过「状态」4 分被选中，玩家继续空转（实测 P1：6 条）。
   * 纯读指令的覆盖率由完整指令路径的注入保证（decide.ts 的 coverageDecision），
   * 菜单这条路上不需要它们。
   */
  状态: 0,
  背包: 0,
  帮助: 0,
  世界: 0,
  反馈: 0,
  // 「看今天还有什么可做」只是入口，选它等于原地打转
  今日: 0,
};

export function menuScore(ctx: DecisionContext, option: MenuChoice): number {
  const name = commandNameOf(option.command);
  const snapshot = ctx.snapshot;
  let score = MENU_BASE_SCORE[name] ?? 10;

  /**
   * 空转保护 —— **完整指令路径有、菜单路径一开始漏掉的那一条**。
   *
   * promoteChain 里有 `if (snapshot.dig >= 100) return busywork(...)`：
   * 消化度顶格之后再扮演不会有任何变化，真人这时候会去交易/组队/占卜。
   * 菜单打分表最初没有这个判断，于是「继续扮演」永远是最高分，
   * 玩家在 DIG 满的时候会一直选它 —— 200×14 分片回归里 6 条 P1
   *（NO_STATE_CHANGE，M2.2 单进程同规模是 0 条）就是这么来的。
   *
   * 必须 **直接 return 0**（而不是降权）：降到 5 分仍然会压过纯读项被选中，等于没修。
   */
  if (name === '扮演') {
    const playsToday = snapshot.dailyCounters['play'] ?? 0;
    if (snapshot.dig >= 100 || playsToday >= PLAYER_MODEL.maxPlaysPerDay) return 0;
  }

  // 状态覆盖：到线了就先恢复，这和完整指令路径的判断完全同源
  if (name === '休息') score = snapshot.mad >= 70 || snapshot.status === 'lost_control' ? 95 : 8;
  if (name === '净化') score = snapshot.cor >= 60 || snapshot.status === 'lost_control' ? 95 : 8;
  if (name === '服用' && snapshot.mad >= 85) score = 40; // 疯狂太高，先别喝
  if (name === '晋升' && snapshot.dig < NUMERIC.promotion.digThreshold) score = 10;
  // M2.5：仪式是「能晋升时」的高优先级选择（与 .晋升 同级），不能晋升时不给分
  if (name === '仪式') score = snapshot.dig >= NUMERIC.promotion.digThreshold ? 85 : 0;

  // 目标微调：同一个菜单，冲序列的人和闲逛的人按的键不一样
  if (ctx.profile.goal === 'explore' && name === '探索') score += 20;
  if (ctx.profile.goal === 'social' && (name === '队伍' || name === '交易')) score += 20;
  if (ctx.profile.goal === 'promote' && (name === '扮演' || name === '服用' || name === '晋升')) score += 15;
  if (ctx.profile.goal === 'casual' && name === '扮演') score += 10;
  return score;
}

/** 菜单路径的决策；没有可用菜单（或全部不可选）时返回 null，由调用方回落到常规决策 */
export function menuDecision(ctx: DecisionContext): Decision | null {
  const menu = ctx.pendingMenu;
  /**
   * M2.4：世界事件菜单对**所有**玩家生效。
   * `ctx.menuPath` 是 M2.3 的画像开关（一半玩家走菜单路径、一半走完整指令路径），
   * 而世界播报是发给整个群的 —— 谁都会看见，谁都可以回数字。
   * 所以这里按菜单类型放行，而不是按画像放行。
   */
  /**
   * M2.8：遭遇是**未决状态** —— 那只生物还站在雾里，不管走哪条路径的玩家都得处置它。
   * 不处置的话它会一直挂着（sightings 里 action 为 NULL 的记录越积越多），
   * 而且「感知分层到底有没有生效」就无从在行为日志里验证（任务书 §4.8）。
   */
  if (menu?.menuType === 'encounter') return encounterMenuDecision(ctx, menu);
  /**
   * M2.9：战斗菜单。
   *
   * 与遭遇同一个理由（未决状态），但更强：战斗是**跨指令的多回合状态** ——
   * 玩家可能关掉 QQ 五分钟再回来，而那五分钟里服务端会替他防御。
   * 虚拟玩家不认得这张菜单，就会在战斗里回一个不相干的数字，
   * 而「回合制到底有没有跑起来」「生物行为分布散不散」就全无从验证。
   */
  if (menu?.menuType === 'battle') {
    const battle = ctx.snapshot.activeBattle;
    const usable = menu.options.filter((option) => !option.disabled && option.key !== FREEFORM_KEY);
    // null = PVP 里还没轮到他 —— 交给下面的常规决策（他去干别的，而不是撞「还没轮到你」）
    if (battle && usable.length > 0) {
      const decided = battleDecision(ctx, battle, usable);
      if (decided) return decided;
      return null;
    }
  }

  /**
   * M2.11：挑战菜单是**未决状态**（应战者还没表态），与 encounter / battle 同一类。
   * 不认它的话，虚拟玩家会像没看见一样走开 —— 实测过：'challenge' 不在这一串里时，
   * 挑战会悬在那里直到超时代打，而「B 到底有没有让人更愿意接」就无从验证。
   */
  if (menu?.menuType === 'challenge') return challengeMenuDecision(ctx, menu);

  const isShared = menu?.menuType === 'world_event' || menu?.menuType === 'travel';
  if (!ctx.menuPath && !isShared) return null;
  if (!menu || menu.options.length === 0) return null;
  // M2.7：路途事件用**专门的决策**（不是「按目标给选项打分」那一套）。
  // 事件菜单的选项是「战斗 / 逃跑 / 观察 / 互动」，通用打分对它们一律给 0 分 ——
  // 那会让玩家永远不回数字，事件全部落进到达时的自动结算（= 清一色「观察」），
  // 「移动中的选择」这条链路在实例测试里就等于不存在。
  if (menu.menuType === 'travel') return travelMenuDecision(ctx, menu);

  const usable = menu.options.filter(
    (option) => !option.disabled && option.key !== FREEFORM_KEY,
  );
  if (usable.length === 0) return null;

  const scored = usable
    .map((option) => ({ option, score: menuScore(ctx, option) }))
    .filter((entry) => entry.score > 0);
  if (scored.length === 0) return null;

  const best = Math.max(...scored.map((entry) => entry.score));
  const top = scored.filter((entry) => entry.score === best);
  const picked = top[Math.floor(rngFor(ctx).next() * top.length)]!;
  return {
    command: picked.option.key,
    reason: `菜单路径：选「${picked.option.label}」→ ${picked.option.command}`,
    menuPath: true,
  };
}

/**
 * M2.7：路途事件的应对决策。
 *
 * 规则很简单，但每一条都有理由：
 *   - 敢于冒险的（riskAppetite > 0.5）优先「战斗」，其余人优先「观察」；
 *   - 「互动」对所有画像都是次优 —— 它伤害减半，是没有战斗能力时的稳妥选择；
 *   - 「逃跑」给胆小型（riskAppetite < 0.3）留一条路，但排在有把握的选项之后；
 *   - 同分时用 rng 抽一个，保证同一个 seed 仍然完全可复现。
 */
/**
 * M2.8：遭遇的处置决策。
 *
 * **关键手法：从菜单的选项集反推感知层次。**
 *
 * 判定层已经把「这一层能做什么」编码进了菜单 —— 所以虚拟玩家不需要知道序列差，
 * 只要看有哪些选项就知道自己在哪一层：
 *
 *   有「站着不动」        → 普通人（blur，且是 mortal 专属的第二个选项）
 *   只有「撤退」          → blur（弱 3 级及以上）
 *   「观察 / 撤退」       → silhouette（弱 1—2 级）
 *   「观察 / 对峙 / 互动」→ full 或 advantage（同序列 / 强 1—2 级）
 *   「观察本质 / 互动」   → essence（强 3 级及以上）
 *
 * 这样做还有一个好处：**层次会自然写进行为日志**（decision.reason 里带层次名），
 * 而「普通人只看到模糊、已入途径看到具体」这两件事因此在跑批结果里是可验证的，
 * 不是只能靠读代码相信（任务书 §4.8 的验收要求）。
 */
/**
 * M2.11：**挑战菜单**的决策（应战者那一侧）。
 *
 * ⚠️ 三条必须写下来的口径：
 *
 * 1. **虚拟玩家一律接受。** 它们没有「躲避」这个行为，也不该有 ——
 *    任务书 §九 明确要求「不要预设结论」。如果这里按画像掷骰决定接不接，
 *    跑批测出来的「接受率」就变成了**我们写进去的分布**，
 *    而不是机制本身的性质（前置 1 测出 43.8%，那是有机制来源的数字：
 *    应战者不在自己回合时去做别的事，等回来时早已超时）。
 * 2. 所以「拒绝」这条路径在跑批里是 0 次，它由 test/m2-11.test.ts 直接钉住。
 * 3. 完整指令路径的玩家发**带点号的完整指令**（' .挑战 @某人 接受 '），
 *    菜单路径的玩家回数字 —— 与 world_event / travel 那两张共享菜单同一手法。
 */
function challengeMenuDecision(
  ctx: DecisionContext,
  menu: NonNullable<DecisionContext['pendingMenu']>,
): Decision | null {
  const accept = menu.options.find((option) => option.key === '1' && !option.disabled);
  if (!accept) return null;
  return {
    command: ctx.menuPath === true ? accept.key : '.' + accept.command,
    reason: '挑战：他打过来了 —— 接下（虚拟玩家不会躲，这是构造的）',
    menuPath: ctx.menuPath === true,
  };
}

function encounterMenuDecision(
  ctx: DecisionContext,
  menu: { options: MenuChoice[] },
): Decision | null {
  const options = menu.options.filter(
    (option) => !option.disabled && option.key !== FREEFORM_KEY,
  );
  if (options.length === 0) return null;
  const find = (needle: string): MenuChoice | undefined =>
    options.find((option) => option.command.includes(needle));
  const rng = rngFor(ctx);
  const appetite = ctx.profile.riskAppetite;

  const retreat = find('撤退');
  const hold = find('站着不动');
  const essence = find('观察本质');
  const confront = find('对峙') ?? find('驱逐');
  const interact = find('互动');
  const observe = find('观察本质') ?? find('观察');
  /*
   * M2.9：遭遇菜单的最后一项 —— 动手（只在 silhouette 及以上出现）。
   *
   * ⚠️ 这里**必须按 command 匹配**，不能写 find('动手')：
   * 那个选项的 label 是「动手」，而 command 是完整指令原文「战斗 开始」——
   * 上面那些 find('撤退') / find('观察') 之所以能这么写，是因为它们的 label 与
   * command 里的动作词是同一个词（'遭遇 撤退'）。
   *
   * 这个坑实测踩过：写错之后 4 个分片跑满 14 天**一场战斗都没有**，
   * 而菜单、门槛、服务端兜底全都是对的 —— 是虚拟玩家永远选不中那个选项。
   * 现在由 test/m2-3-vplayer.test.ts 的一条用例守着。
   */
  const fight = options.find((option) => option.command === '战斗 开始');

  /*
   * M2.3 的两条路径在这里也要成立：
   *   菜单路径的玩家**回数字**；完整指令路径的玩家**发完整指令**。
   * 这一条不能因为「遭遇特殊」就破例 —— 虚拟玩家的对照测试守的就是
   * 「奇数号玩家的动作里没有回数字」，破例会让那个契约失效。
   * 遭遇确实对所有玩家生效（未决状态，谁都得处置），但**处置的方式仍按各自的路径走**。
   */
  const pick = (option: MenuChoice, reason: string): Decision => ({
    command: ctx.menuPath ? option.key : option.command,
    reason,
    menuPath: ctx.menuPath,
  });

  /**
   * 普通人：他连那是什么都不知道，**没有「观察」这个念头**。
   * 大多数时候退回去，偶尔愣在原地（真人也会愣住 —— 这一条让分布不至于一刀切）。
   */
  if (hold && !essence) {
    const picked = rng.next() < 0.75 && retreat ? retreat : hold;
    return pick(picked, `遭遇（blur·普通人）：看不清是什么，选「${picked.label}」`);
  }

  /** 强 3 级及以上：看得见本质 —— 顺手把材料取了（M2.8 唯一一条生物 → 物品的路） */
  if (essence && observe === essence) {
    // M2.9：层次高到这一步，也看得清该不该动手 —— 三成的人选择直接打
    if (fight && rng.next() < 0.3) {
      return pick(fight, `遭遇（essence·强 3 级）：看得见本质，也知道打得过 —— 选「${fight.label}」`);
    }
    // 其余人先观察本质（采集），剩下的人只是打个照面
    const picked = rng.next() < 0.9 || !interact ? essence : interact;
    return pick(picked, `遭遇（essence·强 3 级）：看得见本质，选「${picked.label}」`);
  }

  /**
   * 弱 1—2 级：看得见轮廓了 —— 于是既有「看清楚一点（观察，MAD +1）」，
   * 也有 M2.9 新给的「动手」。
   *
   * 这一档是战斗在 M2 里**唯一真正可得的入口**（见 encounter-menu.ts 的口径修正），
   * 所以按画像掷的意愿必须够高，否则报告里的战斗样本会少到看不出分布。
   */
  if (observe && retreat && !confront) {
    /*
     * M2.13：**手里有「借来的强」时更愿意动手。**
     *
     * 这一档（弱 1—2 级）是**封印物的主战场** —— 序列 9 的玩家打序列 8 的生物就落在
     * 这里（delta = -1）。而封印物的定位是「让序列 9 有可能打赢序列 8」，
     * 那么第一步就是**敢不敢动手**：真人手里握着一件专门用来跨越序列差的东西时，
     * 看到平时会绕开的东西会想试一下 —— 不带它的时候则照旧绕开。
     *
     * 只对**两件核心**生效（封印之刃 / 命运骰子）：灰雾之眼与时间沙漏不改变胜负，
     * 带着它们去动手是送死，不是「借来的强」。
     */
    const appetite =
      FIGHT_APPETITE[ctx.profile.persona] + (hasBorrowedPower(ctx.snapshot) ? 0.25 : 0);
    if (fight && ctx.snapshot.hp >= FIGHT_MIN_HP && rng.next() < Math.min(0.95, appetite)) {
      return pick(fight, `遭遇（silhouette·弱 1—2 级）：看得见轮廓，决定先下手 —— 选「${fight.label}」`);
    }
    const picked = rng.next() < appetite ? observe : retreat;
    return pick(picked, `遭遇（silhouette·弱 1—2 级）：看不太清，选「${picked.label}」`);
  }

  /** 同序列 / 强 1—2 级：看得清，可以打交道。激进的先对峙，稳健的先观察 */
  if (confront && observe) {
    const aggressive = appetite > 0.5;
    const layerName = confront.command.includes('驱逐') ? 'advantage·强 1—2 级' : 'full·同序列';
    /*
     * M2.9：这一层起多了一个选项 —— **动手**（任务书 §4.7「full 以上进入战斗」）。
     *
     * 为什么只有激进型会动手、而且只有 45%：动手是遭遇菜单里唯一一个
     * 会把你拖进多回合的选项，真人也不会一看见什么都打。
     * 但比例不能太低 —— 否则 M2.9 的战斗在跑批里样本不足，
     * 「生物行为分布」会因为采样太少而看不出模式。
     */
    /*
     * 动手之前先看自己还剩多少血 —— 这一条不是可有可无的。
     *
     * 实测教训：不加它的时候，17 场战斗里有 11 场**只打了 1 个回合**就结束 ——
     * 因为玩家进场时 HP 就只有二三十（探索掉血 / 失控掉血攒下来的），
     * 而「HP < 30% 就撤」那条规则第一回合就把他带出了战斗。
     * 真人不会带着二十点血去打雾里的东西：**能打的前提是你还站得住**。
     */
    const healthy = ctx.snapshot.hp >= FIGHT_MIN_HP;
    if (fight && healthy && rng.next() < FIGHT_APPETITE[ctx.profile.persona]) {
      return pick(fight, `遭遇（${layerName}）：看清了、也还站得住 —— 选「${fight.label}」`);
    }
    const picked = aggressive && rng.next() < 0.6 ? confront : observe;
    return pick(picked, `遭遇（${layerName}）：看得清，选「${picked.label}」`);
  }

  // 兜底：有什么回什么（至少把这次遭遇了结掉，别让它一直挂着）
  const fallback = retreat ?? options[0]!;
  return pick(fallback, `遭遇：选「${fallback.label}」`);
}

/**
 * M2.9：一场战斗里的出招决策（任务书 §4.7）。
 *
 * 四条规则，顺序就是优先级 —— 每一条都能从 snapshot 里的**血量**读出来，
 * 所以虚拟玩家做的不是「按画像瞎掷」，而是**看血做决定**：
 *
 *   自己 HP < 30%   → 撤退
 *   它 HP < 30%     → 攻击（**不给它逃跑的机会**）
 *   灵力够          → 优先技能
 *   否则            → 攻击
 *
 * 两条路径都要成立（与 M2.3 / M2.8 同一条纪律）：
 *   菜单路径 —— 回数字（command 就是那个 key）
 *   完整指令 —— 发 .战斗 攻击 这样的原文
 * 所以这里先挑出「要做什么」，再按路径决定怎么说。
 */
function battleDecision(
  ctx: DecisionContext,
  battle: NonNullable<DecisionContext['snapshot']['activeBattle']>,
  menuOptions: readonly MenuChoice[],
  /** M2.10：PVP 里**不在自己回合**时返回 null（调用方据此回落到别的决策） */
): Decision | null {
  const rng = rngFor(ctx);
  const usable = menuOptions.filter((option) => !option.disabled && option.key !== FREEFORM_KEY);
  const findIn = (needle: string): MenuChoice | undefined =>
    usable.find((option) => option.command.includes(needle));

  /*
   * 走哪条路（与 M2.3 / M2.8 同一条纪律）：
   *   菜单路径 —— 回数字（前提是**这张战斗菜单真的挂着**，否则回数字等于回给别的菜单）
   *   完整指令 —— 发 .战斗 攻击 这样的原文
   */
  const byMenu = ctx.menuPath === true && usable.length > 0;

  const attack = (reason: string): Decision => {
    const option = findIn('战斗 攻击');
    return byMenu && option ? { command: option.key, reason, menuPath: true } : command('.战斗 攻击', reason);
  };
  const defend = (reason: string): Decision => {
    const option = findIn('战斗 防御');
    return byMenu && option ? { command: option.key, reason, menuPath: true } : command('.战斗 防御', reason);
  };
  const retreat = (reason: string): Decision => {
    const option = findIn('战斗 撤退');
    // 撤退不再有行动点门槛（M2.85）：这里只保证「想撤」
    return byMenu && option ? { command: option.key, reason, menuPath: true } : command('.战斗 撤退', reason);
  };

  const playerRatio = battle.playerHp / 100;
  const foeRatio = battle.creatureMaxHp > 0 ? battle.creatureHp / battle.creatureMaxHp : 0;

  /*
   * M2.10（PVP）：**不在自己回合就别出招**。
   *
   * 异步 PVP 是「两人各出一个动作再一起结算」，服务端会记住轮到谁。
   * 虚拟玩家不知道这件事的话，会一路撞「还没轮到你」——
   * 而那种拒绝既不消耗资源、也不报异常，只会把当天剩下的动作全部烧光（实测踩过）。
   */
  if (battle.isPvp && !battle.yourTurn) return null;

  /*
   * ==================================================================
   * M2.13：**封印物** —— 序列 9 玩家打序列 8 生物时那个「借来的机会」
   * ==================================================================
   *
   * 这一段的定位写在任务书 §5.1：封印物**不是给高序列玩家的工具**，
   * 是让低序列玩家**有可能打赢**。所以它的触发条件完全按「序列差」来，
   * 而不是按「我包里有什么好东西」：
   *
   *   gap = 生物的序列 − 我的序列（正数 = 它比我强）
   *
   *   gap ≥ 3  —— 本来会被 M2.6.1 直接拦掉（「你根本近不了它的身」）。
   *               只有**封印之刃**能把这一刀递出去，所以这里直接用它，不看别的。
   *   gap 1—2  —— 打得到，但命中 ×0.4^(gap)、伤害 ×0.5^(gap)。
   *               封印之刃把它变成「必中」，命运骰子把命中率再抬一次。
   *   gap ≤ 0  —— **不用**。打得过就是打得过，把封印物花在这里是浪费。
   *
   * 两道节制（真人也会有）：
   *   1. COR ≥ 80 不用封印之刃、MAD ≥ 80 不用命运骰子 —— 代价会把人推进失控；
   *   2. 一场战斗里每件只考虑一次由调用顺序天然保证（每回合只出一个动作，
   *      而这一步在「攻击 / 技能」之前 —— 所以用得上就一定先用了）。
   */
  const borrowed = borrowedPower(ctx, battle);
  if (borrowed) return borrowed;

  /* M2.10（PVP）：快输了就认输 —— 认输判负但**对方不通缉**，比被磨死强 */
  if (battle.isPvp && playerRatio < 0.2 && rng.next() < 0.3) {
    const option = findIn('战斗 认输');
    const why = `PVP：自己只剩 ${battle.playerHp} 点血，认输（对方不通缉）`;
    return byMenu && option
      ? { command: option.key, reason: why, menuPath: true }
      : command('.战斗 认输', why);
  }

  // 被放逐 / 失控：这一回合本来就做不了主，直接防御（服务端会照常结算）
  if (battle.playerStatuses.includes('banish') || battle.playerStatuses.includes('lostControl')) {
    return defend('被放逐/失控：这一回合只能先守住');
  }

  // 1) 自己快倒了 → 撤
  if (playerRatio < 0.3) {
    return retreat(`战斗第 ${battle.round} 回合：自己 HP ${battle.playerHp}/100，先撤`);
  }

  // 2) 它快倒了 → 不让它有逃跑的机会（这也是「暴走的那只不会跑」的对策）
  if (foeRatio < 0.3) {
    return attack(
      `战斗第 ${battle.round} 回合：${battle.speciesName}只剩 ${battle.creatureHp}/${battle.creatureMaxHp}，不给它跑的机会`,
    );
  }

  /*
   * 3) 有技能且灵力够 → 用技能。
   *
   * ⚠️ 但要**先把「输出型」和「辅助型」分开**。任务书 §4.7 写的是「MP 够 → 优先技能」，
   * 照做会踩一个很实的坑：序列 9 的愚者唯一的技能是「占卜预判」（**零伤害**），
   * 于是玩家会把一整场架打成「一直占卜」—— 生物从头到尾满血，
   * 「逃跑 / 暴走 / 求援 / 进化 / 装死」五种依赖掉血的行为一个都触发不了。
   *
   * 实测抓到的正是这个：48 个回合里 16 次是辅助技能、生物行为只剩「攻击 + 特殊」。
   * 所以这里按**效果表**判断（有 damageMultiplier / hits 的才是输出型），
   * 辅助型只在少数回合用 —— 真人也不会在挨打的时候一直占卜。
   */
  const affordable = skillsFor(ctx.snapshot.pathwayId ?? null, ctx.snapshot.sequence).filter(
    (skill) => skill.mpCost <= battle.playerMp,
  );
  const damaging = affordable.filter((skill) => {
    const effect = skillEffectOf(skill.id);
    /*
     * M2.12：**命运赌注也算输出型**。
     * 它的形态是「打一下，打空了就重掷一次」—— 语义上是一次攻击，只是带了一次运气。
     * 不把它算进来的话，序列 7 的愚者会把它当辅助技能，用率从七成掉到一成半，
     * 而「序列 7 的技能到底有没有人用」正是这一轮要验的东西之一。
     */
    return (
      effect.damageMultiplier !== undefined ||
      effect.hits !== undefined ||
      effect.rerollMiss === true
    );
  });
  const support = affordable.filter((skill) => !damaging.includes(skill));
  const useSkill = (skill: (typeof affordable)[number], why: string): Decision => {
    const option = usable.find((entry) => entry.command === `战斗 技能 ${skill.name}`);
    if (byMenu && option) return { command: option.key, reason: why, menuPath: true };
    return command(`.战斗 技能 ${skill.name}`, why);
  };
  if (damaging.length > 0 && rng.next() < 0.7) {
    const chosen = damaging[Math.floor(rng.next() * damaging.length)]!;
    return useSkill(chosen, `战斗：灵力够，用输出型技能「${chosen.name}」`);
  }
  if (support.length > 0 && rng.next() < 0.15) {
    const chosen = support[Math.floor(rng.next() * support.length)]!;
    return useSkill(chosen, `战斗：先用一次「${chosen.name}」`);
  }

  // 4) 背包里有能用的东西 → 偶尔用一件（符咒 / 消耗品）
  if (rng.next() < 0.25) {
    const option = findIn('战斗 物品');
    if (option) {
      return byMenu
        ? { command: option.key, reason: `战斗：用一件${option.label}`, menuPath: true }
        : command(`.${option.command}`, `战斗：用一件${option.label}`);
    }
    // 没有菜单时自己从背包里挑一件 —— 符咒优先（那是为打架准备的东西）
    const charm = ctx.snapshot.inventory.find((slot) => slot.itemId.startsWith('符咒'));
    if (charm) return command(`.${'战斗 物品 ' + charm.itemId}`, '战斗：手上有符咒，用一张');
  }

  return attack(`战斗第 ${battle.round} 回合：常规攻击`);
}

function travelMenuDecision(
  ctx: DecisionContext,
  menu: { options: MenuChoice[] },
): Decision | null {
  const options = menu.options.filter(
    (option) => !option.disabled && option.key !== FREEFORM_KEY,
  );
  if (options.length === 0) return null;
  const appetite = ctx.profile.riskAppetite;
  const score = (command: string): number => {
    if (command.includes('fight')) return appetite > 0.5 ? 3 : 1;
    if (command.includes('interact')) return 2;
    if (command.includes('flee')) return appetite < 0.3 ? 2 : 1;
    return appetite > 0.5 ? 2 : 3; // 观察
  };
  const rng = rngFor(ctx);
  /*
   * 15% 的概率「临场发挥」：不按脾气出牌，而是在可行选项里随机挑一个。
   * 两个理由：
   *   1. 真人不会每次都按画像走 —— 这一条让实例测试更接近真实分布；
   *   2. 它是**「逃跑」在实例测试里唯一的入口**：三档画像的偏好里，
   *      逃跑永远排不到第一（激进型要打、稳健型要观察），
   *      第一版长跑的 357 次抉择里逃跑 0 次 —— 按钮有四个，实测只按了三个。
   */
  if (rng.next() < 0.15) {
    const wild = options[Math.floor(rng.next() * options.length)]!;
    return {
      command: wild.key,
      reason: `路途事件：临场发挥，选「${wild.label}」`,
      menuPath: true,
    };
  }
  const scored = options.map((option) => ({ option, value: score(option.command) }));
  const best = Math.max(...scored.map((entry) => entry.value));
  const top = scored.filter((entry) => entry.value === best);
  const picked = top[Math.floor(rng.next() * top.length)]!;
  return {
    command: picked.option.key,
    reason: `路途事件：选「${picked.option.label}」→ ${picked.option.command}`,
    menuPath: true,
  };
}

function pickWeighted<T extends { weight: number }>(items: readonly T[], rng: { next(): number }): T | null {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return null;
  let roll = rng.next() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll < 0) return item;
  }
  return items[items.length - 1] ?? null;
}


/*
 * M2.7.6 / M2.85：普通人今天做什么（见下方 mortalDecision）。
 *
 * 优先级（与 .线索 的文案口径一致）：
 *   1. 手上有调好的魔药 → 喝下去（入途径）；
 *   2. 材料齐了 → 调制；
 *   3. 四处走走 —— 这是普通人唯一稳定的产出手段，也是**配方线索的唯一来源**；
 *   4. 休息（若今天还没休息过）；没事可做就下线（绝不发纯只读命令当兜底）。
 *
 * M2.85 起没有「等引导」的玩法了 —— 线索只从探索里出（5%；满 cluePityDays
 * 天必出），所以每个普通人都在「主动找线索」，区别只在频率。
 */

/**
 * M2.16：教会行为的旋钮（与 PLAYER_MODEL 同一手法 —— 模型参数写在模型里，不散在分支中）。
 *
 * ⚠️ **它不是游戏数值**：游戏侧的阈值全在 \`NUMERIC.church\`。这里管的是
 * 「虚拟玩家愿不愿意掏钱」，也就是**玩家行为**。
 */
const CHURCH_MODEL = {
  /** 手上至少这么多便士才考虑捐献（低于这个数留着买材料 —— 真人也是这么想的） */
  donateMinPenny: 60,
  /** 一次决策里有多大概率去捐（服务端还有 24h 冷却，这里只是别天天撞它） */
  donateChance: 0.6,
  /** 单次捐献的目标额度；服务端还有「不超过持有的一半」的上界 */
  donateTargetPenny: 100,
};

/*
 * ============================================================================
 * M2.17 第 0 步：**教会行为的两个对照开关**（进程启动时读一次）
 * ============================================================================
 *
 * M2.16 交付后查出「入途径 → 8 掉 5.2 pp」，初查给出两条候选路径却分不开：
 *
 *   A 动作挤占 —— 教会动作（入教 + 捐献，960 次）占掉了本该用于 .扮演 的动作位
 *   B rng 偏移 —— churchDecision 多取一个 rng.next()，让**同一步内后续所有分支**
 *                 拿到整体偏移一位的随机序列，于是整条行为轨迹都变了
 *
 * 要分开它们，只能跑**同 seed 的四版对照**：
 *
 *   A  现状                    → 基线
 *   B  M217_CHURCH=off         → 直接 return null，**一次 rng 都不取**
 *   D  M217_CHURCH_DRAIN=on    → **在 A 版会取数的那一行照样取一次**，然后什么都不做
 *
 * 于是两个净影响是：
 *
 *   **A − D = 候选 A（动作挤占）** —— 两者 rng 消耗完全相同，差别只有「产不产生动作」
 *   **D − B = 候选 B（rng 消耗）** —— 两者都不产生动作，差别只有「取不取那一个数」
 *
 * ⚠️ **D 的消耗位置必须在 A 的同一行**，不能挪到函数开头。
 * 任务书 §九 把它写成一行 `if (drain) rng.next(); return null;` —— 如果那一行放在函数最前面，
 * D 就会对**未入教的玩家**也消耗一次随机数（A 版不会），
 * 于是 A − D 里混进「消耗位置的差异」，两个候选就又分不开了。
 * 这也是唯一一处与任务书字面不同的地方：D 不是一行，而是**复刻 A 的消耗前置条件**。
 */
const CHURCH_OFF = process.env.M217_CHURCH === 'off';
const CHURCH_DRAIN = process.env.M217_CHURCH_DRAIN === 'on';

/** M2.16：这座城里有没有与我途径对应的正神教会（与服务端 canJoin 的判据同源） */
function matchingChurch(
  ctx: DecisionContext,
  world: WorldKnowledge,
): WorldKnowledge['churches'][number] | null {
  const cityId = ctx.snapshot.currentCityId;
  const pathway = ctx.snapshot.pathwayId;
  if (!cityId || !pathway) return null;
  return (
    world.churches.find(
      (church) => church.pathway === pathway && church.seats.includes(cityId),
    ) ?? null
  );
}

/**
 * M2.16：教会（入教 + 捐献）。
 *
 * 两件事合在一个决策里，因为它们的**优先级相同**（都是「我今天要不要理教会」），
 * 而且第一件做完之后第二件才有意义：
 *
 *   1. 还没入教，而这座城市有我这条途径的教会 → \`.加入教会 <id>\`（一次性）；
 *   2. 已经入教，钱够 → \`.教会 捐献 <额度>\`（贡献换档位）。
 *
 * ⚠️ **不填这一段，任务书 F 的「入教人数 ≥ 50%」与「church_rank_up ≥ 50」必然是 0** ——
 * 而 0 看起来像「功能没生效」，不像「测试没走那条路」。这是它必须存在的原因。
 *
 * 两条判据都**自己先算一遍**（本地有没有教会 / 钱够不够），
 * 与服务端的判定同源但独立 —— 算错了会被拒（不会走偏），算对了才不会把动作
 * 烧在必然被拒的指令上（M2.7.7 那条教训：空转的试错会打穿覆盖率）。
 */
function churchDecision(
  ctx: DecisionContext,
  world: WorldKnowledge,
  rng: { next(): number },
): Decision | null {
  // 对照 B：教会行为完全不介入（也不消耗随机数）
  if (CHURCH_OFF) return null;
  /*
   * M2.17（B5）：secular 画像**整段跳过**教会分支 —— 不入教、不捐献。
   *
   * 位置很关键：必须在**任何 rng.next() 之前**返回。放在下面任何一处之后，
   * 这个画像就会比 steady 多走一段取数路径，两个画像的轨迹从第一天起就分叉了 ——
   * 而那正是对照组最不能有的东西（M2.16 那 5.2 pp 的教训）。
   */
  if (ctx.profile.persona === 'secular') return null;

  const snapshot = ctx.snapshot;

  // ① 入教：一次性，本地有对应教会才发（这一支**不消耗 rng**）
  if (!snapshot.churchId) {
    // 对照 D：连入教也不做 —— 它要的是「什么都不做」
    if (CHURCH_DRAIN) return null;
    const church = matchingChurch(ctx, world);
    if (!church) return null;
    if (ctx.lastRejected === '加入教会') return null;
    return command('.加入教会 ' + church.id, '这座城里有与我途径对应的教会：入教');
  }

  // ② 捐献：钱够、且今天还没撞过冷却
  if (ctx.lastRejected === '教会') return null;
  const penny = has(snapshot, CURRENCY_ITEM_ID);
  if (penny < CHURCH_MODEL.donateMinPenny) return null;

  /*
   * ⚠️ **本函数唯一的 rng 消耗点，A 与 D 共用这一行。**
   * 对照 D 能干净地量出「动作挤占」，全靠它的消耗位置与 A 一模一样。
   */
  const roll = rng.next();
  // 对照 D：数已经取了（行为轨迹的影响照常发生），但**什么都不做**
  if (CHURCH_DRAIN) return null;

  if (roll >= CHURCH_MODEL.donateChance) return null;
  const amount = Math.min(Math.floor(penny * NUMERIC.church.donation.maxShareOfHolding), CHURCH_MODEL.donateTargetPenny);
  if (amount < NUMERIC.church.donation.pennyPerContribution) return null;
  return command('.教会 捐献 ' + amount, '给教会捐一笔：贡献换教内等级');
}

function mortalDecision(ctx: DecisionContext, world: WorldKnowledge, rng: { next(): number }): Decision {
  const snapshot = ctx.snapshot;

  // 1) 手上有魔药 → 喝下去（这是整条路的终点：.服用 就是入途径那一刻）
  const potion = snapshot.inventory.find((slot) => slot.itemId.startsWith('potion_'));
  if (potion && ctx.lastRejected !== '服用') {
    return command(`.服用 ${potion.itemId}`, '魔药到手了：喝下去');
  }

  /*
   * 1.6) 手上有配方（自己翻到的那张线索）→ **材料齐了才调**。
   *
   * M2.7.7 改：原来是「有线索就试一下，材料不够会被拒」，于是普通人
   * 一天能试十几次 —— 实测 shard1 的 2086 次 .魔药 调用里有 1503 次是「材料不足」。
   * 那种试错对真人来说也说不通：他手上有那张纸，看得见自己缺什么。
   *
   * 改成先在本地核对材料：不齐就去第 2 步探索找材料，齐了才发一条。
   * 「自己找到配方」那条路照走（材料齐 → 调制 → 下一步 .服用 → 入途径），
   * 而空转的试错消失了。
   *
   * 不带参数调是不行的：虚拟玩家不知道线索指向哪条途径，
   * 所以这里按「哪条途径的序列 9 配方材料齐了」来挑 —— 齐的那条基本就是他手上那条。
   */
  if (snapshot.hasRecipe === true && ctx.lastRejected !== '魔药') {
    /*
     * 挑**配方指向的那条途径**的序列 9 配方 —— 不是「材料齐的那条」。
     * 两者可以不一样（线索指向 seer，而 warrior 的材料恰好齐了），
     * 挑错就会打出一条必然被拒的「没有这份配方」（实测浪费 5188 次动作）。
     */
    const ready = world.recipes.find(
      (entry) =>
        entry.seq === 9 &&
        (snapshot.recipePathway == null || entry.pathway === snapshot.recipePathway) &&
        [...entry.main, ...entry.aux].every(
          (need) =>
            (snapshot.inventory.find((slot) => slot.itemId === need.itemId)?.quantity ?? 0) >= need.qty,
        ),
    );
    if (ready && snapshot.mp >= NUMERIC.potion.mpCost) {
      return command(`.魔药 ${ready.id}`, '材料齐了：把这一瓶调出来（这是入途径的最后一步）');
    }
  }

  // 2) 探索：本城、今天还没探满的地方（刚被拒过就换招，别死磕）
  if (ctx.lastRejected !== '探索') {
    const spot = mortalSpot(ctx, world);
    if (spot) {
      return command(
        `.探索 ${spot}`,
        ctx.profile.id % 10 < 3 ? '主动找线索：多翻几个地方' : '四处走走（普通人阶段的主要内容）',
      );
    }
  }

  /* 3) 今天还有一次休息没用 → 休息一下（M2.85 起不再受行动点限制）。 */
  if ((snapshot.dailyCounters['rest'] ?? 0) < NUMERIC.recovery.rest.dailyLimit) {
    return command('.休息', '今天还没休息过，休息一下');
  }

  /*
   * 4) 真的没事可做了 → 下线。
   *
   * 不用纯只读命令（.状态 / .线索）当兜底：它们永远有话说，但对角色状态
   * 没有任何改变，连发十几次就会被异常检测记成 NO_STATE_CHANGE ——
   * 实测那不只是一两条噪声，而是两千多条，足以把真异常埋掉。
   * （M2.85：原来的 .引导 兜底随引导玩法一并删除。）
   */
  return {
    command: '',
    reason: '普通人阶段：今天没什么可做的，下线',
    skip: true,
  };
}

/* M2.7.7 的 offerReachable（引导任务可连性判定）随 M2.85 的引导玩法一并删除。 */

/**
 * 本城、今天还没探满的一个地点名（普通人的探索目标）。
 *
 * **轮询而不是随机**：快照在同一次登录里不会更新（它是登录开始时读的那一份），
 * 于是「随机挑一个未探满的地点」会挑到同一个 —— 一整天死磕它，
 * 3 次之后就被「今日上限」挡回，而挡回不改变角色状态，
 * 连发十几次就会被记成 NO_STATE_CHANGE（实测正是两千多条 P1 的来源）。
 * 按 step 轮询让玩家在城里转着走，与真人行为也更像。
 */
function mortalSpot(ctx: DecisionContext, world: WorldKnowledge): string | null {
  const cityId = ctx.snapshot.currentCityId ?? null;
  const cap = NUMERIC.explore.dailyCapPerLocation;
  const candidates = world.locations.filter((location) => {
    // 与菜单层同一条口径：查不到城市归属时不过滤（宁可多给几个选项）
    if (cityId && location.city && location.city !== cityId) return false;
    return (ctx.snapshot.exploreCounts[location.id] ?? 0) < cap;
  });
  if (candidates.length === 0) return null;
  /*
   * **没去过的地方优先。**
   *
   * 为什么：普通人阶段的动作数比非凡者少得多（他没有扮演、没有魔药、没有晋升），
   * 轮到每个地点上的次数也就少 —— 纯轮询会让同一批玩家反复走同几个地方，
   * 而 CI 的硬门「新号可达地点没被探索过」是按地点全覆盖判的。
   * 先把没去过的走一遍，再回头挖，这与真人「四处看看」的行为也更像。
   */
  const fresh = candidates.filter((location) => !ctx.visitedLocations.has(location.name));
  const pool = fresh.length > 0 ? fresh : candidates;
  const index = (ctx.step + ctx.login * 7) % pool.length;
  return pool[index]!.name;
}

export function decide(ctx: DecisionContext, world: WorldKnowledge): Decision {
  const rng = rngFor(ctx);
  const snapshot = ctx.snapshot;

  // 0) 还没建号
  //    M2.7：出生城市是派生的（birthCityOf），而每座城市只传承两条途径 ——
  //    拿 profile.pathway 直接去建号，会有一大批号被「这座城市没有这条途径的传承」挡回，
  //    然后卡在「创建失败 → 换途径重试」上，把后面的覆盖率一起拖垮。
  //    所以这里先算出自己落在哪座城市，再挑一条它真传承的途径。
  if (!snapshot.exists) {
    /*
     * M2.7.6：建号是**两步**，而虚拟玩家的世界模型只有「发什么指令」——
     * 所以它必须知道第一步之后该发的是一个数字。
     * 判据是快照里的 genderPending（服务端挂在 'create:<userId>' 上的那张菜单）。
     *
     * 性别按 profile.gender 选，50/50 由 seed 派生：
     * 同一批画像跑两遍，每个人的性别与其它画像参数一样可复现。
     */
    if (snapshot.genderPending) {
      return command(
        ctx.profile.gender === 'female' ? '2' : '1',
        '建号第二步：回性别',
      );
    }
    const home = birthCityOf(ctx.profile.userId, world.birthCities);
    return command(`.创建 ${ctx.profile.name}`, `第 0 天建号（出生地 ${home.name}）`);
  }

  // 0.5) M2.3：走菜单路径的玩家，只要服务端还挂着菜单就按目标选一项回数字。
  //      放在最前面是有意的 —— 菜单是「系统给的选项」，玩家先看选项再谈别的。
  const viaMenu = menuDecision(ctx);
  if (viaMenu) return viaMenu;

  /*
   * 0.55) M2.9：**有一场没打完的战斗，就先把它打完。**
   *
   * 为什么优先级这么高：战斗是未决状态，它不会自己消失 —— 而超时只会替你「防御」，
   * 不会替你结束它。虚拟玩家不处理它的话，那只生物会一直站在那里，
   * 八回合之后僵持收场，而他这一整天剩下的动作全都在「假装没在打架」。
   *
   * 走完整指令路径的人在这里发 .战斗 出招；走菜单路径的人通常在 0.5) 就被
   * battle 菜单拦下了（回数字），这一条是它的兜底。
   */
  if (snapshot.activeBattle) {
    // M2.10：PVP 里不在自己回合时 battleDecision 会返回 null（服务端会拒）——
    // 那时候他去干别的，而不是一路撞「还没轮到你」
    const inBattle = battleDecision(ctx, snapshot.activeBattle, []);
    if (inBattle) return inBattle;
    /*
     * M2.13 前置 4：**PVP 等待期不空转 —— 这是这一条保护的主要落点。**
     *
     * M2.10 只做到「不在自己回合就返回 null，让他去干别的」，而「别的」是什么没有人管：
     * 他落到下面那套目标链上，被 `promoteChain` 接住，然后接着发 `.扮演`——
     * 而消化度早就满了，状态一次都不变（M2.11 / M2.12 的 P1 都是这个形状，
     * M2.12 修完只剩 2 条，正是它）。
     *
     * 现在等待期有明确的四档落点（见 `idleDecision`）：
     * 未决遭遇 → 用消耗品 → 血低休息 → `.状态`。
     *
     * ⚠️ **PVE 到不了这里**：生物不等你，`yourTurn` 恒为 true，
     * `battleDecision` 在 PVE 下永远给出一个动作（M2.10 的判据在它内部）。
     * 所以这一条对 PVE 的行为一个字节都没改。
     */
    /*
     * ⚠️ **只在「有必须要做的事」时才接管**（未决遭遇 / 用消耗品 / 血低休息）。
     * 三档都没有时**继续往下走**（正常目标链），而不是return一个 `.状态` ——
     * 这一条是 200×30 逼出来的，理由见 idleDecision 的注释。
     */
    const idle = idleDecision(
      ctx,
      world,
      'PVP 等待：' + (snapshot.activeBattle.opponentName ?? '对手') + '还没出招，先做点别的',
    );
    if (idle) return idle;
  }

  /**
   * 3.3) M2.10：**挑战**（PVP）。
   *
   * 三个前置条件，与任务书 §4.9 的画像分档一起构成「虚拟玩家怎么发起 PVP」：
   *   1. 有**同地点**、且不是重伤的人（跨地点挑战会被服务端拒 —— 不去撞它）；
   *   2. 自己血够（与 PVE 的动手同一个门槛：不拿半条命去打架）；
   *   3. 按画像掷（激进 0.3 / 混乱 0.25 / 完美主义 0.1 / 稳健 0.05 / 轻量 0.05）。
   *
   * ⚠️ 掷骰**只在有可挑战对象时**发生 —— 否则每一条指令都会消费一个随机数，
   * 把后面所有判定的随机序列整体推偏（同 seed 的可复现性还在，但既有分布会变）。
   */
  const challengable = (ctx.peers ?? []).filter(
    (peer) =>
      peer.locationId !== null &&
      peer.locationId !== undefined &&
      peer.locationId === snapshot.currentLocationId &&
      peer.status !== 'injured' &&
      // 正在打的人不能挑战（服务端会拒）—— 实测：不加这一条会有 39 次「他正在和别人打」
      !peer.inBattle,
  );
  if (
    /*
     * ⚠️ 三个「必被拒」的条件都要提前筛掉，否则他会一路撞墙：
     *   自己正在打（0.55 那条路上 PVP 等回合时会落到这里）
     *   对方正在打（上面那条 filter）
     *   血不够（FIGHT_MIN_HP）
     * 实测：不筛自己那条时，一片 5 天里撞了 171 次「你正在打」。
     */
    !snapshot.activeBattle &&
    challengable.length > 0 &&
    // 自己重伤也不能打（服务端会拒）——实测：漏了这一条，4 片 14 天撞了 553 次
    snapshot.status !== 'injured' &&
    snapshot.hp >= FIGHT_MIN_HP &&
    !snapshot.traveling &&
    rng.next() < CHALLENGE_APPETITE[ctx.profile.persona]
  ) {
    const target = challengable[Math.floor(rng.next() * challengable.length)]!;
    return command(
      `.挑战 ${target.name} 发起`,
      `挑战：${target.name} 也在${snapshot.currentLocationId ?? '这里'}，按画像掷中了`,
    );
  }

  // 0.6) M2.7：在路上。
  //      服务端会把「需要在地」的指令全部挡回（探索 / 扮演 / 晋升 / 仪式 / 袭击），
  //      只放行查看类与 .移动 —— 虚拟玩家不知道这一点的话，会在旅途中一路撞墙，
  //      把当天的动作全烧光。
  if (snapshot.traveling) {
    return rng.next() < 0.6
      ? command('.移动', '在路上：看还有多久到 / 处理路途事件')
      : command('.今日', '在路上：先看看今天还有什么');
  }

  // 0.7) M2.7：移动链。约 1/7 的玩家有远行的念头（id 派生，确定性），
  //      其余人在本城过日子 —— 这样「玩家群分成几个圈子」在实例测试里也看得见。
  const travel = travelDecision(ctx, world, rng);
  if (travel) return travel;

  /*
   * 0.72) M2.13：**手里有「借来的强」，就去有更强生物的地方。**
   *
   * 封印物的定位是「让序列 9 的玩家有可能打赢序列 8 的生物」，而这句话的第一步是
   * 「**去有那种东西的地方**」—— 手里握着封印之刃却继续在安全的地方转悠，
   * 等于把它白放着。任务书 §5.9 把这条写成「虚拟玩家会**主动**探索、交易获取封印物」。
   *
   * 三道前置都取自既有的纪律：
   *   只有那两件核心才触发（灰雾之眼不改变胜负）；
   *   血够（与 FIGHT_MIN_HP 同一个门槛：不拿半条命去打架）；
   *   **只为「可能有更高序列生物」的地点花这一次机会**（见 WorldKnowledge 的
   *   locationCreatureSequences）。
   *
   * ⚠️ 它**只在真的有封印物时才消费随机数** —— 与 M2.6 那条「不该掷骰时不掷」同源。
   */
  const hunt = borrowedPowerHunt(ctx, world, rng);
  if (hunt) return hunt;

  /*
   * 0.75) M2.7.6：**普通人阶段**。
   *
   * 这一段必须**总是**给出一个决策：普通人做不了扮演 / 晋升 / 占卜 / 仪式，
   * 一旦让流程落到下面那套非凡者逻辑上，虚拟玩家就会一整天撞在
   * 「你还没有途径」这堵墙上（服务端会拒绝，而拒绝不算卡死，连 P1 都不会报）。
   */
  if (snapshot.mortal) return mortalDecision(ctx, world, rng);

  // 1) 收件箱里有别人的交易 → 先处理（social / 覆盖率都需要）
  if (ctx.pendingTrades.length > 0 && rng.next() < 0.7) {
    const trade = ctx.pendingTrades[0]!;
    const decideConfirm = rng.next() < (ctx.profile.riskAppetite > 0.5 ? 0.55 : 0.75);
    return decideConfirm
      ? command(`.确认 ${trade.id}`, '确认收到的交易单')
      : command(`.取消 ${trade.id}`, '拒绝收到的交易单');
  }

  // 2) 失控 → 优先恢复（混乱型除外：它就是要压边界）
  //    M2.1 起失控真的会发生，这条分支第一次真正跑到；它原来没查圣盐，
  //    没材料时会一直撞「净化材料不足」把一整天耗光（被拒的指令不算卡死，连 P1 都不会报）。
  //    所以这里按 coverageDecision 的同一套写法补上「有材料 + 没被拒过」两个前置条件，
  //    任一条不成立就退到 .休息（休息不消耗材料）。两条都用不了就照常玩 —— 真人也是这样。
  if (snapshot.status === 'lost_control' && ctx.profile.persona !== 'chaotic') {
    const purifiedToday = snapshot.dailyCounters['purify'] ?? 0;
    const canPurify =
      purifiedToday < NUMERIC.recovery.purify.dailyLimit &&
      has(snapshot, '辅助材料·圣盐') > 0 &&
      ctx.lastRejected !== '净化';
    if (canPurify) return command('.净化', '失控中：优先净化');
    const restedToday = snapshot.dailyCounters['rest'] ?? 0;
    const canRest = restedToday < NUMERIC.recovery.rest.dailyLimit && ctx.lastRejected !== '休息';
    if (canRest) return command('.休息', '失控中：净化用不了（没材料/已用过），改为休息');
  }

  // 3) 高风险时（完美主义/稳健）先降 MAD/COR 再冒进
  const cautious = ctx.profile.persona === 'perfectionist' || ctx.profile.persona === 'steady';
  if (cautious && (snapshot.mad >= 70 || snapshot.cor >= 60)) {
    const purifiedToday = snapshot.dailyCounters['purify'] ?? 0;
    if (snapshot.cor >= 60 && purifiedToday < NUMERIC.recovery.purify.dailyLimit) {
      return command('.净化', 'COR 偏高：先净化再继续');
    }
    const restedToday = snapshot.dailyCounters['rest'] ?? 0;
    if (snapshot.mad >= 70 && restedToday < NUMERIC.recovery.rest.dailyLimit) {
      return command('.休息', 'MAD 偏高：先休息再继续');
    }
  }

  /*
   * 2.5) M2.16：**教会** —— 入教（一次性）+ 捐献（贡献换档位）。
   *
   * 位置在失控恢复与「高风险先降 MAD/COR」之后、战斗与晋升链之前：
   * 教会是**长期线**，不该抢在「快失控了」或「有一场架没打完」前面。
   * 但它必须**存在** —— 虚拟玩家不发这两条指令的话，任务书 F 的
   * 「入教人数 ≥ 50%」与「church_rank_up ≥ 50」恒为 0，而 0 会被读成「功能没生效」。
   */
  const church = churchDecision(ctx, world, rng);
  if (church) return church;

  /**
   * 3.2) M2.9：**血量偏低先休息。**
   *
   * 为什么 M2.9 才需要这一条：不打架的时候，血低只是一个数字（探索掉血、失控掉血
   * 都会慢慢攒着）；而打架是**按当前血量打的** —— 实测抓到的两个后果：
   *   1. 带着二三十点血进场的人，第一回合就撞上「HP < 30% 就撤」，11 场里只有 1 回合；
   *   2. 侥幸打下去的人也撑不到把对手打出血，于是生物那些**依赖掉血**的行为
   *      （逃跑 / 暴走 / 求援 / 进化 / 装死）一个都触发不了。
   *
   * 真人的行为很清楚：**血少了先歇着**，而 `.休息` 就在他手边（每日 1 次、回 20）。
   * 这一条不改变任何数值，只是让虚拟玩家别拿半条命去打架。
   */
  const restUsed = snapshot.dailyCounters['rest'] ?? 0;
  if (
    snapshot.hp <= HEAL_BELOW_HP &&
    restUsed < NUMERIC.recovery.rest.dailyLimit &&
    ctx.lastRejected !== '休息'
  ) {
    return command('.休息', `血量 ${snapshot.hp} 偏低：先休息再继续`);
  }

  /**
   * 3.5) M2.5 干扰路径：群里看到「某处有人在举行仪式」之后，激进的人会去搅一把。
   *
   * 干扰是**每日 1 次 + 消耗圣盐**的决策（任务书 §4.3），所以这里也按决策来写：
   * 只有风险偏好够高、且手上真有圣盐的人才动手；失败要自己吃 COR +5。
   */
  if (
    (ctx.runningRituals?.length ?? 0) > 0 &&
    ctx.profile.riskAppetite > 0.5 &&
    has(snapshot, NUMERIC.interference.materialCost) >= NUMERIC.interference.materialQty &&
    rng.next() < 0.35
  ) {
    const victims = ctx.runningRituals!;
    const target = victims[Math.floor(rng.next() * victims.length)]!;
    return command(`.干扰 ${target}`, '干扰路径：有人在举行仪式，去搅一把');
  }

  /**
   * 3.6) M2.6 逃逸路径：被通缉了，而且人还在势力范围内 → 立刻往无主地点躲。
   *
   * 为什么排在覆盖率注入与目标链之前：对通缉犯来说这是**唯一理性的选择**。
   * 待在原地等于随时准备挨一次罚款或围剿。真人被盘查罚过一次款就会往灰雾之上跑。
   *
   * 注意它**只在"不在安全区"时触发** —— 逃到无主地点之后这条分支自然失效，
   * 玩家回到正常玩法。这正是任务书要验证的「逃到无主地点后不再被追捕」。
   */
  if (
    snapshot.wantedLevel > 0 &&
    !isInSafeZone(world, snapshot.currentLocationId) &&
    // 60% 才真的立刻跑。**不能是 100%**：一被通缉就秒逃的话，
    // 「势力范围内被盘查」这条路径在实例测试里永远走不到
    //（实测第一轮：签发 2 条通缉、遭遇判定 0 次，「有可疑人物出现」的播报一次都没发出来）。
    sideRng(ctx, 'flee').next() < 0.6
  ) {
    const refuge = pickRefuge(ctx, world, sideRng(ctx, 'flee-place'));
    if (refuge) {
      return command('.探索 ' + refuge, '逃逸路径：被通缉中（' + snapshot.wantedLevel + ' 级），撤到无主地点');
    }
  }

  /**
   * 3.7) M2.6 举报路径：知道谁被通缉 → 去治安官那里换赏金。
   *
   * 「不变强线」的收益来源（任务书 §主任务三）：情报贩子不靠晋升、不靠打怪，
   * 只靠"知道谁被通缉"就能赚钱。
   *
   * 只有风险偏好够高的人才干这事 —— 举报失败要自己吃信誉 -5，
   * 而目标是不是还待在势力范围内，举报的人**看不到**（只能赌）。
   * 这个「赌」正是失败路径在实例测试里必然出现的原因。
   */
  if (
    (ctx.wantedNames?.length ?? 0) > 0 &&
    ctx.profile.riskAppetite > 0.45 &&
    ctx.lastRejected !== '举报' &&
    sideRng(ctx, 'report').next() < 0.2
  ) {
    const names = ctx.wantedNames!;
    const target = names[Math.floor(sideRng(ctx, 'report-pick').next() * names.length)]!;
    return command('.举报 ' + target, '举报路径：有人在被通缉，去换赏金');
  }

  /**
   * 3.8) M2.6 犯罪路径：手痒的人会主动挑事 —— **这是 1 级通缉的唯一来源**。
   *
   * 三个前置条件都是必要的：
   *   - 自己没被通缉（wantedLevel === 0）：已经背着案子的人不再加罪，
   *     否则会形成「被通缉 → 更被通缉」的雪球，把长链路玩家的动作全吃掉；
   *   - 自己没重伤：重伤的人连站都站不稳（命令层也会拒）；
   *   - 风险偏好够高：这是有代价的动作（MAD +3 / COR +2，还会被通缉）。
   *
   * 概率 3%：20×3 的动作量（约 1000 条）下能稳定产出 10 次以上，
   * 又不会让"互相打进重伤"变成这个批次的主旋律。
   */
  if (
    ctx.profile.riskAppetite > 0.5 &&
    snapshot.wantedLevel === 0 &&
    snapshot.status !== 'injured' &&
    // 第 0 天的头几步大家都在建号，这时候打出去的目标多半还没角色
    //（实测：5 条 .袭击 全部回「找不到这个人：700004」）。
    (ctx.day > 0 || ctx.step > 10) &&
    sideRng(ctx, 'crime').next() < 0.05
  ) {
    return command(
      '.袭击 @' + pickAssaultTarget(ctx, sideRng(ctx, 'crime-target')),
      '犯罪路径：手痒，去挑事（目标按序列差挑过）',
    );
  }

  /**
   * 3.8b) M2.6.1 越级袭击**取证路径**：故意挑一个序列高到打不动的目标。
   *
   * 这条路径不是玩法，是取证。没有它，「序列差 ≥ 3 被拦」这条规则在实例测试里
   * 永远不会被触发 —— 上面那条犯罪路径会主动避开打不过的人，
   * 于是报告里的「被拦次数」永远是 0，等于这条规则没被验证过。
   *
   * 代价很低：被拦什么都不花（判定层认为"根本没动成手"），只占一个动作槽，
   * 所以概率可以给到 3%。
   */
  if (
    (ctx.peers?.length ?? 0) > 0 &&
    snapshot.wantedLevel === 0 &&
    snapshot.status !== 'injured' &&
    (ctx.day > 0 || ctx.step > 10)
  ) {
    const blockAt = NUMERIC.assault.sequenceGating.blockThreshold;
    const tooStrong = ctx.peers!.filter((peer) => snapshot.sequence - peer.sequence >= blockAt);
    if (tooStrong.length > 0 && sideRng(ctx, 'overreach').next() < 0.03) {
      const picked = tooStrong[Math.floor(sideRng(ctx, 'overreach-pick').next() * tooStrong.length)]!;
      return command('.袭击 @' + picked.userId, '越级袭击：验证序列差拦截（取证路径）');
    }
  }

  // 4) 覆盖率注入：低概率执行稀有指令，保证每条指令都被真实打到。
  //    走长链路的画像（promote 目标）注入概率更低，避免关键动作被巡检吃掉。
  const injectionRate = ctx.profile.goal === 'promote' ? 0.06 : 0.15;
  if (rng.next() < injectionRate) {
    const injected = coverageDecision(ctx, world, rng);
    if (injected) return injected;
  }

  // 5) 目标链：目标在一场会话（一次登录）内保持稳定，跨会话才可能漂移。
  //    真人不会每条指令换一个目标——逐条掷骰会把长链路切得七零八落，
  //    也会把耐心参数的真实含义（「这个人能不能坚持一个目标」）糊掉。
  const sessionRng = createSeededRng(seedFrom([ctx.profile.seed, 'goal', ctx.day, ctx.login]));
  const goal = sessionRng.next() < ctx.profile.patience ? ctx.profile.goal : driftGoal(sessionRng);
  switch (goal) {
    case 'promote':
      return promoteChain(ctx, world, rng);
    case 'explore':
      return exploreChain(ctx, world, rng);
    case 'social':
      return socialChain(ctx, world, rng);
    case 'casual':
    default:
      return casualChain(ctx, rng, world);
  }
}

/**
 * 独立随机源（M2.6）。
 *
 * **M2.6 新增的三条路径绝不能消费主 rng**：主 rng 是「同一 seed → 同一条决策流」的载体，
 * 在里面插一次 next()，后面所有决策（目标链 / 覆盖率注入 / 各类链）拿到的都是错位后的值，
 * 整个行为分布会跟着漂。
 *
 * 这不是理论担忧 —— 实测（20×3，seed=smoke，与 M2.5 基线同 seed）：
 * 三条新路径各插了一次推进之后，.交易 从 53 笔掉到 19 笔、.确认 17 → 11。
 * 行为分布整体位移会让「与上一轮逐项对比」这件事直接失效。
 * 所以每条新路径各自派生一个只属于自己的随机源，主 rng 一步不动。
 */
function sideRng(ctx: DecisionContext, tag: string): { next(): number } {
  // login 也要拌进去：只用 (day, step) 的话，同一个玩家"每天同一时刻"会得到同一个随机数，
  // 于是每次都挑中同一个目标 —— 实测第一轮：5 次袭击全部指向 @700004，
  // 前两次把他打成重伤，后三次全部撞「已经倒下了」，11 次袭击只签发 1 条通缉。
  return createSeededRng(seedFrom([ctx.profile.seed, tag, ctx.day, ctx.login, ctx.step]));
}

/**
 * 找一个和自己不同的玩家 QQ，随机源由调用方给。
 *
 * otherUserId() 用的是 rngFor(ctx)，而 rngFor 的种子只含 (day, step) ——
 * 同一个时刻的多个调用点拿到的是同一个值。交易场景无所谓（目标重复最多是挂两笔单），
 * 但袭击场景是致命的：重复打同一个人，第二次就把人打进重伤，之后全是空转。
 */
function otherUserWithRng(ctx: DecisionContext, rng: { next(): number }): string {
  const base = 700000;
  const size = Math.max(2, ctx.profile.fleetSize || 2000);
  const current = Number(ctx.profile.userId) - base;
  const offset = 1 + Math.floor(rng.next() * Math.min(12, size - 1));
  return String(base + ((current + offset) % size));
}

/**
 * M2.6.1：挑一个「打了有胜算」的袭击目标。
 *
 * 序列差决定一切（见 domain/wanted/assault.ts）：弱 3 级直接不可行、
 * 弱 1—2 级命中率掉到 20% / 8%。真人当然挑打得过的下手，虚拟玩家按同一条逻辑挑 ——
 * 否则「被拦」会占满统计，而"命中"这一类样本会少到看不出东西。
 *
 * 挑不到合适的（同批里没有可打的）才退回 otherUserWithRng 的盲选。
 */
function pickAssaultTarget(ctx: DecisionContext, rng: { next(): number }): string {
  const peers = ctx.peers ?? [];
  if (peers.length === 0) return otherUserWithRng(ctx, rng);
  const mine = ctx.snapshot.sequence;
  const blockAt = NUMERIC.assault.sequenceGating.blockThreshold;
  const reachable = peers.filter((peer) => mine - peer.sequence < blockAt);
  if (reachable.length === 0) return otherUserWithRng(ctx, rng);
  // 优先"打得过或差不多"的：不弱于对方，或只弱 1 级
  const favorable = reachable.filter((peer) => mine - peer.sequence <= 1);
  const pool = favorable.length > 0 ? favorable : reachable;
  return (pool[Math.floor(rng.next() * pool.length)] ?? pool[0]!).userId;
}

/** M2.6：这个地点是不是无主地点（安全区）。没有位置记录时按「不知道」处理（不算安全） */
function isInSafeZone(world: WorldKnowledge, locationId: string | null): boolean {
  if (!locationId) return false;
  const location = world.locations.find((entry) => entry.id === locationId);
  if (!location) return false;
  return world.safeLocationNames.includes(location.name);
}

/**
 * 挑一个今天还能去的无主地点躲。
 *
 * 三个过滤条件缺一不可：
 *   1. 序列够得着（灰雾之上要序列 8 —— 新号躲不进去，这一条必须挡住，
 *      否则会打出一条必然被拒的 .探索）；
 *   2. 这个地点今天还没到达每日上限；
 *   3. 优先没去过的（真人也倾向于躲到一个"没人认识自己"的新地方）。
 */
function pickRefuge(
  ctx: DecisionContext,
  world: WorldKnowledge,
  rng: { next(): number },
): string | null {
  const snapshot = ctx.snapshot;
  const reachable = world.safeLocationNames.filter((name) => {
    const location = world.locations.find((entry) => entry.name === name);
    if (!location) return false;
    if (!(snapshot.sequence <= location.minSeq && snapshot.sequence >= location.maxSeq)) return false;
    const id = world.locationIdByName[name];
    const used = id ? (snapshot.exploreCounts[id] ?? 0) : 0;
    // ⚠️ 这是**模拟玩家的自律**（一天探三次就收手），不是机制限制 —— 每日次数已是软上限
    return used < NUMERIC.explore.dailyCapPerLocation;
  });
  if (reachable.length === 0) return null;
  const fresh = reachable.filter((name) => !ctx.visitedLocations.has(name));
  const pool = fresh.length > 0 ? fresh : reachable;
  return pool[Math.floor(rng.next() * pool.length)] ?? pool[0] ?? null;
}

/** 耐心不足时目标漂移（混乱型行为的主要来源） */
function driftGoal(rng: { next(): number }): DecisionContext['profile']['goal'] {
  // 漂移不是均匀的：没耐心的玩家更可能去瞎逛探索，而不是原地挂交易
  const pool: Array<{ goal: DecisionContext['profile']['goal']; weight: number }> = [
    { goal: 'promote', weight: 1 },
    { goal: 'explore', weight: 3 },
    { goal: 'social', weight: 2 },
    { goal: 'casual', weight: 2 },
  ];
  const total = pool.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = rng.next() * total;
  for (const entry of pool) {
    roll -= entry.weight;
    if (roll < 0) return entry.goal;
  }
  return 'casual';
}

/**
 * promote 链：建号 → 凑材料 → 调制 → 服用 → 刷消化度 → 备晋升材料 → 晋升。
 *
 * 这是 W7 的核心被验证对象（要求 200 人里至少 50 人走完序列 9 → 8），
 * 所以每一步都按「有目标、有耐心、会算账的玩家」来决策：
 *   1) 晋升成功率公式里 MAD/COR 是负项 → 压线时先休息/净化，而不是硬顶；
 *   2) 消化度的两条来源里，.服用 一次 +6（快，但要材料 + 6 疯狂），.扮演 一次约 +0.3—0.6（慢，但不耗任何稀缺资源）；
 *   3) 材料是唯一稀缺资源，所以只在「真的缺」的时候才去探索；
 *   4) 材料齐了先调一瓶喝掉，消化度达标后再攒晋升要的主材料 ×2。
 */
function promoteChain(ctx: DecisionContext, world: WorldKnowledge, rng: { next(): number }): Decision {
  const snapshot = ctx.snapshot;

  /*
   * 4.0 M2.12：**判据从「序列号」换成「有没有对应当前序列的配方」。**
   *
   * M2.9—M2.11 这里写的是「sequence < 9 就转去探索」，理由当时是对的：
   * 内容表里只有序列 9 的配方，升到序列 8 之后确实没有下一段了。
   * 序列 8→7 上线之后，那句话会把所有刚升到 8 的玩家立刻赶去闲逛 ——
   * 而他们本该继续往上爬。换成按配方判断之后，链路自动多出一段，
   * 再往上加内容（序列 6、5……）时这里也不用再改。
   */
  const recipe = recipeOf(world, ctx);
  if (snapshot.sequence < 9 && !recipe) return postPromotionChain(ctx, world, rng);
  const restUsed = snapshot.dailyCounters['rest'] ?? 0;
  const purifyUsed = snapshot.dailyCounters['purify'] ?? 0;
  const canRest = restUsed < NUMERIC.recovery.rest.dailyLimit;
  const canPurify =
    purifyUsed < NUMERIC.recovery.purify.dailyLimit &&
    has(snapshot, '辅助材料·圣盐') > 0;
  /**
   * M2.13 前置 4：**发 `.扮演` 之前过同一道守卫**（见 `playIsPointless`）。
   *
   * M2.5 起这里有一条 `dig >= 100 → busywork`，但它**只覆盖这一条分支**
   * —— 下面 §4.4 的「等着」与 casualChain 的三条都绕过了它。
   * 守卫收进这个局部函数之后，`promoteChain` 里两处发出点自动都受保护。
   */
  const play = (reason: string): Decision =>
    playIsPointless(ctx)
      ? // 消化度满了：先看有没有「必须要做的事」，没有就转去做点别的（M2.5 的 busywork）
        (idleDecision(ctx, world, reason + '（消化度已经满了，再扮演也不会有任何变化）') ??
        busywork(ctx, world, reason + '：消化度已经满了，做点别的'))
      : command(`.扮演 ${playTextAt(ctx.profile.pathway, ctx.playsToday)}`, reason);

  if (!recipe) return exploreChain(ctx, world, rng);

  // 4.1 压线了先降 MAD / COR（晋升成功率 = 0.7 + 0.2×DIG - 0.05 - 0.3×MAD - 0.15×COR）
  const madLimit = PLAYER_MODEL.madRestAt[ctx.profile.persona] ?? 70;
  const corLimit = PLAYER_MODEL.corPurifyAt[ctx.profile.persona] ?? 60;
  const drinkLimit = PLAYER_MODEL.madDrinkLimit[ctx.profile.persona] ?? 70;
  if (snapshot.mad >= madLimit && canRest) {
    return command('.休息', `链路：疯狂 ${snapshot.mad} 到线了，先休息（晋升判定里 MAD 是负项）`);
  }
  if (snapshot.cor >= corLimit && canPurify) {
    return command('.净化', `链路：污染 ${snapshot.cor} 到线了，先净化（70 以上还会被注视）`);
  }

  // 4.2 手里有魔药 → 服用（+6 消化度；疯狂太高就先压一压再喝）
  if (has(snapshot, recipe.productItemId) > 0) {
    if (snapshot.mad >= drinkLimit && canRest) {
      return command('.休息', '链路：疯狂偏高，缓一缓再服用');
    }
    return command(`.服用 ${recipe.productItemId}`, '链路：手里有魔药，先服用（一次 +6 消化度）');
  }

  /*
   * M2.12：消化度门槛**不是一个定值** —— 序列 9→8 要 60，序列 8→7 要 80……
   *
   * **M2.33（P4 落地）：改成直接调判定层的 `digThresholdFor`。**
   * 原来这里**抄了一份两档分支**（`recipe.seq <= sequence7.recipeSeq ? 80 : 60`），
   * 注释写着「与判定层同源」—— 但那是**人工保证的同源**：
   * P4 把门槛改成五档阶梯（60/80/85/90/95）之后，这一份**不会跟着变**，
   * 而症状极其隐蔽：vplayer 会按旧值磨到 80 就停手，然后反复撞「消化度不足（需要 85）」
   * ——跑批报告里只表现为「高序列晋升停滞」，**没有断言会红**（K18 的形状：一端有人守、另一端没有）。
   * ⇒ 现在它是**真的同源**：同一个函数，改阶梯只有一处。
   */
  const target = digThresholdForSeq(recipe.seq) + (PLAYER_MODEL.digBuffer[ctx.profile.persona] ?? 0);

  // 4.25 需要净化但没有圣盐 → 先去能掉圣盐的地方（玩家会为此专门跑一趟）
  if (
    snapshot.cor >= corLimit &&
    purifyUsed < NUMERIC.recovery.purify.dailyLimit &&
    !has(snapshot, '辅助材料·圣盐')
  ) {
    const spot = locationFor(ctx, world, '辅助材料·圣盐', snapshot.sequence, ctx.visitedLocations);
    if (spot) return command(`.探索 ${spot}`, '链路：污染高但要净化得先有圣盐');
  }

  // 4.3 消化度没到位。材料是唯一稀缺资源（M2.85 起行动值已移除），所以要分两个阶段花：
  //     阶段一（离达标还远）：主材料到手就调成魔药喝掉——一瓶 +6 消化度，比 10 次扮演还快；
  //     阶段二（下一次服用就能达标）：停手攒晋升要的主材料 ×2，别再吃掉它。
  //     反过来的做法（一直留着晋升储备）会让前期一瓶药都喝不上，达标被拖到第 6—7 天。
  if (snapshot.dig < target) {
    const nearTarget = snapshot.dig + NUMERIC.potion.digOnDrink >= target;
    const stock = nearTarget
      ? recipe.main.map((need) => ({
          itemId: need.itemId,
          qty: need.qty * NUMERIC.promotion.mainMaterialMultiplier,
        }))
      : [...recipe.main, ...recipe.aux];
    const missingStock = missingMaterial(world, ctx, stock);
    if (missingStock) {
      const spot =
        locationFor(ctx, world, missingStock, snapshot.sequence, ctx.visitedLocations) ??
        bestExploreLocation(world, ctx, rng);
      if (spot) {
        return command(
          `.探索 ${spot}`,
          nearTarget
            ? `链路：DIG ${snapshot.dig.toFixed(1)} 快达标了，把晋升要的 ${missingStock} 挖够`
            : `链路：缺 ${missingStock}，挖回来调一瓶（+6 消化度）`,
        );
      }
    }
    const brewReady = missingMaterial(world, ctx, [...recipe.main, ...recipe.aux]) === null;
    if (!nearTarget && brewReady && snapshot.mp >= NUMERIC.potion.mpCost) {
      return command(`.魔药 ${recipe.id}`, `链路：DIG ${snapshot.dig.toFixed(1)} < ${target}，材料齐了先调一瓶`);
    }
    // 消化度已经顶到上限：再扮演也不会有任何变化，转去做点别的（否则就是空转）
    if (snapshot.dig >= 100) return busywork(ctx, world, '链路：消化度已经满了，做点别的等明天');
    if (ctx.playsToday < PLAYER_MODEL.maxPlaysPerDay) {
      return play(`链路：DIG ${snapshot.dig.toFixed(1)} < ${target}，用扮演推消化度`);
    }
    return command('.状态', `链路：今天扮演已满 ${PLAYER_MODEL.maxPlaysPerDay} 次（标签上限到了也不涨），等明天`);
  }

  // 4.4 消化度达标 → 备齐晋升材料（主材料 ×2）→ 晋升
  const mainNeed = recipe.main.map((need) => ({
    itemId: need.itemId,
    qty: need.qty * NUMERIC.promotion.mainMaterialMultiplier,
  }));
  const missingForPromotion = missingMaterial(world, ctx, mainNeed);
  if (missingForPromotion) {
    const spot =
      locationFor(ctx, world, missingForPromotion, snapshot.sequence, ctx.visitedLocations) ??
      bestExploreLocation(world, ctx, rng);
    if (spot) return command(`.探索 ${spot}`, `链路：晋升还缺 ${missingForPromotion}`);
    if (snapshot.dig >= 100) return busywork(ctx, world, '链路：消化度已经满了，做点别的');
    return play('链路：先扮演攒消化度（晋升材料还没挖够）');
  }
  /**
   * M2.5：两条晋升路径的对照实验（任务书 §8）。
   * 偶数号走\u0020.仪式（高投入高回报，但有被打断的风险），奇数号走 .晋升（快速通道）。
   * 仪式路径是三步状态机，状态直接由快照里的两个布尔驱动，不需要额外记忆：
   *   没有准备态 → 先挑地点（灰雾之上 +15%，是配置里最高的一档）
   *   有准备态   → .仪式 开始（阶段 1/2）
   *   有 running → .仪式 融合（阶段 3）
   */
  if (ctx.profile.id % 2 === 0) {
    if (snapshot.ritualRunning) {
      return command('.仪式 融合', '仪式路径：融合（阶段 3）');
    }
    // 有准备态**且已经挑了地点**才能开始；否则回去挑地点（不然会被服务端连拒）
    if (snapshot.ritualPreparing && snapshot.ritualLocationId) {
      return command('.仪式 开始', '仪式路径：开始（阶段 1/2）');
    }
    return command('.仪式 地点 灰雾之上', '仪式路径：先挑地点（灰雾之上 +15%）');
  }
  return command('.晋升', `链路：DIG ${snapshot.dig.toFixed(1)} ≥ ${target}、材料齐备，发起晋升`);
}

/**
 * M2.13：**「借来的强」** —— 什么时候该动封印物。
 *
 * 判据只有一条：**序列差**。见 battleDecision 里那一段的注释。
 *
 * 为什么要单独一个函数而不是写在 battleDecision 里：`.袭击` 那条路
 * （domain：resolveAssault）用的是同一套判据，而它不在战斗状态机里 ——
 * 两处各写一遍「gap ≥ 3 才用封印之刃」是这类规则最容易漂的地方。
 *
 * @returns 用哪一件（null = 这一回合不用）
 */
/**
 * M2.13：背包里有没有**改变胜负的那两件**（封印之刃 / 命运骰子）。
 *
 * 刻意不写成「有没有任何封印物」：灰雾之眼（看信息）等不改变胜负的封印物，
 * 带着它们去动手是送死 —— 那不是「借来的强」，是「借来的一双眼睛」。
 */
export function hasBorrowedPower(snapshot: { inventory: ReadonlyArray<{ itemId: string; quantity: number }> }): boolean {
  return snapshot.inventory.some(
    (slot) =>
      slot.quantity > 0 && (slot.itemId === 'sealed_blade' || slot.itemId === 'sealed_fate_dice'),
  );
}

export function borrowedPowerChoice(input: {
  playerSequence: number;
  targetSequence: number;
  cor: number;
  mad: number;
  inventory: ReadonlyArray<{ itemId: string; quantity: number }>;
}): string | null {
  /*
   * ==================================================================
   * ⚠️ **序列号越小越强** —— 这一位的减法方向在 M2.13 里写反了
   * ==================================================================
   *
   * `gap = playerSequence − targetSequence`：**正数 = 对方比我强**。
   *
   * ## M2.13 写的是 `targetSequence − playerSequence`，后果是两头都错
   *
   * | 场景 | 真值 | 写反之后的 gap | 结果 |
   * | --- | --- | --- | --- |
   * | **PVE**：序列 9 玩家打序列 8 生物（对手更强） | 应触发 | `8 − 9 = −1` | **从不触发** |
   * | **PVP**：序列 7 玩家打序列 8 对手（对手**更弱**） | 不该触发 | `8 − 7 = +1` | **反向触发**（白用一件） |
   *
   * 这就是 200×30 里「封印物使用 0 次」的真因 —— 不是样本量：
   * 取证脚本（`scripts/m2-13-1-borrowed-power-trace.ts`）数出来的漏斗是
   * `L0 战斗回合 1018 → L1 那一刻手里有那两件 8 → L2（正确口径）8 / L2'（写反的口径）0`。
   * **8 次机会，一次都没被认出来。**
   *
   * 而同一条错误在 M2.13 里**已经犯过一次**（`borrowedPowerHunt` 取 max 找的是
   * 「可能有更弱生物的地方」）—— 那一次修了，这一次没连带检查。
   * 所以这一段的写法刻意与 M2.6.1 的 `diff` 反号，并把两个方向都写出来。
   */
  const gap = input.playerSequence - input.targetSequence;
  if (gap <= 0) return null;
  const has = (id: string): boolean =>
    input.inventory.some((slot) => slot.itemId === id && slot.quantity > 0);

  // gap ≥ 3：被拦死的那一档，只有封印之刃有用（命运骰子对它一点帮助都没有）
  if (gap >= 3) {
    return has('sealed_blade') && input.cor < 80 ? 'sealed_blade' : null;
  }
  // gap 1—2：先封印之刃（必中），再命运骰子（重抽一次）
  if (has('sealed_blade') && input.cor < 80) return 'sealed_blade';
  if (has('sealed_fate_dice') && input.mad < 80) return 'sealed_fate_dice';
  return null;
}

/**
 * M2.13：**「去有更强生物的地方」** —— 有封印物时的第一步。
 *
 * 与 `borrowedPowerChoice` 是同一件事的两半：
 *   这一半决定「**去哪**」（在战斗之外，还没遇到东西的时候）；
 *   那一半决定「**用什么**」（已经打起来了的时候）。
 * 分开写是因为它们的输入完全不同（一个有战斗状态，一个没有），
 * 而判据是同一条：**序列差**。
 *
 * @returns 去哪探索（null = 不去 / 没得去）
 */
function borrowedPowerHunt(
  ctx: DecisionContext,
  world: WorldKnowledge,
  rng: { next(): number },
): Decision | null {
  const snapshot = ctx.snapshot;
  if (!hasBorrowedPower(snapshot)) return null;
  if (snapshot.status === 'injured') return null;
  if (snapshot.hp < FIGHT_MIN_HP) return null;

  const targets = nearbyLocations(ctx, world).filter(
    (location) =>
      snapshot.sequence <= location.minSeq &&
      snapshot.sequence >= location.maxSeq &&
      explorableToday(ctx, world, location.name) &&
      // ⚠️ 小于号：**序列号越小越强**。「那里有比我强的生物」= 那里有序列号更小的物种
      (world.locationCreatureSequences[location.id] ?? 99) < snapshot.sequence,
  );
  if (targets.length === 0) return null;
  // 优先没去过的（真人也是先挑没走过的那条路），全都去过了就轮着来
  const fresh = targets.filter((location) => !ctx.visitedLocations.has(location.name));
  const pool = fresh.length > 0 ? fresh : targets;
  const picked = pool[Math.floor(rng.next() * pool.length)] ?? pool[0]!;
  return command(
    '.探索 ' + picked.name,
    '封印物：手里有借来的强，去' + picked.name + '碰碰（那里可能有序列更高的东西）',
  );
}

/**
 * 把「该用哪一件」翻成一个战斗动作。
 *
 * 两条路径都要成立（与 M2.3 / M2.8 / M2.9 同一条纪律）：
 *   菜单路径 —— 回数字（战斗菜单里有「物品 <名>」这一项）
 *   完整指令 —— 发 `.战斗 物品 <名>`
 */
function borrowedPower(
  ctx: DecisionContext,
  battle: NonNullable<DecisionContext['snapshot']['activeBattle']>,
): Decision | null {
  const choice = borrowedPowerChoice({
    playerSequence: ctx.snapshot.sequence,
    targetSequence: battle.creatureSequence,
    cor: ctx.snapshot.cor,
    mad: ctx.snapshot.mad,
    inventory: ctx.snapshot.inventory,
  });
  if (!choice) return null;
  const gap = battle.creatureSequence - ctx.snapshot.sequence;
  const why =
    '封印物：' +
    battle.speciesName +
    ' 序列 ' +
    battle.creatureSequence +
    '、我序列 ' +
    ctx.snapshot.sequence +
    '（差 ' +
    gap +
    '）—— 用 ' +
    choice;
  const menuOption = ctx.pendingMenu?.options.find((option) => option.command.includes(choice));
  if (ctx.menuPath === true && menuOption) {
    return { command: menuOption.key, reason: why, menuPath: true };
  }
  return command('.战斗 物品 ' + choice, why);
}

/**
 * M2.13 前置 4：**「现在再扮演一次也不会有任何变化」** —— 这一条判据只有一个出处。
 *
 * ## 为什么单独抽出来
 *
 * M2.9 把这条保护加进了**菜单打分表**（`menuScore`：DIG 满 / 当日扮演到顶 → 扮演记 0 分），
 * 但**完整指令路径**一直只有 `promoteChain` 里那一处（`dig >= 100`）——
 * 而 `.扮演` 在完整指令路径上有**五个**发出点（promoteChain 两处 + casualChain 三处）。
 * M2.10 与 M2.11 的 P1 都是同一个形状：
 *
 *   玩家在 PVP 里等对手出招（这是对的，真人也会）
 *     → 他连着发 .扮演，而 DIG 已经满了 → 状态不变
 *     → noChangeStreak 累积到 10 → P1
 *
 * M2.11 的交付说明里已经写清落点是「**DIG 满了就别再扮演这条保护要覆盖完整指令路径**」，
 * M2.12 没做。这一条就是它：**所有发出点走同一个守卫**，而不是再补一个 if。
 *
 * ⚠️ **这不是改异常判定**：`NO_CHANGE_STREAK` 的阈值一个数都没动
 * （`test/numeric-freeze.test.ts` 与 `test/m2-13.test.ts` 都守着它）。
 * 改的是虚拟玩家自己的行为 —— 真人不会在消化度满了之后一直扮演。
 *
 * 两个计数都要看，因为它们回答的是同一件事的两种读法：
 *   `dig >= 100` 是**服务端**的消化度上限（再扮演 computeDigNext 也只会停在 100）；
 *   `dailyCounters.play` 与 `ctx.playsToday` 是**当日扮演次数**的两种记法
 *   （前者是服务端流水，后者是这次跑批里自己数出来的），任一到达上限就都不会再涨。
 */
export function playIsPointless(ctx: DecisionContext): boolean {
  const snapshot = ctx.snapshot;
  return (
    snapshot.dig >= 100 ||
    (snapshot.dailyCounters['play'] ?? 0) >= PLAYER_MODEL.maxPlaysPerDay ||
    ctx.playsToday >= PLAYER_MODEL.maxPlaysPerDay
  );
}

/**
 * M2.13 前置 4：**等待 / 无事可做时做有意义的事**（不是空转）。
 *
 * 三个调用点，都是「玩家此刻没有更好的事可做」：
 *   1. PVP 等待期（对面还没出招）—— **主要落点**；
 *   2. 消化度满了 / 当日扮演到顶，但 `promoteChain` 还想发 `.扮演`；
 *   3. `casualChain` 的三条「随手扮演」（它们原来一条保护都没有）。
 *
 * 四档按任务书 §4.2 的顺序，每一档都是**真的会改变状态或真的有信息量**的动作：
 *   未决遭遇 → 处置它（它是个未决状态，不会自己消失）；
 *   背包里有能用的消耗品 → 用一件（回血回灵性，都是战斗里用得上的）；
 *   HP 低于 50 → 休息；
 *   否则 → `.状态`。
 *
 * ⚠️ `.状态` 是**纯读指令**，不在 `ACTION_COMMANDS` 里 ——
 * 所以它既不会累积 `noChangeStreak`，也不会被记成 P1。
 * 这正是「至少是一个有信息量的动作」的落点：玩家在看自己的血量与等待还差多久。
 */
function idleDecision(
  ctx: DecisionContext,
  world: WorldKnowledge,
  reason: string,
): Decision | null {
  const snapshot = ctx.snapshot;

  /*
   * 0) **在路上的时候什么都别做**（M2.13 补）。
   *
   * 服务端在途只放行查看类指令与 .移动 —— 发 .休息 / .使用 都会被一句
   * 「你还在路上，做不了这件事。」挡回来。而那句话**不在 isRejected 的词表里**，
   * 于是 noChangeStreak 一路涨到 10。
   *
   * 实测：200×30 的 P1 一共 3 条，全部是它（一个在去贝克兰德路上的玩家，
   * HP 35，等待期连发了十几次 .休息）。**这一档本该由 decide 的 0.6 分支兜住**，
   * 但等待期（0.55）排在它前面 —— 顺序上的一个疏忽。
   */
  if (snapshot.traveling === true) return null;

  // 1) 未决遭遇：那只生物还站在那里，先处置它
  if (snapshot.pendingSighting === true) {
    return command('.遭遇 观察', reason + '：还有一只生物没处置，先看它一眼');
  }

  /*
   * 2) 背包里有能用的消耗品 → 用一件（只在状态不满时，否则是浪费）。
   *
   * ⚠️ **两类要排除，都是有实测依据的**：
   *   1. `符咒·*`（M2.9 的三件）—— 它们是**战斗专用**的（battle 字段），
   *      平时用只会得到「现在用不上」；
   *   2. `charm_*`（M2.13 的三件）—— 它们是**一次性牌**，而且
   *      **有的还需要参数**（传送符要地点名）。第一版没排除，200×30 的实测结果是：
   *      `.使用 charm_teleport`（不带地点）连着发，服务端回的是「要去哪？用法：……」——
   *      那句话**不是拒绝**，所以 noChangeStreak 一路涨到 10，
   *      **P1 一共 59 条，全部来自这一条指令**。
   *
   *      这条教训值得写下来：「凭空多发一条指令」和「这条指令会不会被算成拒绝」
   *      是两件事 —— 用法提示类回执既没有改变状态、也不在 isRejected 的词表里。
   */
  const usableItem = snapshot.inventory.find(
    (slot) =>
      slot.quantity > 0 &&
      world.itemKinds[slot.itemId] === 'consumable' &&
      !slot.itemId.startsWith('符咒') &&
      !slot.itemId.startsWith('charm_'),
  );
  if (usableItem && (snapshot.hp < 80 || snapshot.mad >= 40)) {
    return command(
      '.使用 ' + usableItem.itemId,
      reason + '：背包里有' + usableItem.itemId + '，用一件',
    );
  }

  // 3) 血量偏低 → 休息（一次回 20 点，是把下一场架打得起来的前提）
  const restUsed = snapshot.dailyCounters['rest'] ?? 0;
  if (
    snapshot.hp < FIGHT_MIN_HP &&
    restUsed < NUMERIC.recovery.rest.dailyLimit &&
    ctx.lastRejected !== '休息'
  ) {
    return command('.休息', reason + '：HP ' + snapshot.hp + ' 偏低，先歇一会儿');
  }

  /*
   * ==================================================================
   * 三档都没有 → **返回 null，让调用方继续走正常的目标链**（不是接管）
   * ==================================================================
   *
   * 这一条是被 200×30 逼出来的，两版都错在同一个方向：
   *
   *   **第一版**：等待期一律 `.状态`。结果是 20×3 的三栏判定里
   *   货币 / 通缉 / 袭击三项同时从「有数据」掉成 0 —— 等待期把玩家从社交里挤出去了。
   *
   *   **第二版**：改成 busywork（挂交易 / 组队 / 占卜 / 翻背包）。
   *   社交回来了，但 200×30 的**晋升进度腰斩**：序列 7 从 33 人掉到 15 人，
   *   advantage 从 30 次掉到 12 次。因为等待期**占掉了当天的动作额度**，
   *   而 M2.12 的等待期是走完整目标链的（继续探索 / 调魔药 / 刷消化度）。
   *
   * **两版都漏了同一件事：等待期该做的不是「另一个动作」，是「别的动作照旧」。**
   * 真人不会因为对面还没出招就改去翻背包 —— 他会接着干自己的事。
   *
   * 那「空转」是怎么被挡住的？**在 `.扮演` 的发出点上**（`playIsPointless`），
   * 不在等待期这一段。这才是 M2.11 写下的那个落点。
   */
  return null;
}

/**
 * 「今天没事可做了」时干什么：消化度顶满之后，
 * 再刷扮演不会有任何变化（会被卡死检查记成 P1），真人这时候会去交易、组队、占卜。
 */
function busywork(ctx: DecisionContext, world: WorldKnowledge, reason: string): Decision {
  // ⚠️ 最后一档（翻背包）**必须留着**：M2.5 起 busywork 就总会给出一个动作，
  //    而它的调用点（promoteChain 的「DIG 满了」）依赖这一点。行为一个字节都没改。
  return busyworkOrNull(ctx, world, reason) ?? command('.背包', `${reason}：翻翻背包`);
}

/**
 * M2.13 前置 4：busywork 的「有得做才返回」版本。
 *
 * 与 `busywork` 的区别只有一处：**没有可做的事时返回 null 而不是翻背包**。
 * 为什么要多这一个函数：等待期需要的正是这个形状 ——
 * 「有事就做，没事才安心地发一条 `.状态`」。
 * 直接调 `busywork` 的话，「没事」也会被它兜成一條动作，
 * 于是 `.状态` 那一档永远到不了，而等待期的动作分布会全被「翻背包」吃掉。
 */
function busyworkOrNull(
  ctx: DecisionContext,
  world: WorldKnowledge,
  reason: string,
): Decision | null {
  const snapshot = ctx.snapshot;
  const item = tradeableItem(snapshot, world);
  if (item && snapshot.pendingTradeCount < 3) {
    return tradeDecision(ctx, otherUserId(ctx), item.itemId, 5, `${reason}：挂一笔交易`);
  }
  if (snapshot.partyId === null) {
    if (ctx.knownParties.length > 0) return joinKnownParty(ctx, `${reason}：加入群里公告过的队伍`);
    return command('.队伍 创建', `${reason}：建个队`);
  }
  /*
   * 占卜那一档的两道前置（M2.13 前置 4 补的）：
   *   1. **普通人不能占卜** —— 服务端的 mortalGuard 会回「你手上没有任何能用来占卜的东西」。
   *      等待期会走到这条链上的普通人不少（他可以被人挑战），
   *      不筛这一条的话，实测 20×3 里 `.占卜` 被拒 **142 次**；
   *   2. **今天的次数用完就不再占** —— 每日上限是 3（愚者序列 8 与水景另有加成），
   *      而 `lastRejected` 只记得**上一条**指令：中间夹一条别的，它就清空了。
   *
   * 这与 M2.9 写在 decide 里的那条纪律同源：「三个『必被拒』的条件都要提前筛掉，
   * 否则他会一路撞墙」。
   */
  const divinedToday = snapshot.dailyCounters['divination'] ?? 0;
  if (
    snapshot.mortal !== true &&
    snapshot.mp >= NUMERIC.divination.mpCost &&
    divinedToday < NUMERIC.divination.dailyLimit &&
    ctx.lastRejected !== '占卜'
  ) {
    return command('.占卜 我接下来该做什么', `${reason}：占一卦`);
  }
  return null;
}

/** 走完序列 8 之后：MVP 没有下一段配方，玩家会去踩新开放的地点 */
function postPromotionChain(ctx: DecisionContext, world: WorldKnowledge, rng: { next(): number }): Decision {
  const snapshot = ctx.snapshot;
  const opened = nearbyLocations(ctx, world).filter(
    (location) =>
      snapshot.sequence <= location.minSeq &&
      snapshot.sequence >= location.maxSeq &&
      explorableToday(ctx, world, location.name) &&
      !ctx.visitedLocations.has(location.name) &&
      location.minSeq < 9,
  );
  if (opened.length > 0) {
    const target = opened[Math.floor(rng.next() * opened.length)]!;
    return command(`.探索 ${target.name}`, '序列 8：新开放的地点，先去踩点');
  }
  return exploreChain(ctx, world, rng);
}

/**
 * M2.7 移动链：跨城市。
 *
 * 三条约束，每一条都对应一个真实的服务端规则：
 *   1. **约 1/7 的玩家才有远行的念头**（id 派生，确定性）——
 *      任务书要求「至少 10% 的虚拟玩家会尝试跨城市移动」，而 200 人里 1/7 ≈ 28 人；
 *   2. **只走负担得起的路线**，且优先走能负担的**最贵**那条 ——
 *      短轮里这只会选中 20—30 便士的陆路，长跑里攒够了就会自己走上跨海航线；
 *   3. **M2.85 起移动不再消耗行动点** —— 只剩下金钱与序列门槛两道约束。
 */
function travelDecision(
  ctx: DecisionContext,
  world: WorldKnowledge,
  rng: { next(): number },
): Decision | null {
  const snapshot = ctx.snapshot;
  const cityId = snapshot.currentCityId;
  if (!cityId) return null;
  if (ctx.profile.id % 7 !== 0) return null;
  // 不是每一步都想着远行（同一天里几次登录各掷一次）
  if (rng.next() > 0.3) return null;
  const wallet = snapshot.inventory
    .filter((slot) => slot.itemId === '便士')
    .reduce((sum, slot) => sum + slot.quantity, 0);
  const routes = world.routes
    .filter((route) => route.from === cityId && route.costPenny <= wallet)
    .sort((a, b) => b.costPenny - a.costPenny || a.id.localeCompare(b.id));
  const pick = routes[0];
  if (!pick) return null;
  const name = world.cityNames[pick.to];
  if (!name) return null;
  return command(`.移动 ${name}`, `移动链：带上 ${pick.costPenny} 便士去${name}`);
}

/** explore 链：优先没去过的地点 → 事件 → 背包塞满就交易 */
function exploreChain(ctx: DecisionContext, world: WorldKnowledge, rng: { next(): number }): Decision {
  const snapshot = ctx.snapshot;
  const unvisited = nearbyLocations(ctx, world).filter(
    (location) =>
      snapshot.sequence <= location.minSeq &&
      snapshot.sequence >= location.maxSeq &&
      explorableToday(ctx, world, location.name) &&
      !ctx.visitedLocations.has(location.name),
  );
  if (unvisited.length > 0) {
    const target = unvisited[Math.floor(rng.next() * unvisited.length)]!;
    return command(`.探索 ${target.name}`, '探索链：优先没去过的地点');
  }
  const known = nearbyLocations(ctx, world).filter(
    (location) =>
      snapshot.sequence <= location.minSeq &&
      snapshot.sequence >= location.maxSeq &&
      explorableToday(ctx, world, location.name),
  );
  if (known.length > 0) {
    const target = known[Math.floor(rng.next() * known.length)]!;
    return command(`.探索 ${target.name}`, '探索链：全部去过，回头再挖一遍');
  }
  if (snapshot.inventory.length >= 6) {
    const item = tradeableItem(snapshot, world);
    if (item) {
      return tradeDecision(ctx, otherUserId(ctx), item.itemId, 6, '探索链：背包满了，挂一笔交易');
    }
  }
  return casualOrRecover(ctx, rng, '探索链：没有能去的地方了，做点别的');
}

/** social 链：组队 → 队伍任务 → 交易 → 占卜 */
function socialChain(ctx: DecisionContext, world: WorldKnowledge, rng: { next(): number }): Decision {
  const snapshot = ctx.snapshot;
  if (snapshot.partyId === null) {
    // 群里有现成的队就加（真人也是这么干的），没有才自己建
    if (ctx.knownParties.length > 0) return joinKnownParty(ctx, '社交链：加入群里公告过的队伍');
    return command('.队伍 创建', '社交链：先建个队');
  }
  if (snapshot.isPartyLeader && snapshot.partySize >= 2) {
    const used = snapshot.dailyCounters['party_task'] ?? 0;
    if (used < NUMERIC.party.taskDailyLimit) {
      return command('.队伍 任务', '社交链：带队做队伍任务');
    }
  }
  const item = tradeableItem(snapshot, world);
  if (item && rng.next() < 0.6) {
    return tradeDecision(ctx, otherUserId(ctx), item.itemId, 8, '社交链：挂一笔交易');
  }
  if (snapshot.mp >= NUMERIC.divination.mpCost && ctx.lastRejected !== '占卜') {
    return command('.占卜 我的队友可靠吗', '社交链：占卜');
  }
  return casualOrRecover(ctx, rng, '社交链：做点杂事');
}

/** casual 链：2—3 条随机指令，不走长链路 */
function casualChain(ctx: DecisionContext, rng: { next(): number }, world: WorldKnowledge): Decision {
  const snapshot = ctx.snapshot;
  /**
   * M2.13 前置 4：休闲链的三条「随手扮演」是**完整指令路径上唯一没有 DIG 保护的那三条**
   * （见 `playIsPointless`）。消化度满了之后抽中它们就是一次纯空转 ——
   * 它们不在菜单打分表覆盖的范围内（打分表只管菜单路径）。
   */
  const play = (index: number): Decision =>
    playIsPointless(ctx)
      ? (idleDecision(ctx, world, '休闲：消化度已经满了，随手做点别的') ??
        busywork(ctx, world, '休闲：消化度已经满了，随手做点别的'))
      : command(`.扮演 ${playText(ctx, PATHWAY_TAGS[ctx.profile.pathway], index)}`, '休闲：随手扮演');
  const pool: Array<() => Decision> = [
    () => command('.状态', '休闲：看一眼状态'),
    () => command('.背包', '休闲：翻背包'),
    () => command('.帮助', '休闲：看指令'),
    () => command('.今日', '休闲：看今天还有什么可做'),
    () => play(ctx.step),
    () => play(ctx.step + 2),
    () => play(ctx.step + 4),
  ];
  pool.push(() => command('.事件', '休闲：碰碰运气'));
  pool.push(() => command('.休息', '休闲：休息一下'));
  if (snapshot.mp >= NUMERIC.divination.mpCost) {
    pool.push(() => command('.占卜 今天运气如何', '休闲：占一卦'));
  }
  const pick = pool[Math.floor(rng.next() * pool.length)] ?? pool[0]!;
  return pick();
}

function casualOrRecover(ctx: DecisionContext, rng: { next(): number }, reason: string): Decision {
  const snapshot = ctx.snapshot;
  if (rng.next() < 0.5) {
    const restedToday = snapshot.dailyCounters['rest'] ?? 0;
    if (restedToday < NUMERIC.recovery.rest.dailyLimit) return command('.休息', reason);
  }
  return command('.状态', reason);
}

/** 挑一个「能掉本途径所需材料」的地点 */
function bestExploreLocation(world: WorldKnowledge, ctx: DecisionContext, rng: { next(): number }): string | null {
  const recipe = recipeOf(world, ctx);
  const wanted = recipe ? [...recipe.main, ...recipe.aux].map((need) => need.itemId) : [];
  const candidates = nearbyLocations(ctx, world).filter(
    (location) =>
      ctx.snapshot.sequence <= location.minSeq &&
      ctx.snapshot.sequence >= location.maxSeq &&
      explorableToday(ctx, world, location.name) &&
      (wanted.length === 0 || location.loot.some((item) => wanted.includes(item))),
  );
  if (candidates.length === 0) return null;
  const fresh = candidates.filter((location) => !ctx.visitedLocations.has(location.name));
  const pool = fresh.length > 0 ? fresh : candidates;
  return (pool[Math.floor(rng.next() * pool.length)] ?? pool[0]!).name;
}

export { coverageDecision };

/** 供单测使用：把画像/快照塞进最小上下文 */
export function makeContext(
  profile: DecisionContext['profile'],
  snapshot: DecisionContext['snapshot'],
  overrides: Partial<DecisionContext> = {},
): DecisionContext {
  return {
    profile,
    snapshot,
    playsToday: 0,
    day: 1,
    login: 0,
    step: 0,
    visitedLocations: new Set<string>(),
    pendingTrades: [],
    lastRejected: null,
    knownParties: [],
    ...overrides,
  };
}

export type { CharacterState };
