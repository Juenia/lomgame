/**
 * .线索 —— M2.85 的新人入口（替代被删除的 .引导）。
 *
 * 设计动机（用户口径）：引导「莫名其妙的来，中间怎么走都不知道」。
 * 现在走上途径只有一条路 —— 探索翻线索（5%，满 cluePityDays 天必出）——
 * 而「中间怎么走」这个问题由这条命令回答：
 *   手上的纸 → 是哪条途径的 → 主材料叫什么 → 哪些地点有产出。
 * 全部从内容表反查（配方表 / 掉落表），没有一份手抄清单。
 */
import { INITIATION } from '../../config/numeric.ts';
import { PATHWAY_LABELS } from '../../domain/character/rules.ts';
import {
  isInitiated,
  type CharacterState,
  type InitiatedCharacter,
  type PathwayId,
} from '../../domain/character/types.ts';
import { mortalDayOf } from '../../domain/initiation/index.ts';
import { hl } from '../../adapter/highlight.ts';
import { loadLocations } from '../../data/loader.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { requireCharacter } from './common.ts';

export const CLUE_USAGE = '用法：.线索 —— 看看手上有哪些配方线索、它们的主材料去哪里找';

/**
 * 「哪个地点掉这样东西」的反查索引（itemId → 地点 id 列表）。
 *
 * 掉落表的正向形状是「地点 → 掉什么」，而玩家手里拿着的是**材料名** ——
 * 他要问的是「去哪能弄到它」。模块级记一份：内容表只在启动时读，
 * 进程活着的时候它不会变。
 */
let dropIndex: Map<string, string[]> | null = null;
function dropsOfItem(itemId: string): readonly string[] {
  if (!dropIndex) {
    dropIndex = new Map();
    for (const location of loadLocations().locations) {
      for (const loot of location.loot) {
        const list = dropIndex.get(loot.itemId) ?? [];
        if (!list.includes(location.id)) list.push(location.id);
        dropIndex.set(loot.itemId, list);
      }
    }
  }
  return dropIndex.get(itemId) ?? [];
}

/** 途径 → 序列 9 主材料（从配方表派生；AGENTS §3.1 —— 清单只能有一份） */
function mainMaterialOf(ctx: CommandContext, pathway: PathwayId): string | null {
  const recipe = ctx.deps.recipes.forPathway(pathway).find((entry) => entry.seq === 9);
  return recipe?.main[0]?.itemId ?? null;
}

/*
 * M2.86：**长度上限**（用户：「小心不要过长又给截断了」）。
 *
 * 实测：一张线索 246 字符、六张 1042 字符 —— 而通道侧的 `#clampContent` 上限是 1000，
 * 也就是说**第七张起就会被截断**，玩家看到的是半截列表。
 *
 * 所以这里主动收口，而不是等通道去截：
 *   · 产出地点最多列 `MAX_DROPS` 个，其余并成「等 N 处」；
 *   · 线索明细最多展开 `MAX_DETAIL` 张，其余只列途径名。
 *
 * 两个数都是量出来的：6 个地点 + 3 张明细之后，输出稳定在 600 字符上下，
 * 留足了余量（`#clampContent` 还会为超长内容补一句「已截断」，那行本身也要占位）。
 */
const MAX_DROPS = 6;
const MAX_DETAIL = 3;

/**
 * 材料 id → 人话（M2.86）。
 *
 * 原作的配方里「或」是**斜杠写在一个 id 里**的，例如：
 *
 *     主材料·结晶太阳花一朵/一只成年火石鸟的尾羽/纵火鸟的尾羽
 *
 * 也就是「三种任选其一」。直接照抄出来玩家会以为是三种都要，
 * 而且那一长串挤在「主材料：」后面看着像乱码。
 *
 * 这里做两件事：
 *   ① 去掉「主材料·」/「辅助材料·」前缀 —— 上一行已经写了「主材料：」，重复；
 *   ② 把 `/` 展成「或」—— 这才是那条配方的真实含义。
 *
 * **只改显示、不改数据**：id 是对照原作的键，动了它内容就再也对不回去。
 */
function materialLabel(id: string): string {
  return id
    .replace(/^(主材料|辅助材料)·/, '')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' 或 ');
}

/** 展示用：地点 id → 「城市·地点名」（查得到城市才拼前缀） */
function locationLabel(ctx: CommandContext, locationId: string): string {
  const location = ctx.deps.locations.get(locationId);
  const city = ctx.deps.geo.cityOfLocation(locationId);
  const name = location?.name ?? locationId;
  const cityName = city?.name ?? city?.id ?? '';
  /*
   * M2.86：城市与地点**同名时不要重复**。
   *
   * 实机输出里出现过「廷根市·廷根市」—— 因为那座城市本身也是一个可探索地点，
   * 名字一样。拼出来像口吃，而且占长度（这一行列了 28 个地点）。
   */
  if (!cityName || cityName === name) return name;
  return `${cityName}·${name}`;
}

