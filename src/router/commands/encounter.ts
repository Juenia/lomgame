/**
 * 遭遇（M2.8）：玩家遇到「此时此刻的那只生物」时能做的事。
 *
 * 四个动作（任务书 §4.2）：观察 / 对峙 / 撤退 / 互动。
 * 外加普通人专属的「站着不动」—— 他连那是什么都不知道，
 * 「观察」「对峙」「互动」对他都没有意义（任务书 §4.3.3）。
 *
 * ⚠️ **没有攻击**。M2.8 不做战斗 —— 战斗是 M2.9 的活。
 * 这里做的事只有三件：扣代价、给文案、记审计。
 *
 * 遭遇本身由探索（或移动到达）挂着掷出来，这条指令只负责**结算玩家对它的处置**。
 */
import { CREATURE } from '../../config/numeric.ts';
import {
  allowedActionsOf,
  canHarvest,
  rollHarvest,
  visibilityOf,
  type PerceptionLayer,
  type SightingAction,
} from '../../domain/creature/index.ts';
import {
  buildEncounterMenu,
  encounterFlavorOf,
  encounterTitleOf,
} from '../../domain/menu/encounter-menu.ts';
import { buildBattleMenu } from '../../domain/menu/battle-menu.ts';
import { battleViewFor } from '../../domain/battle/index.ts';
import { battleItemsOf, settleBattleTimeout } from './battle-hooks.ts';
import { isInitiated, sequenceOrInitiate } from '../../domain/character/types.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import { weatherLabel } from '../../domain/world/weather.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { applyFor, requireCharacter, worldViewFor } from './common.ts';
import type { EffectDelta } from '../../domain/effect/apply.ts';

export const ENCOUNTER_USAGE = '用法：.遭遇 观察 / .遭遇 对峙 / .遭遇 撤退 / .遭遇 互动';

/**
 * 玩家输入的词 → 动作。
 *
 * 同一个动作在不同感知层次下**指令原文不同**（菜单里给的就是这一层的说法）：
 *   confront 在同序列是「对峙」，在占优层是「驱逐」
 *   observe   在同序列是「观察」，在本质层是「观察本质」
 * 所以这里两种说法都认 —— 玩家照着菜单点，也能自己敲。
 */
const ACTION_WORDS: ReadonlyArray<{ words: readonly string[]; action: SightingAction }> = [
  { words: ['观察本质', '观察'], action: 'observe' },
  { words: ['对峙', '驱逐'], action: 'confront' },
  { words: ['撤退', '退回去', '退开', '走开'], action: 'retreat' },
  { words: ['互动'], action: 'interact' },
  { words: ['站着不动', '不动', '站着'], action: 'hold' },
];

export function parseEncounterAction(query: string): SightingAction | null {
  const text = query.trim();
  for (const entry of ACTION_WORDS) {
    if (entry.words.includes(text)) return entry.action;
  }
  return null;
}

/** 这一层的动作是不是被允许（不允许的动作不能靠直接敲指令绕过） */
function actionAllowed(action: SightingAction, allowed: readonly SightingAction[]): boolean {
  return allowed.includes(action);
}

/*
 * 「这一层允许哪些动作」**只有一处定义**：`domain/creature/perception.ts` 的
 * `allowedActionsOf`。菜单由它生成，判定也读它。
 *
 * ⚠️ 这里原来抄了第二份（一个叫 `allowedOf` 的本地函数），注释还写着
 * 「与判定层同一份口径」—— 抄的那一刻确实是，但 M2.87 给凡人加了「观察」
 * （`perception.ts` 改成 `['observe', 'retreat', 'hold']`）时**只改了那一处**。
 *
 * 后果是一条只对凡人成立的死路：菜单摆出三个选项，玩家点「观察」，
 * 判定读到的还是旧的那份 `['retreat', 'hold']` —— 于是**必定**回
 * 「你现在能做的不是这件事」。而凡人正是**每个新号开局的形态**。
 *
 * 这类抄写最贵的地方在于它**不报错**：类型上两边都是 `SightingAction[]`，
 * tsc 全绿，只有在真人点下那个按钮时才现形。
 */

