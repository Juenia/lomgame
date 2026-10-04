/**
 * 上下文推进（M2.3 任务二）：每条指令执行完，主动给下一步选项。
 *
 * 复用任务一的 `Menu` 接口，只是选项更短（NUMERIC.menu.nextOptionCount = 4）、
 * 按当前状态推荐 —— 任务书 §4.3。
 *
 * 覆盖范围（任务书 §4.2 要求至少 8 条）：
 *   扮演 / 探索 / 魔药 / 服用 / 晋升 / 休息 / 净化 / 确认（交易）—— 见 `CONTINUATIONS`。
 *   其余指令（状态、背包、世界、占卜、事件、队伍、使用…）也走同一条出口，
 *   落到「通用兜底」，所以**任何一条指令执行完都不会出现死胡同**。
 *
 * 纯函数：不读库、不掷骰。需要的东西全在 MenuCharacter / WorldSnapshot 里。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { PATHWAY_LABELS } from '../character/rules.ts';
import { TIME_OF_DAY_LABELS } from '../world/clock.ts';
import { weatherLabel } from '../world/weather.ts';
import { phraseOf } from './phrases.ts';
import { matchLabel } from './play-menu.ts';
import { scorePlay } from '../play/score.ts';
import { inCurrentCity } from './types.ts';
import { sequenceOrInitiate } from '../character/types.ts';
import type { InventoryItem, LocationView, Menu, MenuCharacter, MenuOption, PathwayKit, WorldSnapshot } from './types.ts';

/** 「今天最多扮演几次」：标签每日上限（tagDailyCap）决定了再多的扮演也不涨消化度 */
const PLAYER_MODEL_PLAY_CAP = 30;

export interface NextMenuInput {
  state: MenuCharacter;
  world: WorldSnapshot;
  /**
   * M2.7.6：普通人的「下一步」是**另一套** ——
   * 他没有途径，所以扮演 / 魔药 / 晋升 / 仪式这四条路对他都不存在，
   * 给他摆出来只会得到一串「你做不了这件事」。
   * 于是 pathway 变成可选：undefined = 还没走上任何一条路（见 buildMortalNextMenu）。
   */
  pathway?: PathwayKit;
  /** 刚执行完的指令名（去掉点号与参数，如 '扮演'） */
  after: string;
  /** 刚执行完那条指令的原文（不含前导点号），用于「再来一次」类选项 */
  command?: string;
  /** 结果里值得写进菜单上下文的一句话（例如「DIG 52 → 53.2」） */
  notes?: readonly string[];
  /**
   * M2.86：**刚看过/走过时，正文里列出的那些出口**（由 `.看` 交出）。
   *
   * 有它就用它 —— 按钮必须与正文说同一批地方；没有才退回 `world.locations`。
   */
  exits?: readonly { name: string; danger: number }[];
  /** M2.86：**指令自己交出的下一步按钮**（优先于本文件里的一切推断） */
  actions?: readonly { label: string; command: string; preview?: string }[];
}

/** 挑一个今天最「值钱」的标签（还没用满 tagDailyCap 的优先，其次用量最少的） */
function freshestTag(state: MenuCharacter, kit: PathwayKit): string {
  const cap = NUMERIC.playScore.tagDailyCap;
  const pool = [...kit.tags.core, ...kit.tags.secondary];
  const rank = (tag: string): number => state.tagUsage?.get(tag) ?? 0;
  const usable = pool.filter((tag) => rank(tag) < cap);
  const list = usable.length > 0 ? usable : pool;
  return [...list].sort((a, b) => rank(a) - rank(b))[0] ?? '观察';
}

/** 可达、今天还没探满、且**在本城**的地点（按危险度降序，先给最有内容的那个） */
function openLocations(state: MenuCharacter, world: WorldSnapshot): LocationView[] {
  return (world.locations ?? [])
    .filter((view) => inCurrentCity(state, view))
    .filter(
      (view) => {
        // M2.7.6：普通人没有序列，按序列 9 参与地点准入
        const seq = sequenceOrInitiate(state);
        /*
         * M2.86：**软上限**（用户：「探索每日三次是不合理的机制」）。
         *
         * 原来是 `(view.usedToday ?? 0) < cap` —— 探到 3 次的地点**直接从菜单消失**，
         * 比「拒绝了再告诉你」更隐蔽：玩家只会觉得「这地方怎么不见了」。
         * 现在只有到硬上限才从菜单里去掉（那是防脚本的），
         * 3 次之后仍可去，只是收益递减、危险上涨。
         */
        return seq <= view.minSeq && seq >= view.maxSeq
          && (view.usedToday ?? 0) < NUMERIC.explore.hardCapPerLocation;
      },
    )
    .sort((a, b) => b.danger - a.danger || b.lootCount - a.lootCount);
}

/**
 * 「下一步」生成器。
 * 每个分支只做一件事：把玩家此刻最可能想做的 3—4 件事排到前面。
 */
/**
 * M2.86：**适应化按钮** —— 刚看过/走过之后，按钮应该是**那些能去的地方**。
 *
 * 用户原话：
 *
 * > 「这里的四个按钮还是基础四件套，没做按模板变化，这里应该是 `.看`，显示了能走的地方，
 * >   那么就应该按钮变成了**走往 XXX**，这是适应化的对应按钮功能」
 *
 * 之前两版都不对：
 *   · 第一版我在 `.看` 里自己塞 `interactive` —— 但 router 只在 `options.length > 0` 时才用它，
 *     给的是 `quickButtons`，于是**整块被丢掉**（真机上还是旧的四个按钮）；
 *   · 而且我做的 `buttonsForScene('scene')` 是**固定四件套**，与「眼前有什么」无关 ——
 *     那不叫适应化。
 *
 * 正解是接进这里的「下一步菜单」：它本来就拿得到 `world`（含可达地点）与 `after`（刚执行的指令名）。
 */
