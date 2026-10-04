import { EventEngine } from '../../domain/event/engine.ts';
import {
  dangerLabel,
  exploreDailyCap,
  resolveExplore,
  rollDrop,
} from '../../domain/explore/explore.ts';
import { lostDayCandidates, sequenceAllowed } from '../../domain/explore/location.ts';
// M2.169：世界伤痕（神明级事件在地上留下的东西）叠加到地点上
import { mergeScars } from '../../domain/world/world-scar.ts';
import { weatherFlavor, weatherLabel } from '../../domain/world/weather.ts';
import { buildExploreMenu, buildLocationMenu } from '../../domain/menu/index.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import { cardDisplayName } from '../../domain/display.ts';
import { isInitiated, sequenceOrInitiate } from '../../domain/character/types.ts';
import { isMortalCard, mortalExploreModifiers } from '../../domain/initiation/index.ts';
import { runInitiation } from './initiation-hooks.ts';
import { dailyFlowLines } from './ritual.ts';
import { ownerAt } from '../../domain/church/conflict.ts';
import { checkTaboosFor } from './taboo-hooks.ts';
import { pickFortune, renderFortune } from '../../domain/world/fortune-schema.ts';
// M2.86：风格化上色（颜色走 LaTeX，见 adapter/highlight.ts）
import { hl, hlMark } from '../../adapter/highlight.ts';

/**
 * 奇遇的触发率。
 *
 * ⚠️ 这个数**改过三轮**，每一次都跟着探索机制的改动重算：
 *
 *   · 第一版 0.8%，按「每日 3 次」算 ⇒ 平均 42 天才碰一次 —— 太罕见，等于没有
 *   · 第二版 2%，还是按 3 次/天 ⇒ 17 天一次（当时是对的）
 *   · **第三版 1%**：用户把「每日 3 次」的硬上限改成了软上限（越刷越亏，但不禁止），
 *     于是活跃玩家一天可能探 10 次以上 ⇒ 2% 会变成「两天一次」，那就不是奇遇了。
 *     1% × 10 次/天 ⇒ 约 **10 天**一次 —— 落在「一个月总该碰上两三次」的区间。
 *
 * 奇遇一旦变成日常就不再是奇遇，但**一辈子遇不上**也不叫奇遇。
 */
const FORTUNE_RATE = 0.01;
import { rollCalamityDrop, rollExtraordinaryDrop, type ExtraordinaryKind } from '../../domain/extraordinary/index.ts';
import { calamityFactorAt } from '../../domain/world/calamity.ts';
import { runSighting } from './creature-hooks.ts';
import { wonderEffectsOf } from './wonder-hooks.ts';
import { menuCharacterFor, worldSnapshotFor } from '../menu.ts';
import type { CommandContext, CommandResult, RouterDeps } from '../index.ts';
import type { CharacterState, DomainEvent } from '../../domain/character/types.ts';
import {
  abilityEffectsOf,
  applyFor,
  eligibleCardIds,
  renderCardText,
  requireCharacter,
  today,
  worldViewFor,
} from './common.ts';
import { renderDeltaSummary } from './render.ts';
import { setCurrentLocation, tollOnAction } from './wanted-hooks.ts';
import { sealedDigChanceOf } from '../../domain/world/history.ts';
import {
  actionMarkFlag,
  eventDelayMarkTurns,
  exploreDangerMarkMultiplier,
  freeExploreMark,
  lootGrantMark,
  lootMarkMultiplier,
} from '../../domain/menu/pathway-action-resolve.ts';

/**
 * M2.38 任务 1：**主动行动留下的探索倍率标记**。
 *
 * `.行动` 把 `exploreDangerMultiplier` 写成一个带**地点 + 日期**的 flag
 * （`action:exploreDanger:<地点>:<日期>`）—— 键自带作用域与过期，
 * 所以这里读不到就是 1（既有行为逐位不变），读到就是那条行动声明的倍率。
 *
 * ⚠️ **不需要显式清理**：跨天之后键本身就对不上了（第二道保险）；
 * 同一天用两次是 UPSERT 覆盖，不会叠乘。
 */
function actionDangerMarkOf(
  deps: RouterDeps,
  character: CharacterState,
  locationId: string,
  date: string,
): number {
  // 键名与解析只在 resolver 里写一次（K22）：这里只把「怎么读 flag」注入进去
  return exploreDangerMarkMultiplier(
    (flag) => deps.flags.value(character.id, flag),
    locationId,
    date,
  );
}

/**
 * M2.65：**本地点这一次的四条行动标记**。
 *
 * 与 M2.38 的 `exploreDanger` 同一套键（`action:<标记>:<地点>:<日期>`），
 * 只是这一批以前**没有任何消费者**（写了没人读）。四条各有一个落点：
 *
 * | 标记 | 谁写的 | 在这里做什么 |
 * | --- | --- | --- |
 * | `loot` | mother.seedKeep / perfect.sequencingOrder | 掉落的**件数** ×N |
 * | `eventDelay` | warrior.intimidate 威慑 | 这一次**不出事件卡** |
 * | `lootGrant` | sleepless.weaveDream 织梦 | 结算完**多带回一件**（当日作用域） |
 *
 * ⚠️ **读完即删**：这四条都是「用一次」的语义，留着会变成永久的隐藏加成
 *（K19 的形状）。日期那一道保险照旧在键里。
 */
interface ExploreActionMarks {
  /** 掉落件数倍率（1 = 不变） */
  lootMultiplier: number;
  /** 本地点还要安静几格 */
  delayTurns: number;
  /** 本日补一件收获 */
  grantLoot: boolean;
  /** M2.85：秘偶代行 —— 「免行动点」的说法没了，但它仍是「这一趟偶人替你走」的标记 */
  free: boolean;
}