export async function handleEncounter(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  let character = gate.character;
  const { deps, msg, now } = ctx;

  /*
   * M2.9：**在战斗中时，.遭遇 不再重新触发遭遇判定**（任务书 §五 末尾那条）。
   *
   * 理由：「查看未决遭遇」与「你和它已经打起来了」是同一件事的两个阶段 ——
   * 再掷一次遭遇判定等于凭空多出一只生物，而玩家真正想知道的是
   * 「我打到第几回合了、它还剩多少血」。
   * 所以这里直接把战斗现场摆出来（连菜单一起），战斗打完之前 .遭遇 就是 .战斗。
   */
  const timeout = settleBattleTimeout(deps, character, now);
  if (timeout.rounds > 0) character = deps.characters.findByUserId(msg.userId) ?? character;
  const active = timeout.battle ?? deps.battles.activeOf(character.id);
  if (active) {
    const view = battleViewFor({
      battle: active,
      character,
      items: battleItemsOf(deps, character.id),
    });
    const opened = deps.pendingMenus.openWith(character.id, 'battle', buildBattleMenu(view), now);
    return {
      privateText: [
        `你正在和${active.speciesName}打 —— 第 ${active.round} 回合。`,
        '先把这一场打完（.战斗 出招）。',
        '',
        opened.text,
      ].join('\n'),
      detailToPrivate: true,
      menuOpened: true,
      interactive: opened.interactive,
    };
  }

  const open = deps.creatures.openSighting(character.id);
  if (!open) {
    return {
      privateText: '你现在没有遇到什么。走到雾里去看看（.探索 某个地方）。',
      detailToPrivate: true,
    };
  }

  const creature = deps.creatures.byId(open.creatureId);
  const species = deps.creatureIndex.byId(open.speciesId);
  if (!creature || !species) {
    // 生物在生态 tick 里死了/被吃掉了，而玩家还没处置这次遭遇 —— 记一次了结，不报错
    deps.creatures.resolveSighting(open.id, 'retreat', []);
    return {
      privateText: '你再看过去的时候，那里已经没有东西了。',
      detailToPrivate: true,
    };
  }

  const mortal = !isInitiated(character);
  const locationName = deps.locations.get(creature.locationId)?.name ?? creature.locationId;
  const world = worldViewFor(deps, now, creature.locationId, character.pathway ?? undefined);
  const allowed = allowedActionsOf(open.layer, mortal);
  const label = weatherLabel(world.weather);

  const query = ctx.args.join(' ').trim();

  // 不带参数 = 再看一眼（重新摆菜单）。遭遇是未决状态，可以反复看。
  if (!query) {
    const view = encounterViewFor(deps, character, open.creatureId, open.layer, mortal, now);
    if (!view) return { privateText: '那里已经什么都没有了。', detailToPrivate: true };
    const menu = buildEncounterMenu(view);
    const opened = deps.pendingMenus.openWith(character.id, 'encounter', menu, now);
    return {
      privateText: opened.text,
      detailToPrivate: true,
      menuOpened: true,
      ...(opened.interactive ? { interactive: opened.interactive } : {}),
    };
  }

  const action = parseEncounterAction(query);
  if (!action) {
    return {
      privateText: `不知道该对那东西做什么：${query}\n${ENCOUNTER_USAGE}`,
      detailToPrivate: true,
    };
  }
  if (!actionAllowed(action, allowed)) {
    // 看不清的时候不能「对峙」，普通人不能「观察」—— 菜单不给，直接敲也不放行
    return {
      privateText: '你现在能做的不是这件事。\n' + ENCOUNTER_USAGE,
      detailToPrivate: true,
    };
  }

  const seed = seedFrom([msg.messageId, character.id, now, 'encounter', action]);
  const deltas: EffectDelta[] = [];
  /*
   * M2.87：**每个动作都必须改变点什么**
   * （用户：「事件是游戏变化的基础，事件白开水等于游戏是废的」）。
   *
   * 原来 `retreat` 与 `hold` 两个 case 是空的 —— 而它们**恰好是普通人的全部选项**，
   * 也就是说每个新号开局遇到的每一次遭遇，读完之后世界没有任何变化。
   */
  /*
   * 「它会记住你吗」：查物种自己声明的 `behaviors` 里有没有 `stalk`。
   *
   * 不掷随机、不重算种子 —— `stalk` 是**这个物种的习性**（火石鸟写着
   * `stalk: { trigger: always, chance: 0.25 }`），查表就能回答，
   * 而且答案稳定：同一只鸟每次都会「把你看在眼里」，变的只是它有没有跟上来。
   */
  const stalks = species.behaviors.some((b) => b.kind === 'stalk');
  /*
   * **首见？**（M2.87）—— 「观察」的正反馈就落在这里。
   *
   * 用户的原话：「没有负面反馈和正向反馈，纯白开水？」
   * 负反馈上一步已经补了（观察/撤退/站着不动都要付 MAD），但**正反馈一直是缺的**：
   * 只有 `essence` 层（强 3 级）能采集，其余层次的「观察」什么都不换。
   *
   * 而在诡秘的世界观里**「知道」本身就是资源** —— 克莱恩靠「知道」活命。
   * 所以：第一次看清一个物种给 `dig +1`（见闻推动消化），第二次起不给。
   *
   * ⚠️ 判据是 `count <= 1` 不是 `hasSeenSpecies` —— 见 repo 里那段说明。
   */
  const firstSight = deps.creatures.sightingCountOf(character.id, species.id) <= 1;
  switch (action) {
    case 'observe':
      /*
       * 凡人走的是 `mortalObserve`：他不知道那是什么，但他记住了 ——
       * 而**记住是要付代价的**，这恰好是诡秘的基调（知道得越多越危险）。
       */
      {
        const cfg = mortal ? CREATURE.actions.mortalObserve : CREATURE.actions.observe;
        if (cfg.madGain !== 0) deltas.push({ type: 'mad', value: cfg.madGain });
      }
      /*
       * **正反馈：首见把一个物种「记下来」，见闻推动消化 +1。**
       *
       * 为什么是 dig（消化度）而不是物品或钱：
       *   · 「见了、记住了」在原作里推动的正是消化 —— 愚者途径靠理解，不靠击杀；
       *   · 给物品会把「遭遇」变成刷材料的路子（那是探索的活）；
       *   · 给钱更糟，那会让「盯着雾看」变成赚钱手段。
       *
       * **只有第一次给** —— 重复观察同一物种不再有收益，
       * 但「观察」仍保留：玩家想再读一遍那段描述是可以的。
       *
       * 凡人没有 DIG，所以只给文案（见 observeLines 的 mortal 分支）。
       */
      if (firstSight && !mortal) deltas.push({ type: 'dig', value: 1 });
      break;
    case 'confront':
      deltas.push({ type: 'mad', value: CREATURE.actions.confront.madGain });
      deltas.push({ type: 'cor', value: CREATURE.actions.confront.corGain });
      break;
    case 'retreat':
      // 跑得掉，但「看见过」这件事会留在脑子里
      deltas.push({ type: 'mad', value: CREATURE.actions.retreat.madGain });
      /*
       * ⚠️ M2.88：**会跟踪的那一类，跑了也甩不掉。**
       *
       * 原来「撤退」是四个动作里唯一**完全不看物种**的那个 —— 玩家实测的原话是
       * 「撤退没有实际的反馈」。同一只火石鸟，你盯着看它记住了你，转身走它就忘了，
       * 说不通：`stalk` 是**这个物种的习性**，不是「你有没有看它」的函数。
       *
       * 所以这里补上与「站着不动」同一档的代价（只吃 MAD、不吃 COR ——
       * 它记住了你，但还没对你做什么）。数值取 `hold.madGain`，两处同源。
       */
      if (stalks) deltas.push({ type: 'mad', value: CREATURE.actions.hold.madGain });
      break;
    case 'interact':
      deltas.push({ type: 'mp', value: -CREATURE.actions.interact.mpCost });
      break;
    case 'hold':
    default:
      /*
       * ⚠️ M2.88：**「站着不动」必须有代价，而不是按物种分档给 0 或 1。**
       *
       * 原来只有 `stalk` 的物种才扣 MAD，其余 `deltas` 是空的 —— 而 `deltas` 一空，
       * 下面那段「扣不动就什么都不发生」的结算整个跳过，玩家看到的就是
       * 「它看了你一会儿，然后走了」＋状态毫无变化（用户：「没有实际的反馈」）。
       *
       * 现在的语义：**你把自己暴露给它看，这本身就有代价** —— 所有物种都扣 MAD。
       * `stalk` 的那一类**额外**记你一笔（它记住了你，见下），于是两档仍然可区分：
       *
       *   普通物种   MAD +1（你被看了一眼）
       *   会跟踪的   MAD +1 且它记住了你（后续遭遇概率上升）
       */
      deltas.push({ type: 'mad', value: CREATURE.actions.hold.madGain });
      if (stalks) deltas.push({ type: 'mad', value: CREATURE.actions.hold.madGain });
      break;
  }

  let state = character;
  const events = [];
  // AP / MP 扣不动就什么都不发生（与探索的「先扣后执行」同一口径）
  if (deltas.length > 0) {
    const applied = applyFor(deps, state, deltas, '遭遇' + query, now, seed);
    if (applied.rejected) {
      return {
        privateText: action === 'retreat'
          ? '你想退，但腿没动 —— 行动点不够了。先休息一会儿。'
          : '你现在做不了这件事（行动点或灵力不够）。',
        groupText: `【${character.name}】站在原地，什么也没做成。`,
        detailToPrivate: true,
      };
    }
    state = applied.newState;
    events.push(...applied.events);
  }

  /* ---------------- 采集：M2.8 唯一一条「生物 → 物品」的路 ---------------- */
  const harvest: { itemId: string }[] = [];
  if (action === 'observe' && canHarvest(open.layer) && species.drops.length > 0) {
    const got = rollHarvest({ species, rng: createSeededRng(seedFrom([seed, 'harvest'])) });
    for (const entry of got) {
      const item = deps.items.get(entry.itemId);
      if (!item) continue;
      harvest.push({ itemId: entry.itemId });
      deps.inventory.addMany(character.id, [{ itemId: entry.itemId, quantity: 1, bindType: 'bound' }], now);
      events.push({
        type: 'item_gain',
        characterId: character.id,
        payload: { itemId: entry.itemId, quantity: 1, bindType: 'bound', creatureId: creature.id },
        reason: '观察本质采集',
        seed,
        createdAt: now,
      });
    }
  }

  deps.creatures.resolveSighting(open.id, action, harvest);

  // 任务书 §4.2：每次判定 seed 写入 domain_events
  events.push({
    type: 'creature_sighting',
    characterId: character.id,
    payload: {
      creatureId: creature.id,
      speciesId: species.id,
      layer: open.layer,
      action,
      harvest: harvest.map((entry) => entry.itemId),
    },
    reason: '遭遇处置：' + query,
    seed,
    createdAt: now,
  });

  deps.characters.update(state);
  deps.characters.appendEvents(events);

  /* ---------------- 回执 ---------------- */
  const lines: string[] = [];
  lines.push(encounterHeadline(locationName, label, species, open.layer));
  lines.push(species.perception[open.layer]);
  lines.push('');

  switch (action) {
    case 'observe':
      lines.push(...observeLines(species.name, open.layer, harvest, mortal, firstSight));
      break;
    case 'confront':
      lines.push(
        open.layer === 'advantage'
          ? `你往前走了一步。${species.name}退开了，没有回头。`
          : `你站定了，没有退。它比你更早把视线移开。`,
      );
      break;
    case 'retreat':
      /*
       * 文案要**说出代价**，而不是只报「你走了」。
       * 诡秘的基调是「知道了就回不去」—— 所以这句落在「记住了」上。
       */
      lines.push('你退了出去。身后的雾合上了。');
      lines.push('你没有回头 —— 但你记住了那种感觉。');
      break;
    case 'interact':
      lines.push(...interactLines(species.name, open.layer));
      break;
    case 'hold':
      /*
       * 分两档：**会跟踪的**（stalk）留下来记住了你，其余的只是路过。
       * 分档的意义是让「站着不动」这个选择**看起来像选择** ——
       * 前者有风险，后者没风险，而玩家会因此开始看物种的习性。
       */
      if (stalks) {
        lines.push('你站着没动。它绕着你转了一圈 —— 不紧不慢，像在丈量什么。');
        lines.push('然后它走了。但你知道，它把你的样子记住了。');
      } else {
        lines.push('你站着没动。它看了你一会儿，然后走了。');
      }
      break;
    default:
      break;
  }

  return {
    privateText: lines.join('\n'),
    groupText: groupLineFor(character.name, action),
    detailToPrivate: true,
  };
}