function buildLookNextMenu(input: NextMenuInput): Menu | null {
  const { state, world } = input;
  /*
   * **优先用正文里那批出口**（`.看` 交出来的）。
   *
   * 退回 `world.locations` 是**次选**：那是全城地点表，与正文的邻接出口不是一回事 ——
   * 第一版就是拿它拼的，于是正文说「迷雾街区 / 蒸汽车站」，按钮给「灰雾之上 / 赤道雨林」。
   */
  if (input.exits !== undefined && input.exits.length > 0) {
    const exits = input.exits.slice(0, 4);
    return {
      title: '往哪走',
      context: ['刚才那几个地方，去哪个'],
      options: exits.map((exit, index) => ({
        key: String(index + 1),
        label: '走往' + exit.name,
        command: '走 ' + exit.name,
        preview: exit.danger >= 4 ? '危险 ' + exit.danger + ' · 想清楚' : '危险 ' + exit.danger,
      })),
      allowFreeform: true,
    };
  }
  const cityId = state.currentCityId ?? null;
  const spots = (world.locations ?? [])
    // 与 openLocations 同一条城市口径：没登记城市的照旧放行（宁可多给几个）
    .filter((view) => view.city === undefined || view.city === '' || view.city === cityId)
    // 今天还没去过的排前面（那是玩家最可能想去的），其次按危险度
    .sort((a, b) => (a.usedToday ?? 0) - (b.usedToday ?? 0) || b.danger - a.danger)
    .slice(0, 4);
  if (spots.length === 0) return null;
  return {
    title: '往哪走',
    context: ['眼前这些地方都还去得'],
    options: spots.map((view, index) => ({
      key: String(index + 1),
      label: '走往' + view.name,
      command: '走 ' + view.name,
      // M2.122：默认值不显示（用户：「多余的解释也不要」）
    preview: (view.danger > 0 ? '危险 ' + view.danger : '') + ((view.usedToday ?? 0) > 0 ? (view.danger > 0 ? ' · ' : '') + '今日已探 ' + view.usedToday + ' 次' : ''),
    })),
    allowFreeform: true,
  };
}

/**
 * M2.86：**背包之后** —— 玩家刚翻完包，接下来最可能做的是「用掉里面的东西」。
 * 原来给的是通用的「继续扮演 / 恢复 / 看状态」，与他刚做的事无关。
 */
/**
 * M2.86：**背包之后** —— 每件能用的东西**各自一个按钮**。
 *
 * ## 这里原来有个大坑（用户点名）
 *
 * 旧写法是「写死第一个物品」：
 *
 * ```ts
 * push({ label: '服用魔药', command: '服用 ' + potions[0].itemId });
 * push({ label: '使用物品', command: '使用 ' + usable[0].itemId });
 * ```
 *
 * 于是玩家点「使用物品」，用掉的是**系统挑的那一件**，不是他想用的那一件 ——
 * 而且按钮上**根本没写是哪件**。用户原话：「背包里的使用物品按钮默认使用第一个物品，是个大坑」。
 *
 * 现在每件东西一个按钮，标签里带物品名：
 *
 * ```
 * [用治疗药剂] [用圣盐] [装备左轮] [装备栏]
 * ```
 *
 * ## 标签为什么要截短
 *
 * 官方对按钮文字的限制是 **10 个字符**（M2.44 真机校准过：长中文标签会显示不全）。
 * 而物品名动辄「辅助材料·仲夏草一根」—— 直接塞进去必然被截，还截得难看。
 * 所以这里取「去掉『辅助材料·』这类前缀后的名字」，最多 6 个字。
 * 截短的完整名放在 `preview` 里（正文会渲染它），玩家仍能看全。
 */
function shortItemName(itemId: string): string {
  // 「辅助材料·仲夏草一根」→「仲夏草一根」；「魔药·愚者·序列9」→「愚者·序列9」
  const bare = itemId.replace(/^(主材料|辅助材料|魔药|材料)·/, '');
  return bare.length > 6 ? bare.slice(0, 6) : bare;
}

/** 物品大类的中文（快捷按钮的副标题用它 —— 副标题不该是 `potion`） */
const ITEM_KIND_CN: Readonly<Record<string, string>> = {
  potion: '魔药',
  material: '材料',
  consumable: '消耗品',
  trinket: '饰品',
  sealed: '封印物',
  charm: '符咒',
  currency: '货币',
  weapon: '武器',
};

/**
 * 背包项在快捷按钮里怎么显示（M2.100）。
 *
 * ⚠️ 这一批修的是用户实机反馈的两个毛病：
 *   ① 「使用 XXX / 装备 XXX 类的应该用**文字预输入标签按钮**」——
 *      按钮的 `command` 原来拼的是 `itemId`（`potion_seer_9`），点下去输入框里就是那串英文。
 *      命令层本来就认中文名（`findByNameOrName`），所以这里改成用 `name`。
 *   ② 「装备的模板**没删信息尾**」—— 按钮的 `preview` 原来直接写 `preview: slot.itemId`，
 *      于是副标题是 `potion_seer_9`。现在写「魔药 ×2」这种给人看的东西。
 */
