/**
 * 扮演标签词典（W2 §3.1）
 *
 * 明确不使用 LLM、不做中文分词：用关键词「包含匹配」。
 * 误命中用 forbidden 对冲，而不是上分词器（MVP 阶段分词的成本远大于收益）。
 */
import type { PathwayId } from '../character/types.ts';

export interface PathwayTags {
  pathway: PathwayId;
  /** 权重 1.0 */
  core: string[];
  /** 权重 0.5 */
  secondary: string[];
  /** 权重 -0.5 */
  forbidden: string[];
}

export const PATHWAY_TAGS: Record<PathwayId, PathwayTags> = {
  seer: {
    pathway: 'seer',
    core: ['占卜', '预兆', '命运', '历史', '幻觉', '幕后'],
    secondary: ['观察', '推算', '仪式', '低语', '赌'],
    forbidden: ['蛮力', '正面冲锋', '暴怒'],
  },
  warrior: {
    pathway: 'warrior',
    core: ['战斗', '冲锋', '守护', '勇气', '荣耀'],
    secondary: ['训练', '武器', '格挡', '威慑'],
    forbidden: ['背叛', '逃跑', '诡计'],
  },
  sleepless: {
    pathway: 'sleepless',
    core: ['守夜', '黑夜', '梦', '隐秘', '间谍'],
    secondary: ['潜伏', '观察', '追踪', '静默'],
    forbidden: ['喧哗', '光明', '暴露'],
  },
  /*
   * M2.19：水手（sailor）。
   *
   * 与另外三条同一个口径：core 是「这条途径的人做什么算数」，
   * forbidden 是「做什么会掉消化度」。水手的核心不是战斗，是**在风浪里把船和货带回去** ——
   * 所以 core 落在航行与风暴上，而「弃船 / 逃避风浪」是它唯一不可原谅的事。
   */
  sailor: {
    pathway: 'sailor',
    core: ['航行', '风暴', '操舵', '甲板', '潮汐'],
    secondary: ['观察', '远行', '勇气', '守夜', '训练'],
    forbidden: ['弃船', '逃避风浪', '背叛同伴'],
  },
  /*
   * M2.26 第一批：完美者（perfect）。
   *
   * 这一条途径的人做什么算数：**把东西调到它该有的样子**。
   * 所以 core 落在校准与打磨上，而「将就」是它唯一不可原谅的事 ——
   * 与战士的「逃跑」、水手的「弃船」同一个形状（都是一条途径的自我否定）。
   */
  perfect: {
    pathway: 'perfect',
    core: ['校准', '机械', '齿轮', '打磨', '精准'],
    secondary: ['观察', '训练', '武器', '守夜', '勇气'],
    forbidden: ['将就', '暴怒', '诡计'],
  },
  /*
   * M2.26 第二批：阅读者（reader）。
   *
   * 这一条途径的人做什么算数：**把读到的变成知道的**。
   * core 落在阅读与解构上；「焚书」是它唯一不可原谅的事 ——
   * 与战士的「逃跑」、水手的「弃船」、完美者的「将就」同一个形状。
   */
  reader: {
    pathway: 'reader',
    core: ['阅读', '记录', '推算', '知识', '解构'],
    secondary: ['观察', '历史', '低语', '仪式', '训练'],
    forbidden: ['焚书', '妄断', '隐瞒'],
  },
  /*
   * M2.26 第三批：母亲（mother）。
   *
   * 这一条途径的人做什么算数：**让东西活下去**（种、养、守、等）。
   * forbidden 落在这里最有分量：**毁田、弃养、竭泽** —— 三件事都是「把还没长成的东西提前了结」，
   * 与战士的「逃跑」、水手的「弃船」、完美者的「将就」、阅读者的「焚书」同一个形状。
   */
  mother: {
    pathway: 'mother',
    core: ['耕种', '生长', '土壤', '守候', '繁衍'],
    secondary: ['观察', '忍耐', '仪式', '医疗', '守夜'],
    forbidden: ['毁田', '弃养', '竭泽'],
  },
  /*
   * M2.76：15 条新途径的扮演词典。
   *
   * 口径与既有 7 条一致：`core` 是「这条途径的人做什么算数」（权重 1.0），
   * `forbidden` 是「做什么会掉消化度」（−0.5）—— 对应扮演法里那条
   * 「做出与途径不符的事，消化度不涨反跌」。
   * 词条取自 `诡秘之主原作数据/01-途径与序列/` 各途径档案的能力方向。
   */
  door: {
    pathway: 'door',
    core: ['穿越', '门', '空间', '旅行', '记录'],
    secondary: ['探索', '标记', '绕路', '藏'],
    forbidden: ['固守', '原地等待'],
  },
  sun: {
    pathway: 'sun',
    core: ['光', '净化', '正义', '歌唱', '正直'],
    secondary: ['照亮', '揭露', '庇护'],
    forbidden: ['阴影', '亵渎', '谎言'],
  },
  corpse_collector: {
    pathway: 'corpse_collector',
    core: ['死亡', '尸体', '通灵', '安葬', '亡者'],
    secondary: ['收敛', '询问', '等待'],
    forbidden: ['救治', '复活', '怜悯'],
  },
  error: {
    pathway: 'error',
    core: ['偷窃', '欺骗', '解密', '恶作剧', '漏洞'],
    secondary: ['潜行', '伪造', '钻空子'],
    forbidden: ['诚实', '守序', '坦白'],
  },
  mystery_pryer: {
    pathway: 'mystery_pryer',
    core: ['隐秘', '星象', '禁忌', '窥探', '传承'],
    secondary: ['研读', '测算', '收藏'],
    forbidden: ['张扬', '公开', '炫耀'],
  },
  spectator: {
    pathway: 'spectator',
    core: ['心理', '梦', '操纵', '催眠', '洞察'],
    secondary: ['观察', '暗示', '引导'],
    forbidden: ['直白', '强攻', '硬碰'],
  },
  apothecary: {
    pathway: 'apothecary',
    core: ['药', '治疗', '驯服', '血脉', '深红'],
    secondary: ['调配', '诊断', '安抚'],
    forbidden: ['毒杀', '浪费', '滥杀'],
  },
  arbiter: {
    pathway: 'arbiter',
    core: ['律令', '制裁', '契约', '秩序', '裁决'],
    secondary: ['审讯', '定罪', '约束'],
    forbidden: ['违约', '混乱', '偏袒'],
  },
  assassin: {
    pathway: 'assassin',
    core: ['暗杀', '毒', '魅惑', '痛苦', '阴影'],
    secondary: ['潜伏', '下毒', '伪装'],
    forbidden: ['正面', '光明正大', '留手'],
  },
  criminal: {
    pathway: 'criminal',
    core: ['罪恶', '欲望', '恶魔', '纵欲', '血腥'],
    secondary: ['引诱', '交易', '破坏'],
    forbidden: ['守序', '自制', '仁慈'],
  },
  hunter: {
    pathway: 'hunter',
    core: ['狩猎', '火焰', '战争', '追踪', '挑衅'],
    secondary: ['点燃', '埋伏', '号令'],
    forbidden: ['逃避', '退缩', '投降'],
  },
  lawyer: {
    pathway: 'lawyer',
    core: ['规则', '腐化', '贿赂', '条文', '钻营'],
    secondary: ['谈判', '曲解', '结盟'],
    forbidden: ['无私', '牺牲', '直率'],
  },
  monster: {
    pathway: 'monster',
    core: ['运气', '概率', '混乱', '赌', '巧合'],
    secondary: ['押注', '碰运气', '搅局'],
    forbidden: ['计划', '精确', '按部就班'],
  },
  prisoner: {
    pathway: 'prisoner',
    core: ['束缚', '疯癫', '月', '变形', '挣扎'],
    secondary: ['忍受', '嘶吼', '挣脱'],
    forbidden: ['自由', '体面', '克制'],
  },
  secrets_supplicant: {
    pathway: 'secrets_supplicant',
    core: ['牺牲', '倾听', '牧羊', '忏悔', '隐忍'],
    secondary: ['接受', '劝诫', '承担'],
    forbidden: ['自私', '索取', '逃避'],
  },
};

/** 命中反馈用：把标签翻译成玩家能看懂的方向名 */
export const TAG_KIND_LABELS = {
  core: '契合',
  secondary: '沾边',
  forbidden: '违背',
} as const;
