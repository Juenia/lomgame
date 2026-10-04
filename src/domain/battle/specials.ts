/**
 * 物种专属行为（M2.9，任务书 §4.3.3 的「特殊」一行）。
 *
 * 内容侧在 creatures.yaml 里只写一个**名字**（`battle.special: whisper`），
 * 效果在这里查表。这样做的理由与「一处声明，四处生效」同源：
 * 物种表管「它叫什么」，判定层管「它做什么」，
 * 内容同学改文案时不会不小心改到战斗数值。
 *
 * ⚠️ schema 里是**枚举**：写错一个名字启动就报错，
 *    而不是等某个玩家在雾里撞见一只什么都不做的怪物。
 */
import type { BattleStatusId } from './types.ts';

export interface SpecialDef {
  id: string;
  name: string;
  /** 旁白（回执里的一句话） */
  note: string;
  /** 伤害倍率（缺省 1 = 用物种的基础伤害） */
  damageMultiplier: number;
  /** 命中加成 */
  hitBonus: number;
  /** 给**玩家**挂的状态 */
  applyToPlayer: readonly BattleStatusId[];
  /** 玩家 MAD 增量 */
  madGain: number;
  /** 玩家 MP 汲取 */
  mpDrain: number;
  /** 把玩家上一击的伤害原样打回来（命运幻影的模仿） */
  mimic: boolean;
  /** 本回合生物受到的伤害减半（镜中客的镜像） */
  shield: boolean;
}

const BASE: Omit<SpecialDef, 'id' | 'name' | 'note'> = {
  damageMultiplier: 1,
  hitBonus: 0,
  applyToPlayer: [],
  madGain: 0,
  mpDrain: 0,
  mimic: false,
  shield: false,
};

export const SPECIALS: Readonly<Record<string, SpecialDef>> = {
  /** 灰雾游魂：渗冷 —— 不疼，但你身上越来越冷 */
  chill: { ...BASE, id: 'chill', name: '渗冷', note: '它贴上来。你身体里的力气被抽走一点。', mpDrain: 3 },
  /** 低语者：低语 —— 命中 -20%（「恐惧」状态的第二个来源） */
  whisper: {
    ...BASE,
    id: 'whisper',
    name: '低语',
    note: '它贴着你的耳朵说话。你听清了每一个字。',
    applyToPlayer: ['fear'],
  },
  /** 铁血猎犬：撕咬 —— 会造成流血 */
  maul: {
    ...BASE,
    id: 'maul',
    name: '撕咬',
    note: '它咬住不放，牙齿在肉里拧了一下。',
    applyToPlayer: ['bleed'],
    damageMultiplier: 0.8,
  },
  /** 命运幻影：模仿 —— 把你上一击原样打回来 */
  mimic: {
    ...BASE,
    id: 'mimic',
    name: '模仿',
    note: '它做了个和你一模一样的动作。你觉得手腕疼。',
    mimic: true,
    damageMultiplier: 0,
  },
  /** 骨语者：骨尘 —— 中毒 */
  bone_dust: {
    ...BASE,
    id: 'bone_dust',
    name: '骨尘',
    note: '它吹了口气，细白的粉末落了你一身。',
    applyToPlayer: ['poison'],
    damageMultiplier: 0.6,
  },
  /** 深海凝视者：注视 —— MAD +5（「知道得越多越危险」的战斗版） */
  gaze: {
    ...BASE,
    id: 'gaze',
    name: '注视',
    note: '它没有眼睛，但你确定它在看你。你想起了一件不该想起来的事。',
    madGain: 5,
    damageMultiplier: 0.5,
  },
  /** 镜中客：镜像 —— 本回合受到的伤害减半 */
  mirror: { ...BASE, id: 'mirror', name: '镜像', note: '你的影子比你早动了半拍。', shield: true, damageMultiplier: 0.5 },
  /** 时序蠕虫：时间凝滞 —— 你被放逐一回合 */
  freeze: {
    ...BASE,
    id: 'freeze',
    name: '时间凝滞',
    note: '你抬起手，然后发现自己还在抬手的那个瞬间。',
    applyToPlayer: ['banish'],
    damageMultiplier: 0,
  },
};

/** 合法的特殊行为名（schema 与启动校验共用一份，防止两边漂移） */
export const SPECIAL_IDS: readonly string[] = Object.keys(SPECIALS).sort();

export function specialById(id: string | null): SpecialDef | null {
  if (!id) return null;
  return SPECIALS[id] ?? null;
}