/** ⚠️ 导出是刻意的：`.背包` 命令的 `nextActions` 与这里的菜单选项必须**同源**，
 * 否则两处会漂移（一处写中文名、一处写 id —— 那正是用户第一轮报的那个毛病）。 */
export function bagButtonOf(slot: InventoryItem, verb: string): { label: string; command: string; preview: string } {
  const name = slot.name ?? slot.itemId;
  const kind = ITEM_KIND_CN[slot.kind ?? ''] ?? '';
  const count = slot.quantity > 1 ? ' ×' + slot.quantity : '';
  return {
    label: verb + shortItemName(name),
    command: verb.trim() + ' ' + name,
    preview: kind === '' ? count.trim() : kind + count,
  };
}

function buildBagNextMenu(input: NextMenuInput): Menu | null {
  const { state } = input;
  const options: MenuOption[] = [];
  const push = (option: Omit<MenuOption, 'key'>): void => {
    options.push({ ...option, key: String(options.length + 1) });
  };
  /*
   * 只给「手上真有的东西」——没有就不给，免得玩家点了被告知「你没有」。
   * 上限 4 个按钮：一屏放得下的量，超过的让玩家自己打 `.使用 <名字>`。
   */
  const slots = state.inventory ?? [];
  const potions = slots.filter((slot) => slot.itemId.includes('魔药'));
  const usable = slots.filter((slot) => !slot.itemId.includes('魔药') && !slot.itemId.includes('材料'));
  const drinkFirst = [...potions, ...usable].slice(0, 3);
  for (const slot of drinkFirst) {
    // 魔药走 .服用，其余走 .使用 —— 两条指令的分工在命令层已经定了
    const isPotion = slot.itemId.includes('魔药') || slot.kind === 'potion';
    // M2.100：command 用**中文名**（点下去输入框里是「使用 魔药·愚者·序列9」，不是 potion_seer_9）
    push(bagButtonOf(slot, isPotion ? '服用' : '用'));
  }
  // 装备也按件给：玩家点「装备左轮」比点「装备栏」再翻一次少一步
  /*
   * M2.100：装备也走同一个构造 —— 原来的 `preview: slot.itemId` 就是用户说的
   * 「装备的模板没删信息尾」（副标题是一串英文 id）。
   */
  const equippable = slots.filter((s) => s.itemId.includes('封印物') || s.itemId.includes('武器') || s.kind === 'sealed' || s.kind === 'weapon').slice(0, 1);
  for (const slot of equippable) {
    push(bagButtonOf(slot, '装备'));
  }
  push({ label: '装备栏', command: '装备栏', preview: '看看身上穿了什么' });
  return options.length <= 1 ? null : { title: '包里的东西怎么用', context: ['刚翻过包'], options, allowFreeform: true };
}

/**
 * M2.86：**战斗之后** —— 只给这一回合能做的事（打完/没打完都成立）。
 */
function buildBattleNextMenu(): Menu {
  return {
    title: '这一回合',
    context: ['打、守、退 —— 选一个'],
    options: [
      { key: '1', label: '攻击', command: '战斗 攻击', preview: '把这一场打完' },
      { key: '2', label: '防御', command: '战斗 防御', preview: '恢复灵力' },
      { key: '3', label: '撤退', command: '战斗 撤退', preview: '危险度越高越难走' },
    ],
    allowFreeform: true,
  };
}

/** 后续按钮的最小形状（与 `NextMenuInput.actions` 的元素一致） */
interface AfterAction {
  label: string;
  command: string;
  preview?: string;
}

/**
 * **命令 → 后续按钮**（M2.86）。
 *
 * ## 为什么是集中一张表，而不是让每个命令自己交
 *
 * `CommandResult.nextActions` 那条路（「谁产生正文谁交按钮」）是对的，但它只覆盖了
 * 4 个命令 —— 其余 49 个落到了通用四件套，于是几乎每条指令下面都是
 * 「看线索 / 休息一下 / 查看状态 / 翻翻背包」，跟刚做的事毫无关系。
 *
 * 用户的要求很明确：「49条命令的按钮要做！严肃要做！这是运营发行包的前提」。
 *
 * 逐个改 49 个文件既慢又容易漏，而且这些命令的「下一步」**大多是固定组合**
 * （刚休息完 → 看看状态 / 回今日），并不依赖命令内部的细节。
 * 所以把**通用的那一档**收敛到这张表；真正需要看内部状态的（`.看` 的出口清单、
 * `.委托` 的可接列表、`.查` 的线索列表）仍然走 `nextActions` 自己交 ——
 * 两条路的优先级是 `nextActions` > 这张表 > 通用兜底。
 *
 * ## 写表的纪律
 *
 *   · 按钮里的指令**必须是真实存在的**（`test/button-consistency` 会对账）；
 *   · 一条命令最多 4 个（菜单层的上限，也是群里一屏放得下的量）；
 *   · **不要写「看线索 / 翻背包」这种与场景无关的**——那正是这张表要消灭的东西。
 */
