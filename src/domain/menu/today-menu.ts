/**
 * 两个「入口型」菜单（M2.3）：
 *   buildLocationMenu —— `.探索` 不带参数时的地点选择菜单（执行前）
 *   buildTodayMenu    —— `.今日` 的当日摘要 + 主菜单（也是菜单过期后的重新开始入口）
 *
 * 它们和 buildPlayMenu / buildExploreMenu 一样是纯函数。
 * `.今日` 的意义（任务书 §5.1）：菜单过期之后玩家需要一个**一句话就能重新拿到选项**的入口。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { EMOJI, withEmoji } from '../../adapter/highlight.ts';
import { dangerLabel } from '../explore/explore.ts';
import { TIME_OF_DAY_LABELS } from '../world/clock.ts';
import { weatherLabel, worldModifiers, type WeatherId } from '../world/weather.ts';
import { buildPlayMenu } from './play-menu.ts';
import { sequenceOrInitiate } from '../character/types.ts';
import { inCurrentCity } from './types.ts';
import type {
  InventoryItem,
  LocationView,
  Menu,
  MenuCharacter,
  MenuOption,
  PathwayKit,
  WorldSnapshot,
} from './types.ts';

function pct(value: number): string {
  const delta = value * 100;
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}%`;
}

function dangerOf(world: WorldSnapshot, weather: WeatherId): number {
  return worldModifiers({ clock: world.clock, weather }).exploreDangerMultiplier;
}

/**
 * 今天还能去的地点（按危险度降序，最有内容的排前面）。
 *
 * M2.7 加了城市过滤：玩家只做自己**脚下这座城市**里的事。
 * 「想去别的城市」是 .移动 的事，不是 .探索 的事 —— 否则地理就只是一张标签。
 */
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
 * `.探索` 不带参数：把「今天能去哪儿」一次性摆出来。
 * 这是 M2.3 想解决的核心痛点 —— 玩家不该靠记忆去背地点名。
 */
export function buildLocationMenu(state: MenuCharacter, world: WorldSnapshot): Menu {
  const options: MenuOption[] = [];
  const reachable = openLocations(state, world);

  for (const view of reachable.slice(0, 4)) {
    const weather = view.weather ?? world.weather;
    options.push({
      key: String(options.length + 1),
      label: `${view.name}（${dangerLabel(view.danger)} · ${weatherLabel(weather)} · 掉落 ${view.lootCount} 种）`,
      command: `探索 ${view.name}`,
      // M2.90 修：同上（漏了 ${}）
      preview: todayPreview(dangerOf(world, weather), view.usedToday ?? 0),
    });
  }
  if (reachable.length === 0) {
    options.push({
      key: '1',
      label: '今天所有能去的地方都探满了',
      command: '状态',
      preview: '等明天行动点恢复',
    });
  }
  options.push({
    key: String(options.length + 1),
    label: '世界与天气',
    command: '世界',
    preview: '时段 · 月相 · 雾日 · 各地天气',
  });

  const used = (world.locations ?? []).filter((view) => (view.usedToday ?? 0) > 0).length;
  return {
    title: `【探索 · 选一个地方】`,
    context: [
      `${weatherLabel(world.weather)} · ${TIME_OF_DAY_LABELS[world.clock.timeOfDay]} · 今日去过 ${used} 处`,
      `本时段基准危险 ${pct(dangerOf(world, world.weather) - 1)}${world.clock.foggy ? '（雾日）' : ''}`,
    ],
    options,
    allowFreeform: true,
  };
}


/**
 * 普通人的 .今日（M2.7.6 §2.2）。
 *
 * 三条内容按优先级：有人在等你回话 → 四处走走 → 恢复与查看。
 * 与 next-menu 的普通人分支同一口径，只是入口不同（.今日 是「重新开始」的入口）。
 */
