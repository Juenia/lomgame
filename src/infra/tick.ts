import { loadContent } from '../data/loader.ts';
import { NUMERIC } from '../config/numeric.ts';
import { renderTemplate } from '../cards/template.ts';
import { pickAftershockText, pickLostControlText } from '../cards/lost-control.ts';
import { capsFromAbilityEffects, NO_ABILITY_EFFECTS } from '../domain/ability/ability.ts';
import { planCharacterTick } from '../domain/daily/tick.ts';
import { applyWithCaps } from '../domain/effect/apply.ts';
import { createSeededRng, seedFrom } from '../domain/rng.ts';
import { qualifiedForGodhood, willAscend } from '../domain/world/npc-advance.ts';
import { canHandle, canHunt, handleChance, meritOfCalamity, meritOfHunt } from '../domain/world/npc-calamity.ts';
import { corruptedEnoughToServe, deathChanceOf, deathLineOf, meritOfKill } from '../domain/world/npc-life.ts';
// M2.167：教会来清理（编制表 / 资格闸 / 三档结果都在 domain/world/fallen-beast.ts）
import { cullLineOf, cullOutcome, squadOf, willCull } from '../domain/world/fallen-beast.ts';
// M2.169：教会失了庇护就不再出清剿队
import { stillActive } from '../domain/world/church-fate.ts';
// M2.170：登位期间每天被神性啃
import { claimantsOf, riteStrain } from '../domain/world/throne-contest.ts';
import { DEED_EFFECT_LABELS, deedMerit, deedsFor, pickDeed, renderDeedText } from '../domain/world/pathway-deed.ts';
import { calamityAt } from '../domain/world/calamity.ts';
import {
  SCHEME_DAYS_BY_TIER, SCHEME_KIND_LABELS, SCHEME_NATURE_LABELS, SCHEME_NATURES,
  canUseKind, effectOfNature, kindsFor, natureOfKind, requiresFor, schemeIdOf, schemeTierOf, stageAt,
} from '../domain/world/npc-scheme.ts';
import { giftTierOf, willScheme } from '../domain/world/npc-relation.ts';
import { strikeTextFor, type SchemeFacts } from '../domain/world/scheme-narrative.ts';
import { canHandleEvent, EVENT_MERIT, handlingText, pickHandler } from '../domain/world/event-handling.ts';
import { worldEventHeadline } from '../domain/world/events.ts';
import { randomInt } from '../domain/random.ts';
import { dateKey } from './date.ts';
import { expireStaleTrades } from '../router/commands/common.ts';
import { npcSequenceOf } from '../router/commands/common.ts';
import { wonderEffectsOf } from '../router/commands/wonder-hooks.ts';
import { mortalCapsFor } from '../domain/initiation/index.ts';
import { checkRankUp, rankNameOf } from '../domain/church/membership.ts';
import { decayEntries } from '../domain/church/conflict.ts';
import type { RouterDeps } from '../router/index.ts';

/**
 * M2.16：这个角色**上一次记到第几档**（没有记录 = 0，即刚入教时的信徒）。
 * 档位是算出来的、没有存储列，所以「变了没有」只能跟事件里那个值比。
 */
function lastRecordedRank(deps: RouterDeps, characterId: string): number {
  const payload = deps.characters.lastEventPayloadOf(characterId, 'church_rank_up');
  const to = payload?.['toRank'];
  return typeof to === 'number' ? to : 0;
}

export interface TickNotification {
  userId: string;
  text: string;
}

export interface TickSummary {
  date: string;
  /** true = 今天已经跑过，本次什么都没做 */
  skipped: boolean;
  characters: number;
  recovered: number;
  lostControl: number;
  tradesExpired: number;
  eventsPruned: number;
  notifications: TickNotification[];
}

const EMPTY = (date: string): TickSummary => ({
  date,
  skipped: true,
  characters: 0,
  recovered: 0,
  lostControl: 0,
  tradesExpired: 0,
  eventsPruned: 0,
  notifications: [],
});

/**
 * 每日 tick（W4）
 *   AP 恢复 → MP 恢复 → 失控判定（与 §8 共用公式）→ 事件记录清理 → 交易超时
 * 幂等：daily_ticks 抢占当天，重复调用直接返回 skipped。
 */
/**",
 * 从玩家的领域事件里**提取阴谋能用的原料**（M2.85）。
 *
 * 用户问过「阴谋是否需要对接 AI」—— 不需要。针对性来自**这里**：
 * 项目已经在记 72 种事件，把这些事实喂给叙事层，阴谋说的每件事就都是真的发生过。
 * 借不到就返回空对象，叙事层会自动降级为泛化文案（宁可含糊，绝不编造）。
 */
function factsFromEvents(events: readonly { type: string; payload: Record<string, unknown> }[]): SchemeFacts {
  const facts: SchemeFacts = {};
  // 倒着找最近的那一条（events 是按时间正序）
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (facts.lastFoe === undefined && e.type === 'battle_start' && typeof e.payload['speciesName'] === 'string') facts.lastFoe = String(e.payload['speciesName']);
    if (facts.lastItem === undefined && e.type === 'item_gain' && typeof e.payload['itemId'] === 'string') facts.lastItem = String(e.payload['itemId']);
    if (facts.lastPlace === undefined && e.type === 'travel_arrive' && typeof e.payload['to'] === 'string') facts.lastPlace = String(e.payload['to']);
    if (facts.wantedLevel === undefined && e.type === 'wanted_issued') facts.wantedLevel = Number(e.payload['level'] ?? 1);
    if (facts.lastFoe !== undefined && facts.lastItem !== undefined && facts.lastPlace !== undefined) break;
  }
  return facts;
}

