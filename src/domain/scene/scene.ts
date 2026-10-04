/**
 * 场景（M2.85 RPG 化）—— **纯函数，无 IO**。
 *
 * ## 用户拍板的两条（都改在叙事层）
 *
 * > ① 「我要的 RPG 感是游戏视角上的，现在的游戏就是推事件卡，像是在玩 galgame」
 * > ② 「伟大生物没有在城市里过度出现吧？起码普通人并不知道非凡生物和非凡者的存在吧？」
 * > ③ 人称：**第三人称**（群友能围观剧情）
 *
 * ② 是《诡秘之主》的**世界观基石**：**非凡世界是隐藏的**。
 * 一个序列 9 的普通人在街上**看不见**「噩梦邪眼（序列 9）」这种东西 ——
 * 他看见的是一点说不清的动静、一句邻居的怪话。
 *
 * 所以本文件有两个轴：
 *
 *   awareness  mortal（未入途径）  看得见日常，看不见真相
 *              initiated（非凡者） 看得见「那是什么」
 *   person     第三人称 —— 回执写给一整个群看，不是只写给当事人
 */

export interface SceneLocationView {
  id: string;
  name: string;
  /** 1（最安全）到 5（最危险） */
  danger: number;
  minSeq: number;
  maxSeq: number;
}

export interface SceneExit {
  locationId: string;
  name: string;
  danger: number;
}

export interface SceneBeast {
  name: string;
  sequence: number;
  /** 同名个体的数量（三只写成 ×3，不占三行） */
  note: string;
}

/** 玩家对非凡世界的认知：普通人与非凡者看到的是两个世界 */
import { hl, hlMark } from '../../adapter/highlight.ts';

export type Awareness = 'mortal' | 'initiated';

export interface Scene {
  location: SceneLocationView;
  exits: SceneExit[];
  beasts: SceneBeast[];
  /** 没看清的东西 —— 凡人只会看到这一栏（「有什么东西」），而不是它的名字 */
  hints: string[];
  others: string[];
  /** 同地点的 NPC —— 凡人只看到「一个人」，非凡者看得到名字与序列 */
  people: string[];
  /** 针对这个人的阴谋露出的**端倪**（omen 阶段）—— 玩家察觉与反制的入口 */
  omens: string[];
  /**
   * M2.86：**这一带的危险档位**（人话，如「很危险」「还算安稳」）。
   *
   * 用户：「正文信息也不能过于精简，起码的信息量要凸显出来」——
   * 危不危险是玩家决定「要不要继续待着」的唯一依据，之前只写在出口列表里。
   */
  dangerLabel: string;
  /** 危险度原始档位 0—5（上色与标记用） */
  danger: number;
  /** 氛围句：由危险度与天时共同决定 */
  atmosphere: string;
}

/**
 * 危险度 → 氛围句。**全部无人称**（第三人称回执要写给一整个群看）。
 *
 * 每一档都有白昼与夜晚两种说法，档与档之间、昼夜之间**都不重样**（守卫会抓模板）。
 */
const ATMOSPHERE: Record<number, { day: string; night: string }> = {
  1: {
    day: '这里人声不断，石板路被踩得发亮 —— 是个安全的地方。',
    night: '夜里也有灯。巡逻的人刚走过去一趟。',
  },
  2: {
    day: '来往的人不少，但都走得很快，没人愿意在这儿多留。',
    night: '灯少了一半。剩下那几盏照不到的地方，黑得比别处深。',
  },
  3: {
    day: '这一带安静得不太正常，偶尔有风穿过，带着一点铁锈味。',
    night: '没有灯。走夜路的人贴着墙，手一直没离开口袋里的东西。',
  },
  4: {
    day: '墙上留着爪痕。地上的血迹被人草草盖过，没盖干净。',
    night: '远处有东西在动。它停了一下，像是也在听这边的动静。',
  },
  5: {
    day: '这里的光是斜的。进来之后，身后的声音就断了。',
    night: '数不清这里有几双眼睛 —— 但那些眼睛都在看。',
  },
};

export function atmosphereOf(danger: number, isNight: boolean): string {
  const tier = ATMOSPHERE[Math.min(5, Math.max(1, Math.round(danger)))]!;
  return isNight ? tier.night : tier.day;
}

/**
 * 凡人看到「有东西在那里」时会怎么描述 —— **不出现物种名、不出现序列**。
 *
 * 这些句子按危险度分档，且刻意写得含糊：原著里的普通人就是这样活着的。
 */
const MORTAL_HINTS: Record<number, readonly string[]> = {
  1: ['墙根有什么东西很快地过去了，像是猫。'],
  2: ['有影子在动。看过去的时候又没有了。'],
  3: ['空气里有股味道，说不清是什么。有人低声说这一带晚上不太平。'],
  4: ['地上的痕迹不像人留下的。附近的人家全都关着窗。'],
  5: ['有什么东西就在近处 —— 但看不见它，只看得出「那里有」。'],
};

export function mortalHintOf(danger: number, index: number): string {
  const pool = MORTAL_HINTS[Math.min(5, Math.max(1, Math.round(danger)))]!;
  return pool[index % pool.length]!;
}

/** 第三人称代词 */
export function pronounOf(gender: string | null | undefined): string {
  return gender === 'female' ? '她' : '他';
}

