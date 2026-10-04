import { PATHWAY_LABELS } from '../../domain/character/rules.ts';
import { isInitiated, type CharacterState } from '../../domain/character/types.ts';
import { isInternalFlag } from '../../infra/db/flags.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { hl, hlMark } from '../../adapter/highlight.ts';
import { wantedStatusLine } from './wanted-hooks.ts';
import { pvpWaitBlockFor } from './pvp-hooks.ts';

/** SAN 是视图概念，恒等于 100 - MAD，不落库（S1 §9 决策） */
export const GENDER_TAGS: Readonly<Record<string, string>> = { male: '男', female: '女' };

/**
 * 状态卡正文（M2.45 扩充）。
 *
 * ⚠️ **这里不再画「【名字】性别 · 途径序列」那一行** ——
 * 那一行现在是**消息头**的一部分（头像 / 昵称 / 性别 / 途径序列 / 分割线），
 * 由路由组装、通道渲染，见 `adapter/types.ts` 的 MessageHeader。
 * 状态卡正文从「这一行」直接开始，所以在群里看到的是：
 *
 *     [头像] **の** ♂
 *     愚者 · 序列 9
 *     ────────────
 *     **HP** 100/100   **MP** 80/100   **SAN** 90/100
 *     ...
 *
 * `extras` 是纯函数拿不到、由命令层查出来的东西（城市名 / 教会名 / 背包件数）。
 */
/**
 * 进度条（M2.45）。
 *
 * 为什么值得画：状态卡上全是「100/100」这种数字，一眼看不出还剩多少 ——
 * 真机上玩家最先想知道的是**哪个条快空了**，而不是精确到个位的数。
 * `▰▱` 两个字符在所有客户端宽度一致，比 emoji 稳。
 */