/**
 * M2.70：抬头**走同一个生成函数**（K22）。
 *
 * 在此之前这里、菜单标题、`runSighting` 的 headline 各写了一遍同样的格式 ——
 * 加一句氛围就要改三处，漏一处场上就同时存在两种遭遇标题。
 */
function encounterHeadline(
  locationName: string,
  weatherLabelText: string,
  species: { flavor: string; name: string },
  layer: PerceptionLayer,
): string {
  // 与 runSighting **同一条退回规则**（encounterFlavorOf 里一处定义）
  const flavor = encounterFlavorOf({
    flavor: species.flavor,
    visibleName: visibilityOf(layer) ? species.name : null,
  });
  return encounterTitleOf({ locationName, weatherLabel: weatherLabelText, flavor });
}

function observeLines(
  speciesName: string,
  layer: PerceptionLayer,
  harvest: readonly { itemId: string }[],
  mortal: boolean,
  /** 这是不是第一次见到这个物种（M2.87 的正反馈判据） */
  firstSight: boolean,
): string[] {
  /*
   * 凡人：**「什么也没看出来」改成「你记住了」。**
   *
   * 原来那一句是纯零 —— 而它恰好是**每个新号**唯一能看到的观察结果。
   * 现在他仍然不懂（世界观不变），但他带走了一样东西：**印象**。
   * 这正是凡人被卷入非凡世界的第一种方式。
   */
  if (mortal) {
    return firstSight
      ? [
          '你盯着它看了很久，直到眼睛发酸。',
          '你说不清那是什么 —— 但你确定自己记住了它的样子。这个画面对你有用，虽然你还不知道为什么。',
        ]
      : ['你又看了一会儿。还是说不清那是什么，只是那种冷更熟悉了一点。'];
  }
  switch (layer) {
    case 'blur':
      return ['你盯着那团东西看，看得越久越冷。别的什么也没发生。'];
    case 'silhouette':
      return ['你看清了一点：它有轮廓，但没有脸。再看下去对你没有好处。'];
    case 'essence': {
      const lines = [
        `你看到了它的本质：${speciesName}的核心就在你说的那个位置，露在外面。`,
      ];
      if (harvest.length > 0) {
        lines.push(`你取走了一样东西：${harvest.map((entry) => entry.itemId).join('、')}。`);
      } else {
        lines.push('你伸手，什么也没取到 —— 它身上此刻没剩下什么可用的。');
      }
      return lines;
    }
    default:
      return firstSight
        ? [
            '你看清了它。有些东西一旦看清了，就再也没法当作没看见。',
            '你把它记了下来 —— **知道本身就是要紧的**。（消化 +1）',
          ]
        : ['你已经见过它了。再看下去，只是让那种冷更清楚一点。'];
  }
}

