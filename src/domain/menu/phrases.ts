/**
 * 标签 → 人话（M2.3）。
 *
 * **这不是判定，也不是写死的选项**：选哪些标签完全由
 * 「途径的 tags + 天气 + 时段」算出来，这里只负责把那个标签翻译成一句玩家看得懂的行为。
 *
 * ⚠️ 一条硬规则（test/menu.test.ts 会逐条校验）：**每一句文案都必须包含它自己的标签词**。
 * 原因是判定层用的是「关键词包含匹配」（src/domain/play/score.ts）——
 * 文案里没有「占卜」两个字，玩家选了这条也不会涨消化度，菜单就成了骗人的。
 * 内容层新加标签时不用改这里：`phraseOf` 会走兜底句，兜底句自带标签词，测试照样过。
 */
import type { PathwayId } from '../character/types.ts';
import type { TimeOfDay } from '../world/clock.ts';
import type { WeatherId } from '../world/weather.ts';
/*
 * M2.56：表从**内容层**注入（src/data/tag-phrases.yaml），这里不再硬编码。
 *
 * 为什么搬出去：这批文案玩家每次 .扮演 都会看到，是最值得反复打磨的一批 ——
 * 而它原来躺在代码里，改一个措辞要发版。
 *
 * 为什么不在这里留一份默认表：那会变成**两处真相**。改了 YAML 忘了改代码、
 * 或者反过来，都会让「菜单上写的」和「判定实际算的」对不上 —— 而那种不一致
 * 没有任何东西会报错。唯一真相在 YAML，loader 逐条校验（含标签词那条硬规则）。
 */
let injected: Record<string, Record<string, string>> | null = null;

/** 启动时由 main.ts 注入一次。没注入时 phraseOf 走兜底句（单测与降级路径） */
export function installTagPhrases(table: Record<string, Record<string, string>>): void {
  injected = table;
}

/** 表里没有的标签用这句；自带标签词，保证「内容加标签，菜单不漏项、也不骗人」 */
export function phraseOf(pathway: PathwayId, tag: string): string {
  const fromTable = injected?.[pathway]?.[tag];
  if (fromTable !== undefined) return fromTable;
  /*
   * 兜底句**必须自带标签词**：判定层按关键词匹配，少那两个字的话，
   * 内容层新加一个标签、文案还没跟上时，玩家选了这条就不涨消化度 ——
   * 而这不会报任何错，只是那个玩法静默失效。
   */
  return '以「' + tag + '」的方式行事';
}

/**
 * 情境偏好（天气 / 时段 → 优先说哪个标签）。
 *
 * 为什么是「偏好标签」而不是「固定行为」：任务书要的是
 * 「雾天多观察、血月多仪式」，而**具体那句话必须由途径决定** ——
 * 愚者的「观察」和战士的「观察」不是一件事。
 * 所以这里只给一串候选标签，由生成器去途径自己的 tags 里找第一个命中的；
 * 一个都命中不了（例如战士在雾天）就用途径自己的核心标签兜底。
 *
 * 白天的偏好表是**空的**：白天是基准时段，没有「情境」可言 ——
 * 只有真的有情境（雾 / 雨 / 雷暴 / 血月 / 静默 / 灵界渗透，或黎明 / 黄昏 / 夜晚）
 * 才往菜单前面插一条情境选项。这样「换天气」在菜单上是看得见的。
 */
const WEATHER_BIAS: Partial<Record<WeatherId, readonly string[]>> = {
  fog: ['观察', '追踪', '隐秘', '潜伏'],
  greyfog_tide: ['隐秘', '潜伏', '幕后', '静默'],
  rain: ['追踪', '潜伏', '静默', '观察'],
  storm: ['勇气', '威慑', '守护', '武器'],
  blood_moon: ['仪式', '守夜', '梦', '低语'],
  silence: ['静默', '潜伏', '隐秘', '梦'],
  spirit_creep: ['低语', '梦', '幻觉', '仪式'],
  clear: [],
};

const TIME_BIAS: Partial<Record<TimeOfDay, readonly string[]>> = {
  dawn: ['远行', '训练', '推算', '历史'],
  dusk: ['潜行', '隐秘', '仪式', '赌'],
  night: ['守夜', '潜行', '黑夜', '潜伏'],
};

/** 天气偏好在前（M2.2 的天气要在这里变现），时段偏好兜后 */
export function situationBias(weather: WeatherId, timeOfDay: TimeOfDay): readonly string[] {
  return [...(WEATHER_BIAS[weather] ?? []), ...(TIME_BIAS[timeOfDay] ?? [])];
}

/** 菜单首屏给情境选项配的一句话 */
export const SITUATION_NOTE: Partial<Record<WeatherId, string>> = {
  fog: '雾天',
  greyfog_tide: '灰雾潮',
  rain: '雨天',
  storm: '雷暴',
  blood_moon: '血月',
  silence: '静默',
  spirit_creep: '灵界渗透',
};