const AFTER_ACTIONS: Readonly<Record<string, readonly AfterAction[]>> = {
  /* ---- 身体与恢复 ---- */
  状态: [
    { label: '休息一下', command: '休息', preview: '回点血与理智' },
    { label: '今日', command: '今日', preview: '今天还能做什么' },
    { label: '翻翻背包', command: '背包' },
  ],
  休息: [
    { label: '查看状态', command: '状态', preview: '休息之后什么样' },
    { label: '今日', command: '今日' },
  ],
  净化: [
    { label: '查看状态', command: '状态' },
    { label: '今日', command: '今日' },
  ],

  /* ---- 出门与探索 ---- */
  探索: [
    { label: '查看状态', command: '状态', preview: '这次掉了多少' },
    { label: '今日', command: '今日' },
  ],
  看: [
    { label: '今日', command: '今日' },
    { label: '状态', command: '状态' },
  ],
  走: [
    { label: '今日', command: '今日' },
    { label: '状态', command: '状态' },
  ],
  移动: [
    { label: '今日', command: '今日', preview: '到了之后能做什么' },
    { label: '看看四周', command: '看' },
    { label: '状态', command: '状态' },
  ],

  /* ---- 物品与装备 ---- */
  装备栏: [
    { label: '翻翻背包', command: '背包', preview: '还能换什么' },
    { label: '状态', command: '状态' },
    { label: '今日', command: '今日' },
  ],
  装备: [
    { label: '看看装备栏', command: '装备栏' },
    { label: '状态', command: '状态' },
  ],
  卸下: [
    { label: '看看装备栏', command: '装备栏' },
    { label: '状态', command: '状态' },
  ],
  使用: [
    { label: '查看状态', command: '状态', preview: '用完什么样' },
    { label: '翻翻背包', command: '背包' },
  ],
  买: [
    { label: '翻翻背包', command: '背包' },
    { label: '今日', command: '今日' },
  ],
  交易: [
    { label: '翻翻背包', command: '背包' },
    { label: '今日', command: '今日' },
  ],
  /*
   * M2.87 交易体系的两条新命令。
   *
   * ⚠️ 这两条是我加完命令**忘了进表**、被 `test/button-coverage.test.ts` 抓住的 ——
   * 那条用例存在的意义就是这个：新增指令时如果没人提醒，玩家看到的会是
   * 「看线索 / 休息一下 / 查看状态 / 翻翻背包」那套与场景无关的四件套。
   */
  商店: [
    { label: '翻翻背包', command: '背包', preview: '看看手上有什么' },
    { label: '卖点东西', command: '卖', preview: '把不用的换成钱' },
    { label: '看看状态', command: '状态' },
  ],
  卖: [
    { label: '逛商店', command: '商店', preview: '买点补给' },
    { label: '翻翻背包', command: '背包' },
    { label: '看看状态', command: '状态' },
  ],

  /* ---- 非凡之路 ---- */
  /*
   * ⚠️ `魔药` 这条要留意：**刚调完药的下一步是「喝掉这一瓶」**，
   * 而那个按钮（`服用 魔药·愚者·序列9`）需要物品名 —— 集中表写不出来。
   *
   * 第一版我在表里写了 `{ label: '喝下去', command: '服用' }`，
   * `test/menu.test.ts` 当场红：「刚调完药，下一步就是喝掉」。
   * 删掉它又让 `button-coverage` 红（每条指令都得有按钮）。
   *
   * 解法不是二选一，而是**让状态驱动的按钮优先，表补在后面**（见下面的合并顺序）。
   * 所以这里只放与角色状态无关的入口。
   */
  魔药: [
    { label: '翻翻背包', command: '背包', preview: '看看调出了什么' },
    { label: '查看状态', command: '状态' },
  ],
  服用: [
    { label: '查看状态', command: '状态', preview: '身体的变化' },
    { label: '今日', command: '今日' },
  ],
  晋升: [
    { label: '状态', command: '状态' },
  ],
  仪式: [
    { label: '查看状态', command: '状态' },
    { label: '今日', command: '今日' },
  ],
  占卜: [
    { label: '查看状态', command: '状态' },
    { label: '今日', command: '今日' },
  ],

  /* ---- 人与势力 ---- */
  教会: [
    { label: '今日', command: '今日' },
    { label: '状态', command: '状态' },
  ],
  查: [
    { label: '今日', command: '今日' },
    { label: '状态', command: '状态' },
  ],
  交: [
    { label: '今日', command: '今日' },
    { label: '状态', command: '状态' },
  ],

  /* ---- 世界与查阅 ---- */
  世界: [
    { label: '今日', command: '今日' },
    { label: '看看四周', command: '看' },
    { label: '状态', command: '状态' },
  ],
  图鉴: [
    { label: '今日', command: '今日' },
    { label: '状态', command: '状态' },
  ],
  帮助: [
    { label: '今日', command: '今日', preview: '从今天开始' },
    { label: '状态', command: '状态' },
  ],
  菜单: [
    { label: '今日', command: '今日' },
    { label: '状态', command: '状态' },
  ],

  /* ---- M2.86 补齐：剩下这些原先落在通用四件套上 ---- */
  创建: [
    { label: '查看状态', command: '状态', preview: '你是谁、在哪' },
    { label: '今日', command: '今日', preview: '从今天开始' },
  ],
  角色: [
    { label: '今日', command: '今日' },
    { label: '状态', command: '状态' },
  ],
  线索: [
    { label: '今日', command: '今日', preview: '去找材料' },
    { label: '翻翻背包', command: '背包' },
  ],
  背包: [
    { label: '状态', command: '状态' },
    { label: '今日', command: '今日' },
  ],
  事件: [
    { label: '今日', command: '今日' },
    { label: '状态', command: '状态' },
  ],
  今日: [
    { label: '状态', command: '状态' },
    { label: '翻翻背包', command: '背包' },
  ],
  遭遇: [
    { label: '查看状态', command: '状态', preview: '手上还有什么' },
    { label: '今日', command: '今日' },
  ],
  行动: [
    { label: '查看状态', command: '状态' },
    { label: '今日', command: '今日' },
  ],
  委托: [
    { label: '今日', command: '今日' },
    { label: '状态', command: '状态' },
  ],
  接: [
    { label: '查看委托', command: '委托', preview: '还压着几件' },
    { label: '今日', command: '今日' },
  ],
  队伍: [
    { label: '今日', command: '今日' },
    { label: '状态', command: '状态' },
  ],
  加入教会: [
    { label: '查看状态', command: '状态' },
    { label: '今日', command: '今日' },
  ],
  确认: [
    { label: '今日', command: '今日' },
    { label: '状态', command: '状态' },
  ],
  取消: [
    { label: '今日', command: '今日' },
    { label: '状态', command: '状态' },
  ],
  战斗: [
    { label: '查看状态', command: '状态', preview: '伤得多重' },
    { label: '今日', command: '今日' },
  ],
  挑战: [
    { label: '查看状态', command: '状态' },
    { label: '今日', command: '今日' },
  ],
  袭击: [
    { label: '查看状态', command: '状态' },
    { label: '今日', command: '今日' },
  ],
  举报: [
    { label: '今日', command: '今日' },
    { label: '状态', command: '状态' },
  ],
  干扰: [
    { label: '查看状态', command: '状态' },
    { label: '今日', command: '今日' },
  ],
  反馈: [
    { label: '今日', command: '今日' },
    { label: '状态', command: '状态' },
  ],

  /*
   * M2.123 补齐：这两条原先落在通用四件套上（`button-coverage` 一直在报的正是它俩）。
   *
   * 它们的下一步是从各自的正文里读出来的：
   *   · `.神战` 讲的是「谁在图谋谁」—— 看完能做的事就是**插手**（告密 / 助推），
   *     这两个参数是固定的（不像 `服用 <物品名>` 那样要动态值），所以写得进表；
   *   · `.王座` 讲的是「哪些位置空着、谁在往上坐」—— 下一步自然是去看那几局阴谋，
   *     而 `登位 <编号>` 要编号、写不进表（与 `魔药` 同一条规矩）。
   */
  神战: [
    { label: '告密', command: '神战 告密', preview: '把消息递出去 · 会让它提前败露' },
    { label: '助推', command: '神战 助推', preview: '替动手那位办事 · 陨落来得更快' },
    { label: '查看状态', command: '状态' },
  ],
  王座: [
    { label: '神战', command: '神战', preview: '看看谁在图谋谁' },
    { label: '查看状态', command: '状态', preview: '够不够格' },
    { label: '今日', command: '今日' },
  ],
};