function buildMortalTodayMenu(
  state: MenuCharacter,
  world: WorldSnapshot,
  inventory: readonly InventoryItem[],
): Menu {
  const options: MenuOption[] = [];
  const push = (option: Omit<MenuOption, 'key'>): void => {
    if (options.some((existing) => existing.command === option.command)) return;
    options.push({ ...option, key: String(options.length + 1) });
  };

  push({
    label: '看线索',
    command: '线索',
    preview: (state.clueCount ?? 0) > 0 ? `手上有 ${state.clueCount} 张纸` : '第几天了 · 满 5 天探索必出',
  });
  const spot = openLocations(state, world)[0];
  if (spot) {
    push({
      // 按钮只放得下四个字；危险档与掉落种数并进 preview（渲染在正文里）
      label: `探索${spot.name}`,
      command: `探索 ${spot.name}`,
      // M2.90 修：同上（漏了 ${}）
      preview: todayPreview(dangerOf(world, spot.weather ?? world.weather), spot.usedToday ?? 0),
    });
  }
  push({
    label: '世界与天气',
    command: '世界',
    preview: '时段 · 月相 · 雾日 · 各地天气',
  });
  push({ label: '翻翻背包', command: '背包', preview: `${inventory.length} 格` });

  const date = state.dailyCounters ?? {};
  const todayBits: string[] = [];
  if ((date['rest'] ?? 0) > 0) todayBits.push(`休息 ${date['rest']}/${NUMERIC.recovery.rest.dailyLimit}`);
  todayBits.push(`背包 ${inventory.length} 格`);
  if (state.clueCount && state.clueCount > 0) todayBits.push(`手上有一张纸`);

  return {
    title: '【今日 · 还没有途径】',
    context: [
      `${weatherLabel(world.weather)} · ${TIME_OF_DAY_LABELS[world.clock.timeOfDay]} · ` +
        `HP ${state.hp} · MAD ${state.mad}`,
      '你还不知道自己会变成什么。',
      `今日已做：${todayBits.join(' · ')}`,
    ],
    options,
    allowFreeform: true,
  };
}

/**
 * `.今日`：当日摘要 + 主菜单。
 * 选项直接复用 buildPlayMenu（同一份纯函数），所以「今天该做什么」在任何入口下都是同一套推荐。
 */