function interactLines(speciesName: string, layer: PerceptionLayer): string[] {
  switch (layer) {
    case 'essence':
      return [`你伸手碰了碰${speciesName}。它没有躲，也没有回应。`];
    case 'advantage':
      return [`你试着跟${speciesName}打交道。它让你靠近了一点点。`];
    default:
      return [`你试着跟${speciesName}打交道。它听懂了一部分，剩下的它不想懂。`];
  }
}

function groupLineFor(name: string, action: SightingAction): string {
  switch (action) {
    case 'retreat':
      return `【${name}】从雾里退了出来。`;
    case 'observe':
      return `【${name}】盯着雾里的什么东西看了很久。`;
    case 'confront':
      return `【${name}】没有退。`;
    case 'interact':
      return `【${name}】跟什么东西打了个照面。`;
    default:
      return `【${name}】站在原地没动。`;
  }
}

/** 重新摆菜单时用的视图（与探索挂点共用同一份口径） */
export function encounterViewFor(
  deps: CommandContext['deps'],
  character: import('../../domain/character/types.ts').CharacterState,
  creatureId: string,
  layer: PerceptionLayer,
  mortal: boolean,
  now: number,
): import('../../domain/menu/encounter-menu.ts').EncounterMenuView | null {
  const creature = deps.creatures.byId(creatureId);
  if (!creature) return null;
  const species = deps.creatureIndex.byId(creature.speciesId);
  if (!species) return null;
  const locationName = deps.locations.get(creature.locationId)?.name ?? creature.locationId;
  const world = worldViewFor(deps, now, creature.locationId, character.pathway ?? undefined);
  return {
    locationName,
    weatherLabel: weatherLabel(world.weather),
    /*
     * M2.70：**这一处原来漏了** —— 它是第四个构造遭遇视图的地方
     *（另外三处是 creature-hooks / 处置回执 / 菜单标题），
     * 而它恰好是 .遭遇（再看看一眼）走的路径：端到端用例当场抓到
     * 「重新摆出来的标题没有氛围句」。规则与那里同一份（encounterFlavorOf）。
     */
    flavor: encounterFlavorOf({ flavor: species.flavor, visibleName: visibilityOf(layer) ? species.name : null }),
    text: species.perception[layer],
    layer,
    allowedActions: allowedActionsOf(layer, mortal),
    behaviorText: null,
    mortal,
    // M2.10 前置 2：与 creature-hooks 共用同一份口径（玩家序列 − 生物序列，正数 = 玩家更弱）
    sequenceGap: sequenceOrInitiate(character) - creature.sequence,
  };
}