export function runDailyTick(deps: RouterDeps, now: number): TickSummary {
  const date = dateKey(now);
  if (!deps.dailyTicks.claim(date, now)) return EMPTY(date);

  /*
   * M2.18 任务 B：势力争夺的**每日衰减**（幂等水位线之后再跑）。
   *
   * 作用域是「所有 contested location 的 Σ > 0 的教会」，不只是未翻转的 ——
   * 已翻转的地盘每天也掉 1 点，于是「守住地盘」是一件持续要做的事。
   * 衰减本身也是**增量**（记一条 -decayPerDay），seed 底图始终不动。
   */
  for (const entry of decayEntries(deps.churchConflict.all(), NUMERIC.church.conflict.decayPerDay)) {
    deps.churchConflict.record({ ...entry, now });
  }

  /*
   * ═══════ M2.170：**正在登位的人，每天被神性啃一口** ═══════
   *
   * 这是「神位竞争是残酷的」里最安静的那一条：没有人打他，他也会掉。
   * 序列 1 每天 6 点理智，7 天 42 点 —— 原本理智高的人撑得住，
   * 已经在边缘的人会在最后一天失控（而失控的后果比「没坐上」重得多）。
   *
   * ⚠️ **必须放在顶层**。第一版把它插进了下面清剿段那个「按怪物循环」的循环体里 ——
   * 于是只有「城里有堕落生物」的日子才会侵蚀，别的日子一点都不掉。
   * 而它不报错：判据跑出来是「日 tick 没有侵蚀他：0 !== 6」。
   *
   * ⚠️ 也放在**日 tick** 而不是小时 tick：站上去的代价是按天算的，
   * 每小时结算一次小数会把这个数值磨成噪声。
   */
  for (const contest of deps.throneContests?.open() ?? []) {
    /*
     * ⚠️ **对撞时两个人都要被啃**。
     *
     * 第一版只算 `contest.claimantId`（先上去的那个）—— 于是实测跑出：
     * 12 天之后第一个人的理智 100（崩了）、第二个人 0（一点没掉）。
     * 那等于「先动手的人独自承受全部代价，后来者白捡」。
     */
    const everyone = claimantsOf(contest);
    for (const id of everyone) {
      const claimant = deps.characters.findById(id);
      if (claimant === null) continue;
      // 对撞时神性只有一份而两个人在抢 —— 侵蚀加倍
      const strain = riteStrain(claimant.sequence ?? 9, everyone.length);
      if (strain <= 0) continue;
      deps.characters.update({
        ...claimant,
        mad: Math.min(100, claimant.mad + strain),
        updatedAt: now,
      });
    }
  }

  const characters = deps.characters.all();
  let recovered = 0;
  let lostControl = 0;
  const notifications: TickNotification[] = [];

  /*
   * M2.85：原 M2.7.6 的两段 —— 过期邀约清扫与普通人的每日引导判定 —— 随
   * 势力引导玩法一并删除。「走上途径」只剩探索翻线索（cluePityDays 保底），
   * 那条路发生在 .探索 里，与每日 tick 无关。
   */

  for (const character of characters) {
    /*
     * M2.16：教内档位的**第二处触发点**（第一处在 `.教会 捐献` 之后）。
     *
     * 为什么必须有这一处：档位由「贡献 + 序列」双门槛算出来，而**序列会在晋升之后变**。
     * 一个玩家完全可能「贡献早就够了、当时序列不够」，等他升上序列之后档位才该动 ——
     * 如果只在捐款后检测，这种人会一直挂在旧档上，直到他碰巧再捐一次。
     * M2.13.1 那 49 个「够门槛没发起晋升」的根因之一就是「条件达成时没有检测点」，
     * 所以这里不是可选项。
     *
     * ⚠️ 位置必须在下面那个 `continue` **之前**：
     * 那个 continue 是「今天数值什么都没变就跳过」，而一个玩家升档那天
     * 完全可能既不失控也不需要恢复 —— 放在后面的话，检测会被静默跳过。
     */
    if (character.churchId) {
      const church = deps.churches.byId(character.churchId);
      if (church) {
        const up = checkRankUp(character, church, lastRecordedRank(deps, character.id));
        if (up.canUp) {
          deps.characters.appendEvents([
            {
              type: 'church_rank_up',
              characterId: character.id,
              payload: {
                churchId: church.id,
                fromRank: up.from,
                toRank: up.to,
                source: 'daily_tick',
              },
              reason: '教内晋升:' + church.id,
              seed: null,
              createdAt: now,
            },
          ]);
          notifications.push({
            userId: character.userId,
            text: '【' + church.name + '】你被认作了' + rankNameOf(church, up.to) + '。',
          });
        }
      }
    }

    const seed = seedFrom(['tick', date, character.id]);
    /*
     * M2.13：把**被动物品**的影响喂进每日结算（占卜水晶的每日 MAD）。
     * 缺省是中性 —— 没有那件东西的人，这一行与 M2.12 的行为逐位一致。
     * ⚠️ M2.85：时间沙漏的 AP 减半代价随行动值机制移除。
     */
    const wonder = wonderEffectsOf(deps, character.id, now);
    /*
     * M2.7.6：普通人没有途径，也就没有能力上限可查；
     * 但要叠上**普通人的上限**（MAD 20 / COR 10）—— 与 common.ts 的 applyFor 同一口径。
     * M2.85：这一份 caps 现在**也要喂给计划层** —— 「MP 已满就不再写那一条恢复」
     * 需要知道真实上限（能力加成会把它抬到 100 以上）。
     */
    const effects = character.pathway
      ? deps.abilities.effectsOf(character.id, character.pathway)
      : NO_ABILITY_EFFECTS;
    const caps = { ...capsFromAbilityEffects(effects), ...mortalCapsFor(character) };
    const plan = planCharacterTick({
      state: character,
      rng: createSeededRng(seed),
      wonder: {
        madPerDay: wonder.madPerDay,
      },
      // M2.76：堕落形态池 —— 形态决定这次失控的后果；空池时行为与改动前逐位一致
      forms: deps.lostControlPool.forms,
      caps,
    });

    if (plan.deltas.length === 0 && plan.status === character.status) continue;

    const applied = applyWithCaps(
      character,
      plan.deltas,
      `每日tick:${date}`,
      now,
      seed,
      caps,
    );
    const state = { ...applied.newState, status: plan.status, updatedAt: now };
    deps.characters.update(state);
    deps.characters.appendEvents(applied.events);

    if (plan.recoveredFrom === 'lost_control') {
      recovered += 1;
      // 余波：恢复之后还有一段缓冲，避免「一夜之间完全没事」
      const afterRng = createSeededRng(seedFrom([seed, 'aftershock']));
      const aftershock = renderTemplate(
        pickAftershockText(deps.lostControlPool, Math.floor(afterRng.next() * 1000)),
        deps.fragments,
        afterRng,
        { 名字: character.name },
      );
      notifications.push({
        userId: character.userId,
        text: ['【每日结算】你从失控里缓过来了。', '', aftershock].join('\n'),
      });
    }

    /*
     * 普通人**不可能走到这里**：他的 MAD/COR 上限（20/10）低于失控闸门（65/65），
     * 概率恒为 0。所以 pathway 为空时直接跳过，不需要给失控文案编一个兜底途径 ——
     * 那种兜底只会在将来某个 bug 里被当成真话播出去。
     */
    if (plan.lostControl?.triggered && character.pathway) {
      lostControl += 1;
      const textRng = createSeededRng(seedFrom([seed, 'text']));
      const raw = pickLostControlText(
        deps.lostControlPool,
        character.pathway,
        Math.floor(textRng.next() * 1000),
      );
      const text = renderTemplate(raw, deps.fragments, textRng, { 名字: character.name });
      deps.lostControlEvents.record({
        characterId: character.id,
        date,
        pathway: character.pathway,
        text,
        hpLoss: plan.lostControl.hpLoss,
        // M2.76：MAD 由形态决定（没有形态时就是全局缺省，与改动前同值）
        madGain: plan.lostControl.madGain,
        form: plan.lostControl.formId,
        source: 'tick',
        createdAt: now,
      });
      /*
       * M2.76：正文与播报都带上形态 ——「你失控了」这句话对玩家没有信息量，
       * 「你进入了窥视者形态」才是他下次想避开的那个东西。
       */
      const formLine = plan.lostControl.formName ? `——${plan.lostControl.formName}。` : '。';
      const costLine =
        `HP -${plan.lostControl.hpLoss}，MAD +${plan.lostControl.madGain}` +
        (plan.lostControl.corGain !== 0 ? `，COR +${plan.lostControl.corGain}` : '') +
        '。';
      notifications.push({
        userId: character.userId,
        text: [
          `【每日结算】你失控了${formLine}`,
          '',
          plan.lostControl.blurb ?? text,
          '',
          costLine + '发送 .休息 或 .净化 可以稳住自己（失控也会在次日自动解除）。',
        ].join('\n'),
      });
      /*
       * ⚠️ 形态的 group（群播报）**这里不消费**：TickNotification 只有 userId + text，
       * 每日结算没有群播报这条边（写成 `userId: null` 是类型错误，tsc 会挡）。
       * 字段先留在内容里，等接群内可见播报时再消费 —— 见 M2.76 交付说明的「未接线」一节。
       */
    }
  }

  const tradesExpired = expireStaleTrades(deps, now);
  const eventsPruned = deps.eventTriggers.pruneBefore(dateKey(now - NUMERIC.tick.eventRetentionDays * 86_400_000));

  /*
   * ===== M2.85 世界演化：**NPC 也在往上走** =====
   *
   * 用户拍板：「让 NPC 参与世界的演化」「不能让他们非常快的就成神了，按原著的进度来」。
   *
   * 每天做三件事：
   *   ① 播种 —— 第一次见到某个 NPC 时，把原作记载的当前序列写进 npc_progress（此后它归世界管）
   *   ② 判定 —— 停留时间够长才可能晋升（门槛在 domain/world/npc-advance.ts，按原著进度指数递增）
   *   ③ 记录 —— 晋升写进 npc_deeds；**走到序列 0 时发一条全服世界事件**（「他登神了」）
   *
   * ⚠️ 随机是**确定性**的（seed 含日期）——补跑与逐日跑结果一致，这是本仓库一贯的纪律。
   */
  const npcRng = createSeededRng(seedFrom(['npc-advance', date]));

  /*
   * ===== 世界演化：**NPC 也会走动** =====
   *
   * 站着不动的人不叫「有智慧的人机」。每天有小概率有人离开当前地点、去一个相邻的地方 ——
   * 于是玩家隔几天回到同一条街，可能遇到的人就换了。
   */
  const walkRng = createSeededRng(seedFrom(['npc-walk', date]));
  if (walkRng.next() < 0.15) {
    const movers = deps.npcProgress.all().filter((p) => p.sequence >= 1 && p.locationId !== null);
    const mover = movers.length > 0 ? movers[Math.floor(walkRng.next() * movers.length)] : undefined;
    if (mover !== undefined && mover.locationId !== null) {
      const loc = deps.locations.get(mover.locationId);
      const adjacent = (loc?.adjacent ?? []).filter((id: string) => deps.locations.get(id) !== undefined);
      if (adjacent.length > 0) {
        deps.npcProgress.moveTo(mover.npcId, adjacent[Math.floor(walkRng.next() * adjacent.length)]!);
      }
    }
  }

  /*
   * ===== 世界演化第二层：**NPC 出手处理灾厄** =====
   *
   * 用户拍板：「不要随便来个路人甲就窜一下子解决了大灾厄，然后还成神了」。
   * 所以出手前先过**资格闸**：序列决定他能碰多高的灾厄（低序列连靠近都做不到），
   * 够格的人里挑**序列最高**的那位去（强者先上），成功率按能力余量算，输了记受伤（0 分）。
   * 化解成功才记功绩 —— 而功绩是**成神**的必要条件之一。
   */
  /*
   * ===== 世界演化第二层：**NPC 按自己的途径出手** =====
   *
   * 用户拍板：「NPC 也要会做出符合自己途径的行为」。
   *
   * 在此之前，这里只有两条**通用**逻辑（谁都可猎杀、谁都可化解灾厄）—— 一个走「愚者」的天使
   * 和一个走「红祭司」的天使除了数值没有任何区别。现在改成：按他的**途径**从
   * `pathway-deeds.yaml` 里挑一条行为（愚者占卜、猎人猎杀、死神收尸、阅读者研读……），
   * 效果仍受原来的**资格闸**约束（打不过的东西不会硬上）。
   *
   * 六个效果里，三个有真实世界影响（hunt 减一只、tend 加一只、calm 压灾厄），
   * 三个是信息与功绩（foretell / observe / gather 写世界事件）。
   */
  /*
   * ═══════ M2.164：**死者不参与世界** ═══════
   *
   * 用户拍板「NPC 死亡是真的死亡（永久，不刷新）」—— 那么它必须处处成立：
   * 街上不站死人、死人不布局、死人不晋升、死人不化解灾厄、死人不再与人熟络。
   *
   * 一次全表读，然后处处用它（与下面 448 行那段性能注释同一条纪律：
   * 循环里查库会让 tick 的成本随人数线性上涨）。
   *
   * ⚠️ 漏掉任何一处的后果都一样：**街上有死人**，而且不报错。
   */
  const dead = deps.npcLife.deadIds();
  /** 致死判定用**独立的流**：一场阴谋或一次灾厄的死活，不该随别的随机消费而改变 */
  const killRng = createSeededRng(seedFrom(['npc-death', date]));

  const deedRng = createSeededRng(seedFrom(['npc-deed', date]));
  if (deedRng.next() < 0.2) {
    const byId = new Map(deps.npcTracks.map((t) => [t.id, t]));
    const actors = deps.npcProgress.all().filter((p) => p.sequence >= 1 && byId.has(p.npcId) && !dead.has(p.npcId));
    const actor = actors.length > 0 ? actors[Math.floor(deedRng.next() * actors.length)] : undefined;
    if (actor !== undefined) {
      const track = byId.get(actor.npcId)!;
      const pathway = track.pathways[0] ?? '';
      const pool = deedsFor(deps.pathwayDeeds, pathway, actor.sequence);
      const deed = pickDeed(pool, deedRng.next());
      if (deed !== null) {
        const text = renderDeedText(deed, track.name);
        const merit = deedMerit(deed.effect);
        let worldText: string | null = null;
        if (deed.effect === 'hunt') {
          // 真实影响：从生态里减一只（仍要过资格闸：打不过的不硬上）
          const edible = deps.creatures.all().filter((c) => canHunt(actor.sequence, c.sequence));
          const prey = edible.length > 0 ? edible[Math.floor(deedRng.next() * edible.length)] : undefined;
          if (prey !== undefined) {
            deps.creatures.deleteMany([prey.id]);
            worldText = `${text}（${prey.speciesId} 不再出现在那一带）`;
          }
        } else if (deed.effect === 'tend') {
          // 真实影响：给生态加一只（母亲的播种、药师的采药后补种）
          const all = deps.creatures.all();
          const seedBeast = all.length > 0 ? all[Math.floor(deedRng.next() * all.length)] : undefined;
          if (seedBeast !== undefined) {
            deps.creatures.insertMany([{ ...seedBeast, id: seedBeast.id + '-tend-' + now, hp: seedBeast.maxHp, ageHours: 0 }]);
            worldText = `${text}（那一带的生气回来了）`;
          }
        } else if (deed.effect === 'calm') {
          const calamityNow = calamityAt(deps.worldSeed ?? 'world', now);
          if (calamityNow !== null && calamityNow.level > 0) {
            worldText = `${text} —— 「${calamityNow.name}」被压了下去。`;
          }
        } else {
          // foretell / observe / gather：信息类，写进世界事件（玩家看得到）
          worldText = text;
        }
        deps.npcDeeds.record({ npcId: actor.npcId, kind: 'deed', detail: `${DEED_EFFECT_LABELS[deed.effect]}：${text}`, merit, at: now });
        if (worldText !== null) {
          deps.worldEvents.insert({
            id: 'npc-deed-' + actor.npcId + '-' + now,
            type: deed.effect === 'calm' ? 'calamity' : 'rumor',
            text: `【世界 · ${track.name}】${DEED_EFFECT_LABELS[deed.effect]}\n${worldText}`,
            visibility: 'public',
            createdAt: now,
          });
        }
      }
    }
  }

  /*
   * ===== 世界演化第六层：**NPC 处理世界事件** =====
   *
   * 用户拍板：「NPC 相当于一个有智慧的人机，事件也有可能被 NPC 解决」。
   *
   * 在这之前，世界事件**只作用于玩家** —— 它们是背景噪音，到点自己过期，没人回应。
   * 现在每天有约四分之一的概率，一位**够格且对路**的 NPC 会认领一件事：
   *   · 够不够格看序列（传闻谁都能接，势力动向要序列 4 以上）
   *   · 对不对路看途径（灾厄优先战士/太阳/审判者；发现优先阅读者/门）
   *
   * 灾厄类事件不在这里处理 —— 它由第二层的「灾厄响应」专门负责（那一条要掷成功率、输了会受伤）。
   * 一件事只会被处理一次（主键约束），先到先得。
   */
  const evRng = createSeededRng(seedFrom(['npc-event', date]));
  if (evRng.next() < 0.25) {
    const handled = deps.eventHandling.handledIds();
    // ⚠️ 还要排除「已被处理」的通报本身（id 以 npc-handled- 开头）—— 第一版没排，
    //    于是出现了「XX 把这件事查实了 ——【世界 · 已被处理】安提哥努斯」这种套娃文案。
    const live = deps.worldEvents
      .live(now, 20)
      .filter((e) => !handled.has(e.id) && e.type !== 'calamity' && !e.id.startsWith('npc-handled-'));
    const target = live.length > 0 ? live[Math.floor(evRng.next() * live.length)] : undefined;
    if (target !== undefined) {
      const trackById = new Map(deps.npcTracks.map((t) => [t.id, t]));
      const candidates = deps.npcProgress
        .all()
        .filter((p) => p.sequence >= 1 && trackById.has(p.npcId) && !dead.has(p.npcId))
        .map((p) => ({ npcId: p.npcId, sequence: p.sequence, pathways: trackById.get(p.npcId)!.pathways }))
        .filter((c) => canHandleEvent(c.sequence, target.type));
      const handler = pickHandler(candidates, target.type, evRng.next());
      if (handler !== null) {
        const merit = EVENT_MERIT[target.type];
        // headline 只取标题（第一行），正文另起一行 —— 见 events.ts 的约定「第一行是抬头」
        const headline = worldEventHeadline(target).trim();
        const claimed = deps.eventHandling.claim({
          eventId: target.id,
          npcId: handler.npcId,
          note: `${handler.npcId} 处理了 ${target.type}`,
          merit,
          at: now,
        });
        if (claimed) {
          const handlerName = trackById.get(handler.npcId)!.name;
          deps.npcDeeds.record({ npcId: handler.npcId, kind: 'event', detail: handlingText(handlerName, target.type, headline), merit, at: now });
          deps.worldEvents.insert({
            id: 'npc-handled-' + target.id,
            type: target.type,
            text: `【世界 · 已被处理】${handlerName}\n${handlingText(handlerName, target.type, headline)}`,
            visibility: 'public',
            createdAt: now,
          });
        }
      }
    }
  }

  /*
   * ===== 世界演化：**NPC 的阴谋** =====
   *
   * 用户三次拍板：①算计玩家**或 NPC** ②别像偷东西那么儿戏 ③别单调。
   *
   * 所以：**六种性质**（损害/操纵/误导/渗透/颠覆/收割）× **三个层级** ⇒ 三十多种手段，
   * 而后果按 nature 收敛成六种（effectOfNature）。
   */
  const schemeRng = createSeededRng(seedFrom(['npc-scheme', date]));
  /*
   * ⚠️ **性能**：这些原来在循环体里反复查库（`npcSchemes.all()` 每迭代一次就是一次全表扫描），
   * 实测让 `.查` 的测试从 10 秒涨到 **83 秒**。tick 一天只跑一次，但它的成本直接决定
   * 跑批与补跑能不能接受 —— 所以所有全表读取一律**提到循环外，只做一次**。
   */
  const dispById = new Map(deps.npcDispositions.map((d) => [d.npcId, d]));
  const trackOf = new Map(deps.npcTracks.map((t) => [t.id, t]));
  /*
   * M2.164：**名册居民也要有自己的立场**。
   *
   * npc-dispositions.yaml 里只有轨道那 41 位 —— 不加这一段，120 位居民
   * 永远不会被算计（循环里 `disp === undefined → continue`），而**不报错**。
   * 名册自己带着性情，所以这里直接派生：敌对途径为空，赠礼档位按序列。
   */
  for (const entry of deps.npcRoster.all) {
    if (entry.source !== 'cast' || dispById.has(entry.id)) continue;
    dispById.set(entry.id, {
      npcId: entry.id,
      name: entry.name,
      sequence: entry.sequence,
      pathways: entry.pathway === '' ? [] : [entry.pathway],
      temperament: entry.temperament,
      hostilePathways: [],
      giftTier: giftTierOf(entry.sequence ?? 9),
      note: '',
    });
  }
  /*
   * M2.164：**回来的人不再是原来的人** —— 这条要在这里生效。
   *
   * changed / vessel / thrall 三种形态的人，性情一律按黑暗向算：
   * 他会替把他拉回来的那位做事（`willScheme` 只对 dark 放行，所以这一行
   * 决定了他会不会成为这只手上的刀）。
   */
  for (const life of deps.npcLife.all()) {
    const returnedChanged = life.returnedAs !== '' && life.returnedAs !== 'same';
    // 被低语说动过的（堕落度过 30）与「回来的不是他」一样，都替祂办事
    const serving = corruptedEnoughToServe(life.corrupted);
    if (!returnedChanged && !serving) continue;
    const disp = dispById.get(life.npcId);
    if (disp === undefined) continue;
    dispById.set(life.npcId, { ...disp, temperament: 'dark' });
  }
  const npcAll = deps.npcProgress.all();
  const relationsAll = deps.npcRelations.all();
  const schemesAll = deps.npcSchemes.all();
  // 已发动的手段按「谁→对谁」索引：连锁判定要在循环里查很多次
  const doneByPair = new Map<string, Set<string>>();
  for (const s of schemesAll) {
    if (s.stage !== 'strike') continue;
    const key = s.npcId + '|' + s.targetId;
    const set = doneByPair.get(key) ?? new Set<string>();
    set.add(s.kind);
    doneByPair.set(key, set);
  }
  for (const rel of relationsAll) {
    // M2.164：死了的人不再布局 —— 他已经不在这张棋盘上了
    if (dead.has(rel.npcId)) continue;
    const disp = dispById.get(rel.npcId);
    if (disp === undefined) continue;
    // ⚠️ M2.89：走 npcSequenceOf —— 直接读 npcProgress 会让所有人都是序列 9，
      // 于是 schemeTierOf(9) 恒为 petty，阴谋**只会生成最低档**（这个 bug 一直存在）
      const sequence = npcSequenceOf(deps, rel.npcId);
    if (!willScheme(rel.affinity, disp.temperament, sequence)) continue;
    if (deps.npcSchemes.activeOf(rel.characterId).some((s) => s.npcId === rel.npcId)) continue;
    if (schemeRng.next() > 0.12) continue;
    /* **目标也可以是 NPC**（用户第 ① 条：「算计玩家或者 NPC」）。
     * NPC 之间的敌意不另建表，按**途径对立 + 序列差**派生 —— 数据都现成。 */
    let targetId = rel.characterId;
    /*
     * **目标也可以是 NPC**（用户第 ① 条：「算计玩家或者 NPC」）。
     *
     * ⚠️ 前两版都没跑出 NPC 互算：第一版要求「途径对立」，第二版加了「同一条途径」——
     * 两次都太严，实测 500 天 **0 起**。而原著里高序列者之间的博弈本来就不需要世仇：
     * 争材料、压晋升、试探底线，**任何人都是潜在对手**。
     * 所以现在只要求「同为序列 1—6 的人」，按 35% 概率把矛头转向同行。
     */
    const rivals = npcAll.filter((p) => p.npcId !== rel.npcId && p.sequence >= 1 && p.sequence <= 6 && !dead.has(p.npcId));
    if (rivals.length > 0 && schemeRng.next() < 0.35) {
      targetId = rivals[Math.floor(schemeRng.next() * rivals.length)]!.npcId;
    }
    const tier = schemeTierOf(sequence);
    const nature = SCHEME_NATURES[Math.floor(schemeRng.next() * SCHEME_NATURES.length)]!;
    /*
     * **阴谋连锁**：棋局级的手段要先有铺垫（先安插人才能顶替、先扮盟友才能利用）。
     * 判定依据是「他对同一个目标已经发动过什么」—— 从历史里读，不另存状态。
     */
    const doneKinds = doneByPair.get(rel.npcId + '|' + targetId) ?? new Set<string>();
    /*
     * ⚠️ 两处都要过滤，第一版只做了前一半，实测出两个问题：
     *   ① **同一手段可以反复发动**（sabotage_ritual 连着 12 天，一天一次）—— 那是刷，不是棋
     *   ② 连锁把可用手段从 11 种压到 3 种 —— 因为 grand 层大多需要铺垫
     * 所以：既要「不重复已经用过的」，也要「没有铺垫时退回用得起的那几个」。
     */
    /*
     * ⚠️ 第三处修正：连锁把可用手段压到 3 种，因为 **grand 层的手段几乎都要铺垫**，
     * 而铺垫手段（frame / expose / watch / disguise / drain / befriend / plant_spy / false_ally）
     * 全都在 **serious 层** —— 于是序列 1 的半神反而只会反复用那三个「无前置」的手段。
     *
     * 修法：**把他真的要用的那一手的「铺垫」也放进池子**。
     * 于是链条自然长成：先做 prep（serious），再做杀招（grand）—— 那才是「布局」。
     */
    const wants = kindsFor(tier, nature);
    const preps = wants.map((k) => requiresFor(k)).filter((k): k is string => k !== null);
    const pool = [...new Set([...wants, ...preps])];
    const kinds = pool.filter((k) => !doneKinds.has(k) && canUseKind(k, doneKinds));
    if (kinds.length === 0) continue;
    const kind = kinds[Math.floor(schemeRng.next() * kinds.length)]!;
    const days = SCHEME_DAYS_BY_TIER[tier];
    if (deps.npcSchemes.activeOf(targetId).some((s) => s.npcId === rel.npcId)) continue;
    deps.npcSchemes.create({
      id: schemeIdOf(rel.npcId, targetId, kind),
      npcId: rel.npcId,
      targetId,
      kind,
      stage: 'lurk',
      startedAt: now,
      dueAt: now + (days.lurk + days.omen) * 86_400_000,
      revealedAt: null,
      foiledAt: null,
    });
    const name = deps.npcRoster.nameOf(rel.npcId);
    const targetName = deps.npcRoster.byId(targetId)?.name;
    deps.npcDeeds.record({ npcId: rel.npcId, kind: 'scheme', detail: `${name} 开始布局（${SCHEME_KIND_LABELS[kind] ?? kind} · ${SCHEME_NATURE_LABELS[nature]}）` + (targetName === undefined ? '' : ` → ${targetName}`), merit: 0, at: now });
  }
  for (const scheme of schemesAll) {
    if (scheme.foiledAt !== null || scheme.stage === 'strike') continue;
    // M2.164：布局的人死了，局就散了（死者不下棋）；目标死了，这一局也没有意义了
    if (dead.has(scheme.npcId) || dead.has(scheme.targetId)) continue;
    // ⚠️ M2.89：走 npcSequenceOf —— 直接读 npcProgress 会让所有人都是序列 9，
      // 于是 schemeTierOf(9) 恒为 petty，阴谋**只会生成最低档**（这个 bug 一直存在）
      const npcSeq = npcSequenceOf(deps, scheme.npcId);
    const tier = schemeTierOf(npcSeq);
    const next = stageAt(scheme.stage, scheme.startedAt, now, tier);
    if (next === scheme.stage) continue;
    deps.npcSchemes.setStage(scheme.id, next, now);
    if (next !== 'strike') continue;
    const npcName = deps.npcRoster.nameOf(scheme.npcId);
    const nature = natureOfKind(scheme.kind);
    // ⚠️ M2.164：目标是不是 NPC 要看**名册**（两份表合成的那一个）——
    //    只看轨道表的话，居民永远被当成「不是 NPC」，于是走到玩家的分支上去
    const isNpcTarget = deps.npcRoster.byId(scheme.targetId) !== null;
    /* NPC 之间的博弈：他们互相下棋，玩家是旁观者（只写世界事件） */
    if (isNpcTarget) {
      // M2.164：名字走 roster —— 名册里的居民也会被别人算计（在这之前只认轨道表，
      //    于是 120 位居民永远不会成为阴谋的目标，而且不报错）
      const tn = deps.npcRoster.nameOf(scheme.targetId);
      deps.worldEvents.insert({
        id: 'npc-scheme-npc-' + scheme.id + '-' + now,
        type: 'power',
        // NPC 之间用**性质**说话（手段名是对玩家的口吻，如「篡改你的记录」，套在 NPC 身上不通）
        text: `【世界 · 暗流】${SCHEME_NATURE_LABELS[nature]}` + '\n' + `${npcName}对${tn}动了手 —— 他们之间的事与你无关，但你看在眼里。`,
        visibility: 'public',
        createdAt: now,
      });
      deps.npcDeeds.record({ npcId: scheme.npcId, kind: 'scheme_strike', detail: `${npcName} 对 ${tn} 发动了${SCHEME_KIND_LABELS[scheme.kind] ?? scheme.kind}`, merit: 0, at: now });
      /*
       * M2.164：**这一手可能真的会死人**（用户拍板「NPC 死亡是真的死亡」）。
       *
       * 在这之前，NPC 之间的阴谋只写一条世界事件 —— 于是「算计」在这个世界里
       * 没有任何后果，只是一段文本。现在的口径（见 npc-life.ts 的档位表）：
       * 凡人死在局里 25%，序列 1 的天使 1.5%，序列 0 是 0（要动祂得走神战那条线）。
       */
      const targetSeq = npcSequenceOf(deps, scheme.targetId);
      if (killRng.next() < deathChanceOf(targetSeq, 'scheme')) {
        const line = deathLineOf(tn, 'scheme', npcName);
        deps.npcLife.kill({ npcId: scheme.targetId, kind: 'scheme', note: line, killer: scheme.npcId, at: now });
        deps.npcDeeds.record({ npcId: scheme.npcId, kind: 'kill', detail: `${npcName} 弄死了 ${tn}（${SCHEME_KIND_LABELS[scheme.kind] ?? scheme.kind}）`, merit: meritOfKill(targetSeq), at: now });
        deps.worldEvents.insert({
          id: 'npc-death-' + scheme.targetId + '-' + now,
          type: 'power',
          text: `【世界 · 死讯】${line}`,
          visibility: 'public',
          createdAt: now,
        });
      }
      continue;
    }
    const target = deps.characters.findById(scheme.targetId);
    if (target === null) continue;
    const facts = factsFromEvents(deps.characters.eventsOf(scheme.targetId));
    const text = strikeTextFor(scheme.kind, facts);
    /* 后果按**性质**落（六种机制，不写三十个分支） */
    const eff = effectOfNature(nature);
    const wantedFaction = deps.factions.all()[0]?.id ?? 'none';
    const issueWanted = (level: number, reason: string) => {
      deps.wanted.upsert({ id: 'scheme-wanted-' + scheme.id, characterId: target.id, level, factionId: wantedFaction, reason, createdAt: now, expiresAt: now + 30 * 86_400_000 });
    };
    switch (eff.target) {
      case 'item': {
        const slots = deps.inventory.list(target.id);
        if (slots.length > 0) deps.inventory.tryRemoveMany(target.id, [{ itemId: slots[0]!.itemId, qty: 1 }], now);
        break;
      }
      case 'hp':
        deps.characters.update({ ...target, hp: Math.max(1, target.hp - 8), mad: Math.min(100, target.mad + 4), updatedAt: now });
        if (scheme.kind === 'frame') issueWanted(2, '被指认做了一件没做过的事');
        if (scheme.kind === 'borrow_blade') issueWanted(3, '有人替你得罪了一个你打不过的人');
        break;
      case 'dp':
        deps.characters.update({ ...target, dp: Math.max(0, target.dp - 20), updatedAt: now });
        break;
      case 'dig':
        deps.characters.update({ ...target, dig: 0, promotionFails: (target.promotionFails ?? 0) + 1, updatedAt: now });
        break;
      case 'church':
        deps.characters.update({ ...target, churchContribution: 0, promotionFails: (target.promotionFails ?? 0) + 1, updatedAt: now });
        break;
      case 'wanted':
        issueWanted(2, '有人替你得罪了一个你打不过的人');
        break;
      case 'none':
        deps.npcDeeds.record({ npcId: scheme.npcId, kind: 'plant', detail: `${npcName} 在 ${target.name} 身上埋了一根线`, merit: 0, at: now });
        break;
    }
    deps.worldEvents.insert({
      id: 'scheme-strike-' + scheme.id + '-' + now,
      type: 'power',
      text: `【世界 · ${eff.headline}】${npcName}｜${SCHEME_KIND_LABELS[scheme.kind] ?? scheme.kind}` + '\n' + text,
      visibility: 'public',
      createdAt: now,
    });
    deps.characters.appendEvents([{
      type: 'npc_scheme_strike',
      characterId: scheme.targetId,
      payload: { npcId: scheme.npcId, kind: scheme.kind, nature, tier, schemeId: scheme.id },
      reason: 'NPC 的阴谋发动',
      seed: null,
      createdAt: now,
    }]);
    deps.npcDeeds.record({ npcId: scheme.npcId, kind: 'scheme_strike', detail: `${npcName} 的${SCHEME_KIND_LABELS[scheme.kind] ?? scheme.kind}发动了`, merit: 0, at: now });
  }
  /*
   * M2.85 RPG 化：**常在同一个地方出现，人情就有了**。
   *
   * 这是好感的三条路里最慢的一条（每天 15% 概率 +1）——
   * 但它是唯一**不需要做什么大事**的那种：你在哪条街上待着，就与谁熟。
   */
  const cohabitRng = createSeededRng(seedFrom(['npc-cohabit', date]));
  if (cohabitRng.next() < 0.15) {
    for (const person of deps.characters.all()) {
      const here = person.currentLocationId;
      if (here === null || here === undefined) continue;
      const locals = deps.npcProgress.atLocation(here).filter((p) => !dead.has(p.npcId));
      if (locals.length === 0) continue;
      const who = locals[Math.floor(cohabitRng.next() * locals.length)]!;
      deps.npcRelations.bump(who.npcId, person.id, 1, now);
    }
  }

  const calamity = calamityAt(deps.worldSeed ?? 'world', now);
  if (calamity !== null && calamity.level > 0) {
    const byId = new Map(deps.npcTracks.map((t) => [t.id, t]));
    const hero = deps.npcProgress
      .all()
      .filter((p) => p.sequence >= 1 && byId.has(p.npcId) && !dead.has(p.npcId) && canHandle(p.sequence, calamity.level))
      .sort((a, b) => a.sequence - b.sequence || a.npcId.localeCompare(b.npcId))[0];
    if (hero !== undefined) {
      const track = byId.get(hero.npcId)!;
      if (npcRng.next() < handleChance(hero.sequence, calamity.level)) {
        deps.npcDeeds.record({ npcId: hero.npcId, kind: 'calamity', detail: `${track.name} 化解了「${calamity.name}」`, merit: meritOfCalamity(calamity.level), at: now });
        deps.worldEvents.insert({
          id: 'npc-calamity-' + hero.npcId + '-' + calamity.dayIndex,
          type: 'calamity',
          text: `【世界 · 灾厄】${track.name} 出手\n「${calamity.name}」被压了下去 —— 出手的是序列 ${hero.sequence} 的${track.name}。`,
          visibility: 'public',
          createdAt: now,
        });
      } else {
        /*
         * M2.164：化解失败**可能死在里面** —— 灾厄不是背景板。
         * 凡人六成会死，天使只有 4%（见 npc-life.ts 的档位表）。
         */
        if (killRng.next() < deathChanceOf(hero.sequence, 'calamity')) {
          const line = deathLineOf(track.name, 'calamity', '');
          deps.npcLife.kill({ npcId: hero.npcId, kind: 'calamity', note: line, killer: '', at: now });
          deps.npcDeeds.record({ npcId: hero.npcId, kind: 'death', detail: `${track.name} 死在「${calamity.name}」里`, merit: 0, at: now });
          deps.worldEvents.insert({
            id: 'npc-death-calamity-' + hero.npcId + '-' + calamity.dayIndex,
            type: 'calamity',
            text: `【世界 · 死讯】${line}\n他去处理「${calamity.name}」，没有回来。`,
            visibility: 'public',
            createdAt: now,
          });
        } else {
          deps.npcDeeds.record({ npcId: hero.npcId, kind: 'injury', detail: `${track.name} 在「${calamity.name}」中受了伤`, merit: 0, at: now });
        }
      }
    }
  }
  for (const track of deps.npcTracks) {
    // M2.164：死了的人不再晋升 —— 「永久」这条口径在这里最关键（否则死人还会登神）
    if (dead.has(track.id)) continue;
    // ⚠️ 原作里**已经坐在神位上的**（克莱恩 / 罗塞尔等，currentSequence = 0）不纳入演化：
    //    他们本来就是神，不能被算成「世界演化里新登神的人」——那是 pantheon.yaml 的记载。
    if (track.currentSequence === null || track.currentSequence <= 0) continue;
    const progress = deps.npcProgress.of(track.id);
    if (progress === null) {
      /*
       * M2.85：播种的同时**安置位置** —— 按他的主途径，落在该途径传承城市的一处地点上。
       *
       * 为什么按途径：原著里「走哪条途径」与「在哪儿活动」是绑着的（黑夜女神的信徒在鲁恩、
       * 死神途径的人在南大陆的部族…）。用 id 的哈希挑，保证**同一个人每次都落在同一处**
       * （重跑与逐日跑一致），而不同的人自然散开。
       */
      const pathway = track.pathways[0] ?? null;
      /*
       * ⚠️ 安置要落到**街区**，不能落到城市节点上。
       *
       * 第一版用 deps.geo.city(l.id) 判断，而它只对**城市 id 本身**返回城市 ——
       * 街区（mist_street 之类）不属于任何城市，于是 31 个人全都站在城市节点上，
       * 而玩家 .看 看到的是街区 → **街上永远没有人**。
       * 正确做法是从城市的 locations（街区清单）里挑。
       */
      const cities = loadContent().cities;
      const homeCities = pathway === null ? [] : cities.filter((c) => (c.pathways as readonly string[]).includes(pathway));
      const pool = [...new Set(homeCities.flatMap((c) => c.locations ?? []))].filter((id) => deps.locations.get(id) !== undefined);
      const fallback = [...new Set(cities.flatMap((c) => c.locations ?? []))].filter((id) => deps.locations.get(id) !== undefined);
      const candidates = pool.length > 0 ? pool : fallback;
      let h = 0;
      for (const ch of track.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const home = candidates.length > 0 ? candidates[h % candidates.length]! : null;
      deps.npcProgress.seed({ npcId: track.id, sequence: track.currentSequence, since: now, ascensions: 0, godhoodAt: null, locationId: home });
      continue;
    }
    if (progress.sequence <= 0) continue;
    /*
     * 成神门槛（用户拍板：不能窜一下就成神）：
     * 序列 1 的人要把 1 → 0 走完，除了「时间够」（21 年），还必须**功绩过线**
     * （例如化解 4 次神话级灾厄）。单靠躺着等时间，永远登不了神。
     */
    if (progress.sequence === 1 && !qualifiedForGodhood({ sequence: 1, merit: deps.npcDeeds.meritOf(track.id) })) continue;
    if (!willAscend({ sequence: progress.sequence, since: progress.since, now, roll: npcRng.next() })) continue;
    const after = deps.npcProgress.ascend(track.id, now);
    if (after === null) continue;
    const isGod = after.sequence <= 0;
    deps.npcDeeds.record({
      npcId: track.id,
      kind: isGod ? 'godhood' : 'advance',
      detail: isGod
        ? `${track.name} 走到序列 0，成为这条途径的神`
        : `${track.name} 升到序列 ${after.sequence}`,
      at: now,
    });
    if (isGod) {
      const pathways = track.pathways.length > 0 ? track.pathways.join('、') : '其所走的途径';
      deps.worldEvents.insert({
        id: 'npc-god-' + track.id + '-' + now,
        type: 'power',
        text: `【世界 · 神位】${track.name} 登神\n他走到了序列 0 —— ${pathways} 这条途径自此有了一位新的神。`,
        visibility: 'public',
        createdAt: now,
      });
    }
  }

  /*
   * ═══════ M2.164：**名册居民也要站在世界上** ═══════
   *
   * 120 位居民有常驻地点（npc-cast.yaml 的 location）—— 不播种的话，
   * 场景里永远看不到他们，阴谋与好感也落不到他们身上：名册就只是一份数据。
   *
   * ⚠️ 他们**不参与晋升**：上面那一条循环仍然只走 npc-tracks。
   * 「谁在路上」与「谁在城里」是两件事 —— 混起来会让巡警也开始登神。
   */
  for (const npc of deps.npcCast) {
    if (npc.location === '') continue;   // 居无定所的人不占位置
    if (dead.has(npc.id)) continue;      // 死人不占位置
    if (deps.npcProgress.of(npc.id) !== null) continue;
    deps.npcProgress.seed({
      npcId: npc.id,
      sequence: npc.sequence,
      since: now,
      ascensions: 0,
      godhoodAt: null,
      locationId: npc.location,
    });
  }

  /*
   * ═══════ M2.167③：**教会来清理**（用户点名的那一条）═══════
   *
   * `zone.ts` 里 `orderPressure` 的注释早就写着「秩序高的地方，非凡生物活不长
   * （有人来清剿）」—— 但那是个**没有执行者的抽象**。这一段给它补上执行者。
   *
   * 三道门（全按原作，不另编分数）：
   *   ① **有没有编制** —— 只有值夜者 / 代罚者 / 机械之心 / 净化者四家会做这件事
   *      （`04-神明与教会/七正神.yaml` 的 extraordinary_squad_code；其余三家没有编制，所以不来）
   *   ② **有没有人** —— 这座城里该教会的居民 NPC，还活着、还是人、能打的先上
   *   ③ **打不打得过** —— 复用猎杀资格闸 `canHunt`：差不够就**不上**（等精英，
   *      而等的那段时间里它还在吃人）
   *
   * 三条结果都有代价（原作里这种事是要死人的：洛薇雅小队疯掉的队员「被清除」、
   * 邓恩·史密斯在邪神子嗣事件里牺牲）：清掉了 / 受伤抬回来 / 没能回来。
   *
   * ⚠️ 播报**写教会与编制名** —— 与神明行动（匿名 rumor）不同：
   *    教会的清剿是公开的治安行为，原作里也确实登报。两套口径不能混。
   */
  const beastLives = deps.npcLife.beasts();
  if (beastLives.length > 0) {
    const cullRng = createSeededRng(seedFrom(['npc-cull', date]));
    for (const life of beastLives) {
      const instance = deps.creatures.byId(life.beastId);
      // 已经被人打死了（玩家抢在前面）—— 那就没有可清剿的东西了
      if (instance === null) continue;
      const city = deps.geo.cityOfLocation(instance.locationId);
      if (city === null) continue;

      /*
       * M2.169：**失了庇护的教会不再出清剿队** —— 神倒下之后，高序列的走了、封印物调走了，
       * 于是那座城里的怪物没人清理（这是「神的死」落到玩家身上最直接的一层）。
       * 被吞并的教会照常出人（换了个主人而已）。
       */
      const here = deps.churches
        .churchesOfCity(city.id)
        .filter((c) => willCull(c.id) && stillActive(deps.churchStates?.fateOf(c.id) ?? 'intact'));
      if (here.length === 0) continue;
      const church = here[Math.floor(cullRng.next() * here.length)]!;
      const squad = squadOf(church.id)!;
      const pool = deps.npcRoster.all
        .filter((e) =>
          e.source === 'cast' && e.city === city.id && e.church === church.id &&
          deps.npcLife.isAlive(e.id) && deps.npcLife.isHuman(e.id),
        )
        // 序列小的先上：能打的先去（打不过的话，这道门会把它挡在外面）
        .sort((a, b) => (a.sequence ?? 9) - (b.sequence ?? 9));
      const culler = pool[0];
      if (culler === undefined) continue;
      const outcome = cullOutcome({
        cullerSequence: culler.sequence ?? 9,
        beastSequence: instance.sequence,
        rng: cullRng,
      });
      // 打不过 —— 等精英。这一段里它还在吃人（这条「迟到的代价」是有意的）
      if (outcome === null) continue;
      const beastName = deps.npcRoster.nameOf(life.npcId);
      if (outcome === 'success') {
        deps.creatures.deleteMany([instance.id]);
        deps.npcDeeds.record({
          npcId: culler.id,
          kind: 'cull',
          detail: culler.name + '（' + squad + '）清掉了「' + beastName + '」',
          merit: meritOfKill(instance.sequence),
          at: now,
        });
        deps.worldEvents.insert({
          id: 'npc-cull-' + life.npcId + '-' + now,
          type: 'power',
          text: '【世界 · 清剿】' + cullLineOf(culler.name, squad, beastName, 'success'),
          visibility: 'public',
          createdAt: now,
        });
      } else if (outcome === 'injury') {
        deps.npcDeeds.record({ npcId: culler.id, kind: 'injury', detail: culler.name + ' 从「' + beastName + '」手底下被抬了回来', merit: 0, at: now });
        deps.worldEvents.insert({
          id: 'npc-cull-hurt-' + life.npcId + '-' + now,
          type: 'rumor',
          text: '【世界 · 清剿】' + cullLineOf(culler.name, squad, beastName, 'injury'),
          visibility: 'public',
          createdAt: now,
        });
      } else {
        const line = deathLineOf(culler.name, 'creature', beastName);
        deps.npcLife.kill({ npcId: culler.id, kind: 'creature', note: line, killer: instance.id, at: now });
        deps.npcDeeds.record({ npcId: culler.id, kind: 'death', detail: culler.name + ' 去清剿「' + beastName + '」，没能回来', merit: 0, at: now });
        deps.worldEvents.insert({
          id: 'npc-cull-death-' + life.npcId + '-' + now,
          type: 'power',
          text: '【世界 · 清剿】' + cullLineOf(culler.name, squad, beastName, 'death'),
          visibility: 'public',
          createdAt: now,
        });
      }
    }
  }

  return {
    date,
    skipped: false,
    characters: characters.length,
    recovered,
    lostControl,
    tradesExpired,
    eventsPruned,
    notifications,
  };
}

/** 只读取证：给定角色与日期，算出这次 tick 会抽到的失控代价（供测试与排查） */
export function previewTickPenalty(date: string, characterId: string): number {
  const rng = createSeededRng(seedFrom(['tick', date, characterId]));
  // planCharacterTick 内部先掷失控判定，再掷 HP 损失；这里只复现 HP 区间
  void rng;
  return randomInt(createSeededRng(seedFrom(['tick', date, characterId, 'hp'])), NUMERIC.tick.lostControlHpMin, NUMERIC.tick.lostControlHpMax);
}