export function buildTodayMenu(
  state: MenuCharacter,
  world: WorldSnapshot,
  /** M2.7.6：普通人没有途径 —— 不传 = 他还没有走上任何一条路 */
  pathway?: PathwayKit,
  inventory: readonly InventoryItem[] = [],
): Menu {
  /*
   * M2.7.6：普通人的 .今日 是**另一个菜单**。
   *
   * 不能只把「扮演 / 魔药 / 晋升」删掉了事：那三项对普通人是坏选项，
   * 而「找路」这件事必须顶上来 —— 他今天要么去看看手上的线索（.线索），
   * 要么四处走走翻出点什么（.探索；满 cluePityDays 天必出）。
   */
  if (!pathway) return buildMortalTodayMenu(state, world, inventory);
  const play = buildPlayMenu(state, world, pathway);
  /*
   * ⚠️ M2.86 修正：**这三处原来写的都是 `key: ''`**。
   *
   * `key` 是选项 id —— 玩家点按钮时平台回传的、回数字时玩家打的就是它。
   * 空 key 的后果是：按钮 `id` 为空、`pick('')` 找不到选项、
   * 而 `interactive.options` 与 `pending_menus` 里的菜单**对不上号**
   * （探针跑出来的现象就是「按钮说 X，菜单里同 id 是 Y」）。
   *
   * 这个 bug 是**本轮做按钮一致性探针时抓出来的** —— 玩家侧的表现会非常难描述：
   * 「今日的按钮点了没反应 / 点出来是别的东西」。
   *
   * 与 `.今日` 同一个文件里的 `buildLocationMenu` / `buildMortalTodayMenu` 都老老实实写了
   * `String(options.length + 1)`，只有这里漏了。
   */
  /*
   * ⚠️ M2.121：**这里原来放的是 `buildPlayMenu` 的前两项**（也就是 `.扮演`）。
   * 扮演那条命令已经下线（改由日常遭遇承担），所以这两项撤掉 ——
   * 留着它们的话，玩家点下去会收到「没有 .扮演 这条指令」。
   *
   * `play` 变量仍然要算：`below` 那一段用它判断「有没有可做的事」，
   * 而 `play.options` 本身在别处还有用（引导文案）。
   */
  const options: MenuOption[] = [];

  const spot = openLocations(state, world)[0];
  if (spot) {
    options.push({
      key: String(options.length + 1),
      // 按钮只放得下四个字；危险档与掉落种数并进 preview（渲染在正文里）
      label: `探索${spot.name}`,
      command: `探索 ${spot.name}`,
      /*
       * M2.86：**preview 也要一眼看出轻重**（用户：「上色的地方也少，该用 emoji 的也不要省」）。
       * emoji 是纯文本、两端都渲染、还自带颜色 —— 比颜色更该用。
       */
      /*
       * ⚠️ M2.122：**次数交给 `todayPreview` 判**（0 次不显示）。
       *
       * 这里原来把「今日已探 N 次」硬拼在后面 —— 于是 `todayPreview` 里那条
       * 「0 次不显示」的规矩在**这一处**根本不生效，实测跑出来是：
       *
       *     1. 探索北大陆（ · ⏳ 今日已探 0 次）
       *
       * 中间那个孤零零的 ` · ` 就是硬拼留下的。
       */
      preview: todayPreview(dangerOf(world, spot.weather ?? world.weather), spot.usedToday ?? 0),
    });
  }
  options.push({
    key: String(options.length + 1),
    label: '世界与天气',
    command: '世界',
    preview: '时段 · 月相 · 雾日 · 各地天气',
  });

  const date = state.dailyCounters ?? {};
  /*
   * M2.86：正文首行带 emoji —— 天气/时间一组、身体三个数一组。
   * 这一行本来是一串用 `·` 连起来的数字，扫过去分不出哪些是「环境」哪些是「自己」。
   */
  const lines = [
    withEmoji(EMOJI.weather, `${weatherLabel(world.weather)} · ${TIME_OF_DAY_LABELS[world.clock.timeOfDay]}`)
      + ' · ' + withEmoji(EMOJI.arcane, `DIG ${state.dig.toFixed(1)}`)
      + ` · MAD ${state.mad} · COR ${state.cor}`
      + ' · ' + withEmoji(EMOJI.hp, `HP ${state.hp}`),
  ];
  const todayBits: string[] = [];
  /*
   * ⚠️ M2.121：**不再显示「扮演 N 次」，也不显示「今天还能遇到几次」**。
   *
   * 用户的原话：「今日里**别显示第几次**，显示了**期待感没了**」。
   * 遭遇是「自己找上门来的事」—— 把次数摊在页面上，它就从**惊喜**变成了**进度条**。
   */
  if ((date['rest'] ?? 0) > 0) todayBits.push(`休息 ${date['rest']}/${NUMERIC.recovery.rest.dailyLimit}`);
  if ((date['purify'] ?? 0) > 0) todayBits.push(`净化 ${date['purify']}/${NUMERIC.recovery.purify.dailyLimit}`);
  if ((date['divination'] ?? 0) > 0) todayBits.push(`占卜 ${date['divination']} 次`);
  todayBits.push(`背包 ${inventory.length} 格`);
  lines.push(`今日已做：${todayBits.join(' · ')}`);
  if (state.status === 'lost_control') lines.push('⚠ 你现在处于失控状态，先恢复再冒险。');

  return {
    title: `【今日 · ${pathway.label} · 序列 ${state.sequence}】`,
    context: lines,
    options,
    allowFreeform: true,
  };
}

/**
 * `.今日` 选项后面那句括号（M2.122）。
 *
 * ⚠️ **默认值不显示**：`危险 ×1.00` 说的是「和平时一样」，`今日已探 0 次` 说的是
 * 「今天还没来过」—— 两条都是默认值，摆在选项上只是噪音。
 * 用户的原话：「**多余的解释也不要**」。
 *
 * 与 `explore-menu.ts` 的 `explorePreview` **同一个口径**（两处都改，免得只改了看得见的那一处）。
 */
function todayPreview(danger: number, usedToday: number): string {
  const parts: string[] = [];
  if (Math.abs(danger - 1) > 1e-9) {
    parts.push(withEmoji(EMOJI.danger, `危险 ×${danger.toFixed(2)}`));
  }
  if (usedToday > 0) parts.push(`今日已探 ${usedToday} 次`);
  return parts.join(' · ');
}