/** 查这张表：没有登记的命令给 null（调用方继续走通用兜底） */
export function afterActionsOf(command: string): readonly AfterAction[] | null {
  return AFTER_ACTIONS[command] ?? null;
}

export function buildNextMenu(input: NextMenuInput): Menu {
  /*
   * M2.86：**指令自己给的按钮最优先**（适应化的通用形态）。
   *
   * 谁产生正文谁最清楚下一步能做什么 —— `.委托` 知道有哪几个委托可接，
   * `.查` 知道有哪几条线索可追，而这里（菜单层）只能靠 `after` 猜。
   */
  if (input.actions !== undefined && input.actions.length > 0) {
    return {
      title: '接着做什么',
      context: [],
      options: input.actions.slice(0, 4).map((action, index) => ({
        key: String(index + 1),
        label: action.label,
        command: action.command,
        ...(action.preview !== undefined ? { preview: action.preview } : {}),
      })),
      allowFreeform: true,
    };
  }
  /*
   * M2.123：**重伤优先** —— 这种状态下能做的事只剩两件。
   *
   * 用户口径：「重伤情况下要显示休息按钮和求医的按钮」。
   *
   * 为什么放在**菜单入口**、而不是各个命令里：重伤是**角色状态**，不是某条指令的结果 ——
   * 任何一条回执之后他都还是重伤。放在这一层，一处就覆盖了所有回执、所有途径，
   * 不必去 58 个命令里逐个补。
   *
   * 排在 `input.actions`（指令自己给的）之后：那一档仍然最优先，谁产生正文谁最清楚。
   * 但它排在所有靠 `after` 猜的分支之前 —— 没有哪条指令比「你现在重伤」更清楚下一步。
   */
  if (input.state.status === 'injured') {
    const restLimit = NUMERIC.recovery.rest.dailyLimit;
    return {
      title: '【下一步 · 重伤】',
      context: ['伤没好之前，别的都做不了 —— 休息不要钱，就医要钱但一次到底。'],
      options: [
        { key: '1', label: '休息', command: '休息', preview: `恢复 HP 与 MAD · 每日 ${restLimit} 次` },
        { key: '2', label: '就医', command: '就医', preview: '花钱请医生上门 · 回满生命并解掉重伤' },
        { key: '3', label: '查看状态', command: '状态', preview: '看看伤得多重' },
        { key: '4', label: '今日', command: '今日' },
      ],
      allowFreeform: true,
    };
  }
  // M2.86：刚「看」过 / 「走」过 —— 玩家眼前是「我在哪、能去哪」，按钮就该是那些出口
  if (input.after === '看' || input.after === '走') {
    const look = buildLookNextMenu(input);
    if (look !== null) return look;
  }
  /*
   * ⚠️ M2.101：**`.背包` 之后不再开菜单**（用户第二次的反馈）。
   *
   * 用户的原话：「背包里我要的是**点击后自动把指令输入进编辑框**的那个文字标签指令」。
   *
   * 这里原来会开一份菜单，于是玩家看到的是「接着做什么 / 1. 用愚者·序列9 / 回复数字」——
   * 那是**原生按钮**（`options`）那条路：平台回传数字、后端走 MENU_REPLY，
   * 玩家看到的是**一份要回复数字的列表**。
   *
   * 而背包里的「服用 / 装备」是**普通指令**，`bag.ts` 自己已经用 `nextActions` 交了按钮 ——
   * 那种按钮点下去会把指令**插进输入框**，玩家看得见自己要发什么，也随时可以改。
   * 两条路叠在一起时，菜单那份数字列表会把按钮的意图盖过去。
   *
   * ⇒ 背包这一处**只留 `nextActions`**（分页导航那种「点了直接翻页」的才需要菜单）。
   * `buildBagNextMenu` 与 `bagButtonOf` 保留：前者给「没有交 nextActions 的那条路」兜底，
   * 后者是两处**同源**的文案构造（改了这里那里也跟着变）。
   */
  // ⚠️ M2.101：背包的按钮由 `.背包` 命令自己用 `nextActions` 交（见下面的注释）。
  // 这里**不再开菜单** —— 但 `Menu` 的返回类型不允许 null，所以由路由层统一判断：
  // 「有 nextActions 就不开下一步菜单」（那才是通用规则，别的命令也受益）。
  if (input.after === '战斗') return buildBattleNextMenu();
  /*
   * M2.86：**按命令查表**（这张表覆盖了 30 多条指令的通用后续）。
   *
   * 位置有意排在 `看` / `走` / `背包` / `战斗` 之后 ——
   * 那四条有真正的内部状态（出口清单、包里有什么、战斗回合），
   * 比表里的固定组合更准；表是**兜底**，不是覆盖。
   */
  const tabled = afterActionsOf(input.after);
  if (tabled !== null) {
    /*
     * ⚠️ **先算一遍通用菜单，再换掉它的 options** —— 不要自己从零造一个。
     *
     * 第一版我图省事直接 `return { title, context: [], options: 表里的 }`，
     * 结果 `test/menu.test.ts` 当场红了：
     *
     *   · `context` 是**菜单首屏那几行状态与世界信息**（DIG 消化度、天气、雾日…），
     *     清空之后玩家在「下一步」里看不到自己什么状态、外面什么天气；
     *   · 那份测试还要求「每条指令之后给 3—4 个选项」，而我表里有些只有 2 个。
     *
     * 借用通用分支的骨架就同时解决了这两件事：**它的 context 是对的，
     * 选项不够时它会自己补齐**（`push` 到 `nextOptionCount` 为止）。
     * 我们只把它排在前面的几个选项换成表里那些更贴场景的。
     */
    const base = input.pathway ? buildPathwayNextMenu(input) : buildMortalNextMenu(input);
    /*
     * ⚠️ **状态告警压过「刚做完的事」。**
     *
     * `buildPathwayNextMenu` 有一条判据守着：「失控时第一条永远是恢复（净化）」。
     * 如果表里的按钮无条件排最前，`.扮演` 刚结束、人已经失控，第一条却是「查看状态」——
     * 玩家会先去看状态，而真正该做的是赶紧净化。
     *
     * 所以失控时**整条走通用分支**，一个字不换。
     * 这不是特例，是优先级：**身体出问题 > 刚才做了什么**。
     */
    if (input.state.status === 'lost_control') return base;
    const options: MenuOption[] = [];
    const seen = new Set<string>();
    const add = (option: Omit<MenuOption, 'key'>): void => {
      if (options.length >= NUMERIC.menu.nextOptionCount) return;
      if (seen.has(option.command)) return;
      seen.add(option.command);
      options.push({ ...option, key: String(options.length + 1) });
    };
    /*
     * **合并顺序：状态驱动项 → 表 → 通用其余。**
     *
     * 判据很干净：**通用分支里第一条如果不在表上，它就是状态驱动的**
     * （有魔药 → 「服用 魔药·愚者·序列9」、MAD 到线 → 休息）。
     * 这类按钮带着命令内部才知道的参数（哪一瓶药），集中表永远写不出来，
     * 而它们恰恰是此刻最该点的。所以让它们占第一位。
     *
     * 这一条是被两条判据夹出来的：
     *   · `menu.test.ts`：失控时第一条永远是恢复 / 刚调完药下一步就是喝掉；
     *   · `button-coverage.test.ts`：每条指令都得有按钮。
     * 只满足任一条都会让另一条红 —— **顺序**才是那个能同时成立的解。
     */
    const firstBase = base.options[0];
    if (firstBase !== undefined && !tabled.some((action) => action.command === firstBase.command)) {
      add(firstBase);
    }
    for (const action of tabled) {
      add({
        label: action.label,
        command: action.command,
        ...(action.preview !== undefined ? { preview: action.preview } : {}),
      });
    }
    // 表里不够 3 个时用通用选项补齐（判据要求每条指令之后都有 3—4 个）
    for (const option of base.options) add(option);
    return { ...base, options };
  }
  // 到这里还没被表命中 → 走「有途径」那套通用菜单
  return buildPathwayNextMenu(input);
}