/**
 * 场景渲染 —— **玩家的「游戏视角」**：他在哪、这里有什么、他能去哪。
 *
 * 人称是**第三人称**：回执发在群里，围观的群友也要读得懂。
 * 认知决定「看得见什么」：普通人只看得到迹象，非凡者才看得到「那是什么」。
 */
/** 危险度（0—5）的人话（正文里那一行「这一带……」） */
const DANGER_WORDS: readonly string[] = [
  '还算安稳',
  '还算安稳',
  '偶有异样',
  '不太平',
  '很危险',
  '进去就未必出得来',
];

/** 危险度 → 人话 */
export function dangerWordOf(danger: number): string {
  const i = Math.max(0, Math.min(DANGER_WORDS.length - 1, Math.round(danger)));
  return DANGER_WORDS[i]!;
}

export function renderScene(
  scene: Scene,
  head: { time: string; weather: string; calamity: string },
  who: { name: string; pronoun: string; awareness: Awareness },
  /**
   * M2.86：**正文高亮 + 信息量**（用户拍板）。
   *
   * `supportsColor` 默认 false —— 纯文本通道与既有测试的行为逐字不变；
   * 只有走 markdown 的通道才传 true（见 adapter/highlight.ts 顶部对那次实测冲突的处理）。
   */
  options: { supportsColor?: boolean } = {},
): string {
  const c = options.supportsColor === true;
  const lines: string[] = [];
  /*
   * M2.86：**信息量**（用户：「正文信息也不能过于精简，起码的信息量要凸显出来」）。
   *
   * 这一段原来只有「地点名 + 时间 · 天气」。现在补上这一带**危不危险** ——
   * 那是玩家决定「要不要继续待着」的唯一依据，而它此前只写在出口列表里。
   */
  lines.push('【' + hl(scene.location.name, 'place', c) + '】');
  lines.push(`${head.time} · ${head.weather}${head.calamity === '' ? '' : ` · ${hl(head.calamity, 'danger', c)}`}`);
  if (scene.dangerLabel.length > 0) {
    lines.push(hlMark('这一带' + scene.dangerLabel, scene.danger >= 4 ? 'danger' : 'clue', c));
  }
  lines.push('');
  lines.push(scene.atmosphere);
  if (who.awareness === 'initiated') {
    if (scene.beasts.length > 0) {
      lines.push('', `${who.name}看清楚了 —— 这里不只有寻常东西：`);
      for (const b of scene.beasts) {
        // 序列是**非凡信息**（紫）—— 与「危险」分开，一眼分得开「那是什么」和「有多险」
        lines.push('  · ' + hl(b.name, 'arcane', c) + '（序列 ' + b.sequence + '）' + b.note);
      }
    }
  } else if (scene.hints.length > 0) {
    // 凡人：只写「有动静」，绝不写物种名与序列
    lines.push('');
    for (const h of scene.hints) lines.push(h);
  }
  if (scene.others.length > 0) lines.push('', `在场的还有：${scene.others.join('、')}`);
  /*
   * M2.85：**这里站着的人**。
   * 凡人只被告知「有一个人在那里」—— 原著里普通人不会一眼看出对面是几序列的非凡者；
   * 非凡者才看得到名字与档位。这正是「普通人不知道非凡者的存在」在人身上的落地。
   */
  if (scene.people.length > 0) lines.push('', `${who.name}注意到这里有人：${scene.people.map((p) => hl(p, 'name', c)).join('、')}`);
  /*
   * M2.85：**不对劲的细节**。
   * 刻意不给结论 —— 察觉是玩家的推理，不是系统的广播（.查 才能追下去）。
   */
  if (scene.omens.length > 0) {
    lines.push('', '有些地方不太对：');
    for (const o of scene.omens.slice(0, 3)) lines.push('  · ' + hl(o, 'clue', c));
    lines.push('（发 .查 线索 追一追。）');
  }
  if (scene.exits.length > 0) {
    lines.push('', `${who.name}能往这些地方去（.走 <名字>）：`);
    /*
     * ⚠️ **高亮纪律**：出口名**不上色**。
     *
     * 第一版给每一行都上了地点色，实测 12 行全是金色 —— 那不是「凸显」，是噪音。
     * 高亮是**稀缺资源**：全篇都亮等于全篇都不亮。所以这里只保留**危险标记**，
     * 而那一个标记本身就是红的，不需要再加一层。
     */
    for (const e of scene.exits.slice(0, 12)) {
      const mark = e.danger >= 4 ? ' ' + hlMark('（危险）', 'danger', c) : '';
      lines.push('  → ' + e.name + mark);
    }
  } else {
    lines.push('', '这里没有别的出口。');
  }
  lines.push('', '看 <东西>｜走 <地方>｜查 <线索>｜.状态｜.今日');
  return lines.join('\n');
}

/** 按名字/别名/前缀找一个出口（玩家多半只记得住半截名字） */
export function findExit(exits: readonly SceneExit[], text: string): SceneExit | null {
  const key = text.trim();
  if (key === '') return null;
  return (
    exits.find((e) => e.name === key) ??
    exits.find((e) => e.name.startsWith(key) || key.startsWith(e.name)) ??
    exits.find((e) => e.name.includes(key) || key.includes(e.name)) ??
    null
  );
}