function exploreActionMarksOf(
  deps: RouterDeps,
  characterId: string,
  locationId: string,
  day: string,
): ExploreActionMarks {
  const read = (flag: string): string | null => deps.flags.value(characterId, flag);
  return {
    lootMultiplier: lootMarkMultiplier(read, locationId, day),
    delayTurns: eventDelayMarkTurns(read, locationId, day),
    grantLoot: lootGrantMark(read, locationId, day),
    free: freeExploreMark(read, locationId, day),
  };
}

/**
 * **用完即消**：把这一趟真正用掉的标记删掉（`eventDelay` 还有余量就减一）。
 *
 * 单独一个函数是有意的 —— 清理点只有一处，将来谁加了新标记也不会漏掉「删」这一步。
 */
function consumeExploreActionMarks(
  deps: RouterDeps,
  characterId: string,
  locationId: string,
  day: string,
  marks: ExploreActionMarks,
  now: number,
): void {
  if (marks.lootMultiplier !== 1) deps.flags.clear(characterId, actionMarkFlag('loot', locationId, day));
  if (marks.grantLoot) deps.flags.clear(characterId, actionMarkFlag('lootGrant', locationId, day));
  if (marks.free) deps.flags.clear(characterId, actionMarkFlag('freeExplore', locationId, day));
  if (marks.delayTurns > 0) {
    const flag = actionMarkFlag('eventDelay', locationId, day);
    if (marks.delayTurns > 1) deps.flags.set(characterId, flag, now, String(marks.delayTurns - 1));
    else deps.flags.clear(characterId, flag);
  }
}

export const EXPLORE_USAGE = '用法：.探索 地点（例：.探索 迷雾街区）';

/**
 * M2.13：从内容表里挑一件指定类型的封印物（**命令层的事** —— 判定层不认识 items 表）。
 *
 * 池子按 id 排序后取，所以「同一个 rng → 同一件东西」这条不变量成立。
 * 掉落率只决定**掉不掉**、掉哪一类；掉**哪一件**由这里等概率抽
 * （三类的池子分别是 4 / 5 / 3 件，等概率抽就够了 —— 任务书没有给件与件之间的权重）。
 */
export function pickExtraordinaryItem(
  deps: CommandContext['deps'],
  kind: ExtraordinaryKind,
  rng: { next(): number },
): string | null {
  const pool = deps.items
    .all()
    .filter((item) => item.type === kind)
    .map((item) => item.id)
    .sort();
  if (pool.length === 0) return null;
  return pool[Math.floor(rng.next() * pool.length)] ?? pool[0]!;
}

/** 类别 → 回执里那个人话（三类各有各的叫法） */
export function extraordinaryKindLabel(kind: ExtraordinaryKind): string {
  if (kind === 'wonder') return '神奇物品';
  if (kind === 'sealed') return '封印物';
  return '符咒';
}

/** M2.13：传送符的落点表（「去过的地方」）。单值 flag，值是地点 id 的 JSON 数组 */
export const FLAG_MARKED_LOCATIONS = 'marked_locations';