/**
 * 「已经走在途径上」的通用下一步菜单（M2.86 从 `buildNextMenu` 里抽出来）。
 *
 * 抽出来的原因：集中表那一档要**借它的骨架**（context 是状态与世界那几行，
 * 而且它自己会补齐到 3—4 个选项），只把前几个换成表里更贴场景的。
 * 不抽的话表分支只能自己从零造一个 —— 我第一版就是那么写的，
 * 结果把 context 清空了，`test/menu.test.ts` 当场红。
 */
function buildPathwayNextMenu(input: NextMenuInput): Menu {
  const { state, world, after } = input;
  const kit = input.pathway!;
  const options: MenuOption[] = [];
  const push = (option: Omit<MenuOption, 'key'>): void => {
    if (options.some((existing) => existing.command === option.command)) return;
    if (options.length >= NUMERIC.menu.nextOptionCount) return;
    options.push({ ...option, key: String(options.length + 1) });
  };

  const restUsed = state.dailyCounters?.['rest'] ?? 0;
  const purifyUsed = state.dailyCounters?.['purify'] ?? 0;
  const salt = NUMERIC.recovery.purify.materials[0]!;
  const hasSalt = (state.inventory ?? []).some(
    (slot) => slot.itemId === salt.itemId && slot.quantity >= salt.qty,
  );
  const canRest = restUsed < NUMERIC.recovery.rest.dailyLimit;
  const canPurify = purifyUsed < NUMERIC.recovery.purify.dailyLimit && hasSalt;

  /** 消化度顶格之后再扮演不会有任何变化：这一条要在菜单上说出来，不能等玩家白点十次 */
  const digFull = state.dig >= 100;
  const playedOut = (state.dailyCounters?.['play'] ?? 0) >= PLAYER_MODEL_PLAY_CAP;
  const playOption = (tag: string, note: string): Omit<MenuOption, 'key'> => {
    const text = phraseOf(kit.id, tag);
    const breakdown = scorePlay(text, kit.tags, state.tagUsage ?? new Map());
    return {
      label: `继续扮演（${text}）`,
      command: `扮演 ${text}`,
      preview:
        `匹配${matchLabel(breakdown.final)} · ${note}` +
        (digFull ? ' · DIG 已满，再扮演不涨' : playedOut ? ' · 今天扮演次数已到上限' : ''),
      ...(digFull && playedOut ? { disabled: '消化度已满且今天扮演次数用完' } : {}),
    };
  };

  /* ---------- 1) 状态优先：失控 / 高危，任何指令做完都先劝这一条 ---------- */
  if (state.status === 'lost_control') {
    if (canPurify) {
      push({ label: '净化', command: '净化', preview: `把失控解开 · COR ${NUMERIC.recovery.purify.cor} · MAD ${NUMERIC.recovery.purify.mad}` });
    }
    if (canRest) {
      push({ label: '休息', command: '休息', preview: `没有圣盐就睡一觉 · MAD ${NUMERIC.recovery.rest.mad} · HP +${NUMERIC.recovery.rest.hp}` });
    }
  } else {
    if (state.mad >= NUMERIC.menu.riskTopThreshold && canRest) {
      push({ label: '休息', command: '休息', preview: `先把 MAD ${state.mad} 压下来 · MAD ${NUMERIC.recovery.rest.mad} · HP +${NUMERIC.recovery.rest.hp}` });
    }
    if (state.cor >= NUMERIC.menu.riskTopThreshold && canPurify) {
      push({ label: '净化', command: '净化', preview: `先把 COR ${state.cor} 压下来 · COR ${NUMERIC.recovery.purify.cor} · MAD ${NUMERIC.recovery.purify.mad}` });
    }
  }

  /* ---------- 2) 延续刚才那条指令 ---------- */
  const selfContinue = (note: string): void => push(playOption(freshestTag(state, kit), note));
  switch (after) {
    case '扮演':
      selfContinue('换个行为接着推消化度');
      break;
    case '探索': {
      const spots = openLocations(state, world);
      const here = input.command?.replace(/^探索\s+/, '').trim();
      const hereView = spots.find((view) => view.name === here);
      const next = spots.find((view) => view.name !== here);
      if (hereView) {
        push({
          label: `再探${hereView.name}`,
          command: `探索 ${hereView.name}`,
          // M2.90 修：同上 —— 漏了 ${}，界面上显示的是源码
          // M2.122：0 次不显示
        ...((hereView.usedToday ?? 0) > 0 ? { preview: `今日已探 ${hereView.usedToday} 次` } : {}),
        });
      }
      if (next) {
        push({
          label: `去${next.name}`,
          command: `探索 ${next.name}`,
          preview: `危险 ${next.danger} · 掉落 ${next.lootCount} 种`,
        });
      }
      if (!hereView && !next) selfContinue('今天能去的地方都探完了，回去扮演');
      break;
    }
    case '魔药': {
      const potion = (state.potions ?? []).find(
        (entry) => entry.pathway === kit.id && entry.seq === state.sequence,
      );
      if (potion) {
        push({
          label: `服用 ${potion.name}`,
          command: `服用 ${potion.itemId}`,
          preview: `消化 +${NUMERIC.potion.digOnDrink} · 疯狂 +${NUMERIC.potion.madOnDrink}`,
        });
      } else {
        selfContinue('材料不够，先用扮演推消化度');
      }
      break;
    }
    case '服用':
      selfContinue('魔药之后靠扮演继续推消化度');
      break;
    case '晋升': {
      const spots = openLocations(state, world);
      const fresh = spots.find((view) => (view.usedToday ?? 0) === 0) ?? spots[0];
      if (fresh) {
        push({
          label: `探索${fresh.name}`,
          command: `探索 ${fresh.name}`,
          // 「序列 N 新开放」这句进 preview —— 它渲染在正文里（按钮只放得下四个字）
          preview: `序列 ${state.sequence} 新开放 · 危险 ${fresh.danger} · 掉落 ${fresh.lootCount} 种`,
        });
      }
      selfContinue('把新拿到的能力用起来');
      break;
    }
    case '休息':
    case '净化':
      selfContinue('恢复完接着推消化度');
      break;
    case '确认':
    case '取消':
    case '交易': {
      const spots = openLocations(state, world);
      const spot = spots[0];
      if (spot) {
        push({
          label: `去${spot.name}`,
          command: `探索 ${spot.name}`,
          preview: `危险 ${spot.danger} · 掉落 ${spot.lootCount} 种`,
        });
      }
      selfContinue('交易处理完了，继续推消化度');
      break;
    }
    default:
      selfContinue('接着推消化度');
      break;
  }

  /* ---------- 2.5) M2.5：晋升的另一条路 ---------- */
  // 消化度达标时把「仪式」摆出来 —— 它是高投入高回报的那条路（配置好能顶到 95%），
  // 也是 M2.3 菜单路径的玩家唯一能碰到 .仪式 的入口（他们不会走完整指令路径的巡检）。
  if (state.dig >= NUMERIC.promotion.digThreshold) {
    push({
      label: '准备晋升仪式',
      command: '仪式 准备',
      preview: '成功率拆开显示，失败的代价也更重',
    });
  }

  /* ---------- 3) 通用兜底：任何一条指令做完都不会没路走 ---------- */
  push({ label: '今日去处', command: '今日', preview: '今日摘要 · 还有哪些事可做' });
  push({ label: '查看状态', command: '状态', preview: `DIG ${state.dig.toFixed(1)} · MAD ${state.mad} · COR ${state.cor}` });
  push({ label: '休息一下', command: '休息', preview: canRest ? '恢复 HP 与 MAD · 每日 1 次' : '今天已经休息过了' });
  push({ label: '世界与天气', command: '世界', preview: '时段 · 月相 · 雾日 · 各地天气' });

  const head = `【下一步 · ${PATHWAY_LABELS[kit.id]} · 序列 ${sequenceOrInitiate(state)}】`;
  return {
    title: `${head}`,
    context: [
      `${weatherLabel(world.weather)} · ${TIME_OF_DAY_LABELS[world.clock.timeOfDay]} · ` +
        `DIG ${state.dig.toFixed(1)} · MAD ${state.mad} · COR ${state.cor}`,
      ...(input.notes ?? []),
    ],
    options,
    allowFreeform: true,
  };
}


