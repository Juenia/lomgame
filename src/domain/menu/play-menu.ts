/**
 * `.扮演` 的选项生成器（M2.3 任务一）。
 *
 * 纯函数：`(character, world, pathway) → Menu`，不读库、不掷骰、不看墙上时间。
 *
 * 选项**从状态生成**，不是写死的四句话。每个选项的出处都能指出来：
 *
 * | 来源 | 影响 |
 * |---|---|
 * | 途径 tags | 决定候选标签池（愚者与战士的选项完全不同） |
 * | 序列（abilityName） | 序列 8 解锁「用新能力做这件事」 |
 * | 天气 | 决定情境偏好标签：雾天多「观察」、血月多「仪式」 |
 * | 时段 | 同上：夜晚偏「潜行/守夜」，黎明偏「远行/训练」 |
 * | MAD / COR | ≥ 阈值时把「休息」「净化」置顶 |
 * | 背包 | 手上有本途径本序列的魔药 → 多一个「服用」 |
 *
 * 匹配度只显示「高/中/低」（NUMERIC.menu.match 分档），**不给精确分数** —— 任务书 §3.4：
 * 给数字玩家就会开始算分，那就又变回「背攻略」了。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { PATHWAY_LABELS } from '../character/rules.ts';
import { scorePlay, type PlayScoreBreakdown } from '../play/score.ts';
import { PATHWAY_TAGS } from '../play/tags.ts';
import { sequenceOrInitiate, type PathwayId } from '../character/types.ts';
import { TIME_OF_DAY_LABELS } from '../world/clock.ts';
import { weatherLabel, weatherRow } from '../world/weather.ts';
import { phraseOf, situationBias, SITUATION_NOTE } from './phrases.ts';
import {
  FREEFORM_KEY,
  type Menu,
  type MenuCharacter,
  type MenuOption,
  type PathwayKit,
  type WorldSnapshot,
} from './types.ts';

/** 途径套件：标签表是唯一入口，菜单不硬编码任何一条途径的行为 */
export function pathwayKit(pathway: PathwayId): PathwayKit {
  return { id: pathway, label: PATHWAY_LABELS[pathway], tags: PATHWAY_TAGS[pathway] };
}

/** 匹配度分档文案（只用于显示） */
export function matchLabel(score: number): string {
  const { high, mid } = NUMERIC.menu.match;
  if (score >= high) return '高';
  if (score >= mid) return '中';
  if (score > 0) return '低';
  return '无';
}

/** 打分用的文本 → 一个带「（命中标签，匹配X）」后缀的显示文本 */
function annotate(text: string, breakdown: PlayScoreBreakdown): string {
  const hits = [...breakdown.matchedCore, ...breakdown.matchedSecondary];
  const tagPart = hits.length > 0 ? hits.slice(0, 2).join('·') : '不搭';
  const forbidden = breakdown.matchedForbidden.length > 0 ? '，违背途径' : '';
  return `${text}（${tagPart}，匹配${matchLabel(breakdown.final)}${forbidden}）`;
}

/** 今日某个标签还能不能计入（超过 tagDailyCap 就不再涨消化度了） */
function usageOf(state: MenuCharacter, tag: string): number {
  return state.tagUsage?.get(tag) ?? 0;
}

/**
 * 候选标签 → 选项。排序规则（越靠前越优先）：
 *   1. 今天还用得上（用量 < tagDailyCap）的排在用满的前面；
 *   2. 同组内保持 tag 表里的原始顺序（内容作者的意图）。
 */
function rankTags(state: MenuCharacter, tags: readonly string[]): string[] {
  const cap = NUMERIC.playScore.tagDailyCap;
  return [...tags].sort((a, b) => {
    const usedA = usageOf(state, a) >= cap ? 1 : 0;
    const usedB = usageOf(state, b) >= cap ? 1 : 0;
    if (usedA !== usedB) return usedA - usedB;
    return 0;
  });
}

function playOption(
  state: MenuCharacter,
  kit: PathwayKit,
  tag: string,
  text: string,
  note?: string,
): MenuOption {
  const breakdown = scorePlay(text, kit.tags, state.tagUsage ?? new Map());
  const label = annotate(text, breakdown);
  return {
    key: '',
    label,
    command: `扮演 ${text}`,
    preview: note ? `${note} · ${tag}` : tag,
  };
}

/**
 * 扮演菜单。
 *
 * @param state    角色卡（可带 inventory / dailyCounters / tagUsage / potions 等只读视图）
 * @param world    当前世界快照（worldViewFor 的产物）
 * @param pathway  途径套件（pathwayKit(character.pathway)）
 */