/** 读「去过哪些地方」（解析失败一律当空 —— 一个坏值不该让玩家的传送符变成砖头） */
export function markedLocationsOf(deps: CommandContext['deps'], characterId: string): string[] {
  const raw = deps.flags.value(characterId, FLAG_MARKED_LOCATIONS);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * 记下一次「去过」（幂等：同一个地点重复探索不会让数组变长）。
 *
 * 为什么要在命令层做而不是判定层：这是一条**角色侧的记账**，
 * 判定层（resolveExplore）不认识 flags，也不该认识。
 */
export function rememberMarkedLocation(
  deps: CommandContext['deps'],
  characterId: string,
  locationId: string,
  now: number,
): void {
  const known = markedLocationsOf(deps, characterId);
  if (known.includes(locationId)) return;
  known.push(locationId);
  // 上限 40：内容表里一共 41 个地点，留一个余量即可（再多的部分对传送没有意义）
  deps.flags.set(characterId, FLAG_MARKED_LOCATIONS, now, JSON.stringify(known.slice(-40)));
}

/**
 * M2.12：**序列 7 的两条感知向能力**在探索回执里的落点。
 *
 * ⚠️ 口径：它们**只给信息，不给数值** —— 与 M2.8 的感知分层是同一条原则
 *（「序列正反馈来自能做以前做不到的事」，不是「同一个动作的数字变大」）。
 *   - 敌意感知不告诉你「打不打得过」，只告诉你「有没有东西在等你」；
 *   - 梦隙不给你任何优势，只让你看见同一个地方的另一个时刻。
 * 两条都不碰判定：resolveExplore 的参数一个都没动。
 */
function perceptionSenseLines(
  deps: CommandContext['deps'],
  character: { id: string; pathway: string | null; sequence: number | null },
  location: { id: string; name: string },
): string[] {
  const effects = abilityEffectsOf(deps, character as never);
  const out: string[] = [];

  if (effects.hostilitySense === true) {
    // 表里留下的都是活着的（死掉的会被生态 tick 删掉），所以不需要再筛状态
    const here = deps.creatures.atLocation(location.id);
    if (here.length === 0) {
      out.push('【敌意感知】这里没有东西在等你 —— 至少现在没有。');
    } else {
      const strongest = Math.min(...here.map((creature) => creature.sequence));
      out.push(
        '【敌意感知】有东西在等你：' +
          (here.length === 1 ? '一只' : here.length + ' 只') +
          '，其中最强的那只是序列 ' +
          strongest +
          '。',
      );
      out.push('（它知不知道你来了，是另一回事 —— 走进去才知道。）');
    }
  }

  if (effects.dreamGap === true) {
    out.push(
      '【梦隙】你在同一秒里看见了' + location.name + '的另一个时刻 —— 那时候还没有人在这里留下痕迹。',
    );
  }
  return out;
}


export async function handleExplore(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const { deps, msg, now } = ctx;

  /*
   * M2.108：**重伤出不了门**（用户问「生命为 0 会产生什么变化？为 0 了还能继续探索？」时查出来的）。
   *
   * 查之前的实情：HP 归零会写成 `status: injured`（重伤，不删卡），但 `injured` 的读取点
   * 只有 PVP / 袭击 / 通缉那几处 —— **`.探索` 一个检查都没有**，
   * 于是「被打到 0 血」和「满血」在探索这条路上没有任何区别。
   *
   * 判据取两个：`hp <= 0`（血见底）与 `status === injured`（状态标记）。
   * 两个都判是刻意的 —— 前者是数值事实，后者是别人打你留下的记录（`.袭击` 会把目标写成重伤）。
   */
  if (character.hp <= 0 || character.status === 'injured') {
    return {
      privateText:
        '你伤得站不起来 —— 这条街今天去不了。\n' +
        '> 先 `.休息` 养一养（每日 1 次，回 20 HP）；伤收口之后就能出门了。',
      detailToPrivate: true,
    };
  }

  const query = ctx.args.join(' ').trim();
  if (!query) {
    // M2.3：不带参数的 .探索 = 地点选择菜单（玩家不该靠背地名过日子）
    const menu = buildLocationMenu(
      menuCharacterFor(deps, character, now),
      worldSnapshotFor(deps, now, character, undefined, { withLocations: true }),
    );
    const opened = deps.pendingMenus.openWith(character.id, 'explore', menu, now);
    return {
      privateText: opened.text,
      detailToPrivate: true,
      menuOpened: true,
      interactive: opened.interactive,
    };
  }

  /*
   * M2.169：**内容为底、伤痕叠加**。
   *
   * 探索是 danger 与 loot 的实际消费点 —— 神明陨落留下的痕迹（更危险、变堕落源、
   * 多出原本拿不到的材料）只有在这里合并进来，玩家才真的踩得到。
   * `worldScars` 不传时逐字返回原对象（与加这一层之前逐位相同）。
   */
  const rawLocation = deps.locations.findByNameOrId(query);
  const location = rawLocation === null
    ? null
    : mergeScars(rawLocation, deps.worldScars?.atLocation(rawLocation.id) ?? []);
  if (!location) {
    const names = deps.locations.all().map((l) => l.name).join('、');
    return { privateText: `没有这个地方：${query}\n已知地点：${names}`, detailToPrivate: true };
  }

  /*
   * M2.7 的**唯一强制点**：.探索 只能去自己脚下的城市。
   *
   * 这一条不写的话，玩家用完整指令 .探索 贝克兰德 就能绕过所有菜单过滤 ——
   * 「跨城移动」会变成「免费瞬移」，整套地理设计与 .移动 就都白做了。
   * 菜单过滤只是体验，这里才是规则。
   */
  const cityOfPlace = deps.geo.cityOfLocation(location.id);
  if (cityOfPlace && character.currentCityId && cityOfPlace.id !== character.currentCityId) {
    const here = deps.geo.city(character.currentCityId);
    return {
      privateText: [
        `${location.name}在${cityOfPlace.name}，你现在在${here?.name ?? character.currentCityId}。`,
        `要去那边得先发：.移动 ${cityOfPlace.name}`,
      ].join('\n'),
      groupText: `【${character.name}】想去一个还到不了的地方。`,
      detailToPrivate: true,
    };
  }

  const date = today(ctx);
  const seed = seedFrom([msg.messageId, character.id, now, 'explore']);
  const todayCount = deps.exploreDaily.countOf(character.id, date, location.id);
  // M2.2：这个地点此刻的天气（时段 / 雾日 / 天气的倍率都在 worldModifiersFor 里算好）
  const world = worldViewFor(deps, now, location.id, character.pathway ?? undefined);
  // M2.7.6：普通人的探索修正（危险 ×1.3 / 掉落 ×0.4 / 换事件池）
  const mortalMods = mortalExploreModifiers(character);
  // M2.13：被动的神奇物品（夜行披风：夜 -15% / 昼 +10% 危险）
  const wonder = wonderEffectsOf(deps, character.id, now);
  const eligible = eligibleCardIds(deps, ctx, character, date, location.name);
  // 方案 E：失控当天（按天留档，不看此刻的 status），该地点挂着的 lost_* 卡也进候选池
  const lostToday = deps.lostControlEvents.hasOn(character.id, date);
  /*
   * M2.7.6：**普通人的事件池是另一个池子。**
   *
   * 两个方向都要过滤（这里各写一次，不是靠 cond 兜底）：
   *   - 未入途径 → 只从 mortal 池里抽（他们没有地点绑定，所以不走 location.events 交集）；
   *   - 已入途径 → mortal 卡一张都不进池。
   * 只靠卡片自己的 cond: pathway:mortal 也可以，但那样「池子分得开不开」就取决于
   * 内容同学有没有给每张新卡写对条件 —— 而池子分不开的表现是「非凡者看到普通人的雾」，
   * 属于最难发现的一类内容事故。命令层这一道是硬边界。
   */
  const mortalNow = !isInitiated(character);
  const candidateEventIds = mortalNow
    ? eligible.filter((id) => isMortalCard(id))
    : [
        ...eligible.filter((id) => location.events.includes(id)),
        ...lostDayCandidates(location, lostToday),
        // M2.2：天气只做「事件池筛选」——把该天气的卡加进候选池（它们自己的 cond 照旧要过），
        // 没这个天气时它们一张都不进池，普通日卡池不受影响
        ...world.modifiers.eventPool.filter((id) => eligible.includes(id)),
      ].filter((id) => !isMortalCard(id));

  /*
   * M2.65：这一次探索**带着哪些行动标记**。
   * 读取点全部在 pathway-action-resolve.ts 里（K22）—— 这里只做「读一次、用一次」。
   */
  const actionMarks = exploreActionMarksOf(deps, character.id, location.id, date);

  const outcome = resolveExplore({
    state: character,
    location,
    rng: createSeededRng(seed),
    seed,
    todayCount,
    candidateEventIds,
    // M2.65：威慑（warrior.intimidate）—— 本地点今日事件延后一格
    skipEvent: actionMarks.delayTurns > 0,
    // M2.65：留种 / 定序 —— 这一次的产出 ×N
    lootMultiplier: actionMarks.lootMultiplier,
    /*
     * M2.7.6：普通人的危险 ×1.3（与能力倍率、世界倍率相乘，三者各管一段）
     * M2.13：**夜行披风**再乘一层（夜 0.85 / 昼 1.1）—— 四者仍然是各管一段，
     * 而「没有那件披风时恒为 1」保证了既有行为逐位不变。
     */
    dangerMultiplier:
      (abilityEffectsOf(deps, character).exploreDangerMultiplier ?? 1) *
      // M2.38 任务 1：主动行动（.行动）留下的倍率 —— 没有用时恒为 1
      actionDangerMarkOf(deps, character, location.id, today(ctx)) *
      mortalMods.dangerMultiplier *
      wonder.exploreDangerMultiplier,
    world: {
      exploreDangerMultiplier: world.modifiers.exploreDangerMultiplier,
      // 普通人的掉落 ×0.4：作用在「额外掉落」判定上，与 M2.2 天气倍率同一处
      dropMultiplier: world.modifiers.dropMultiplier * mortalMods.dropMultiplier,
    },
  });
  if (!outcome.ok) return { privateText: outcome.reason, detailToPrivate: true };

  /*
   * M2.85：行动值机制移除 —— 探索不再扣点，也没有「行动点不足」这条拒绝分支。
   * 秘偶代行的标记（freeExplore）保留：它从「免一次探索的行动点」变成
   * 纯粹的「这一趟偶人替你走」—— 消费与回执提示都还在，只是不再提行动点。
   */
  // 标记在这一步之后才算用掉
  consumeExploreActionMarks(deps, character.id, location.id, date, actionMarks, now);

  let state = character;
  const events: DomainEvent[] = [];

  if (outcome.deltas.length > 0) {
    const dangerApplied = applyFor(deps, state, outcome.deltas, '探索危险', now, seed);
    state = dangerApplied.newState;
    events.push(...dangerApplied.events);
  }

  deps.inventory.addMany(character.id, outcome.drops, now);
  for (const drop of outcome.drops) {
    events.push({
      type: 'item_gain',
      characterId: character.id,
      payload: {
        itemId: drop.itemId,
        quantity: drop.quantity,
        bindType: drop.bindType,
        locationId: location.id,
      },
      reason: '探索掉落',
      seed,
      createdAt: now,
    });
  }

  /*
   * M2.65：**织梦**（sleepless.weaveDream）留下的那一件。
   *
   * 独立随机源（`seedFrom([seed, 'action-loot-grant'])`）—— 插进上面那条随机序列里
   * 会让**全部地点**的掉落整体漂移（`domain/wanted/assault.ts` 文件头那条纪律）。
   * 走的是与普通掉落**同一张表、同一个 rollDrop**，只是多掷一次。
   */
  let grantedDrop: { itemId: string; quantity: number; bindType: string } | null = null;
  if (actionMarks.grantLoot) {
    const grantSeed = seedFrom([seed, 'action-loot-grant']);
    const granted = rollDrop(location, createSeededRng(grantSeed), sequenceOrInitiate(character));
    grantedDrop = granted.drop;
    deps.inventory.addMany(character.id, [granted.drop], now);
    events.push({
      type: 'item_gain',
      characterId: character.id,
      payload: {
        itemId: granted.drop.itemId,
        quantity: granted.drop.quantity,
        bindType: granted.drop.bindType,
        locationId: location.id,
        source: 'action-loot-grant',
      },
      reason: '织梦·补一件收获',
      seed: grantSeed,
      createdAt: now,
    });
  }

  /*
   * ==================================================================
   * M2.13：**封印物的探索掉落**（这一轮唯一的获取来源）
   * ==================================================================
   *
   * 三件事决定了它长这样：
   *
   * 1. **独立随机源。** 挂在探索流程的最后，用 `seedFrom([seed, 'extraordinary'])` 派生。
   *    插进 `resolveExplore` 的随机序列里会让**全部地点**的掉落 / 危险 / 事件卡整体漂移
   *    （那条纪律写在 `domain/wanted/assault.ts` 的文件头：不该掷骰时不掷）。
   *    与 M2.8 的 `runSighting` 用 `seedFrom([seed, 'creature'])` 是同一手法。
   *
   * 2. **独立于既有掉落表。** 掉落表的权重含义是「在掉落表里的占比」，
   *    而这里要的是「每次探索 3% 掉一件」—— **概率，不是占比**
   *    （见 `NUMERIC.extraordinary.dropRates` 里那段为什么这么分的注释）。
   *
   * 3. **掉出来的是非绑定物品（unbound）。** 封印物要能交易：
   *    「序列 9 的玩家找序列 7 的玩家买封印物」是这一轮想要的社交入口（任务书 §5.5） ——
   *    序列 9 的人进不去 `min_seq: 7` 的地点（那里掉落率最高），但他们买得到。
   *
   * 留档里同时写下**抽样值、概率与档位**：只记「掉了什么」回答不了
   * 「他为什么三十天一件都没掉」（是概率低？是地点档位不对？还是内容表里根本没有那一类）。
   */
  const extraSeed = seedFrom([seed, 'extraordinary']);
  // M2.14：灾厄因子**现场算**（不缓存）—— 灾厄在一天之内强度都在变
  const calamityFactor = calamityFactorAt(deps.worldSeed ?? 'world', now);
  /*
   * ⚠️ **两次掷骰的顺序固定，不能反**（第 1 步任务书的硬约束）：
   *   1. 先掷普通掉落（灾厄期 ×0.4）
   *   2. 再掷灾厄产出（只在灾厄期）
   * 两次各自用**独立随机源**（都从 extraSeed 派生），所以顺序在数学上不影响彼此 ——
   * 但仍然按这个顺序写、并用测试把「同 seed 同 factor → 同一串消耗」钉住：
   * 将来谁把某一次改成共用 rng，顺序反了就会让两个随机源的输出互换（铁律 6 的延伸）。
   *
   * 另注：calamitySeed 那句 seedFrom **无条件执行**是安全的 ——
   * seedFrom 只是 parts.join(':')（src/domain/rng.ts:26-28），不消耗随机数；
   * 真正会消耗的是 createSeededRng + next()，它们在 factor > 0 的分支里。
   */
  const extraDrop = rollExtraordinaryDrop({
    minSeq: location.min_seq,
    rng: createSeededRng(extraSeed),
    calamityFactor,
  });
  const calamitySeed = seedFrom([extraSeed, 'calamity']);
  const calamityDrop =
    calamityFactor > 0
      ? rollCalamityDrop({ segment: 'explore', rng: createSeededRng(calamitySeed) })
      : null;
  const extraItemId = extraDrop
    ? pickExtraordinaryItem(deps, extraDrop.kind, createSeededRng(seedFrom([extraSeed, 'pick'])))
    : null;
  if (extraDrop && extraItemId) {
    deps.inventory.addMany(
      character.id,
      [{ itemId: extraItemId, quantity: 1, bindType: 'unbound' }],
      now,
    );
    events.push({
      type: 'item_gain',
      characterId: character.id,
      payload: {
        itemId: extraItemId,
        quantity: 1,
        bindType: 'unbound',
        locationId: location.id,
        extraordinaryKind: extraDrop.kind,
        tier: extraDrop.tier,
        roll: Number(extraDrop.roll.toFixed(6)),
        chance: extraDrop.chance,
      },
      reason: '探索·封印物掉落',
      seed: extraSeed,
      createdAt: now,
    });
  }

  /*
   * ==================================================================
   * M2.14：**灾厄产出的主路径**（封印物的第二条来源）
   * ==================================================================
   *
   * 为什么主路径从「战斗胜利」挪到「每次探索」：200×30 实测灾厄期只有 3 场战斗胜利，
   * 而灾厄期探索有 1398 次 —— 差三个数量级。挂在战斗上时，灾厄产出实测 **0 件**。
   * 战斗那条**保留**（语义上「打赢灾厄生物拿东西」是核心叙事），但降为观察项。
   *
   * reason 用「探索·灾厄掉落」而不是并进「探索·封印物掉落」：
   * 报告要能按来源分开数（探索的 9 个旧值 vs 灾厄的新表），混在一起就再也说不清了。
   */
  const calamityItemId = calamityDrop
    ? pickExtraordinaryItem(deps, calamityDrop.kind, createSeededRng(seedFrom([calamitySeed, 'pick'])))
    : null;
  if (calamityDrop && calamityItemId) {
    deps.inventory.addMany(
      character.id,
      [{ itemId: calamityItemId, quantity: 1, bindType: 'unbound' }],
      now,
    );
    events.push({
      type: 'item_gain',
      characterId: character.id,
      payload: {
        itemId: calamityItemId,
        quantity: 1,
        bindType: 'unbound',
        locationId: location.id,
        extraordinaryKind: calamityDrop.kind,
        source: 'calamity-explore',
        roll: Number(calamityDrop.roll.toFixed(6)),
        chance: calamityDrop.chance,
      },
      reason: '探索·灾厄掉落',
      seed: calamitySeed,
      createdAt: now,
    });
  }

  /*
   * ==================================================================
   * M2.72：**埋在地点下的封印物**（历史压出来的那 9 处 —— 见 historyIndex.sealedCount）
   * ==================================================================
   *
   * 三件事与既有做法对齐：
   *
   * 1. **独立随机源**（`seedFrom([seed, 'sealed-dig'])`）—— 与上面那次封印物掉落、
   *    与 `resolveExplore` 的主随机流**都不共用**：插进去会让全部地点的掉落整体漂移。
   * 2. **没有埋东西的地点一次骰都不掷**（`sealedAt` 返回 null 就跳过）——
   *    「不该掷骰时不掷」，且既有行为逐位不变。
   * 3. **打出来的是**一件真实的封印物**（从 items.yaml 的 sealed 池里按 id 稳定抽），
   *    而不是历史文本 —— 历史说的是「这底下埋着东西」，说得对不对由玩家自己去挖。
   *
   * ⚠️ 与 `NUMERIC.extraordinary.dropRates` 的**分工**：那一份是「随便哪个地方都可能捡到」
   *（explore 0.8%）；这一份是「**历史说这里埋着**，所以这里明显更容易挖到」。
   * 两者独立掷、可以同时命中。
   */
  const buried = deps.historyIndex.sealedAt(location.id);
  let dugUp: { itemId: string; what: string; level: string } | null = null;
  if (buried !== null) {
    const digSeed = seedFrom([seed, 'sealed-dig']);
    const digRoll = createSeededRng(digSeed).next();
    if (digRoll < sealedDigChanceOf(buried.level)) {
      const pool = deps.items
        .all()
        .filter((item) => item.type === 'sealed')
        .map((item) => item.id)
        .sort();
      const itemId = pool[Math.floor(createSeededRng(seedFrom([digSeed, 'pick'])).next() * pool.length)] ?? null;
      if (itemId !== null) {
        dugUp = { itemId, what: buried.what, level: buried.level };
        deps.inventory.addMany(character.id, [{ itemId, quantity: 1, bindType: 'unbound' }], now);
        events.push({
          type: 'item_gain',
          characterId: character.id,
          payload: {
            itemId,
            quantity: 1,
            bindType: 'unbound',
            locationId: location.id,
            source: 'sealed-dig',
            // 留档：挖的是**哪一件历史**（报告里要能回答「那 8 处有几处被挖过」）
            because: buried.because,
            level: buried.level,
            roll: Number(digRoll.toFixed(6)),
            chance: sealedDigChanceOf(buried.level),
          },
          reason: '探索·挖出封印物',
          seed: digSeed,
          createdAt: now,
        });
      }
    }
  }

  // M2.40：这里只用来显示 ⇒ 直接存**显示名**，不存 id
  let cardName: string | null = null;
  let cardText: string | null = null;
  let cardGroup: string | null = null;
  if (outcome.eventCardId) {
    const card = deps.engine.byId(outcome.eventCardId);
    if (card) {
      const application = EventEngine.applyCard(state, card, { now, seed });
      state = application.result.newState;
      events.push(...application.result.events);
      deps.flags.setMany(character.id, application.flagsToSet, now);
      deps.eventTriggers.mark(character.id, card.id, date);
      cardName = cardDisplayName(card);
      cardText = renderCardText(deps, card.texts.priv, seed, { 地点: location.name });
      cardGroup = card.texts.group
        ? renderCardText(deps, card.texts.group, seed, { 地点: location.name })
        : null;
    }
  }

  /*
   * M2.13：**探索会留下一个「去过」的记号**（传送符的落点）。
   *
   * 任务书 §5.4 写的是「传送符：传送到**已标记的**地点」，而 M2 里没有「标记」这个动作。
   * 落点是：**标记 = 去过**。理由有两条：
   *   1. 它是唯一一个不需要新指令、且玩家自己心里有数的定义（「我走过的地方」）；
   *   2. 传送符因此不会被当成免费的跨城移动 —— 它只能把你送回**你已经到过**的地方，
   *      与 M2.7「跨城移动要走航线、要花时间」那套设计不冲突。
   *
   * 存成一个 flag（JSON 数组）而不是每地点一个 flag：.状态 的标记清单会把
   * 41 个地点 id 全列出来，而那些是机器状态、不是「这个角色身上发生了什么」
   * —— 与 FLAG_LOCATION 归到 INTERNAL_FLAGS 是同一个理由。
   */
  rememberMarkedLocation(deps, character.id, location.id, now);

  // M2.6：探索本身就是"移动到该地点"——先把位置落下来，再按这个地点的势力结算通缉遭遇。
  // 顺序不能反：反了的话，逃到无主地点的那一次探索仍会按旧地点判一次追捕。
  setCurrentLocation(deps, character.id, location.id, now);
  const toll = tollOnAction({
    deps,
    state,
    now,
    seed,
    locationId: location.id,
  });
  state = toll.state;

  deps.characters.update(state);
  deps.characters.appendEvents(events);
  const usedToday = deps.exploreDaily.increment(character.id, date, location.id);

  /*
   * M2.7.6 / M2.85：探索是「获得途径」的入口 —— 翻到配方线索
   * （5%；创建满 cluePityDays 天后必出）。
   * 放在**结算完掉落之后**：线索和掉落一样，都是探索的产物，不是它的前提。
   */
  const initiateLines: string[] = [];
  if (!isInitiated(state)) {
    const initSeed = seedFrom([seed, 'initiation']);
    const init = runInitiation({
      deps,
      character: state,
      action: { kind: 'explore', locationId: location.id, now },
      rng: createSeededRng(initSeed),
      seed: initSeed,
      now,
    });
    if (init.lines.length > 0) initiateLines.push('', ...init.lines);
  }

  const lines: string[] = [];
  /*
   * M2.86：**回执头拆成两行**（用户实机反馈「这三个信息挤在一起，过长会换行」）。
   *
   * 原来一行塞了五样东西：名字 · 地点 · 危险 · 天气 · 今日次数 —— 手机上必然折行，
   * 而折行的位置由客户端决定，于是「【曾经】特里尔（危险）· 雾 · 今日 2/3 次」
   * 会在任意处断开。拆成两行之后断点是我们自己定的：
   *   第一行 = 你是谁、你在哪、这里多危险（**决策依据**）
   *   第二行 = 天气与今日进度（**氛围与节奏**）
   *
   * 同时去掉「/3」这种配额写法：每日 3 次已经是**软上限**（越刷越亏，但不禁止），
   * 写「2/3」会让人以为还能再探一次就不行了。
   */
  lines.push(
    `【${character.name}】${location.name}（${dangerLabel(location.danger)}）`
  );
  // 只报事实，不报配额（软上限：越刷越亏，但不禁）
  lines.push(`${weatherLabel(world.weather)} · 今日已探 ${usedToday} 次`,
  );
  lines.push(weatherFlavor(world.weather));
  if (world.clock.foggy) lines.push('今天是雾日，看什么都隔着一层。');
  lines.push(...outcome.narrative);
  /*
   * M2.85：**奇遇**（用户问「没有奇遇吗？」）。
   *
   * 与掉落的区别：掉落是「你捡到了资源」，奇遇是「你碰上的一件事」——
   * 它可能给东西，也可能只给你一个念头、一段记忆、一个该记住的名字。
   *
   * ⚠️ 触发率 0.8%：与「非凡物品不是大白菜」同一个口径。奇遇一旦变成日常，
   * 它就不再是奇遇了。
   */
  const fortuneRng = createSeededRng(seedFrom([msg.messageId, character.id, 'fortune']));
  if (fortuneRng.next() < FORTUNE_RATE) {
    const fortune = pickFortune(deps.fortuneTable, fortuneRng.next());
    if (fortune !== null) {
      const eff = fortune.effect;
      const deltas: Array<{ type: 'hp' | 'mad' | 'cor' | 'dig'; value: number }> = [];
      if ((eff.hp ?? 0) !== 0) deltas.push({ type: 'hp', value: eff.hp! });
      if ((eff.mad ?? 0) !== 0) deltas.push({ type: 'mad', value: eff.mad! });
      if ((eff.cor ?? 0) !== 0) deltas.push({ type: 'cor', value: eff.cor! });
      if ((eff.dig ?? 0) !== 0) deltas.push({ type: 'dig', value: eff.dig! });
      if (deltas.length > 0) applyFor(deps, character, deltas, '奇遇:' + fortune.id, now);
      if (eff.itemId !== undefined && (eff.quantity ?? 0) > 0) {
        deps.inventory.addMany(character.id, [{ itemId: eff.itemId, quantity: eff.quantity!, bindType: 'unbound' }], now);
      }
      // 「聊得来的人」：与一位真的有交集的 NPC 结个善缘
      if ((eff.affinity ?? 0) !== 0) {
        const locals = deps.npcProgress.atLocation(location.id);
        const who = locals.length > 0 ? locals[Math.floor(fortuneRng.next() * locals.length)]! : null;
        if (who !== null) deps.npcRelations.bump(who.npcId, character.id, eff.affinity!, now);
      }
      lines.push(...renderFortune(fortune).split('\n'));
      deps.characters.appendEvents([{
        type: 'fortune',
        characterId: character.id,
        payload: { fortuneId: fortune.id, kind: fortune.kind },
        reason: '探索时碰上奇遇',
        seed: null,
        createdAt: now,
      }]);
    }
  }
  // M2.65：两条行动标记的落点要在回执里说出来 —— 不说的话玩家只会看到「这次没掉东西」
  if (actionMarks.delayTurns > 0) lines.push('你站在那里没有动。这条街今天安静了一格 —— 什么也没发生。');
  // M2.65 / M2.85：秘偶代行 —— 原话里有「不花行动点」，现在只保留「偶人替你走」这一半
  if (actionMarks.free) lines.push('偶人替你去了这一趟 —— 你只在雾边看着。');
  lines.push('');
  /*
   * M2.86：**风格化上色**（用户：「颜色也要做风格化」）。
   *
   *   小标题「收获」→ 金（收益类）
   *   物品名       → 亮色（一屏名字里最好扫）
   *   稀有度       → 按档分色：稀有紫 / 少见金 / 常见灰
   *   绑定         → 红（卖不掉，是要紧事）
   * 「挖掘」出来的东西是**非凡遗留**，所以那个小标题走紫色（非凡色）。
   */
  const c = deps.supportsColor === true;
  lines.push(hlMark('收获', 'gain', c));
  for (const drop of outcome.drops) {
    const bind = drop.bindType === 'bound' ? hl('绑定', 'danger', c) : '非绑定';
    const rarityKind = drop.rarity === '稀有' ? 'arcane' : drop.rarity === '少见' ? 'gain' : 'clue';
    lines.push('> ' + hl(deps.items.nameOf(drop.itemId), 'name', c) + ' × ' + drop.quantity
      + '（' + bind + '·' + hl(drop.rarity, rarityKind as never, c) + '）');
  }
  if (grantedDrop) {
    lines.push(
      '> ' + deps.items.nameOf(grantedDrop.itemId) + ' × ' + grantedDrop.quantity + '（梦里顺手带回来的）',
    );
  }
  if (dugUp !== null) {
    /*
     * 挖出来的东西要**说清来历**：玩家挖到的不只是一件封印物，
     * 而是「历史上那件事留下的那一件」。历史文本在这里第一次直接出现在玩法回执里。
     */
    lines.push('');
    lines.push('**挖掘**');
    lines.push('> 你在' + location.name + '底下碰到了不是土的东西。');
    lines.push('> ' + dugUp.what + '（' + deps.items.nameOf(dugUp.itemId) + ' × 1 · 非绑定）');
    lines.push('> 它在这里躺了很久 —— 久到没人记得是谁埋的。');
  }
  if (extraDrop && extraItemId) {
    // M2.13：掉到封印物时要说得比普通掉落**更清楚** —— 它带封印等级，而等级是危险信号
    const extraItem = deps.items.get(extraItemId);
    const seal = extraItem?.sealLevel ? `·封印等级 ${extraItem.sealLevel}` : '';
    lines.push(
      '> **' + extraordinaryKindLabel(extraDrop.kind) + '** ' + (extraItem?.name ?? extraItemId) + ' × 1（非绑定' + seal + '）',
    );
    lines.push('> 它不属于你习惯的那一类东西 —— 用之前先想清楚代价。');
  }
  if (outcome.danger.triggered) {
    lines.push('');
    lines.push('**危险触发** —— 你在离开时付出了代价。');
  }
  if (cardName && cardText) {
    lines.push('');
    // 行内式的「事件【x】」拿不到加粗（渲染层只认独立成行的【…】），改成独立小标题
    lines.push('**事件 · ' + cardName + '**');
    lines.push(...cardText.split('\n'));
  }
  const deltaLines = renderDeltaSummary(events, c, (id) => deps.items.nameOf(id));
  if (deltaLines.length > 0) {
    lines.push('');
    lines.push('**变化**');
    lines.push(...deltaLines.map((line) => '> ' + line));
  }
  lines.push(...perceptionSenseLines(deps, character, location));
  if (initiateLines.length > 0) lines.push(...initiateLines);
  lines.push(...toll.lines);

  /*
   * M2.89：**探索也在推进仪式流程。**
   *
   * 用户否掉计时模型的原话是「拿现实时间去要求就是纯折磨」；而第一版改成流程之后，
   * 唯一的推进方式是 `.仪式 推进` —— **点 12 次**。
   * 那仍然不是「玩着玩着就走完了」，只是把折磨从时钟搬到了手指上。
   *
   * 所以日常动作也要推进它。放在这里（掉落 / 事件卡 / 入途径之后，遭遇之前）：
   * 探索的产物已经给完了，仪式的那一行是**额外**的，不该挤掉掉落的位置。
   *
   * ⚠️ M2.90：**入口收敛成 `dailyFlowLines` 一个**（探索 / 扮演 / 事件 / 战斗共用）——
   * 这里原来直接调 runFlowStep，四个地方各写一遍就是四份会漂移的逻辑。
   * 它内部会挡掉「还没入途径」与「没有仪式记载」两种空转。
   */
  const flowLines = dailyFlowLines(deps, state, now, String(msg.messageId) + ':explore');
  if (flowLines.length > 0) lines.push('', ...flowLines);

  /*
   * M2.8：探索是遭遇生物的**主要挂点** —— 「同一片雾里，你看到的东西变了」就发生在这里。
   *
   * 位置有讲究，放在掉落 / 事件卡 / 入途径**之后**：
   * 遭遇是探索的产物之一，不是它的前提。放在前面会让「这次探索成没成」变得含糊。
   *
   * 遭遇的画面**完全由遭遇菜单承担**（title = 【遭遇 · 地点 · 天气】，context = 感知文本），
   * 这里一个字都不重复 —— 两边都写会让同一段文案在回执里出现两次（M2.3 的菜单测试抓过这个）。
   *
   * 注意 runSighting 无论命中与否都写一条带 seed 的 domain_events ——
   * 「他三十天一只生物都没遇到」这个问题只能靠那些记录回答。
   */
  const sighting = runSighting({
    deps,
    character: state,
    locationId: location.id,
    now,
    seed: seedFrom([seed, 'creature']),
  });

  /*
   * M2.17（任务 B2）：**教义检查点之一 —— 探索之后**。
   *
   * 放在这里而不是函数更前面，理由只有一个：钩子内部会写库（deps.characters.update），
   * 而上面 465 行刚把探索的结果落库 —— 早调用会被它覆盖。
   *
   * 判据里的 location 用**刚探索的那个地点**（而不是出发地）：
   * 「信徒不该踏进烈阳的圣所」要判的正是他这一步走进了哪。
   */
  /*
   * M2.18 任务 B5：**这里现在归谁**（只有真的翻转了才显示）。
   * 与 M2.6 的通缉播报同一个手法 —— 私聊这一行就够，不进群公告。
   */
  const territoryOwner = ownerAt(location.id, deps.churchConflict.ofLocation(location.id));
  if (territoryOwner) {
    const holder = deps.churches.byId(territoryOwner.churchId);
    if (holder) lines.push('', location.name + '现在归' + holder.name + ' —— 它们在这里占着上风。');
  }

  const taboo = checkTaboosFor(ctx, state, 'explore', {
    locationId: location.id,
    cityId: cityOfPlace?.id ?? character.currentCityId ?? null,
  });
  lines.push(...taboo.receipt);

  const result: CommandResult = {
    privateText: lines.join('\n'),
    groupText: cardGroup ?? `【${state.name}】在${location.name}走了一趟。`,
    detailToPrivate: true,
    menuNotes: [
      `${location.name}：今日 ${usedToday}/${exploreDailyCap()} 次`,
      ...renderDeltaSummary(events, false, (id) => deps.items.nameOf(id)).slice(0, 2),
    ],
  };

  // M2.3 §3.5：探索完立刻给这个地点的「探索选项」——
  // 危险倍率拆解、今日次数、掉落倾向、途径专属动作，全部来自同一个纯函数生成器。
  // 挂载点在「执行后」而不是「执行前」：执行前挂载会让 .探索 地点 一条指令做完的事变成两步，
  // 既破坏「完整指令仍然可用」这条硬约束，也会让 200×14 的动作数翻倍（分片提速的目标就没了）。
  //
  // M2.8：**遭遇时改摆遭遇菜单**（而不是探索菜单）——
  // 遭遇是个未决状态，那只生物还站在那里；这时候问「要不要再探索一次」是答非所问。
  // 遭遇处置完（.遭遇 观察 / 撤退 …）之后，玩家自然可以再探索。
  if (sighting) {
    const opened = deps.pendingMenus.openWith(character.id, 'encounter', sighting.menu, now);
    result.privateText = `${result.privateText}\n\n${opened.text}`;
    result.interactive = opened.interactive;
    result.menuOpened = true;
    result.menuNotes = [...(result.menuNotes ?? []), `遭遇：${sighting.layer}`];
    return result;
  }
  {
    const menu = buildExploreMenu(
      menuCharacterFor(deps, state, now),
      worldSnapshotFor(deps, now, state, location.id, { withLocations: true }),
      location,
      deps.inventory.list(character.id),
    );
    const opened = deps.pendingMenus.openWith(character.id, 'explore', menu, now);
    result.privateText = `${result.privateText}\n\n${opened.text}`;
    // M2.7：同一份菜单也交给通道去摆按钮（不支持按钮的通道发上面那段文本，一字不差）
    result.interactive = opened.interactive;
    result.menuOpened = true;
  }
  return result;
}