export function barOf(value: number, max: number, width = 8): string {
  const safeMax = max > 0 ? max : 1;
  const ratio = Math.max(0, Math.min(1, value / safeMax));
  const filled = Math.round(ratio * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

/**
 * 玩家看得见的数值一律取整（M2.40 口径）。
 *
 * 为什么必须有这一步：`dig` 是**浮点** —— `computeDigNext` 按权重累加 0.6 / 0.3 / 0.1 / -0.5，
 * 真实库里的值长这样：`8.5999999`。直接印上去，状态卡上就是「⚗ 消化 8.5999999」：
 * **那不是玩家的数值，是浮点误差**。
 *
 * 角色卡（`src/card/contract.ts` 的 `whole`）早就取整了，并且注释里写着
 * 「状态卡一直是取整显示的」—— 而 M2.45 第六版改表格时把这件事弄丢了（照着浮点直印）。
 * 两边必须同口径，否则同一份数据在两张卡上是两个数。
 */
function whole(value: number): number {
  return Math.round(value);
}

export interface StatusExtras {
  cityName?: string;
  churchName?: string;
  churchContribution?: number;
  bagCount?: number;
  bagKinds?: number;
  pendingPromotion?: string;
  /** M2.86：这条通道支不支持高亮（颜色走 LaTeX，见 adapter/highlight.ts） */
  supportsColor?: boolean;
}

/**
 * `.状态` 的正文（M2.86 起支持高亮）。
 *
 * 用户：「所有模板里的字体颜色都做了嘛？」—— 之前只有 `.看` 用了 `hl()`，
 * 因为 `hl/hlMark` 当时只被 scene.ts 调用。`.状态` 是最常看的一屏，先补这里。
 *
 * 上色的原则：**只给「需要立刻判断」的数**上色 ——
 * 血量低是红的、疯狂高是红的、消化是金的（进展）。全都上色等于都没上色。
 */
export function renderStatus(state: CharacterState, extras: StatusExtras = {}): string {
  const san = 100 - state.mad;
  /*
   * M2.7.6：普通人**没有途径，也没有序列**。
   * 状态卡上不能写「序列 null」，也不能拿一个占位数字糊过去 ——
   * 那会把「他还没有走上任何一条路」这件事说成「他是一个序列 9 的人」。
   */
  const maxMp = isInitiated(state) ? 100 : 50;
  /*
   * M2.45 第七版：**整张卡只留一个表格**。
   *
   * 用户原话：「不要一个正文三四个表格，影响观看」。上一版是三个表格连着排
   * （三条命 / 代价 / 资源），问题不在表格本身，在**表格的数量**：
   *   · 后两张表各自只有**一行数据**，表头比数据还长 —— 玩家看到的是两个几乎空的框；
   *   · 三张表列数不同（3 / 3 / 2），客户端按各自的宽度排版，一条消息里三个宽度
   *     对不齐的方框，整屏都是横线与竖线。
   *
   * 所以这一版按**有没有对齐需求**分：
   *   · 三条命（生命 / 灵性 / 理智）要「名称 + 进度条 + 数值」三列对齐 ⇒ 留**一个**表格；
   *   · 代价与资源（疯狂 / 污染 / 消化 / 行动 / 命运 / 行囊）每项只有一个数字，
   *     没有对齐需求 ⇒ 一行紧凑文本，靠全角空格分项。
   *     这一版敢退回文本行，是因为前缀已经换成 `✜✠⚗✦❖▣` —— **等宽的基本符号**，
   *     不会像 emoji 那样把整行挤歪（第三版正是栽在 emoji 宽度上）。
   *
   * 符号仍取世界观里说得通的那一套：
   *   `†` 生命（维多利亚墓碑十字）｜`◈` 灵性（神秘学菱形）｜`☾` 理智（月亮，理智与疯狂同源）
   *   `✜` 疯狂｜`✠` 污染｜`⚗` 消化（**炼金术蒸馏瓶**，魔药消化度用它最贴）
   *   `✦` 行动｜`❖` 命运｜`▣` 行囊｜`◉` 所在｜`☩` 教会
   *
   * 留表格的那一组，列序固定「属性 | 进度 | 数值」：名字左对齐、数值右对齐 ——
   * 这是拿全角空格凑对齐做不到的（`61/100` 与 `88/100` 在比例字体下宽度是浮动的）。
   */
  const lines: string[] = [];
  const where: string[] = [];
  if (extras.cityName) where.push(`◉ ${extras.cityName}`);
  if (extras.churchName) {
    const contribution = extras.churchContribution ?? 0;
    where.push(`☩ ${extras.churchName} · 虔诚 ${contribution}`);
  }
  /*
   * M2.45 第十二版：地点行**不再自带分割线**（用户：「所在地直接放在昵称下面，这样又节省一行」）。
   *
   * 上一版是「地点行 + 分割线」，而消息头收尾已经有一条分割线 ——
   * 于是「◉ 城市」被两条线夹在中间，白占一行。
   * 现在它紧跟在消息头那条线下面、直接接数值行（`.角色卡` 的文字卡没有消息头，同样成立）。
   */
  if (where.length > 0) lines.push(where.join('　'));
  /*
   * M2.45 第十版：**表格 → 紧凑文字行**。
   *
   * 真机截图（用户原话：「手机端霸屏，又不好看」）：QQ 把表格渲染成**撑满气泡宽度的大格子**，
   * 每行高度约是普通文字行的 1.5 倍 —— 八项数值做成八行表格，光这一块就吃掉半屏，
   * 而它承载的信息量与八行文字**完全相同**。表格在这里不划算：
   * 它买到的是「列对齐」，而列对齐用**等宽的字**就能拿到，不必付格子钱。
   *
   * 对齐怎么保证（用户第二条：「QQ 消息里很难居中，那么对齐就很重要」）：
   *   · 名称一律两个字（生命 / 灵性 / 理智），汉字在中文环境恒为 1 em；
   *   · 刻度条固定 8 个 `▰▱`（Block Elements —— 真机截图里那串方块是整齐的，说明等宽）；
   *   · 两条之间用**全角空格**，位置固定。
   * 三行因此天然成列，而且不依赖客户端排版。
   *
   * ⚠️ 行首**不放装饰符号**：`†◈☾✜✠⚗✦❖` 都是 East Asian Ambiguous 宽度，其中 `⚗☾✦`
   * 在手机上还会被渲染成 emoji（用户截图里 `⚗` 就是个彩色图标），宽度随字体回退而变 ——
   * 放在行首会让三行**整体错位**，而那正是最不能出错的地方。
   */
  /*
   * ⚠️ M2.45 第二十一版：**颜色撤掉了**（第十九版加过，真机打回来了）。
   *
   * 探测组（`.探针 html`）里 `<font color>` / `<span style>` / `<mark>` **全都生效**，
   * 于是我给刻度条上了色。但用户拿**手机 QQ 与电脑 QQ 并排对比**之后发现：
   *
   *   手机 QQ：`生命 <font color="#e54d42">▰▰▰▰</font> 100/100` —— **标签原样打了出来**
   *   电脑 QQ：同一份内容渲染成红/蓝/紫，完全正常
   *
   * ⇒ **同一个渲染器家族，两端不一致**；而玩家绝大多数在手机上。
   * 「探测通过」不等于「可以上」——**探测必须两端都看**，这一条写进了
   * docs/QQ-markdown-能力实测.md。
   *
   * 现在刻度条回到纯字符：加粗名称 + 8 格 ▰▱ + 当前/上限。
   */
  /*
   * M2.86：**按「需要立刻判断」上色**（用户要「所有模板都有颜色」）。
   *
   *   生命低于三成 → 红（该跑了）
   *   理智低于三成 → 红（快失控了）
   *   其余的数值不上色 —— 全都上色等于都没上色。
   */
  const c = extras.supportsColor === true;
  /*
   * M2.86 第二轮：**三档**，而且**血条本身也上色**。
   *
   * 第一轮只在 <=30% 时把数字染红 —— 用户看到的是「血条和数据都没颜色」，
   * 因为 73/100 这种**正常值本来就该有自己的颜色**。玩家要一眼看出的是
   * 「我现在状态好不好」，那需要一条**刻度**而不是一个二元开关：
   *
   *   >= 70%  健康绿    30% 到 70%  警告金    < 30%  危险红
   *
   * 血条（▰▱）与数值用同一个颜色 —— 它们说的是同一件事，分开上色只会乱。
   */
  // 中间档用 warn（橙）而不是 gain（金）—— 金是「收益」，橙才是「注意」
  /*
   * **本色 + 危险时统一变红**（M2.86：用户「血条那三个条都是一个色的」）。
   *
   * 第一版三条共用一套档位色，健康时全绿 —— 分不出哪个是哪个。
   * 但血条必须**一眼可辨身份**（血是红的、灵性是蓝的、理智是紫的），
   * 同时又要能**一眼看出危不危险**。两个诉求叠起来只有一种排法：
   *
   *   正常（>=30%）→ **本色**：生命红 / 灵性蓝 / 理智紫 / 疯狂·污染绿（越低越好）
   *   低于 30%     → **统一 danger 深红 + ▼**
   *
   * 这样「变红」就真的是警报 —— 如果平时也是红的，红就不响了。
   */
  const gradeOf = (value: number, max: number): 'ok' | 'warn' | 'danger' => {
    const ratio = max <= 0 ? 1 : value / max;
    if (ratio < 0.3) return 'danger';
    if (ratio < 0.7) return 'warn';
    return 'ok';
  };
  /**
   * 一行「名称　血条　数值」，三者同色。
   *
   * **本色 + 危险时统一变红**（M2.86：用户「血条那三个条都是一个色的，血条不应该是红的？」）。
   *
   * 第一版三条共用一套档位色（健康绿/警告橙/危险红），于是健康时三条全绿，
   * 分不出哪个是哪个。但血条有两个**同时成立**的诉求：
   *
   *   ① **一眼可辨身份** —— 血是红的、灵性是蓝的、理智是紫的；
   *   ② **一眼看出危不危险**。
   *
   * 两个叠起来只有一种排法：**平时用本色，低于三成统一换成 danger 深红**。
   * 这样「变红」才真的是警报 —— 如果平时也是红的，红就不响了。
   *
   * `base` 就是那条属性的本色。
   */
  const metricLine = (
    label: string,
    value: number,
    max: number,
    base: 'vital' | 'info' | 'arcane',
  ): string => {
    const grade = gradeOf(value, max);
    const kind: 'vital' | 'info' | 'arcane' | 'warn' | 'danger'
      = grade === 'danger' ? 'danger' : grade === 'warn' ? 'warn' : base;
    return '**' + label + '**　' + hl(barOf(value, max), kind, c) + '　' + hl(value + '/' + max, kind, c);
  };
  // 生命红 / 灵性蓝 / 理智紫 —— 三条各持本色
  const hpLine = metricLine('生命', state.hp, 100, 'vital');
  const mpLine = metricLine('灵性', state.mp, maxMp, 'info');
  const sanLine = metricLine('理智', san, 100, 'arcane');
  lines.push(
    hpLine,
    mpLine,
    sanLine,
    '',
    // M2.45 第二十三版：同类字段用「名字:值 | 名字:值」排（借鉴用户给的那批机器人截图：
    // 「清洁度:27 | 心情值:24」比空格分隔更好扫）。半角竖线在行内安全，不会被当成表格（行首不是它）。
    // 疯狂/污染高是危险信号（红），消化是晋升进展（金）—— 三类分开才看得出轻重
    /*
     * 疯狂 / 污染是**越低越好**（与血条相反），所以三档的阈值也反过来：
     *   >= 50 危险红（该净化了）   >= 25 警告金   否则健康绿。
     * 消化是**进展**，绿到金都算好消息，所以固定金色（它没有「危险」一说）。
     */
    /*
     * ⚠️ M2.117：**三角块只表示方向**（用户：「提升是绿色的上箭头，降低是红色的下箭头」）。
     *
     * 这里原来有两处会误导：
     *   · 疯狂 / 污染 高位用 `danger`，而它的符号是 **▼** ⇒「▼ 疯狂 62」读起来像「疯狂降了」，
     *     而它恰恰是**高得危险**；
     *   · 消化度固定用 `gain`（**▲**）⇒「▲ 消化 0」—— 一点进展都没有，却挂着上箭头。
     *
     * 现在：
     *   疯狂 / 污染   高 = `alarm`（红 `!`，不表示方向）／中 = `warn`（金 `!`）／低 = `ok`（无符号）
     *   消化度        > 0 = `up`（绿 ▲，**有进展**）／= 0 = `ok`（无符号，没进展就别挂箭头）
     */
    '疯狂:' + hlMark(String(whole(state.mad)), state.mad >= 50 ? 'alarm' : state.mad >= 25 ? 'warn' : 'ok', c)
      + ' | 污染:' + hlMark(String(whole(state.cor)), state.cor >= 50 ? 'alarm' : state.cor >= 25 ? 'warn' : 'ok', c)
      + ' | 消化:' + hlMark(String(whole(state.dig)), state.dig > 0 ? 'up' : 'ok', c),
    '命运:' + hlMark(state.dp + '/10', 'arcane', c),
  );
  if (extras.bagCount !== undefined) {
    lines.push('', `▣ 行囊 ${extras.bagKinds ?? 0} 种 / ${extras.bagCount} 件`);
  }
  if (extras.pendingPromotion) lines.push(extras.pendingPromotion);
  if (!isInitiated(state)) {
    // 「还没有途径」这句必须**留在正文**里：消息头那一行虽然也写了，
    // 但正文是唯一保证会被看到的地方（而且既有用例就守着这句话）
    /*
     * M2.45 第十八版（用户口径：「不是很紧要的信息就用 `>` 显示，用来高亮区别信息差」）：
     * 这一句是**引导**，不是状态本身 —— 走引用块，跟上面的数值分开层次。
     * 文字也缩到一行：「你还不知道自己会变成什么」那句在「下一步」菜单里已经有一条。
     */
    /*
     * M2.111：**重伤优先于「去探索」**（用户截图抓到的自相矛盾）。
     *
     * 那一刻玩家 `生命 0/100`，而状态页下面还写着「去 .探索：翻到线索就能走上第一条路」——
     * 可 `.探索` 现在会拒绝他（M2.108 加的重伤门槛）。**页面指的路走不通，比不指路更糟。**
     *
     * 判据与那道门槛保持一致：`hp <= 0 || status === injured`。
     */
    if (state.hp <= 0 || state.status === 'injured') {
      lines.push('', '> 你伤得很重 —— 先 `.休息` 把伤收口（每日 1 次），在那之前出不了门。');
    } else {
      lines.push('', '> 还没有途径 —— 去 .探索：翻到线索就能走上第一条路（.线索 看进展）。');
    }
  }
  return lines.join('\n');
}

export function renderStatusSummary(state: CharacterState): string {
  const gender = GENDER_TAGS[state.gender] ?? '';
  if (!isInitiated(state)) {
    return `【${state.name}】${gender} · 还没有途径 · HP ${state.hp} · SAN ${100 - state.mad}`;
  }
  return `【${state.name}】${gender} · 序列 ${state.sequence} · HP ${state.hp} · SAN ${100 - state.mad} · 消化 ${whole(state.dig)}`;
}

export async function handleStatus(ctx: CommandContext): Promise<CommandResult> {
  const character = ctx.deps.characters.findByUserId(ctx.msg.userId);
  // 内部标记（当前地点 / 信誉 / 播报节流…）不进"标记"清单，见 flags.ts 的 isInternalFlag
  const flags = character ? ctx.deps.flags.list(character.id).filter((flag) => !isInternalFlag(flag)) : [];
  if (!character) {
    return {
      privateText: '你还没有角色。发送 .创建 姓名 开始。',
      groupText: `【${ctx.msg.nickname || ctx.msg.userId}】还没有角色。`,
      detailToPrivate: true,
    };
  }
  /*
   * M2.45：状态卡正文现在**又厚又长**，所以把能查到的都查出来给它 ——
   * 用户的原话是「状态卡显示的东西也太少了」。
   * 城市名与教会名要查表（`renderStatus` 是纯函数，只认 CharacterState）。
   */
  const cityName = character.currentCityId
    ? ctx.deps.locations.get(character.currentCityId)?.name ?? character.currentCityId
    : undefined;
  const churchName = character.churchId
    ? ctx.deps.churches.all().find((church) => church.id === character.churchId)?.name ?? character.churchId
    : undefined;
  const bag = ctx.deps.inventory.list(character.id);
  const detail = [
    renderStatus(character, {
      ...(cityName ? { cityName } : {}),
      ...(churchName ? { churchName } : {}),
      ...(character.churchContribution !== undefined
        ? { churchContribution: character.churchContribution }
        : {}),
      bagCount: bag.reduce((sum, entry) => sum + entry.quantity, 0),
      bagKinds: bag.length,
      // M2.86：颜色走 LaTeX，通道能力说了算（默认关时逐字等于旧输出）
      supportsColor: ctx.deps.supportsColor === true,
    }),
  ];
  /*
   * M2.11 前置 3：.状态 是玩家在 PVP 等待期最自然会发的一条。
   * 等待块紧跟状态卡 —— 那一屏要同时回答「我现在什么样」和「这一场现在什么样」。
   */
  const wait = pvpWaitBlockFor(ctx.deps, character, ctx.now);
  if (wait) detail.push('', ...wait);
  // M2.6：被通缉时单占一行 —— 否则玩家只会觉得"AP 怎么突然不够用了"
  const wantedLine = wantedStatusLine(ctx.deps, character.id, ctx.now);
  if (wantedLine) detail.push(wantedLine);
  if (flags.length > 0) {
    /*
     * ⚠️ 这里原来直接把 flag 的 id 列出来（`mark_locations、owes_favor、…`）。
     * 那些是**内部状态**，玩家看到的是一串看不懂的英文 —— 而且它占的那一行
     * 正好在状态卡最显眼的位置，把真正的信息挤下去了。
     * 只报数量与那层意思：具体是什么，让他在玩法里体会（也免得把隐藏机制说穿）。
     */
    // 同上：这一行是提示而不是数值，走引用块与状态卡本体分开
    detail.push(`> 标记：${flags.length} 个　·　有些事还没了结`);
  }
  /*
   * M2.45：**群聊也发完整状态卡**。
   *
   * 原来这里给 groupText 的是一行摘要（`renderStatusSummary`），详细那几行走私聊 ——
   * 那是 M2.11「群聊只播报摘要」的口径。但真机上玩家的感受是「状态卡显示的东西太少」，
   * 因为群聊才是大家真正在用的场景，而私聊那条很少有手机用户会去看。
   * `detailToPrivate: false` 把这份明细留在群里。
   */
  return {
    privateText: detail.join('\n'),
    groupText: detail.join('\n'),
    detailToPrivate: false,
  };
}