/** 已入途径之后 .线索 该说什么：那张纸的故事已经讲完了，指回主线 */
function initiatedText(character: InitiatedCharacter): string {
  return [
    `你已经走在${PATHWAY_LABELS[character.pathway]}这条路上了 —— 线索那页纸的故事结束了。`,
    '',
    '想继续往上走，发 .晋升（要先 .扮演 把消化度攒起来）。',
  ].join('\n');
}

export async function handleClue(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character: CharacterState = gate.character;
  const { deps, now } = ctx;

  if (isInitiated(character)) {
    return { privateText: initiatedText(character), detailToPrivate: true };
  }

  const clues = deps.clues.unusedOf(character.id);
  /*
   * 没线索时**不自己算**「哪个地点开放」—— `.今日` 里本来就有探索选项，
   * 把那个入口给它就是了。自己再算一遍要复制「序列够不够得着」那套判断，
   * 两处判据迟早会漂（K16 的形状）。
   */

  if (clues.length === 0) {
    const day = mortalDayOf(character.createdAt, now);
    const remain = Math.max(0, INITIATION.cluePityDays - day);
    return {
      privateText: [
        '【你手上的线索】一张都没有。',
        '',
        '去 .探索 吧 —— 运气好的话，能在某个角落翻到一张纸（每次探索 5%）。',
        remain > 0
          ? `（你来到这里的第 ${day} 天。满 ${INITIATION.cluePityDays} 天还没翻到的话，探索必定翻到一张 —— 还有 ${remain} 天。）`
          : '（保底已经到了：下一次探索必定翻到一张。）',
        '',
        CLUE_USAGE,
      ].join('\n'),
      /*
       * M2.86：**按钮适应化**（用户：「线索模板的按钮没做适应化，还是基础四件套」）。
       *
       * 没线索时唯一该做的事就是去探索 —— 所以第一个按钮直接给「探索 <第一个开放地点>」，
       * 玩家零打字。其余保留「今日」「状态」两个兜底入口。
       */
      nextActions: [
        { label: '去探索', command: '今日', preview: '今天能去的地方' },
        { label: '状态', command: '状态' },
      ],
      detailToPrivate: true,
    };
  }

  /*
   * M2.86：第一行**要带上线索名**。
   *
   * 用户反馈：「.看线索 手上的线索1张，一张什么线索？不显示出来？」
   *
   * 根因不是明细丢了 —— 明细一直都在，只是 `detailToPrivate: true` 让它去了**私聊**，
   * 群里只留第一行摘要。而那行原来只有「N 张」，**看不出是哪张**。
   * 于是群里的观感就是「说了有一张，却不说是哪张」。
   *
   * 现在把途径名并进摘要：群里也能一眼看懂，明细照旧走私聊。
   */
  /*
   * M2.86：摘要用**线索原文的首句**，不再只报途径名。
   *
   * 用户：「线索 太阳，是什么东西，玩家怎么知道这是什么线索，两个字让人猜也太难猜了吧」
   *
   * 「太阳」是途径名 —— 但玩家（尤其刚上手的）根本不知道那是个途径，
   * 更不知道拿到它意味着什么。而这张纸**本来就有完整来龙去脉**：
   *
   *     「一枚被磨得发亮的铜牌，塞在教堂长椅的缝里。
   *       正面是一个太阳，背面被人用小刀刮过，刮得只剩几个字。
   *       那行字是：结晶太阳花。」
   *
   * 那句话一直存在 `recipe_clues.clue_text` 里，`.背包` 也一直在显示它 ——
   * 只有 `.线索` 把它扔了、只留一个途径名。**信息本来就在，是我没读。**
   */
  const headOf = (clue: { clueText: string }): string =>
    (clue.clueText.split('\n')[0] ?? '').trim() || '（这张纸上没有字）';
  /*
   * M2.86：**一次只看一张**（用户：「有多条线索的情况下，增加一个查看下一条线索的按钮」）。
   *
   * 原来是一条指令把所有线索摊开 —— 三条就 700 字符、七条必被通道截断，
   * 而且「看下一条」这件事在没有翻页的情况下只能靠 `.背包`。
   * 现在 `.线索` 看第 1 张，`.线索 2` 看第 2 张，按钮直接给「下一条」。
   */
  const wanted = Number.parseInt((ctx.args[0] ?? '').trim(), 10);
  const index = Number.isFinite(wanted) ? Math.min(Math.max(wanted, 1), clues.length) - 1 : 0;
  const clue = clues[index]!;
  const material = mainMaterialOf(ctx, clue.pathway);
  const pathwayName = PATHWAY_LABELS[clue.pathway] ?? clue.pathway;
  /*
   * 当前这张线索的主材料的**第一个产出地点**（「去X」按钮用它）。
   *
   * ⚠️ 必须跟着 `index` 走。第一版写的是 `clues[0]`（固定取第一张），
   * 分页之后就成了：「第 2 张是愚者、产出地在廷根市，按钮却写去特里尔」——
   * 因为特里尔是第一张（太阳）的产出地。**按钮指向了别人的地方。**
   */
  let firstDrop: { name: string } | null = null;
  {
    const dropId = material === null ? null : (dropsOfItem(material)[0] ?? null);
    const loc = dropId ? ctx.deps.locations.get(dropId) : null;
    if (loc) firstDrop = { name: loc.name };
  }
  const c = ctx.deps.supportsColor === true;
  const total = clues.length;

  const lines = [total === 1
    ? `【你手上的线索】${headOf(clue)}`
    : `【你手上的线索】第 ${index + 1} / ${total} 张`];
  /*
   * **分层**（用户：「主要的信息用颜色或者加粗高亮显示，其他信息用 > 显示，增加分层感」）：
   *
   *   · 纸上的原文 → **引用块** `>`，它是「故事」，不上色；
   *   · 途径 / 主材料 / 产出地 → **行内颜色**，它们是「能行动的信息」。
   *
   * 两者分开还有一个好处：扫一眼就知道哪几行是要记住的。
   */
  lines.push('');
  const rawLines = clue.clueText.split('\n').map((x) => x.trim()).filter((x) => x.length > 0);
  // 只有一张、且摘要已经念过首句时，引用块不重复第一行
  const body = total === 1 && index === 0 ? rawLines.slice(1) : rawLines;
  for (const text of body) lines.push(`> ${text}`);

  lines.push('');
  lines.push(
    `→ ${hl(pathwayName + '途径', 'arcane', c)} · 主材料：` +
      (material === null
        ? '（配方表里还没有这一条）'
        : hl(materialLabel(material), 'gain', c)),
  );
  if (material !== null) {
    const drops = dropsOfItem(material).map((id) => locationLabel(ctx, id));
    // 最多列 MAX_DROPS 个：实测某条主材料有 28 个产出地，全列出来单这一行就 400+ 字符
    const shown = drops.slice(0, MAX_DROPS);
    const more = drops.length - shown.length;
    lines.push(
      drops.length > 0
        ? `   ⌖ 有产出的地点：${hl(shown.join('、'), 'place', c)}${more > 0 ? ` 等 ${drops.length} 处` : ''}`
        : '   （目前还没有哪个地点产出它 —— 去别的城市碰碰运气）',
    );
  }
  lines.push('', '凑齐主材料与辅助材料之后，发 .魔药 调制；喝下去（.服用），你就再也不是普通人了。');
  return {
    privateText: lines.join('\n'),
    /*
     * M2.86：按钮适应化 —— 有线索时下一步是「去有产出的地方翻材料」。
     *
     * 列表里那串「有产出的地点」原来是**只能读**的信息，玩家要自己抄一个地名去 .探索；
     * 现在第一个按钮直接用那个地点，点一下就等于手打「探索 <地点>」。
     * 地点名要用 `location.name` 而不是 `locationLabel()` —— 后者是「城市·地点」的展示格式，
     * 而指令只认地点名本身。
     */
    nextActions: [
      /*
       * M2.86：**「下一条」按钮**（用户：「有多条线索的情况下，增加一个查看下一条线索的按钮」）。
       *
       * 用指令参数翻页（`.线索 2`）而不是把全部线索摊在一条消息里 ——
       * 后者三条就 700 字符、七条必被通道截断，而且每条都只能看到一小截。
       * 最后一张不再给「下一条」（点了会绕回同一张，那是假按钮）。
       */
      ...(index + 1 < total
        ? [{ label: '下一条', command: `线索 ${index + 2}`, preview: `第 ${index + 2} / ${total} 张` }]
        : []),
      ...(firstDrop !== null
        ? [{ label: '去' + firstDrop.name, command: '探索 ' + firstDrop.name, preview: '主材料可能就在这里' }]
        : []),
      { label: '翻翻背包', command: '背包', preview: '看看手头有什么' },
      { label: '状态', command: '状态' },
    ],
    detailToPrivate: true,
  };
}