/**
 * 普通人的「下一步」（M2.7.6 §2.2）。
 *
 * 只有四件事可做：探索、社交、移动、休息 —— 而「找路」这件事本身
 * 通过 .线索 摆在第一位（它既报进展，也是「下一步该去哪」的答案）。
 *
 * 为什么单独一套而不是让通用分支自己降级：
 *   通用分支里「继续扮演」是**默认动作**，对普通人来说那个选项点了只会得到
 *   一句拒绝。菜单是玩家最先看到的东西，它不该有一半是坏的。
 */
function buildMortalNextMenu(input: NextMenuInput): Menu {
  const { state, world, after } = input;
  const options: MenuOption[] = [];
  const push = (option: Omit<MenuOption, 'key'>): void => {
    if (options.some((existing) => existing.command === option.command)) return;
    if (options.length >= NUMERIC.menu.nextOptionCount) return;
    options.push({ ...option, key: String(options.length + 1) });
  };
  const restUsed = state.dailyCounters?.['rest'] ?? 0;
  const canRest = restUsed < NUMERIC.recovery.rest.dailyLimit;
  const spots = openLocations(state, world);

  /* 1) 「找路」摆在第一位：手上的纸、主材料的下落（M2.85 起 .线索 替代 .引导） */
  push({
    label: '看线索',
    command: '线索',
    preview: (state.clueCount ?? 0) > 0 ? `手上有 ${state.clueCount} 张纸` : '第几天了 · 满 5 天探索必出',
  });

  /* 2) 探索：普通人唯一稳定的产出手段（也更危险、收获更少） */
  const spot = spots[0];
  if (spot) {
    push({
      // 按钮只放得下四个字 ⇒ `去老码头走走` 收成 `去老码头`
      label: `去${spot.name}`,
      command: `探索 ${spot.name}`,
      // M2.90 修：同上
      // M2.122：0 次不显示
      preview: `危险 ${spot.danger}` + ((spot.usedToday ?? 0) > 0 ? ` · 今日已探 ${spot.usedToday} 次` : ''),
    });
  }
  if (after === '探索') push({ label: '今日去处', command: '今日', preview: '本城还有哪些地方能去' });

  /* 3) 恢复与查看 */
  push({ label: '休息一下', command: '休息', preview: canRest ? '恢复 HP 与 MAD · 每日 1 次' : '今天已经休息过了' });
  push({ label: '查看状态', command: '状态', preview: `HP ${state.hp} · MAD ${state.mad}` });
  push({ label: '翻翻背包', command: '背包', preview: '手上的东西与那张纸' });

  return {
    title: '【下一步 · 还没有途径】',
    context: [
      `${weatherLabel(world.weather)} · ${TIME_OF_DAY_LABELS[world.clock.timeOfDay]} · ` +
        `HP ${state.hp} · MAD ${state.mad}`,
      '你还不知道自己会变成什么。',
      ...(input.notes ?? []),
    ],
    options,
    allowFreeform: true,
  };
}

/** 供命令层使用：哪些指令已经接上了「下一步」出口（报告里要列出来） */
export const CONTINUATIONS = [
  '扮演',
  '探索',
  '魔药',
  '服用',
  '晋升',
  '休息',
  '净化',
  '确认',
  '取消',
  '交易',
  '事件',
  '占卜',
] as const;