export function buildPlayMenu(
  state: MenuCharacter,
  world: WorldSnapshot,
  pathway: PathwayKit,
): Menu {
  const { clock, weather } = world;
  const kit = pathway;
  const options: MenuOption[] = [];
  // 注意展开顺序：生成器可能带着空的 key 传进来，编号必须由这里统一盖章
  const push = (option: Omit<MenuOption, 'key'>): void => {
    options.push({ ...option, key: String(options.length + 1) });
  };

  /* ---------- 1) 风险置顶：MAD/COR ≥ 70 或正在失控 ---------- */
  const madHigh = state.mad >= NUMERIC.menu.riskTopThreshold;
  const corHigh = state.cor >= NUMERIC.menu.riskTopThreshold;
  const lostControl = state.status === 'lost_control';
  // 谁到线谁排前面：COR 高先净化、MAD 高先休息、失控则净化优先（它同时压 COR 与 MAD）
  const restFirst = !(corHigh || lostControl);
  if (madHigh || corHigh || lostControl) {
    const restOption = (): Omit<MenuOption, 'key'> => {
      const restUsed = state.dailyCounters?.['rest'] ?? 0;
      return {
        label: '休息（先把自己捞回来）',
        command: '休息',
        preview: `MAD ${NUMERIC.recovery.rest.mad} · HP +${NUMERIC.recovery.rest.hp}`,
        ...(restUsed >= NUMERIC.recovery.rest.dailyLimit ? { disabled: '今天已经休息过了' } : {}),
      };
    };
    const purifyUsed = state.dailyCounters?.['purify'] ?? 0;
    const salt = NUMERIC.recovery.purify.materials[0]!;
    const hasSalt = (state.inventory ?? []).some(
      (slot) => slot.itemId === salt.itemId && slot.quantity >= salt.qty,
    );
    const purifyOption = (): Omit<MenuOption, 'key'> => ({
      label: '净化（把污染逼出来一点）',
      command: '净化',
      preview: `COR ${NUMERIC.recovery.purify.cor} · MAD ${NUMERIC.recovery.purify.mad}`,
      ...(purifyUsed >= NUMERIC.recovery.purify.dailyLimit
        ? { disabled: '今天已经净化过了' }
        : !hasSalt
          ? { disabled: `缺${salt.itemId}` }
          : {}),
    });
    // 谁到线谁排前面：COR 高先净化、MAD 高先休息、失控则净化优先（它同时压 COR 与 MAD）
    if (restFirst) {
      push(restOption());
      push(purifyOption());
    } else {
      push(purifyOption());
      push(restOption());
    }
  }

  /* ---------- 2) 情境选项：天气 + 时段决定先说什么 ---------- */
  const pool = [...kit.tags.core, ...kit.tags.secondary];
  const situationTag = situationBias(weather, clock.timeOfDay).find((tag) => pool.includes(tag));
  const used = new Set<string>();
  if (situationTag) {
    used.add(situationTag);
    const note = SITUATION_NOTE[weather] ?? TIME_OF_DAY_LABELS[clock.timeOfDay];
    push(playOption(state, kit, situationTag, phraseOf(kit.id, situationTag), note));
  }

  /* ---------- 3) 途径核心标签：两个「像本条途径的做法」 ---------- */
  for (const tag of rankTags(state, kit.tags.core)) {
    if (options.length >= NUMERIC.menu.playOptionCount - 1) break;
    if (used.has(tag)) continue;
    used.add(tag);
    push(playOption(state, kit, tag, phraseOf(kit.id, tag)));
  }
  if (options.length < NUMERIC.menu.playOptionCount - 1) {
    for (const tag of rankTags(state, kit.tags.secondary)) {
      if (options.length >= NUMERIC.menu.playOptionCount - 1) break;
      if (used.has(tag)) continue;
      used.add(tag);
      push(playOption(state, kit, tag, phraseOf(kit.id, tag)));
    }
  }

  /* ---------- 4) 序列解锁：序列 8 起多一条「用新能力做这件事」 ---------- */
  // M2.7.6：普通人没有序列 —— sequenceOrInitiate 给 9，于是这一项自然不出现
  if (sequenceOrInitiate(state) <= 8 && state.abilityName) {
    const tag = kit.tags.core[1] ?? kit.tags.core[0]!;
    push(
      playOption(
        state,
        kit,
        tag,
        `我按${state.abilityName}的方式${tag}`,
        `序列 8 专属`,
      ),
    );
  }

  /* ---------- 5) 背包：手上有本途径本序列的魔药 → 直接喝 ---------- */
  const potion =
    (state.potions ?? []).find(
      (entry) => entry.pathway === kit.id && entry.seq === state.sequence,
    ) ?? (state.potions ?? [])[0];
  if (potion) {
    push({
      label: `服用 ${potion.name}`,
      command: `服用 ${potion.itemId}`,
      preview: `消化 +${NUMERIC.potion.digOnDrink} · 疯狂 +${NUMERIC.potion.madOnDrink}`,
    });
  }

  // 一个选项都没有的情况（内容层把 tags 清空了）：给一条保底，别让玩家面对空菜单
  if (options.length === 0) {
    push({ label: '想一想今天要做什么', command: '状态', preview: '看看自己的状态' });
  }

  return {
    title: `【扮演 · ${kit.label} · 序列 ${state.sequence}】`,
    context: playContext(state, world),
    options,
    allowFreeform: true,
  };
}

/** 菜单首屏的世界摘要（M2.2 的天气与时段在这里第一次真正「被玩家看见」） */
function playContext(state: MenuCharacter, world: WorldSnapshot): string[] {
  const { clock, weather, modifiers } = world;
  const gap = NUMERIC.promotion.digThreshold - state.dig;
  const lines: string[] = [];
  lines.push(
    `${weatherLabel(weather)} · ${TIME_OF_DAY_LABELS[clock.timeOfDay]} · ` +
      `DIG ${state.dig.toFixed(1)}（${gap > 0 ? `距晋升线 ${gap.toFixed(1)}` : '已过晋升线'}）`,
  );
  const notes: string[] = [];
  if (modifiers.playMad !== 0) {
    notes.push(`扮演疯狂 ${modifiers.playMad > 0 ? '+' : ''}${modifiers.playMad}/次`);
  }
  if (modifiers.playDigMultiplier !== 1) {
    notes.push(`消化 ×${modifiers.playDigMultiplier.toFixed(2)}`);
  }
  const row = weatherRow(weather);
  if (row.lossOfControl !== 1) notes.push(`失控概率 ×${row.lossOfControl.toFixed(2)}`);
  if (clock.fullMoon) notes.push('月圆：失控概率 +10%');
  if (clock.foggy) notes.push('雾日');
  if (notes.length > 0) lines.push(notes.join('　'));
  return lines;
}