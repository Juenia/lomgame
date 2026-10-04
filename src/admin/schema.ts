/**
 * 数据编辑的字段元数据（M2.49）：**唯一定义可编辑字段的地方**。
 *
 * ## 为什么不让前端直接编辑 yaml 原文
 *
 * 用户原话：「不要把原始数据丢上来让人编辑，容易出 BUG」。
 * 把 yaml 塞进 textarea，等于把「格式正确」这件事外包给使用者 ——
 * 缩进少一个空格、枚举拼错一个字母、数字写成字符串，都不会当场报错，
 * 而是等机器人读配置时才炸，而且**全服一起炸**。
 *
 * 所以每个字段有**类型**：数字用数字框、布尔用下拉、枚举用中文下拉、
 * 引用别人的用选择器。前端据此渲染控件，服务端用它校验 —— 同一份元数据两处用。
 *
 * ## 英文枚举在这里落地成中文
 *
 * 那张枚举表是**扫真实数据扫出来的**（不是猜的）：items.kind 有 5 种取值、
 * regions.type 2 种、routes.type 2 种、factions.priority 2 种……
 * 界面上一律显示中文，只有写回文件时才用英文。
 */

export type FieldType =
  | 'text' | 'number' | 'bool' | 'enum' | 'ref'
  /**
   * 字符串列表：**一行一条**，可增删（events / adjacent / pathways ...）。
   *
   * 声明 `multiline` 时渲染成一个多行框（仍然一行一条），而不是一排单行框 ——
   * 给长文案用：失控文本、卡片片段这种一条几十上百字的，单行框要左右拖着看。
   * 收集口径两者完全一样：换行是分隔符，空行丢掉。
   */
  | 'strlist'
  /** 对象数组：表格编辑，每行几个固定列（loot / drops / ranks / tasks ...） */
  | 'rows'
  /**
   * 嵌套对象：一组固定的子字段（卡片的 trigger / texts）。
   *
   * 子字段走同一套类型系统（`objectFields`），但**只支持单控件的那几种** ——
   * text / number / bool / enum / strlist。不做嵌套容器：
   * 一个能无限套娃的编辑器，改坏一次就再也说不清是哪一层错了。
   */
  | 'object'
  /**
   * 对象数组，**每个对象的键是开放的但那几个键要拼对**（卡片的 effects）。
   *
   * 与 rows 的区别：rows 的列是固定的，而 effects 的一条是「一到两组键值」，
   * 键从 mapKeys 里选（拼错一个键 = 这条效果静默失效，不报错）。
   * 与 map 的区别：map 只有一份，effects 是一串、还允许同键出现多次。
   */
  | 'maplist'
  /**
   * 触发条件列表（M2.83）：一排一排的「种类 + 值」下拉。
   *
   * 它是 strlist 的**结构化版本**，为 cond 那一段 DSL 而存在 ——
   * 声明 `condList: true` 时服务端还会拿真正的解析器逐条验（见 data.ts 的 crossCheck）。
   */
  | 'condlist'
  /** 键值对：键从下拉选，值是数字或枚举（effect / relations ...） */
  | 'map'
  /** 只读：结构太深、或改错会让判定静默失效（taboos / perception / battle） */
  | 'readonly';

import { QUALITY_LABELS, SLOT_LABELS } from '../domain/item/equipment.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import type { z } from 'zod';
import { EffectSchema, TriggerSchema } from '../cards/schema.ts';
import { CreatureHabitSchema, CreatureSpeciesSchema, EcologicalRoleSchema } from '../domain/creature/schema.ts';
import { ExtraordinaryTypeSchema, ItemBattleEffectSchema } from '../domain/item/item.ts';
import { PlannedPathwayIdSchema } from '../domain/geo/types.ts';
import { ForeignInputKindSchema } from '../domain/world/boundary.ts';
import { travelEventLabels } from '../domain/geo/events.ts';
import { ID_PATTERN as CARD_ID_PATTERN } from '../cards/lint.ts';
import { COND_FIELDS, COND_PATHWAYS, COND_STATUSES, type CondField, type CondOperator } from '../domain/event/trigger.ts';
import { NUMERIC } from '../config/numeric.ts';
import { PATHWAY_LABELS } from '../domain/character/rules.ts';
import { NPC_KIND_LABELS } from '../domain/world/npc-cast.ts';
import { GAZE_ACT_LABELS, SEAT_KIND_LABELS, THRONE_STATE_LABELS } from '../domain/world/divine-throne.ts';
import { AUTHORITY_KIND_LABELS } from '../domain/world/authority-effects.ts';

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  /** enum 的中文映射（英文值 → 中文显示） */
  enumMap?: Record<string, string>;
  /** ref 指向哪个实体 */
  ref?: string;
  hint?: string;
  min?: number;
  max?: number;
  /** 只读：能看见，不能改 */
  readOnly?: boolean;
  /** map 字段允许的键（做下拉）。手打键名迟早拼错，而拼错的效果字段是静默失效的 */
  mapKeys?: Record<string, string>;
  /** map 字段允许的值（不给就是数字输入框） */
  mapValues?: Record<string, string>;
  /**
   * map / maplist 字段：**这些键的值是文本**，不是数字（effects 的 item / flag）。
   *
   * 为什么必须显式声明：值控件的类型只能由键决定 —— `item: 夜香草` 和 `dig: 2`
   * 长在同一张列表里。默认数字框会把物品名吞掉（number 输入框不收字母），
   * 写进文件是一个空值，而这条效果**静默失效**。
   */
  textKeys?: string[];
  /**
   * 除了引用目标里真实存在的 id，**这些值也合法**。
   *
   * 为哨兵值而存在：`cities.factions` 里的 `none`（无主 / 安全区）不是 powers 表里的任何一条势力，但它是一个有意义的值 ——
   * schema 的提示里一直写着「none = 无主」。没有这一位，这个合法值会被引用校验挡住，
   * 运营连城市的一个字都改不了。
   */
  allow?: string[];
  /** map 字段的键是某个实体的 id（做成下拉）。没给 mapKeys 才用它 */
  mapRef?: string;
  /**
   * strlist 字段的**每一项**是某个实体的 id（做成下拉，显示中文名）。
   *
   * 为什么需要它：strlist 原来渲染成一排纯文本框，于是界面上是
   * `old_dock` / `fish_market` 这种内部 id —— 而列表页的摘要用的是同一个字段，
   * 那栏也全是 id。内容同学要改「这个域包含哪些地点」得先去别处翻 id。
   *
   * ⚠️ 值仍然是 id（写回文件的是 id），**只有显示是中文** ——
   * 与 ref / mapRef 保持同一条口径：显示名与存储值分开。
   */
  itemRef?: string;
  /**
   * strlist 的每一项来自**好几个**实体，选项取它们的并集。
   *
   * 为什么需要：事件卡按目录分成了三个实体（每日 / 普通人 / 途径专属），
   * 而地点的「事件池」一个字段里三类都有 —— `itemRef` 只能指一个实体，
   * 指哪个都会让另外两类变成生 id。
   *
   * 与 itemRef 二选一；两个都给时以 itemRefs 为准。
   */
  itemRefs?: string[];
  /**
   * strlist 字段的**每一项**是一个英文枚举值，这里给它的中文名。
   *
   * 与 itemRef 的分工：itemRef 的值是**别的实体的 id**（要去那张表里查中文名），
   * valueMap 的值是一个**封闭枚举**（途径 / 输入类型 / 习性），中文名就在这里。
   * 两者都是「存储用英文、显示用中文」—— 界面上原来显示的是 `seer` / `migrant`。
   */
  valueMap?: Record<string, string>;
  /**
   * strlist 字段渲染成**一个多行框**（一行一条）而不是一排单行框。
   *
   * 为什么要它：失控文本和卡片片段一条就是几十上百字，用单行框编辑要左右拖；
   * 而把它们塞进一个 textarea 又必须保证「一行一条」这条口径不丢 ——
   * 所以它不是新类型，只是 strlist 的另一种外观，读写规则逐字相同。
   *
   * ⚠️ **text 类型的这个开关是必须的，不是可选的好看**：卡片正文写在 YAML 块
   * 标量（`priv: |`）里，本身就有换行；而 `<input>` 的 value 装不下换行 ——
   * 浏览器会把它规范化掉，于是「保存一次，正文的分段就没了」，且不报任何错。
   */
  multiline?: true;
  /** object 字段：有哪些子字段（子字段再走一遍同一套类型系统） */
  objectFields?: FieldSpec[];
  /**
   * strlist 字段的每一项是一条**触发条件**（写法由 domain/event/trigger.ts 定义）。
   *
   * 为什么需要这一位：条件是一段 DSL（`seq<=8` / `flag:xxx` / `location:xxx`），
   * 而它写错的后果是**恒为 false** —— 卡片永远不出，界面上什么都不显示、
   * 日志里什么都不写。声明了它，保存时会拿**真正的解析器**逐条校验
   * （见 admin/data.ts 的 crossCheck），而不是让运营照着提示手打。
   */
  condList?: true;

  /**
   * text / strlist 的每一项必须匹配这个正则（不给就不查）。
   *
   * 用途是那些**代码按名字读它**的字段：标记名（卡片里写 `flag:xxx` 去引用）、
   * 各种内部 id。它们拼错一个字符不会报错，只会让引用方永远匹配不上 ——
   * 而「永远匹配不上」在界面上和「条件没满足」长得一模一样。
   */
  pattern?: string;
  /** pattern 不匹配时显示的中文说明（不给就把正则原样贴出去，很难看） */
  patternHint?: string;
  /**
   * text / strlist 每一项的字符数上限（不给就用 TEXT_MAX）。
   *
   * 上限不是「内容不够放」—— 是防那种一眼看不出来的事故：
   * 误粘贴一整篇文档进正文，卡片渲染出来把群消息撑爆。
   */
  maxLength?: number;
  /** rows 字段：每行有哪些列（列本身再走一遍同一套类型系统） */
  rowFields?: FieldSpec[];
  /**
   * M2.65：**这一栏可以留空**（留空 = 写回时把这个键删掉，而不是写一个空串）。
   *
   * 为什么需要它：`ref` 是一排选项的下拉，没有「空」这一项时浏览器会默认选中第一项 ——
   * 于是「这一格我本来就没填」会变成「它指向了列表里的第一个 id」，而且**保存时才发生**。
   * 加了这一位，下拉多一个「（无）」，服务端也认这个空值。
   */
  optional?: boolean;
  /**
   * 跨字段规则：本字段的值里**必须出现同一条记录里另一个字段**的值。
   *
   * 目前只有扮演文案用得上：text 必须含它自己的 tag —— 判定层按关键词匹配算消化度，
   * 少了那两个字玩家选了不涨分，而这不会报任何错。规则由 admin/data.ts 的
   * writeEntity 执行（那里同时看得到两个字段）。
   */
  mustContainField?: string;
}

export interface EntitySpec {
  id: string;
  label: string;
  /** 归类，界面上按这个分组 */
  group: string;
  file: string;
  /**
   * 记录住在哪个根键下面（seq / map 模式必填）。
   *
   * single / dir 模式不用它：single 的「根」就是文件本身，
   * dir 的「根」是目录里每个文件的顶层 —— 都没有一个叫得上名字的根键。
   */
  rootKey?: string;
  /**
   * 根键下面是**什么形状**（M2.76）。
   *
   *   'seq'（默认）—— 对象数组：一条记录一个对象，id 取自 idKey 字段。
   *   'map'         —— 键 → 值：一条记录一个键，**id 就是键名**，
   *                    fields 里除 idKey 外的那一个字段承载值。
   *
   * 用到 'map' 的是失控文本池与卡片片段池：它们天生是「一个键配一组文本」，
   * 硬塞进对象数组就得给每条文本编一个 id —— 那个 id 没有任何意义，
   * 还得跟着文本一起维护。
   */
  rootMode?: 'seq' | 'map' | 'single' | 'dir';
  /**
   * 记录 id 取自哪个字段。
   *
   * single 模式**不填** —— 它的记录 id 就是实体 id，文件里没有那个键，
   * 填一个不存在的键名只是让元数据看起来完整，实际是撒谎。
   */
  idKey?: string;
  /** 列表页显示哪个字段。single 模式同样不填（回退到实体自己的中文名） */
  titleKey?: string;
  /**
   * map 根的 id 是英文键名（途径 id）时，列表页要显示的中文名。
   * 与 enumMap 同一条口径：**存储用英文，显示用中文**。
   */
  titleMap?: Record<string, string>;
  /**
   * 列表页摘要优先显示哪几个字段（按 key，最多取三个）。
   *
   * 不给 = 字段表里的前三个非跳过字段（历史上所有实体的行为，逐位不变）。
   * 给它的场合只有一个：**最该看的信息没排在前三个**。
   * 例：城市的「可用途径」在第四个字段上，默认摘要里露不出来 ——
   * 而「这座城市能走哪几条路」正是打开城市列表要判断的第一件事。
   */
  summaryKeys?: string[];
  /**
   * 新记录的 id 除了「格式安全」之外还要满足的**内容约定**（M2.84）。
   *
   * 为什么单开一位：卡片那边有一条自己的 id 约定（`cards/lint.ts` 的 `ID_PATTERN`）——
   * 它不属于「安全」那一类（大写字母不会写出目录穿越），但违反它的卡会被 lint 拒掉，
   * 而那是**建完之后**才知道的事。配在这里，新建时就能当场说清。
   */
  idPattern?: RegExp;
  /** idPattern 不满足时的中文说明（不给就把正则原样贴出去，很难看） */
  idHint?: string;
  fields: FieldSpec[];
}

/**
 * 途径的中文名（后台显示用）。
 *
 * ⚠️ **M2.76：不再手抄。** 这里曾经写死 7 条途径 —— 而 22 条落地之后，
 * 15 条新途径在后台**显示的是英文 id**（`door` / `sun` / `secret_supplicant`…），
 * 内容同学看到的是「这栏里怎么全是英文」而不知道那是什么。
 *
 * ⇒ 从 `PATHWAY_LABELS`（途径中文名的唯一出处）派生。
 * 这是本轮抓到的**第 9 处同形状的清单副本** —— 前 8 处分别在
 * recipe / ability / item / lost-control 与四个测试文件里。
 */
export const PATHWAY_CN: Record<string, string> = PATHWAY_LABELS;

/**
 * 天气的中文名。
 *
 * 唯一出处是 `NUMERIC.world.weather.effects[id].label`（八种天气都写了中文名），
 * 这里不抄第二份 —— 与 PATHWAY_CN 同一条口径。
 */
/**
 * 下面的三张表都是**同一个写法**：值从 zod 的 enum 派生，中文名用
 * `Record<派生出来的联合类型, string>` 写死。
 *
 * 这样做的意义只有一个：**schema 里加一个值而这里没补中文名，tsc 直接红**。
 * 中文名没法从代码里派生（没有第二处写过它们），但「漏了」必须由编译器喊出来 ——
 * 否则运营看到的是一个英文单词，而且没人知道那是漏了。
 */

/** boundaries.inputs：这座边界对外的输入类型 */
const INPUT_KIND_LABEL: Record<(typeof ForeignInputKindSchema.options)[number], string> = {
  trade: '商队', migrant: '移民', threat: '威胁', contamination: '污染',
};
export const INPUT_KIND_CN: Record<string, string> = INPUT_KIND_LABEL;

/**
 * creatures.tickRate：这只生物多久动一次。
 *
 * ⚠️ 这张表原来是 `{ hourly: '每小时' }` 手写的，而 CreatureSchema 里有两个值 ——
 * 于是 `daily` 那几只（灰雾游魂之类）在后台显示的是英文。
 * 是真数据把它抓出来的：拿每一行的实际取值反查映射表，`daily` 不在里面。
 */
// 用 z.infer 而不是 .options：这一位挂着 `.default('hourly')`，枚举在它里面一层
const CREATURE_TICK_LABEL: Record<z.infer<typeof CreatureSpeciesSchema.shape.tickRate>, string> = {
  hourly: '每小时', daily: '每日',
};
export const CREATURE_TICK_CN: Record<string, string> = CREATURE_TICK_LABEL;

/**
 * 路途事件的中文名（风浪 / 海怪 / 迷雾 …）。
 *
 * ⚠️ `routes.events` 与 `locations.events` **同名不同物**：
 * 前者装的是路途事件 id（`bandit` / `storm`），后者装的是事件卡 id（`daily_001`）。
 * 一开始我把两者当成了同一种东西、给 routes 也配了卡片下拉 ——
 * 结果是现有 20 条航线**全部存不回去**（拿真数据跑一遍当场抓到）。
 */
export const TRAVEL_EVENT_CN: Record<string, string> = travelEventLabels();

/** items.type：这件东西在非凡世界里的类别 */
const EXTRAORDINARY_TYPE_LABEL: Record<(typeof ExtraordinaryTypeSchema.options)[number], string> = {
  material: '材料', wonder: '奇物', sealed: '封印物', charm: '符咒',
};
export const EXTRAORDINARY_TYPE_CN: Record<string, string> = EXTRAORDINARY_TYPE_LABEL;

/** creatures.relations.role：它在生态网里站哪个位置 */
const ECOLOGICAL_ROLE_LABEL: Record<(typeof EcologicalRoleSchema.options)[number], string> = {
  producer: '生产者', consumer: '消费者', decomposer: '分解者',
  parasite: '寄生者', symbiont: '共生者', apex: '顶端捕食者',
};
export const ECOLOGICAL_ROLE_CN: Record<string, string> = ECOLOGICAL_ROLE_LABEL;

/** items.battle.applyToCreature：符咒打上去之后，对面挂什么状态 */
/*
 * 先把那个 enum 取出来再 z.infer：`typeof` 只作用于标识符和属性访问，
 * 写 `typeof X.y().z` 是语法错误（这一位是 z.array(...).optional()，要剥两层）。
 */
const CREATURE_STATUS_ENUM = ItemBattleEffectSchema.shape.applyToCreature.unwrap().element;
const CREATURE_STATUS_LABEL: Record<z.infer<typeof CREATURE_STATUS_ENUM>, string> = {
  bleed: '流血', fear: '恐惧', poison: '中毒', lostControl: '失控', banish: '放逐',
};
export const CREATURE_STATUS_CN: Record<string, string> = CREATURE_STATUS_LABEL;

/** creatures.habits：非凡生物的行为习性 */
const CREATURE_HABIT_LABEL: Record<(typeof CreatureHabitSchema.options)[number], string> = {
  nocturnal: '夜行', social: '群居', territorial: '守域', migratory: '迁徙',
};
export const CREATURE_HABIT_CN: Record<string, string> = CREATURE_HABIT_LABEL;

/**
 * cities.planned_pathways：《宿命之环》那 10 条外神途径。
 *
 * ⚠️ 它的 id 是「该途径**序列 9** 的英文名」（astronomer），而中文取的是**神名**
 *（致密者）—— 两套名字本来就不在同一档上，这里跟的是 `geo/types.ts` 里那张对照表。
 */
const PLANNED_PATHWAY_LABEL: Record<(typeof PlannedPathwayIdSchema.options)[number], string> = {
  astronomer: '致密者', broker: '混沌迷雾', dancer: '永劫者', dreamborn: '永生律',
  miser: '主父', novice: '不朽者', patient: '第二定律', scoundrel: '混沌原胎',
  shaman: '尘世之眼', vagrant: '吞尾者',
};
export const PLANNED_PATHWAY_CN: Record<string, string> = PLANNED_PATHWAY_LABEL;

export const WEATHER_CN: Record<string, string> = Object.fromEntries(
  Object.entries(NUMERIC.world.weather.effects).map(([id, row]) => [id, row.label]),
);

/**
 * 权柄 effects 能写的维度（M2.90）—— 从读取端那份唯一清单派生，不抄第二份。
 *
 * **去掉 weather**：天气有它自己的那一栏（`authorities.weather`），写进 effects
 * 等于同一个维度写两次，而读的时候取最新 ⇒ 两边打架时先写的那条**无声失效**
 * （M2.88 那条「禁令必须取并集」的教训就是从这里来的）。
 */
const AUTHORITY_EFFECT_KIND_CN: Record<string, string> = Object.fromEntries(
  Object.entries(AUTHORITY_KIND_LABELS).filter(([kind]) => kind !== 'weather'),
);


const YESNO = { true: '是', false: '否' };

/* ---- M2.63：M2.58—M2.62 那几张表的英文枚举 → 中文 ----
 *
 * 与判定层的口径**逐字一致**（domain/world/power.ts 的 PowerType、
 * history.ts 的 HistoryEventType、boundary.ts 的 BoundaryKind）。
 * 这几张表是那个面板第一次出现「与判定层枚举同名」的字段，
 * 所以映射写在这里、注释指回判定层 —— 以后判定层加一个值，这里要跟着加。
 */

/** powers.type */
export const POWER_TYPE_CN: Record<string, string> = {
  police: '警察', church: '教会', gang: '黑帮', royal: '王室', order: '密教团',
};

/** powers.stance */
export const STANCE_CN: Record<string, string> = {
  hostile: '敌视', watchful: '戒备', neutral: '中立', friendly: '友好',
};

/** history.type */
export const HISTORY_TYPE_CN: Record<string, string> = {
  epoch: '纪元', dynasty: '王朝', war: '战争', treaty: '条约',
  disaster: '灾难', scandal: '丑闻', migration: '迁徙',
};

/** boundaries.kind */
export const BOUNDARY_KIND_CN: Record<string, string> = {
  port: '港口', frontier: '边境', rift: '裂隙',
};

/** 势力关系（power_relations.kind 与 powers.yaml 的 relations.kind 共用） */
export const RELATION_KIND_CN: Record<string, string> = {
  ally: '同盟', hostile: '敌对', debt: '人情',
};

/** 封印物危险等级（history.effects.sealed.level） */
export const SEAL_LEVEL_CN: Record<string, string> = {
  low: '低', medium: '中', high: '高', forbidden: '禁',
};

/** 因果边的三种关系（M2.60） */
export const CAUSAL_RELATION_CN: Record<string, string> = {
  caused: '导致', responded: '响应', mutated: '改变',
};

/** 只读字段（数组/嵌套对象）：能看见结构，改动走代码 —— 这些是给判定层读的 */
const ro = (key: string, label: string, hint: string): FieldSpec =>
  ({ key, label, type: 'readonly', readOnly: true, hint });

/* ---- M2.76：事件卡的枚举与字段表 ----
 *
 * 事件卡是内容的主体（116 张），而它此前**完全没有后台入口** ——
 * 改一条文案要改文件、跑 lint、重新部署。
 *
 * 下面这两个枚举都**从 src/cards/schema.ts 派生**，不手抄：那份 schema 是
 * 卡片字段的唯一出处，手抄的第二份一定会在某次加字段之后漂移。
 */

/** 触发方式的值，来自 TriggerSchema.type（zod 的 enum） */
const TRIGGER_TYPES = TriggerSchema.shape.type.options;
type TriggerType = (typeof TRIGGER_TYPES)[number];

/**
 * 触发方式的中文名。
 *
 * ⚠️ 类型写成 `Record<TriggerType, string>` 是有意的：**新加一种触发方式而没写
 * 中文名，tsc 会直接红**。中文名只能手写（代码里没有第二处写过它们），
 * 但「漏了」这件事必须由编译器喊出来 —— 而不是等运营在后台看见一个英文单词。
 */
const TRIGGER_TYPE_LABEL: Record<TriggerType, string> = {
  daily: '每日', main: '主线', random: '随机', org: '组织', hidden: '隐藏',
};
export const TRIGGER_TYPE_CN: Record<string, string> = TRIGGER_TYPE_LABEL;

type EffectKey = keyof typeof EffectSchema.shape;

/** 卡效果能写的键的中文名（键本身来自 EffectSchema，同样不手抄） */
const EFFECT_KEY_LABEL: Record<EffectKey, string> = {
  dig: '消化度', cor: '腐蚀', mad: '疯狂', hp: '生命值', mp: '魔力值',
  dp: '防御点', item: '给物品', n: '数量', flag: '置标记',
};
export const EFFECT_KEY_CN: Record<string, string> = EFFECT_KEY_LABEL;

/**
 * 值是**文本**的 effect 键（item / flag）。
 *
 * **从 schema 的行为推出来，不手抄**：能接受 `'x'` 而接受不了 `0` 的就是文本键。
 * 手写一份 ['item','flag'] 的话，哪天 EffectSchema 里把某个数字键改成字符串，
 * 后台就会继续用数字框去接它 —— 输入被吞掉，写进文件是个空值。
 */
const EFFECT_TEXT_KEYS: string[] = Object.keys(EffectSchema.shape).filter((k) => {
  const s = EffectSchema.shape[k as EffectKey];
  return s.safeParse('__x__').success && !s.safeParse(0).success;
});

/**
 * 事件卡的字段表。
 *
 * 三类卡（daily / mortal / pathway）共用**同一份**：它们走的是同一个
 * EventCardSchema，字段少一个或多一个都会在加载期报错。
 * 分开写三份 = 三份一定会漂移的副本。
 */
const CARD_FIELDS: FieldSpec[] = [
  { key: 'id', label: '内部 ID', type: 'text', readOnly: true, hint: '地点与航线用这个 id 引用这张卡，改名会让引用落空' },
  { key: 'name', label: '卡片名', type: 'text', hint: '玩家在群里看到的名字（「事件【夜香草】」—— 以前这里念的是 id）' },
  {
    key: 'trigger', label: '触发', type: 'object',
    objectFields: [
      { key: 'type', label: '触发方式', type: 'enum', enumMap: TRIGGER_TYPE_CN },
      { key: 'weight', label: '权重', type: 'number', min: 0, max: 100, hint: '同一个池子里按权重抽；0 = 抽不到' },
      {
        key: 'cond', label: '触发条件', type: 'condlist', optional: true, condList: true,
        /*
         * ⚠️ 这里原来教的是 `city:tingen`，而解析器认的是 **`location:`** ——
         * 照提示写出来的条件，`parseCond` 返回 null、`evalCond` 返回 false，
         * 于是那张卡**永远不出**，而且不报错、不警告。
         * 提示里教的写法必须是解析器真的认的（现在由 crossCheck 兜底）。
         */
        hint: '一行一条，全部满足才进池。写法：seq<=8（seq/dig/mad/cor/hp/mp/ap/dp 配 > >= < <= == != 和数字）、flag:标记名、location:地点名（如「廷根市」，不是地点 id）、pathway:途径id、status:状态、party:size>=2',
      },
      { key: 'location', label: '限定地点', type: 'strlist', optional: true, hint: '一行一个地点 id（见「地点」），空 = 不限' },
      { key: 'min_seq', label: '最高序列', type: 'number', min: 0, max: 9, optional: true, hint: '数字越小要求越高：9 = 新号也能出' },
      { key: 'max_seq', label: '最低序列', type: 'number', min: 0, max: 9, optional: true, hint: '留空 = 不限' },
      { key: 'cooldown_days', label: '冷却天数', type: 'number', min: 0, max: 60, hint: '同一张卡在这么多天内不再触发' },
    ],
  },
  {
    key: 'effects', label: '效果', type: 'maplist', mapKeys: EFFECT_KEY_CN, textKeys: EFFECT_TEXT_KEYS,
    hint: '每条是一到几组键值。给物品要写成一条里的两组：给物品=夜香草 + 数量=1',
  },
  {
    key: 'texts', label: '正文', type: 'object',
    objectFields: [
      { key: 'priv', label: '私聊正文', type: 'text', multiline: true, hint: '玩家私聊里看到的那几段。支持 {{片段}} 模板' },
      { key: 'group', label: '群播报', type: 'text', multiline: true, optional: true, hint: '群里那一句。留空 = 这件事不播报' },
    ],
  },
  { key: 'daily_limit', label: '每日次数', type: 'number', min: 0, max: 9, hint: '0 = 今天不许出（不必把卡删掉 —— 删了会打断地点对它的引用）' },
];

/* ---- M2.83：触发条件的候选（不让运营手打一段 DSL）----
 *
 * `cond` 是一段由 domain/event/trigger.ts 解析的写法，值域全部来自代码。
 * 让运营照着提示手打，代价是**写错了不会报错**：
 *   · 提示里教的 `city:tingen` 解析器根本不认（它认 `location:`）——
 *     照提示写出来的卡**永远不出**，界面上什么都不显示；
 *   · `flag:` 拼错一个字母、`location:` 写一个不存在的地点，同样静默。
 *
 * 所以前端从下拉选，服务端再校验一遍（admin/data.ts 的 crossCheck）。
 * 下面每一张表都**从代码派生**，中文名用 `Record<派生类型, string>` 写 ——
 * 解析器加一种写法而这里没补中文名，tsc 直接红。
 */

/** 数值条件的字段名 */
const COND_FIELD_LABEL: Record<CondField, string> = {
  seq: '序列', dig: '消化度', mad: '疯狂', cor: '腐蚀',
  hp: '生命', mp: '魔力', dp: '防御点',
};
/** 比较操作符 */
const COND_OPERATOR_LABEL: Record<CondOperator, string> = {
  '>': '大于', '>=': '不小于', '<': '小于', '<=': '不大于', '==': '等于', '!=': '不等于',
};
/** 角色状态（与 COND_STATUSES 对齐 —— 写错一个状态名，条件恒为 false） */
const COND_STATUS_LABEL: Record<(typeof COND_STATUSES)[number], string> = {
  active: '正常', injured: '受伤', lost_control: '失控', promoting: '晋升中',
  in_battle: '战斗中', trading: '交易中', banned: '封禁',
};
/** 入途径状态（pathway:mortal / pathway:initiated） */
const COND_PATHWAY_LABEL: Record<(typeof COND_PATHWAYS)[number], string> = {
  mortal: '未入途径', initiated: '已入途径',
};

export interface CondOption { id: string; title: string }

export interface CondOptions {
  /** 条件的**种类**：数值比较 + flag / location / pathway / status / party */
  kinds: CondOption[];
  fields: CondOption[];
  operators: CondOption[];
  pathways: CondOption[];
  statuses: CondOption[];
  /** registry.yaml 里的标记清单 */
  flags: CondOption[];
  /** 认得的写法长什么样 —— 面板上原样贴给运营看 */
  syntax: string;
}

/**
 * 触发条件的候选表。
 *
 * `flags` 要读文件，所以这里接 root；读不到就给空表（前端退化成手输 + 服务端兜底）。
 */
export function condOptionsOf(root: string): CondOptions {
  const pairs = (o: Record<string, string>): CondOption[] =>
    Object.entries(o).map(([id, title]) => ({ id, title }));
  let flags: CondOption[] = [];
  try {
    const doc = parseDocument(readFileSync(resolve(root, 'src/cards/registry.yaml'), 'utf8'));
    const raw = (doc.get('flags') as { toJSON?: () => unknown } | undefined)?.toJSON?.() ?? [];
    if (Array.isArray(raw)) flags = raw.map((x) => ({ id: String(x), title: String(x) }));
  } catch { flags = []; }
  return {
    kinds: [
      { id: 'num', title: '数值比较' },
      { id: 'flag', title: '有标记' },
      { id: 'location', title: '在某地点' },
      { id: 'pathway', title: '途径' },
      { id: 'status', title: '角色状态' },
      { id: 'party', title: '队伍规模' },
    ],
    fields: COND_FIELDS.map((f) => ({ id: f, title: COND_FIELD_LABEL[f] })),
    operators: pairs(COND_OPERATOR_LABEL as unknown as Record<string, string>),
    // 两条入途径状态 + 22 条具体途径，合成同一个下拉：解析器认的是同一个前缀
    pathways: [...pairs(COND_PATHWAY_LABEL as unknown as Record<string, string>),
      ...pairs(PATHWAY_LABELS)],
    statuses: COND_STATUSES.map((s) => ({
      id: s,
      title: COND_STATUS_LABEL[s as (typeof COND_STATUSES)[number]] ?? s,
    })),
    flags,
    syntax: 'seq<=8（seq/dig/mad/cor/hp/mp/ap/dp 配 > >= < <= == != 和数字）、' +
      'flag:标记名、location:地点名（如「廷根市」）、pathway:途径id、pathway:mortal、status:状态、party:size>=2',
  };
}

export const ENTITIES: EntitySpec[] = [
  {
    id: 'items', label: '物品', group: '世界内容',
    file: 'src/data/items.yaml', rootKey: 'items', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true, hint: '配方与掉落表按它引用，改名会打断所有引用' },
      { key: 'name', label: '显示名', type: 'text' },
      { key: 'kind', label: '类别', type: 'enum', enumMap: { currency: '货币', material: '材料', consumable: '消耗品', potion: '魔药', trinket: '杂物' } },
      { key: 'bindable', label: '可绑定', type: 'bool', hint: '绑定后不能交易' },
      { key: 'tradeable', label: '可交易', type: 'bool' },
      { key: 'note', label: '说明', type: 'text', hint: '只影响观感，不参与判定' },
      {
        key: 'effect', label: '使用效果', type: 'map',
        hint: '键是属性名，值是增减量（正数加、负数减）。键名必须从下拉选 —— 打错的键不报错，会静默失效。',
        mapKeys: { mad: '疯狂', mp: '灵性', hp: '生命', cor: '污染', dig: '消化', ap: '行动', dp: '命运' },
      },
      /*
       * M2.65：**变体**（P16 落地的机制）。
       *
       * 加载时每个变体展开成一条独立物品（id = 原名#变体 id，见 data/loader.ts），
       * 所以这里改的其实是**产物**：改完立刻能被打包、掉落、交易认出来。
       * 「合装用哪一件」留空 = 改制品（拆开再装回去）；填了 = 合装件（还要那一件才装得出来）。
       */
      {
        key: 'variants', label: '变体（改制品 / 合装件）', type: 'rows',
        hint: '加一条 = 这件物品多一个状态。变体 id 会拼成「原名#变体 id」，所以它自己不要带 #。',
        rowFields: [
          { key: 'id', label: '变体 ID', type: 'text', hint: '英文短名，例：retrofit / assembled' },
          { key: 'name', label: '显示名', type: 'text' },
          {
            key: 'from', label: '合装要的另一件', type: 'ref', ref: 'items', optional: true,
            hint: '留空 = 改制品（只要它自己）；选了 = 合装件（这一件 + 它，两件合一件）',
          },
          { key: 'note', label: '说明', type: 'text' },
        ],
      },
      /*
       * M2.77：下面这批字段**此前在内容里存在、判定层在用，但后台看不见也改不了**。
       *
       * 它们是拿「yaml 记录里的顶层键」反查「实体声明的字段」找出来的（见
       * test/m2-77-content-editor.test.ts 里那条用例）。最要紧的是 pathway / seq ——
       * **176 件魔药**靠这两个字段挂在途径与序列上，而它们在后台一个字都改不了。
       *
       * 带 default 的（type / rarity）一律标 optional：不标的话，前端会把默认值
       * 当成「显式值」提交，948 条物品里没写过这两个字段的会一次性全被写上 ——
       * 内容没变、diff 却是几百行。
       */
      { key: 'pathway', label: '所属途径', type: 'enum', enumMap: PATHWAY_CN, optional: true, hint: '魔药才有：这瓶药属于哪条途径' },
      { key: 'seq', label: '序列', type: 'number', min: 0, max: 9, optional: true, hint: '魔药才有：对应哪个序列（数字越小越高）' },
      { key: 'type', label: '非凡类别', type: 'enum', enumMap: EXTRAORDINARY_TYPE_CN, optional: true, hint: '材料 / 奇物 / 封印物 / 符咒；不写按材料算' },
      { key: 'rarity', label: '稀有度', type: 'number', min: 1, max: 5, optional: true, hint: '1 最常见、5 最罕见；不写按 1 算' },
      { key: 'sealLevel', label: '封印等级', type: 'number', min: 0, max: 5, optional: true, hint: '封印物才有：0 最低、5 禁' },
      {
        key: 'sideEffect', label: '副作用', type: 'object', optional: true,
        objectFields: [
          { key: 'mad', label: 'MAD 增量', type: 'number', min: 0, max: 30, optional: true },
          { key: 'cor', label: 'COR 增量', type: 'number', min: 0, max: 30, optional: true },
        ],
      },
      {
        key: 'battle', label: '战斗效果', type: 'object', optional: true,
        objectFields: [
          { key: 'damage', label: '对生物伤害', type: 'number', min: 1, max: 999, optional: true },
          { key: 'cleanse', label: '清除自身负面', type: 'bool', optional: true },
          { key: 'hitBonus', label: '命中加成', type: 'number', min: -1, max: 1, optional: true, hint: '-0.2 = 命中率 -20%' },
          { key: 'applyToCreature', label: '给生物挂状态', type: 'strlist', valueMap: CREATURE_STATUS_CN, optional: true },
        ],
      },
    ],
  },
  {
    id: 'locations', label: '地点', group: '世界内容',
    file: 'src/data/locations.yaml', rootKey: 'locations', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'name', label: '显示名', type: 'text' },
      { key: 'min_seq', label: '最低序列', type: 'number', min: 0, max: 9, hint: '9 最低、0 最高。序列不够会被拒绝进入' },
      // M2.85 扩图：地理坐标（用户：「地球是圆的，而诡秘之主的世界其实也就是地球」）
      { key: 'lat', label: '纬度', type: 'number', min: -90, max: 90, optional: true },
      { key: 'lon', label: '经度', type: 'number', min: -180, max: 180, optional: true },
      { key: 'max_seq', label: '最高序列', type: 'number', min: 0, max: 9 },
      { key: 'danger', label: '危险度', type: 'number', min: 0, max: 100 },
      {
        key: 'corruption_source', label: '堕落源（这里会把人变成怪物）', type: 'bool',
        hint: '【原作】神弃之地的黑暗「会让生物堕落为怪物」；深渊入口「让所有生灵堕落」。标了它，站在这里的堕落者异变概率 ×3',
      },
      {
        key: 'loot', label: '掉落表', type: 'rows',
        hint: '权重越大越容易掉；掉落品必须是 items.yaml 里存在的物品 id',
        rowFields: [
          { key: 'itemId', label: '物品', type: 'ref', ref: 'items' },
          { key: 'weight', label: '权重', type: 'number', min: 0, max: 1000 },
          { key: 'minQty', label: '最少', type: 'number', min: 0, max: 999 },
          { key: 'maxQty', label: '最多', type: 'number', min: 0, max: 999 },
          { key: 'bindType', label: '绑定', type: 'enum', enumMap: { bound: '绑定', unbound: '不绑定' } },
        ],
      },
      /*
       * M2.77：**这一栏此前根本没声明** —— 58 个地点每一个都有它，后台却看不见。
       *
       * 它是拿「yaml 记录里的顶层键」反查「实体声明的字段」找出来的：
       * 文件进了后台 ≠ 文件里的字段进了后台。
       *
       * 值是事件卡 id，而卡片现在分成了三个实体（每日 / 普通人 / 途径专属），
       * 所以用 itemRefs 把三个都拉进下拉 —— itemRef 只能指一个。
       */
      {
        key: 'events', label: '事件卡池', type: 'strlist', optional: true,
        itemRefs: ['cards-daily', 'cards-mortal', 'cards-pathway'],
        hint: '这个地点会出哪些事件卡（下拉显示卡名，存的是 id）。与卡自己的触发条件再取交集',
      },
      ro('adjacent', '相邻地点', '由 routes.yaml 与地图校验共同决定'),
      // ===== M2.85 内容填充 P2：原作地点设定（执行点：.世界 <地点名> 的档案）=====
      // ⚠️ 全部 optional：它们在 zod 里都有默认值，空着是合法的（原作很多地点没有神祇/角色记载）——
      //    不加 optional 会让「原样存回」被必填校验挡住（m2-83 当场抓到）
      { key: 'place_type', label: '地点类型', type: 'text', optional: true, hint: 'church / ruin / government_site / military_site / organization_site（展示时转中文）' },
      { key: 'deity', label: '相关神祇', type: 'text', optional: true },
      { key: 'country', label: '原作国家', type: 'text', optional: true },
      { key: 'role', label: '故事中的角色', type: 'text', multiline: true, optional: true },
      { key: 'notable_events', label: '在此发生的事', type: 'strlist', multiline: true, optional: true },
      { key: 'status', label: '存续状态', type: 'text', optional: true },
    ],
  },
  {
    id: 'recipes', label: '魔药配方', group: '世界内容',
    file: 'src/data/recipes.yaml', rootKey: 'recipes', idKey: 'id', titleKey: 'id',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'pathway', label: '途径', type: 'enum', enumMap: PATHWAY_CN },
      { key: 'seq', label: '目标序列', type: 'number', min: 0, max: 9 },
      { key: 'main', label: '主材料', type: 'rows', rowFields: [
        { key: 'itemId', label: '物品', type: 'ref', ref: 'items' },
        { key: 'qty', label: '数量', type: 'number', min: 1, max: 99 },
      ] },
      { key: 'aux', label: '辅助材料', type: 'rows', rowFields: [
        { key: 'itemId', label: '物品', type: 'ref', ref: 'items' },
        { key: 'qty', label: '数量', type: 'number', min: 1, max: 99 },
      ] },
      { key: 'ritual', label: '仪式要求', type: 'text' },
      { key: 'base_success', label: '基础成功率', type: 'number', min: 0, max: 1, hint: '0—1 之间的小数，界面显示成百分比更直观时再说' },
      { key: 'cor_on_fail', label: '失败加污染', type: 'number', min: 0, max: 100 },
      { key: 'mad_on_fail', label: '失败加疯狂', type: 'number', min: 0, max: 100 },
    ],
  },
  {
    id: 'abilities', label: '能力', group: '世界内容',
    file: 'src/data/abilities.yaml', rootKey: 'abilities', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'name', label: '能力名', type: 'text', hint: '⚠️ 这是能力名，不是序列称号。称号表在 src/card/titles.ts，别混' },
      { key: 'pathway', label: '途径', type: 'enum', enumMap: PATHWAY_CN },
      { key: 'seq', label: '解锁序列', type: 'number', min: 0, max: 9 },
      ro('effect', '效果字段', '判定层直接查表读它；结构改了要同步改代码'),
    ],
  },
  {
    id: 'church-abilities', label: '教会能力', group: '世界内容',
    file: 'src/data/church-abilities.yaml', rootKey: 'churchAbilities', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'name', label: '能力名', type: 'text' },
      { key: 'churchId', label: '所属教会', type: 'ref', ref: 'churches' },
      { key: 'rank', label: '所需等级', type: 'number', min: 0, max: 20 },
      { key: 'description', label: '说明', type: 'text' },
      ro('effect', '效果字段', '判定层直接查表读它'),
    ],
  },
  {
    id: 'churches', label: '教会', group: '势力与地理',
    file: 'src/data/churches.yaml', rootKey: 'churches', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'name', label: '教会名', type: 'text' },
      { key: 'type', label: '类型', type: 'enum', enumMap: { church: '正神教会' } },
      { key: 'pathway', label: '对应途径', type: 'enum', enumMap: PATHWAY_CN, optional: true, hint: '这条途径还没实现时留空，改写下面的「对应的预留途径」' },
      // M2.77：7 个教会都有它，此前没声明 —— 未实现的途径靠它挂在教会上
      { key: 'plannedPathway', label: '对应的预留途径', type: 'enum', enumMap: PLANNED_PATHWAY_CN, optional: true, hint: '尚未实现的外神途径（《宿命之环》那 10 条）；实现了就把上面那栏填上、这里清空' },
      { key: 'dogma', label: '教义', type: 'text' },
      ro('taboos', '禁忌', '每条禁忌带 when/penalty 两层嵌套，改错会让教义判定静默失效；这类结构走代码'),
      { key: 'ranks', label: '等级阶梯', type: 'rows', rowFields: [
        { key: 'id', label: '等级 ID', type: 'text' },
        { key: 'name', label: '等级名', type: 'text' },
      ] },
      { key: 'seats', label: '据点城市', type: 'strlist', itemRef: 'cities', hint: '这家教会在哪些城市有堂口。下拉显示中文城市名，存的是 id' },
      { key: 'relations', label: '与其他教会的关系', type: 'map', mapRef: 'churches',
        mapValues: { ally: '盟友', neutral: '中立', hostile: '敌对' },
        hint: '键是教会 id，值是关系。loader 要求对称：甲对乙是敌对，乙对甲也必须是' },
    ],
  },
  {
    id: 'factions', label: '本地势力', group: '势力与地理',
    file: 'src/data/factions.yaml', rootKey: 'factions', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'name', label: '势力名', type: 'text' },
      { key: 'city', label: '所在城市', type: 'ref', ref: 'cities' },
      { key: 'pathway', label: '传承途径', type: 'enum', enumMap: PATHWAY_CN },
      { key: 'priority', label: '优先级', type: 'enum', enumMap: { primary: '主', secondary: '次' } },
      { key: 'greeting', label: '开场白', type: 'text' },
      { key: 'tasks', label: '引导任务', type: 'rows', rowFields: [
        { key: 'id', label: '任务 ID', type: 'text' },
        { key: 'text', label: '给玩家看的话', type: 'text' },
        { key: 'action', label: '指令', type: 'text' },
        { key: 'target', label: '目标', type: 'text' },
        { key: 'kind', label: '类型', type: 'text' },
      ] },
    ],
  },
  {
    id: 'cities', label: '城市', group: '势力与地理',
    file: 'src/data/cities.yaml', rootKey: 'cities', idKey: 'id', titleKey: 'name',
    // 途径排在字段表第四个 —— 但它是打开城市列表时最想知道的一件事
    summaryKeys: ['pathways', 'region_id', 'center'],
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'name', label: '城市名', type: 'text' },
      /*
       * M2.77：**从手抄的枚举改成引用**。
       *
       * 这里原来写死了四个区域（loen / intez / south / sunia），而 regions.yaml 里有六个 ——
       * 迷雾海（mist_sea）和狂暴海（rage_sea）**在后台根本选不到**，而且不报错：
       * 下拉里就是没有那两项。
       *
       * 改成 ref 之后区域清单只有一份（regions.yaml），加一个区域自动出现在这里。
       * 这是本轮抓到的第 10 处同形状的清单副本（AGENTS.md §3.1）。
       */
      { key: 'region_id', label: '所属区域', type: 'ref', ref: 'regions', hint: '区域的中文名去「区域」那张表改，这里只是引用' },
      { key: 'center', label: '中心地点', type: 'ref', ref: 'locations', hint: '建号时玩家落在这个地点' },
      { key: 'is_port', label: '是否港口', type: 'bool' },
      { key: 'min_seq', label: '进入门槛序列', type: 'number', min: 0, max: 9 },
      { key: 'birth_weight', label: '出生权重', type: 'number', min: 0, max: 1000, hint: '建号时按权重抽城市，0 = 不会在这里出生' },
      { key: 'flavor', label: '风土说明', type: 'text', optional: true, hint: '空串合法：回执会退化成一句通用文案' },
      { key: 'locations', label: '下辖地点', type: 'strlist', itemRef: 'locations', hint: '下拉显示中文地点名，存的是 id' },
      // 这里的 id 是 powers 那个空间（police / church / gang / none）——
      // **不是** factions.yaml 的本地势力（church_tingen 那种），两者同名但不同物。
      { key: 'factions', label: '本地势力', type: 'strlist', itemRef: 'powers', allow: ['none'], hint: '下拉显示中文势力名；none = 无主（安全区），它不是一本书里的势力，但 cities.yaml 每个城市都写着它' },
      { key: 'pathways', label: '可用途径', type: 'strlist', valueMap: PATHWAY_CN, hint: '这座城能走哪几条途径。从下拉选 —— 这里原来显示的是 seer / sleeper 这种英文 id' },
      { key: 'planned_pathways', label: '预留途径', type: 'strlist', valueMap: PLANNED_PATHWAY_CN, hint: '尚未开放、但地理上属于这里的途径（《宿命之环》那 10 条）' },
      // ===== M2.85 内容填充 P2：原作设定字段 =====
      // 全部可选、缺省为空（旧内容一个字都不用改）；执行点：.世界 城市 <名字或别名>
      { key: 'country', label: '原作国家', type: 'text', hint: '原作口径（鲁恩王国…）—— 与上面的「所属区域」并存，不改判定' },
      { key: 'city_type', label: '城市类型', type: 'text', hint: 'capital / city / port / town / village / historic / otherworld（展示时转中文）' },
      { key: 'status', label: '存续状态', type: 'text' },
      { key: 'population', label: '人口', type: 'text', optional: true, hint: '原作没写人口的城就是空的' },
      { key: 'aliases', label: '别名 / 旧称', type: 'strlist', multiline: true, hint: '⚠️ 有执行点：.世界 城市 <别名> 也查得到（原作自由文本）' },
      { key: 'features', label: '城市特征', type: 'strlist', multiline: true },
      {
        key: 'districts', label: '城区', type: 'rows',
        rowFields: [
          { key: 'name', label: '城区名', type: 'text' },
          { key: 'note', label: '注记', type: 'text', optional: true, hint: '原作没写注记的城区就是空的' },
        ],
      },
      { key: 'notable_places', label: '地标', type: 'strlist', multiline: true },
    ],
  },
  {
    /**
     * M2.85 内容填充 P2：区域（17 条 —— 项目原有 6 + 原作国家新扩 11）。
     * 执行点：`.世界 区域 <名>`（区域档案）。
     */
    id: 'regions', label: '区域', group: '势力与地理',
    file: 'src/data/regions.yaml', rootKey: 'regions', idKey: 'id', titleKey: 'name',
    summaryKeys: ['pathways', 'type', 'cities'],
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'name', label: '区域名', type: 'text' },
      { key: 'type', label: '类型', type: 'enum', enumMap: { continent: '大陆', island: '岛屿', sea: '海洋' } },
      { key: 'danger', label: '危险度', type: 'number', min: 0, max: 100 },
      {
        key: 'corruption_source', label: '整片堕落之地（东大陆＝神弃之地）', type: 'bool',
        hint: '【原作】「整片大陆被黑暗笼罩……会让生物堕落为怪物」。标了它，这片区域里所有城市的堕落者异变概率 ×3',
      },
      { key: 'cities', label: '包含城市', type: 'strlist', itemRef: 'cities', hint: '下拉显示中文城市名，存的是 id' },
      { key: 'pathways', label: '可用途径', type: 'strlist', valueMap: PATHWAY_CN, hint: '这个区域能走哪几条途径。从下拉选' },
      // ===== M2.85 内容填充 P2：原作国家设定（执行点：.世界 区域 <名>）=====
      // ⚠️ 全部 optional：原作对这些国家多半只写了名字，空着是合法的
      { key: 'country_name', label: '原作国家名', type: 'text', optional: true },
      { key: 'name_en', label: '英文名', type: 'text', optional: true },
      { key: 'government', label: '政体', type: 'text', multiline: true, optional: true },
      { key: 'capital', label: '首都', type: 'text', optional: true },
      { key: 'language', label: '语言', type: 'text', optional: true },
      { key: 'currency', label: '货币', type: 'text', optional: true },
      { key: 'state_religion', label: '国教', type: 'strlist', multiline: true, optional: true },
      { key: 'royal_pathway', label: '皇室途径（原文）', type: 'text', multiline: true, optional: true, hint: '途径派生的一处来源' },
      { key: 'status', label: '状态', type: 'text', optional: true },
      { key: 'continent', label: '位置', type: 'text', optional: true },
      { key: 'origin', label: '由来', type: 'text', multiline: true, optional: true },
    ],
  },
  {
    id: 'routes', label: '航线', group: '势力与地理',
    file: 'src/data/routes.yaml', rootKey: 'routes', idKey: 'id', titleKey: 'id',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'from', label: '起点城市', type: 'ref', ref: 'cities' },
      { key: 'to', label: '终点城市', type: 'ref', ref: 'cities' },
      { key: 'type', label: '方式', type: 'enum', enumMap: { land: '陆路', sea: '海路' } },
      { key: 'duration_hours', label: '耗时（小时）', type: 'number', min: 0, max: 240 },
      { key: 'cost_penny', label: '花费（便士）', type: 'number', min: 0, max: 100000, hint: '内部按便士存；240 便士 = 1 金镑' },
      { key: 'danger', label: '危险度', type: 'number', min: 0, max: 100 },
      // M2.77：这一栏也此前没声明 —— 14 条航线每条都有它（见 locations.events 的注释）
      {
        /*
         * ⚠️ 这一栏和地点的「事件卡池」**同名不同物**：
         * 地点那边装的是事件卡 id（daily_001），这里装的是**路途事件** id
         * （bandit / storm / fog …，见 domain/geo/events.ts）。
         * 我一开始按名字把两者当成了同一种东西，给它也配了卡片下拉 ——
         * 结果是现有 20 条航线全部存不回去（拿真数据跑一遍当场抓到）。
         */
        key: 'events', label: '路途事件池', type: 'strlist', optional: true,
        valueMap: TRAVEL_EVENT_CN,
        hint: '走这条路可能出哪些**路途事件**（风浪 / 海怪 / 迷雾 …），不是事件卡 id',
      },
    ],
  },
  {
    id: 'creatures', label: '非凡生物', group: '世界内容',
    file: 'src/data/creatures.yaml', rootKey: 'creatures', idKey: 'species', titleKey: 'name',
    fields: [
      { key: 'species', label: '物种 ID', type: 'text', readOnly: true },
      { key: 'name', label: '物种名', type: 'text' },
      { key: 'bestiaryId', label: '图鉴条目', type: 'ref', ref: 'bestiary', hint: '指回设定层（.图鉴 生物）的同一个物种' },
      { key: 'baseSequence', label: '基础序列', type: 'number', min: 0, max: 9 },
      { key: 'baseHp', label: '基础生命', type: 'number', min: 1, max: 10000 },
      { key: 'tickRate', label: '行动频率', type: 'enum', enumMap: CREATURE_TICK_CN, hint: '它多久动一次 —— 每日的那些只在换日时刷新' },
      { key: 'flavor', label: '风味描述', type: 'text' },
      { key: 'habitat', label: '栖息地', type: 'strlist', itemRef: 'locations', hint: '这种生物可能出现在哪。下拉显示中文地点名，存的是 id' },
      { key: 'pathwayAffinity', label: '途径亲和', type: 'strlist', valueMap: PATHWAY_CN, hint: '哪条途径的人更容易撞见它（命中 ×1.4）；从下拉选' },
      { key: 'habits', label: '习性', type: 'strlist', valueMap: CREATURE_HABIT_CN, hint: '夜行 / 群居 / 守域 / 迁徙 —— 群居会求援，夜行只在夜里活跃' },
      { key: 'drops', label: '掉落', type: 'rows', rowFields: [
        { key: 'itemId', label: '物品', type: 'ref', ref: 'items' },
        { key: 'chance', label: '概率', type: 'number', min: 0, max: 1 },
      ] },
      /*
       * M2.77：生态关系网（M2.58）。19 个物种每一个都有它，此前没声明。
       *
       * 它决定「谁吃谁」—— 少了关系不会报错，只会在生态报告里表现为
       * 「捕食次数偏低」，而有太多别的原因可以解释那件事。
       */
      {
        key: 'relations', label: '生态关系', type: 'object', optional: true,
        objectFields: [
          { key: 'role', label: '生态位', type: 'enum', enumMap: ECOLOGICAL_ROLE_CN },
          { key: 'prey', label: '捕食谁', type: 'strlist', itemRef: 'creatures', optional: true },
          { key: 'predators', label: '被谁捕食', type: 'strlist', itemRef: 'creatures', optional: true },
          { key: 'symbiosis', label: '共生', type: 'strlist', itemRef: 'creatures', optional: true },
          { key: 'parasite', label: '寄生', type: 'strlist', itemRef: 'creatures', optional: true },
        ],
        hint: '四个列表都要双向写：A 写了捕食 B，B 也要把自己写进「被谁捕食」',
      },
      ro('behaviors', '行为', '键是动作名、值是触发条件，形状不固定；这类结构走代码'),
      ro('perception', '感知', '对象'),
      ro('battle', '战斗参数', '对象'),
    ],
  },
  {
    /*
     * M2.56：这批文案原来硬编码在 domain/menu/phrases.ts 里（玩家每次 .扮演 都会看到
     * 它），搬到内容表 + 后台之后，改一个措辞不用再发版。
     *
     * ⚠️ 它的 text 带一条**跨字段硬规则**（必须含自己的标签词），所以
     * 后台保存时会当场校验 —— 见 FieldSpec.mustContainField 的注释。
     */
    id: 'tag-phrases', label: '扮演文案', group: '内容',
    file: 'src/data/tag-phrases.yaml', rootKey: 'phrases', idKey: 'id', titleKey: 'text',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true, hint: '途径.标签，由这两项拼成' },
      { key: 'pathway', label: '途径', type: 'enum', enumMap: PATHWAY_CN },
      {
        key: 'tag', label: '标签词', type: 'text',
        hint: '判定层按这个词匹配玩家说的话；改它等于改判定口径，要同步改 abilities.yaml',
      },
      {
        key: 'text', label: '玩家看到的那句话', type: 'text', mustContainField: 'tag',
        hint: '⚠️ 必须出现标签词本身 —— 否则玩家选了不会涨消化度，而这不会报任何错',
      },
    ],
  },
  /* ================================================================== *
   * M2.63：M2.58—M2.62 新增的内容表
   * ================================================================== *
   *
   * 四张内容表（生态域 / 势力 / 历史 / 边界）是在 M2.58—M2.62 里加的，
   * 而它们**一直没进这个编辑器和 GM 面板** —— 要改只能去开 YAML。
   * 这一节把它们补上。
   *
   * ## 一个刻意的取舍：嵌套结构走 readonly
   *
   * 有几处字段是「数组里套对象、对象里再套对象」（历史事件的四条后果）。
   * 当前的行编辑器只支持**一层**嵌套，硬塞进去会得到一个
   * 「看起来能编辑、其实写坏文件」的表单 —— 那比只读更糟。
   * 所以这些字段标成 readonly（能看见结构，改走 YAML），而不是假装能编辑。
   */
  {
    id: 'zones', label: '生态域', group: '势力与地理',
    file: 'src/data/zones.yaml', rootKey: 'zones', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true, hint: '地点按它归属；改名会让那些地点落回全局基线' },
      { key: 'name', label: '显示名', type: 'text' },
      { key: 'description', label: '说明', type: 'text' },
      { key: 'spirituality', label: '灵性浓度', type: 'number', min: 0, max: 1, hint: '越高非凡生物越活跃（迁移与繁衍更快）' },
      { key: 'pollution', label: '污染度', type: 'number', min: 0, max: 1, hint: '越高衰亡越快' },
      { key: 'madness', label: '疯狂度', type: 'number', min: 0, max: 1, hint: '越高，这里传出去的传闻越容易失真（0.8 → 约一半失真）' },
      { key: 'hidden', label: '隐秘度', type: 'number', min: 0, max: 1, hint: '越高目击越难传出去（信息生态读它）' },
      { key: 'order', label: '秩序度', type: 'number', min: 0, max: 1, hint: '越高越有人来清剿 —— 这一域的非凡生物衰亡更快（1.0 = 1.5 倍）' },
      { key: 'fear', label: '恐慌基线', type: 'number', min: 0, max: 1, hint: '这个域本来就容易慌的程度；与运行时累积相加' },
      { key: 'carryingCapacity', label: '承载力', type: 'number', min: 1, max: 50, hint: '单个地点的生物上限' },
      { key: 'migrateMultiplier', label: '迁移倍率', type: 'number', min: 0, max: 5 },
      { key: 'reproduceMultiplier', label: '繁衍倍率', type: 'number', min: 0, max: 5 },
      { key: 'replenishMultiplier', label: '补充倍率', type: 'number', min: 0, max: 5 },
      { key: 'decayMultiplier', label: '衰亡倍率', type: 'number', min: 0, max: 5 },
      { key: 'locations', label: '包含地点', type: 'strlist', itemRef: 'locations', hint: '一个地点只能属于一个域（启动时会校验）。下拉显示中文地点名，存的是 id' },
    ],
  },
  {
    id: 'powers', label: '文明势力', group: '势力与地理',
    file: 'src/data/powers.yaml', rootKey: 'powers', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true, hint: '通缉系统按它引用（police / church / gang 三个 id 不能改）' },
      { key: 'name', label: '显示名', type: 'text' },
      { key: 'type', label: '类型', type: 'enum', enumMap: POWER_TYPE_CN, hint: '决定它对事件怎么反应（警察封锁、教会净化、黑帮趁乱动手）' },
      { key: 'description', label: '说明', type: 'text' },
      { key: 'home_region', label: '主场区域', type: 'ref', ref: 'regions', hint: '留空 = 无处不在（王室那种哪里都插得上手）' },
      { key: 'stance', label: '对玩家态度', type: 'enum', enumMap: STANCE_CN },
      { key: 'goals', label: '长期目标', type: 'strlist', hint: '反应引擎按关键词算「这件事与它有多相关」：污染/异端/真相/秩序/恐慌…' },
      /*
       * M2.67：三项资源从**只读**改成**可编辑**（键是中文映射的下拉，值是 0—1 的数）。
       *
       * 之前它是只读的，理由是「结构太深」—— 而它其实就是一个三键的平表，
       * 与 `effect` / `relations` 同一个形状。内容同学要调「这家势力多有钱」，
       * 得去翻 yaml；而这一栏现在真的影响玩法（投入多少、公告挂多久），更需要能改。
       */
      {
        key: 'resources', label: '资源', type: 'map',
        hint: '三项 0—1 的数。它们是「对付这件事的本钱」，**按事件类型加权**：' +
          '目击看神秘侧、灾厄看人力、传闻看财力；财力还决定它那条公告挂多久。',
        mapKeys: { manpower: '人力', wealth: '财力', mystic: '神秘侧' },
      },
      /*
       * M2.68：关系从**只读**改成**可编辑**。它是内容（powers.yaml 的外交底图），
       * 而这一轮之后它真的影响玩法（盟友壮胆 / 敌对牵制 / 欠人情的跟着走）——
       * 内容同学要调「谁跟谁一伙」不该去翻 yaml。
       *
       * 「对谁」是指向势力的下拉（显示中文名、存 id），「关系」是中文枚举 ——
       * 与 M2.64 的中文映射同一条口径。
       */
      {
        key: 'relations', label: '默认关系', type: 'rows',
        hint: '外交底图：会被历史事件与后台「世界 · 势力关系」里的运行时改写覆盖。' +
          '盟友与敌对是双向的（写一边就够），人情是单向的（写的是「它欠谁」）。',
        rowFields: [
          { key: 'to', label: '对谁', type: 'ref', ref: 'powers' },
          { key: 'kind', label: '关系', type: 'enum', enumMap: RELATION_KIND_CN },
        ],
      },
    ],
  },
  {
    id: 'history', label: '初始历史', group: '世界背景',
    file: 'src/data/history.yaml', rootKey: 'history', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'name', label: '事件名', type: 'text' },
      { key: 'type', label: '类型', type: 'enum', enumMap: HISTORY_TYPE_CN },
      { key: 'year', label: '距今（年）', type: 'number', min: 0, max: 100000, hint: '越大越古老。势力关系冲突时「距今最近的那件说了算」' },
      { key: 'result', label: '结果一句话', type: 'text' },
      { key: 'region', label: '发生区域', type: 'ref', ref: 'regions' },
      { key: 'locations', label: '涉及地点', type: 'strlist', itemRef: 'locations', hint: '按地点查历史时用它。下拉显示中文地点名，存的是 id' },
      { key: 'parties', label: '涉及势力', type: 'strlist', itemRef: 'powers', hint: '按势力查历史时用它。下拉显示中文势力名，存的是 id' },
      ro('effects', '历史留下的东西', '四条后果：势力旧仇 / 地点伤痕 / 封印物 / 禁忌知识 —— 嵌套两层，改走 YAML'),
    ],
  },
  {
    id: 'boundaries', label: '边界', group: '势力与地理',
    file: 'src/data/boundaries.yaml', rootKey: 'boundaries', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'name', label: '显示名', type: 'text' },
      { key: 'kind', label: '类型', type: 'enum', enumMap: BOUNDARY_KIND_CN, hint: '港口进贸易与移民、边境来军事威胁、裂隙漏污染' },
      { key: 'location', label: '本地地点', type: 'ref', ref: 'locations', hint: '一个地点只能是一条边界（启动时会校验）' },
      { key: 'foreign_power', label: '对面是谁', type: 'ref', ref: 'foreign-powers' },
      { key: 'description', label: '说明', type: 'text' },
      { key: 'base_pressure', label: '基础张力', type: 'number', min: 0, max: 1, hint: '每小时攒这么多；攒到 1 发生一次输入（0.03 → 约 33 小时一次）' },
      { key: 'inputs', label: '带来的输入', type: 'strlist', valueMap: INPUT_KIND_CN, hint: '这条边界会把什么带进来。从下拉选' },
    ],
  },
  {
    id: 'foreign-powers', label: '外部势力', group: '势力与地理',
    file: 'src/data/boundaries.yaml', rootKey: 'foreign_powers', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'name', label: '显示名', type: 'text' },
      { key: 'description', label: '说明', type: 'text' },
      { key: 'from_region', label: '来路区域', type: 'ref', ref: 'regions', hint: '留空 = 不属于任何区域的来路（外神那种）；留空时不要写 null' },
      { key: 'attention', label: '关注度', type: 'number', min: 0, max: 1, hint: '越高从它那条边界来的事越频繁' },
      { key: 'threat', label: '威胁', type: 'number', min: 0, max: 1, hint: '目前只落数据，未接判定' },
    ],
  },
  {
    /*
     * M2.76：堕落形态 —— **第一张住在 src/cards/ 下的可编辑内容表**。
     *
     * 在这之前 ENTITIES 全是 src/data/*.yaml；形态跟着失控文本池住在 src/cards/lost-control.yaml
     * （它们本来就该在一起：形态决定后果，文本是它的正文）。
     * 编辑器的 file 是普通相对路径，所以跨目录不需要改任何机制。
     */
    id: 'lost-forms', label: '堕落形态', group: '世界内容',
    file: 'src/cards/lost-control.yaml', rootKey: 'forms', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'pathway', label: '途径', type: 'enum', enumMap: PATHWAY_CN },
      { key: 'name', label: '形态名', type: 'text', hint: '玩家看到的名字：「窥视者」「血怒者」…' },
      {
        key: 'min_seq', label: '最高序列', type: 'number', min: 0, max: 9,
        hint: '数字越小要求越高：9 = 新号也能进，5 = 序列 5 及以下才够得着',
      },
      { key: 'weight', label: '抽取权重', type: 'number', min: 1, max: 100, hint: '同途径内按权重抽；必须为正' },
      { key: 'hp_loss_min', label: 'HP 损失下限', type: 'number', min: 0, max: 100 },
      { key: 'hp_loss_max', label: 'HP 损失上限', type: 'number', min: 0, max: 100, hint: '不能小于下限' },
      { key: 'mad_gain', label: 'MAD 增量', type: 'number', min: 0, max: 30 },
      { key: 'cor_gain', label: 'COR 增量', type: 'number', min: 0, max: 30 },
      { key: 'blurb', label: '形态描述', type: 'text', hint: '失控私聊正文里「你现在是什么样」那一句' },
      { key: 'group', label: '群播报', type: 'text', hint: '⚠️ 本轮无读取点（每日结算只有私聊通道），先留着' },
    ],
  },
  {
    /*
     * M2.76：权柄。**它是「世界级能力」** —— 用到它的人不是玩家，是世界本身。
     * 编辑器里能调的正是运营最需要的那几项：改成什么天气、持续多久、播报怎么写。
     */
    id: 'authorities', label: '权柄', group: '世界背景',
    file: 'src/data/authorities.yaml', rootKey: 'authorities', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'pathway', label: '途径', type: 'enum', enumMap: PATHWAY_CN },
      { key: 'name', label: '权柄名', type: 'text', hint: '玩家在播报抬头里看到的名字（「权柄·愚弄」）' },
      {
        key: 'weather', label: '改写成天气', type: 'enum', enumMap: WEATHER_CN,
        hint: '权柄的效果：把覆盖范围内所有地点的天气改成它，直到到期。改它之前先想清楚 —— 这一条会立刻改变全服所有人的探索系数',
      },
      {
        key: 'scope', label: '作用范围', type: 'text',
        hint: '星号 = 全服；也可以写一个地点 id（如 old_dock）—— 地点覆盖优先于全服覆盖',
      },
      /*
       * M2.90：**权柄的其它改写维度**（M2.88 加的那一层，但上一轮漏在后台外面）。
       *
       * `authorities.yaml` 的 effects 是**机制数据**：愚弄让这一带占卜不灵、
       * 月亮让理智掉一倍、滋长让东西变便宜 —— 而编辑器里一个字段都没给它，
       * 于是运营既看不见也改不了（AGENTS §3.4：新内容表必须在后台可编辑）。
       *
       * 为什么是「一组 {维度, 值}」而不是一个枚举：一条权柄可以同时改几个维度
       * （律令既禁袭击又禁挑战）。
       */
      {
        key: 'effects', label: '其它改写维度', type: 'rows', optional: true,
        hint: '禁令的值是命令名（多条用 | 分隔，必须是真实注册的命令）；其余三个维度的值是一个正数（1.5 = 涨一半，0.6 = 打六折）',
        rowFields: [
          { key: 'kind', label: '维度', type: 'enum', enumMap: AUTHORITY_EFFECT_KIND_CN },
          { key: 'value', label: '值', type: 'text' },
        ],
      },
      { key: 'duration_hours', label: '持续（小时）', type: 'number', min: 1, max: 168, hint: '到期自动失效，不需要清理' },
      { key: 'broadcast', label: '全服播报', type: 'text', hint: '玩家唯一能看见的部分 —— 写得像件事发生了，而不是像一句系统提示' },
      { key: 'note', label: '原著说明', type: 'text', hint: '这个权柄在原著里是什么。不进判定，只给后台与报告看' },
    ],
  },
  {
    /*
     * M2.76：晋升仪式档位（按序列分档）。
     *
     * ⚠️ **阶段表（stages）在这一版是只读的**：它的形状是「对象数组 + 一个可空字段」
     * （融合关的 base 是 null），而 FieldSpec 的 rows 表达不了 null ——
     * 强行放进来会让「留空」写成「删掉这个键」，而 schema 要求那个键必须存在。
     * ⇒ 可编的放进来（那也是最常调的几项），复杂的明确标只读，不假装它能编。
     */
    /**
     * M2.85 内容填充 P6：晋升仪式要求（132 条 —— 22 途径 × 序列 5—0）。
     * 原作对序列 6—9 没有记载仪式，所以这张表**本来就不含**那四档。
     * 执行点：`.仪式 准备` 的「原作记载」一栏。
     */
    /**
     * M2.85 内容填充 P4：原作材料全表（1173 条 —— 辅助 797 / 主 376）。
     * ⚠️ 与「物品」表**并存但不替换**：items 是玩法层（掉落/交易/背包），本表是原著的设定层。
     * 执行点：`.图鉴 材料`。
     */
    /**
     * M2.85 内容填充 P5：原作能力清单（2405 条 —— 22 途径 × 10 档，逐条原文）。
     * ⚠️ 与「能力」（abilities.yaml，154 条机制）是**两层**：本表是原著里能做什么，那张是项目给什么数值。
     * 执行点：`.图鉴 能力 <途径> [序列]`。
     */
    /**
     * M2.85 世界演化第一步：NPC 晋升轨道（41 条 —— 有序列记载的人物）。
     * 执行点：`.图鉴 途径 <途径名>`（显示这条途径的神 + 走在上面的人 + 距登神几档）。
     */
    /**
     * M2.85 世界演化：**途径行为表**（22 途径 × 2 条）。
     * 执行点：`.图鉴 途径 <名>` 会列出「这条途径上的人会做什么」，世界事件里也看得到。
     */
    /**
     * M2.85 RPG 化：**NPC 的立场与性情**（态度与阴谋读它）。
     * 执行点：场景里的态度、npc_schemes 的阴谋判定、赠礼结算。
     */
    /**
     * M2.85 RPG 化 B：**装备表**（.装备 / .装备栏 读它）。
     */
    /**
     * M2.85 RPG 化 D：**委托表**（.委托 读它）。
     */
    /**
     * M2.85：**奇遇**（.探索 有 0.8% 的概率碰上）。
     */
    id: 'fortunes', label: '奇遇', group: '世界内容',
    file: 'src/data/fortunes.yaml', rootKey: 'fortunes', idKey: 'id', titleKey: 'title',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'kind', label: '类型', type: 'enum', enumMap: { find: '捡到', witness: '目睹', meet: '偶遇', omen: '预兆', mishap: '无妄之灾' } },
      { key: 'title', label: '标题', type: 'text' },
      { key: 'text', label: '正文', type: 'text', multiline: true },
      { key: 'weight', label: '权重', type: 'number', min: 1, max: 100, hint: '抽中的相对权重' },
      { key: 'location', label: '发生地', type: 'text', optional: true, hint: '取自 locations.yaml 的真实地名' },
      {
        key: 'effect', label: '效果', type: 'object',
        objectFields: [
          { key: 'itemId', label: '得到的东西', type: 'ref', itemRef: 'items', optional: true },
          { key: 'quantity', label: '数量', type: 'number', min: 0, max: 999, optional: true },
          { key: 'affinity', label: '好感', type: 'number', min: -100, max: 100, optional: true },
          { key: 'hp', label: 'HP', type: 'number', min: -999, max: 999, optional: true },
          { key: 'mad', label: 'MAD', type: 'number', min: -99, max: 99, optional: true },
          { key: 'cor', label: 'COR', type: 'number', min: -99, max: 99, optional: true },
          { key: 'dig', label: '消化', type: 'number', min: -9, max: 9, optional: true },
          { key: 'note', label: '记下的那句话', type: 'text', optional: true },
        ],
      },
    ],
  },
  {
    id: 'quests', label: '委托', group: '世界内容',
    file: 'src/data/quests.yaml', rootKey: 'quests', idKey: 'id', titleKey: 'title',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'kind', label: '类型', type: 'enum', enumMap: { hunt: '猎杀', explore: '探路', deliver: '跑腿' } },
      { key: 'from', label: '委托人', type: 'text', hint: '按身份说（占卜师 / 守夜人 / 老船长…），真正给活的是与你交好的 NPC' },
      { key: 'minAffinity', label: '好感门槛', type: 'number', min: -100, max: 100, hint: '与 npc-relation.ts 的亲近档位对齐（≥25 warm / ≥60 close）' },
      { key: 'minSequence', label: '序列门槛', type: 'number', min: 0, max: 9 },
      { key: 'title', label: '标题', type: 'text' },
      { key: 'text', label: '委托人原话', type: 'text', multiline: true },
      { key: 'condition', label: '要做的事', type: 'text' },
      { key: 'targetPathway', label: '目标途径', type: 'enum', enumMap: PATHWAY_CN, optional: true },
      {
        key: 'reward', label: '报酬', type: 'object',
        objectFields: [
          { key: 'affinity', label: '好感增量', type: 'number', min: -100, max: 100 },
          { key: 'penny', label: '便士', type: 'number', min: 0, max: 9999 },
          { key: 'note', label: '附注', type: 'text', optional: true },
          // ⚠️ 用户拍板「非凡物品不是大白菜」：这个概率**只有猎杀类**该大于 0，而且必须很低
          { key: 'equipmentChance', label: '给非凡物品的概率', type: 'number', min: 0, max: 0.12, optional: true, hint: '0—0.12。只有猎杀类才该开；探路 / 跑腿一律 0' },
        ],
      },
      { key: 'tier', label: '难度档', type: 'number', min: 1, max: 3 },
    ],
  },
  {    id: 'equipment', label: '装备', group: '世界内容',
    file: 'src/data/equipment.yaml', rootKey: 'equipment', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'name', label: '名称', type: 'text' },
      { key: 'slot', label: '槽位', type: 'enum', enumMap: SLOT_LABELS },
      { key: 'quality', label: '品质', type: 'enum', enumMap: QUALITY_LABELS },
      { key: 'sequence', label: '适用序列', type: 'number', min: 0, max: 9, hint: '9 最弱、0 最强。序列不到就压不住它' },
      { key: 'pathway', label: '专属途径', type: 'enum', enumMap: PATHWAY_CN, optional: true, hint: '不填 = 通用' },
      {
        key: 'stats', label: '属性加成', type: 'object',
        // ⚠️ object 类型必须把**子字段**一个个列出来（objectFields），否则边界校验会拒绝整份内容 ——
        // 这一条是 m2-83 那条「现有内容都能原样存回去」抓出来的。
        objectFields: [
          { key: 'hit', label: '命中加成', type: 'number', min: -1, max: 1, optional: true },
          { key: 'damage', label: '伤害加成', type: 'number', min: -99, max: 99, optional: true },
          { key: 'hp', label: 'HP 加成', type: 'number', min: -999, max: 999, optional: true },
          { key: 'defense', label: '防御', type: 'number', min: -1, max: 1, optional: true },
          { key: 'madResist', label: '失控抗性', type: 'number', min: -1, max: 1, optional: true },
          { key: 'cor', label: '腐蚀抗性', type: 'number', min: -99, max: 99, optional: true },
          { key: 'mp', label: '灵力加成', type: 'number', min: -999, max: 999, optional: true },
          { key: 'digBonus', label: '消化加成', type: 'number', min: -1, max: 1, optional: true },
        ],
      },
      { key: 'level', label: '封印等级', type: 'enum', enumMap: { '0': '0 级（非常危险）', '1': '1 级（高度危险）', '2': '2 级（危险）', '3': '3 级（有一定危险）', unrated: '未评级' }, hint: '等级越高增幅越大、代价也越重' },
      { key: 'negativeEffects', label: '副作用（原文）', type: 'strlist', hint: '直接抄原作的 negative_effects —— 这是非凡物品的灵魂' },
      {
        key: 'debuffs', label: '代价（可算数值）', type: 'object',
        objectFields: [
          { key: 'madPerUse', label: '每次使用理智', type: 'number', min: 0, max: 99, optional: true },
          { key: 'corGain', label: '腐蚀', type: 'number', min: 0, max: 99, optional: true },
          { key: 'hpDrain', label: '每回合流血', type: 'number', min: 0, max: 99, optional: true },
          { key: 'statPenalty', label: '属性惩罚', type: 'number', min: 0, max: 99, optional: true },
        ],
      },
      { key: 'abilities', label: '能力（原文）', type: 'strlist', optional: true },
      { key: 'text', label: '描述', type: 'text', multiline: true },
      { key: 'origin', label: '来历', type: 'text' },
    ],
  },
  {    id: 'npc-dispositions', label: 'NPC 立场', group: '世界内容',
    file: 'src/data/npc-dispositions.yaml', rootKey: 'npc_dispositions', idKey: 'npcId', titleKey: 'name',
    fields: [
      { key: 'npcId', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'name', label: '姓名', type: 'text' },
      { key: 'sequence', label: '序列', type: 'number', min: 0, max: 9, optional: true },
      { key: 'pathways', label: '途径', type: 'strlist', valueMap: PATHWAY_CN },
      { key: 'temperament', label: '性情', type: 'enum', enumMap: { dark: '黑暗向（交恶会主动算计）', neutral: '中立（按利害行事）', kind: '善意（交好会伸手）' } },
      { key: 'hostilePathways', label: '敌对途径', type: 'strlist', valueMap: PATHWAY_CN },
      { key: 'giftTier', label: '赠礼档位', type: 'enum', enumMap: { low: '轻', mid: '中', high: '重' } },
      { key: 'note', label: '备注', type: 'text', multiline: true },
    ],
  },
  {    id: 'pathway-deeds', label: '途径行为', group: '世界内容',
    file: 'src/data/pathway-deeds.yaml', rootKey: 'pathway_deeds', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      // ⚠️ 途径**不是一张内容表**（它的唯一出处是 PATHWAY_LABELS），所以只能用 enumMap，
      //    不能写 itemRef —— m2-64 的「itemRef 必须指向真实存在的实体」当场抓到了这一点。
      { key: 'pathway', label: '途径', type: 'enum', enumMap: PATHWAY_CN },
      { key: 'name', label: '行为名', type: 'text' },
      { key: 'text', label: '文案', type: 'text', multiline: true },
      { key: 'effect', label: '效果', type: 'enum', enumMap: { hunt: '猎杀生物', calm: '平息灾厄', tend: '养育补充', foretell: '占卜预言', observe: '观察洞察', gather: '搜寻发现' } },
      { key: 'minSequence', label: '最低序列（越小越强）', type: 'number', min: 0, max: 9 },
      { key: 'weight', label: '权重', type: 'number', min: 1, max: 999 },
    ],
  },
  {
    id: 'npc-tracks', label: 'NPC 晋升轨道', group: '世界内容',
    file: 'src/data/npc-tracks.yaml', rootKey: 'npc_tracks', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'name', label: '姓名', type: 'text' },
      { key: 'raw', label: '原作序列原文', type: 'text', multiline: true },
      { key: 'startSequence', label: '起点序列', type: 'number', min: 0, max: 9, optional: true },
      { key: 'currentSequence', label: '当前序列', type: 'number', min: 0, max: 9, optional: true },
      { key: 'stages', label: '轨迹段数', type: 'number', min: 0, max: 99, optional: true },
      { key: 'pathways', label: '所属途径', type: 'strlist', valueMap: PATHWAY_CN },
    ],
  },
  {
    /*
     * M2.167：**堕落生物**（人堕落之后长成什么）。
     *
     * ⚠️ 它只填 formId —— 形态名 / 途径 / min_seq 全部从 cards/lost-control.yaml 的 forms 派生，
     * 那张表是形态的唯一出处（AGENTS §3.1：两份清单会安静地少读一半）。
     */
    id: 'fallen-beasts', label: '堕落生物', group: '世界内容',
    file: 'src/data/fallen-beasts.yaml', rootKey: 'fallen_beasts', idKey: 'formId', titleKey: 'formId',
    fields: [
      { key: 'formId', label: '形态（失控形态表里的 id）', type: 'text', readOnly: true },
      { key: 'baseSequence', label: '基线序列（1 最强）', type: 'number', min: 1, max: 9 },
      { key: 'baseHp', label: '血量', type: 'number', min: 1, max: 999 },
      { key: 'drops', label: '掉落（原作：怪物是魔药材料的来源）', type: 'rows', rowFields: [
        { key: 'itemId', label: '物品', type: 'ref', ref: 'items' },
        { key: 'chance', label: '概率', type: 'number', min: 0, max: 1 },
      ] },
      ro('behaviors', '行为', '单键 map 的数组；键名拼错这条行为会静默失效'),
      ro('battle', '战斗面', '判定层直接读 damage / hit / special；special 是枚举，写错启动就报错'),
      ro('perception', '五层感知', '缺一层加载就报错；结构太深，不在后台拼'),
      { key: 'flavor', label: '氛围句', type: 'text' },
      { key: 'source', label: '依据', type: 'text' },
    ],
  },  {
    /*
     * M2.169：**神与神的关系网** —— 神明阴谋的依据（没写在这里的关系不算数）。
     *
     * ⚠️ `kind` 是 `covet` 时**有方向**：a 觊觎 b（hint 里也写着）。
     */
    id: 'divine-relations', label: '神与神的关系', group: '世界内容',
    file: 'src/data/divine-relations.yaml', rootKey: 'divine_relations', idKey: 'id', titleKey: 'id',
    fields: [
      { key: 'id', label: '边 ID', type: 'text', readOnly: true },
      { key: 'a', label: '这一边（途径）', type: 'enum', enumMap: PATHWAY_CN },
      { key: 'b', label: '那一边（途径）', type: 'enum', enumMap: PATHWAY_CN },
      {
        key: 'kind', label: '关系', type: 'enum',
        enumMap: { ally: '盟友（可联手）', rival: '水火不容（两边都能下手）', covet: '觊觎其位（a 觊觎 b）' },
        hint: 'covet 有方向：左边那位觊觎右边那位的位置',
      },
      { key: 'since', label: '从什么时候', type: 'text' },
      { key: 'note', label: '说明', type: 'text', multiline: true },
      { key: 'source', label: '原作出处', type: 'text', hint: '写成 文件:行 或 URL —— 内容作者要能回去核' },
    ],
  },  {
    id: 'divine-authorities', label: '权柄与象征（原作）', group: '世界背景',
    file: 'src/data/divine-authorities.yaml', rootKey: 'divine_authorities', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'pathway', label: '途径', type: 'enum', enumMap: PATHWAY_CN, optional: true, hint: '映射不上为 null（原作里有外神途径）' },
      { key: 'pathwayName', label: '原作途径名', type: 'text' },
      { key: 'name', label: '权柄名', type: 'text' },
      { key: 'kind', label: '类别', type: 'text' },
      { key: 'description', label: '说明', type: 'text', multiline: true },
      ro('source', '出处', '校对用（改了不改变判定）'),
      ro('confidence', '可信度', '校对用（改了不改变判定）'),
    ],
  },  {
    /*
     * M2.164：**神座表补登记**（M2.97 做完之后一直没上后台）。
     *
     * 后果不是报错，而是「运营看不见也改不了」：
     * 祂们的资源、目标、手段、反应、注视全都是内容，却只能手改 YAML。
     * 这正是 AGENTS §3.7 那条判据（src 下每一份 yaml 都该在后台）要拦的东西。
     *
     * ⚠️ 两个 id 口径写进了 hint —— 它们是本轮修掉的两个静默缺口（写错都不报错）：
     *    reach 装城市 id（不是地点）、factions 允许哨兵值 none。
     */
    id: 'divine-thrones', label: '神座（序列 0）', group: '世界内容',
    file: 'src/data/divine-thrones.yaml', rootKey: 'divine_thrones', idKey: 'pathway', titleKey: 'title',
    fields: [
      { key: 'pathway', label: '途径', type: 'enum', enumMap: PATHWAY_CN },
      { key: 'title', label: '序列 0 称号', type: 'text' },
      { key: 'seat', label: '现在坐着谁', type: 'text', hint: '空位时写上一任，或空着' },
      { key: 'seatKind', label: '坐的是哪一类', type: 'enum', enumMap: SEAT_KIND_LABELS },
      { key: 'state', label: '状态', type: 'enum', enumMap: THRONE_STATE_LABELS },
      { key: 'evidence', label: '原作依据', type: 'text', multiline: true },
      { key: 'claimant', label: '正在往上爬的那位', type: 'ref', ref: 'npc-tracks', optional: true },
      { key: 'resources', label: '资源（有什么）', type: 'object', objectFields: [
        { key: 'churches', label: '教会', type: 'strlist', itemRef: 'churches' },
        { key: 'factions', label: '势力', type: 'strlist', itemRef: 'powers', allow: ['none'], hint: 'none = 无主（哨兵值，不是任何表里的 id）' },
        { key: 'artifacts', label: '封印物', type: 'strlist' },
        { key: 'reach', label: '够得到的城市', type: 'strlist', itemRef: 'cities', hint: '装的是**城市** id，不是地点 id' },
        { key: 'angels', label: '天使（0—9）', type: 'number', min: 0, max: 9 },
        { key: 'intel', label: '情报（0—5）', type: 'number', min: 0, max: 5 },
        { key: 'wealth', label: '财力（0—5）', type: 'number', min: 0, max: 5 },
      ] },
      { key: 'goals', label: '目标（想要什么）', type: 'rows', rowFields: [
        { key: 'id', label: '目标 id', type: 'text' },
        { key: 'text', label: '想要什么', type: 'text' },
        { key: 'weight', label: '权重', type: 'number', min: 0, max: 99 },
      ] },
      { key: 'methods', label: '手段（能做什么）', type: 'rows', rowFields: [
        { key: 'id', label: '手段 id', type: 'text' },
        { key: 'text', label: '做什么', type: 'text' },
        { key: 'broadcast', label: '播报（玩家看到的）', type: 'text' },
        { key: 'scope', label: '范围', type: 'enum', enumMap: { world: '世界', city: '城市', location: '地点' } },
        { key: 'goal', label: '服务于哪个目标 id', type: 'text' },
        { key: 'cooldown_hours', label: '冷却（小时）', type: 'number', min: 0, max: 999 },
        { key: 'weight', label: '权重', type: 'number', min: 0, max: 99 },
        { key: 'needs', label: '前提', type: 'readonly' },
        { key: 'cost', label: '代价', type: 'readonly' },
      ] },
      { key: 'responses', label: '对局势的反应', type: 'rows', rowFields: [
        { key: 'when', label: '局势关键词', type: 'text' },
        { key: 'prefer', label: '优先用哪条手段 id', type: 'text' },
        { key: 'weight', label: '强度', type: 'number', min: 0, max: 99 },
      ] },
      { key: 'gaze', label: '看向玩家时做什么', type: 'rows', rowFields: [
        { key: 'when', label: '玩家局势', type: 'text' },
        { key: 'act', label: '做什么', type: 'enum', enumMap: GAZE_ACT_LABELS },
        { key: 'text', label: '玩家读到的那一句', type: 'text' },
        { key: 'flag', label: '写下的 flag', type: 'text' },
        { key: 'weight', label: '权重', type: 'number', min: 0, max: 99 },
        { key: 'effect', label: '效果', type: 'readonly' },
      ] },
    ],
  },  {
    id: 'npc-cast', label: '世界人物名册', group: '世界内容',
    file: 'src/data/npc-cast.yaml', rootKey: 'npc_cast', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'name', label: '姓名', type: 'text' },
      { key: 'kind', label: '身份', type: 'enum', enumMap: NPC_KIND_LABELS },
      { key: 'city', label: '常驻城市', type: 'ref', ref: 'cities', hint: '他常驻在哪座城（空 = 居无定所）' },
      /*
       * ⚠️ 这个字段的下拉给的是**全部地点**，而服务端还要求它属于上面那座城 ——
       * 前端控件只是方便，真正的防线在 loader 的 checkNpcCastRefs（「人在一个到不了的地方」）。
       */
      { key: 'location', label: '常驻地点', type: 'ref', ref: 'locations', optional: true, hint: '必须是**该城**的地点（加载器会拦别城的地点）' },
      { key: 'faction', label: '本地势力', type: 'ref', ref: 'factions', optional: true },
      { key: 'organization', label: '所属组织', type: 'ref', ref: 'organizations', optional: true },
      { key: 'church', label: '所属教会', type: 'ref', ref: 'churches', optional: true },
      { key: 'pathway', label: '途径', type: 'enum', enumMap: PATHWAY_CN, optional: true, hint: '空 = 普通人' },
      { key: 'sequence', label: '序列（9 最弱）', type: 'number', min: 0, max: 9, optional: true },
      { key: 'temperament', label: '性情', type: 'enum', enumMap: { dark: '黑暗向（交恶会主动算计）', neutral: '中立（按利害行事）', kind: '善意（交好会伸手）' } },
      { key: 'tags', label: '用途标签', type: 'strlist', hint: '中文自由标签（机制按标签筛选）：可被收买 / 知道港口的事……' },
      { key: 'note', label: '一句话', type: 'text', multiline: true },
    ],
  },
  {    id: 'advancement-rites', label: '晋升仪式要求', group: '角色成长',
    file: 'src/data/advancement-rites.yaml', rootKey: 'advancement_rites', idKey: 'id', titleKey: 'id',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'pathway', label: '途径', type: 'enum', enumMap: PATHWAY_CN },
      { key: 'seq', label: '序列', type: 'number', min: 0, max: 9 },
      { key: 'sequenceTitle', label: '序列称号', type: 'text' },
      { key: 'potion', label: '魔药', type: 'text' },
      { key: 'ritual', label: '原作记载的仪式', type: 'text', multiline: true, hint: '原作原文，未改写' },
    ],
  },
  {
    id: 'rituals', label: '晋升仪式档位', group: '世界内容',
    file: 'src/data/rituals.yaml', rootKey: 'rituals', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'name', label: '档位名', type: 'text' },
      { key: 'min_seq', label: '适用的最高序列', type: 'number', min: 0, max: 9, hint: '数字越小要求越高：9 = 新号也能做' },
      { key: 'max_seq', label: '适用的最低序列', type: 'number', min: 0, max: 9, hint: '必须不大于最高序列，否则这一档匹配不到任何序列' },
      { key: 'witness_min', label: '最少见证人', type: 'number', min: 0, max: 3, hint: '0 = 可以独狼；1 以上会让「一个人躲起来偷偷升」不成立' },
      { key: 'fuse_penalty', label: '融合固定惩罚', type: 'number', min: -1, max: 0, hint: '负数。整档玩家的融合成功率都会乘上它' },
      { key: 'note', label: '说明', type: 'text', hint: '这一档是什么样、给谁看' },
      ro('stages', '阶段表', '对象数组，含一个可空字段（融合关 base = null）—— 形状超出 rows 能表达的范围，请在 YAML 里改'),
    ],
  },
  {
    /*
     * ⚠️ M2.89：**只暴露游戏数据，不暴露建设期元数据。**
     *
     * 用户的原话：
     *
     * > 「生物名录底下的数据都是些什么鬼？前面生物后面材料？文档全部混进数据了，
     * >  还有原作能力清单和原作材料是什么鬼？这种数据不是应该解析后并入框架数据结构吗？
     * >  **原作数据是让你参考写数据，而不是让你直接把参考数据接入到框架**」
     *
     * 改之前这里列着 17 个字段，其中**六个是建设期的中间产物**：
     *
     *   · `materials`    —— 原作素材的**原样文本**（形如「\"暗影之蛇\"的尖牙（主材料 · 用在 criminal:7）」）
     *   · `usedIn`       —— 反向索引，建表时用来对齐配方
     *   · `pathwayNames` —— 原作里的途径叫法，校对用，不是游戏数据
     *   · `note`         —— 「未映射的原作字段」的暂存区
     *   · `sources`      —— 出处（萌娘百科 / 腾讯书城）
     *   · `confidence`   —— 数据可信度
     *
     * **它们都还在 YAML 里**（`.图鉴 生物` 读 materials / usedIn 来显示「产出材料」），
     * 只是**不再让运营编辑** —— 那六项改坏了没有任何东西会报错，而运营也没有理由改它们。
     *
     * ⚠️ 从字段表移除**不会**动到 YAML 里的值：编辑器只改「列出来的那些字段」，
     * 其余原样保留。这条由 `m2-83` 的「全部内容原样存回」用例守着。
     */
    id: 'bestiary', label: '生物名录', group: '世界内容',
    file: 'src/data/bestiary.yaml', rootKey: 'bestiary', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'name', label: '名称', type: 'text' },
      { key: 'aliases', label: '别名', type: 'strlist', multiline: true },
      { key: 'category', label: '分类', type: 'text', hint: '超凡生物 / 普通物种与材料 / 神话生物形态 / 失控机制 / …（图鉴按它分组）' },
      { key: 'creatureCategory', label: '生物类别', type: 'text', hint: 'animal / plant / mineral / spirit…（原作推断值）' },
      { key: 'isExtraordinary', label: '非凡生物', type: 'bool' },
      { key: 'pathways', label: '涉及途径', type: 'strlist', valueMap: PATHWAY_CN },
      { key: 'habitat', label: '栖息地', type: 'text', hint: '⚠️ 原作多为 null（未载）—— 不要凭感觉补' },
      { key: 'appearance', label: '外形', type: 'text', multiline: true, hint: '⚠️ 同上' },
      { key: 'role', label: '材料角色', type: 'text' },
      { key: 'detail', label: '说明', type: 'text', multiline: true },
    ],
  },
  {
    id: 'figures', label: '人物', group: '世界背景',
    file: 'src/data/figures.yaml', rootKey: 'figures', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'name', label: '姓名', type: 'text' },
      { key: 'aliases', label: '别名', type: 'strlist', multiline: true },
      { key: 'category', label: '分类', type: 'text', hint: '主要角色 / 配角 / 天使 / 圣徒 / 古神 / 古代帝王…（图鉴按它分组）' },
      { key: 'gender', label: '性别', type: 'text' },
      { key: 'nation', label: '国籍 / 出身', type: 'text' },
      { key: 'pathways', label: '涉及途径', type: 'strlist', valueMap: PATHWAY_CN },
      { key: 'pathwayNames', label: '原作途径名', type: 'strlist', multiline: true },
      { key: 'sequence', label: '序列', type: 'text', multiline: true },
      { key: 'sequenceTitle', label: '序列称号', type: 'text' },
      { key: 'ascent', label: '晋升轨迹', type: 'text', multiline: true },
      { key: 'organization', label: '所属组织', type: 'strlist', multiline: true },
      { key: 'organizationIds', label: '所属组织（引用）', type: 'strlist', itemRef: 'organizations', hint: '从原作的复合文本匹配出来的 id' },
      { key: 'occupation', label: '职业', type: 'text', multiline: true },
      { key: 'origin', label: '出身地', type: 'text' },
      { key: 'identity', label: '身份', type: 'text', multiline: true },
      { key: 'relation', label: '与主角的关系', type: 'text', multiline: true },
      { key: 'ending', label: '结局', type: 'text', multiline: true },
    ],
  },
  {
    id: 'organizations', label: '组织与势力', group: '势力与地理',
    file: 'src/data/organizations.yaml', rootKey: 'organizations', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'name', label: '名称', type: 'text' },
      { key: 'nameEn', label: '英文名', type: 'text' },
      { key: 'category', label: '分类', type: 'text', hint: '鲁恩机构 / 军队 / 贵族家族 / 商会 / 地下势力 / 隐秘组织（图鉴按它分组）' },
      { key: 'nation', label: '所属国家', type: 'text' },
      { key: 'era', label: '纪元', type: 'text', multiline: true },
      { key: 'nature', label: '性质', type: 'text', multiline: true },
      { key: 'structure', label: '组织结构', type: 'strlist', multiline: true },
      { key: 'doctrine', label: '教义 / 主张', type: 'strlist', multiline: true },
      { key: 'members', label: '成员', type: 'strlist', multiline: true },
      { key: 'pathways', label: '涉及途径', type: 'strlist', valueMap: PATHWAY_CN },
      { key: 'pathwayNames', label: '原作途径名', type: 'strlist', multiline: true },
      { key: 'playerRelation', label: '与玩家的关系', type: 'text', multiline: true },
      { key: 'emblem', label: '徽记', type: 'text' },
      { key: 'note', label: '注记', type: 'strlist', multiline: true },
      { key: 'disputed', label: '存疑', type: 'text', multiline: true },
    ],
  },
  {
    id: 'pantheon', label: '神明', group: '世界背景',
    file: 'src/data/pantheon.yaml', rootKey: 'deities', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'name', label: '名号', type: 'text' },
      { key: 'nameEn', label: '真名（英文）', type: 'text' },
      { key: 'category', label: '分类', type: 'text', hint: '正神 / 支柱级旧日 / 隐秘存在与邪神（图鉴按它分组）' },
      { key: 'tier', label: '层次', type: 'text' },
      { key: 'trueName', label: '真名', type: 'text' },
      { key: 'pathways', label: '对应途径', type: 'strlist', valueMap: PATHWAY_CN },
      { key: 'pathwayNames', label: '原作途径名', type: 'strlist', multiline: true },
      { key: 'aliases', label: '别名', type: 'strlist', multiline: true },
      { key: 'status', label: '状态', type: 'text', multiline: true },
      { key: 'godNameFull', label: '完整尊名', type: 'strlist', multiline: true },
      { key: 'divineKingdom', label: '神国', type: 'text' },
      { key: 'symbols', label: '象征', type: 'strlist', multiline: true },
      { key: 'holyEmblem', label: '圣徽', type: 'text', multiline: true },
      { key: 'church', label: '教会', type: 'text' },
      { key: 'churchIds', label: '教会（引用）', type: 'strlist', itemRef: 'churches', hint: '从原作名归一后匹配出来的 id' },
      { key: 'beliefOrgs', label: '信仰组织', type: 'strlist', multiline: true },
      { key: 'essence', label: '本质', type: 'strlist', multiline: true },
      { key: 'appearance', label: '外貌', type: 'strlist', multiline: true },
      { key: 'nature', label: '性质', type: 'strlist', multiline: true },
      { key: 'relatedLocations', label: '相关地点', type: 'strlist', multiline: true, hint: '原作口语地名，不是项目地点 id' },
    ],
  },
  {
    /**
     * M2.85 内容填充 P1：塔罗牌（大阿卡那 22 张）。
     *
     * 数据来自原作数据目录（三方互证），运营可改的是**展示字段**（牌名、象征、故事注记）——
     * `pathway` 改错了会让那张牌永远抽不到（判定按途径取牌），所以它带枚举下拉。
     */
    id: 'tarot', label: '塔罗牌', group: '仪式与占卜',
    file: 'src/data/tarot.yaml', rootKey: 'cards', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'number', label: '编号', type: 'number', readOnly: true, hint: '愚者是 0 号，不在 1—21 的顺序里（原作设定）' },
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'name', label: '牌名', type: 'text' },
      { key: 'nameEn', label: '英文名', type: 'text' },
      { key: 'pathway', label: '对应途径', type: 'enum', enumMap: PATHWAY_CN, hint: '改错会让这张牌永远抽不到' },
      { key: 'pathwayName', label: '原作途径名', type: 'text' },
      { key: 'sequence0', label: '序列 0（神名）', type: 'text' },
      { key: 'sequence9', label: '序列 9（起点）', type: 'text' },
      { key: 'organizations', label: '关联组织', type: 'strlist', multiline: true },
      { key: 'holder', label: '持有者', type: 'text' },
      { key: 'symbolism', label: '象征意义', type: 'text', multiline: true },
      { key: 'storyNote', label: '故事注记', type: 'text', multiline: true },
      { key: 'evidence', label: '来源', type: 'text' },
    ],
  },
  {
    /* M2.76：封测 FAQ（.帮助 faq 与 docs/FAQ.md 共用这一份来源） */
    id: 'faq', label: '常见问题', group: '运营物料',
    file: 'src/data/faq.yaml', rootKey: 'faq', idKey: 'q', titleKey: 'q',
    fields: [
      { key: 'q', label: '问题', type: 'text', hint: '玩家会怎么问 —— 用他的说法，不用你的说法' },
      { key: 'a', label: '回答', type: 'text', hint: '能用一条指令解决的，就把那条指令写进去' },
    ],
  },
  {
    /*
     * M2.76：失控文本池 —— **第一张 rootMode: 'map' 的表**（键 → 一组文本）。
     *
     * 为什么它必须可编：这张表的读者就是玩家本人。角色失控时，
     * 从他所属途径的那一组里抽一条私聊发给他 —— 它直接决定「失控」这件事
     * 在玩家眼里是什么样。文案要改就得能改，不该等发版。
     *
     * ⚠️ 键是途径 id，**不能改**（改了判定层就找不到这一池）。
     * 界面上它显示成中文途径名、且只读。
     */
    id: 'lost-control', label: '失控文本池', group: '内容',
    file: 'src/cards/lost-control.yaml', rootKey: 'lost_control', rootMode: 'map',
    idKey: 'pathway', titleKey: 'pathway', titleMap: PATHWAY_CN,
    fields: [
      { key: 'pathway', label: '途径', type: 'text', readOnly: true, hint: '失控文本按途径分池：角色只抽得到自己那条途径的' },
      {
        key: 'texts', label: '失控文本', type: 'strlist', multiline: true,
        hint: '一行一条。支持 {{片段}} 模板（片段见「卡片片段池」）；整行以 {{ 开头时要用引号包住',
      },
    ],
  },
  {
    /*
     * M2.76：卡片片段池 —— 事件卡正文里的 {{气味}} / {{声音}} 从这里取。
     *
     * 与失控文本池同一种形状（rootMode: 'map'），区别只在键：这里的键是中文片段名，
     * 所以不需要 titleMap。
     */
    id: 'fragments', label: '卡片片段池', group: '内容',
    file: 'src/cards/fragments.yaml', rootKey: 'fragments', rootMode: 'map',
    idKey: 'name', titleKey: 'name',
    fields: [
      { key: 'name', label: '片段名', type: 'text', readOnly: true, hint: '事件卡正文里写 {{这个名字}}' },
      { key: 'texts', label: '候选文本', type: 'strlist', multiline: true, hint: '一行一条，渲染时按 seed 随机取一条' },
    ],
  },
  {
    /*
     * M2.76：内容注册表 —— `flags` 是「卡片 cond 里能写哪些标记名」的唯一清单。
     *
     * 写错一个标记名不会有任何提示：卡片照样加载、条件照样为假，
     * 那张卡就是永远不出。所以这份清单值得摆在后台最顺手的位置。
     */
    id: 'registry', label: '内容注册表', group: '内容',
    file: 'src/cards/registry.yaml', rootMode: 'single',
    fields: [
      {
        key: 'flags', label: '标记（flag）', type: 'strlist', multiline: true,
        // 卡片里靠 `flag:这个名字` 引用它 —— 拼错一个字符，那条条件就永远不成立
        pattern: '^[a-z][a-z0-9_]*$',
        patternHint: '小写字母开头的标识符（如 met_mentor）',
        hint: '一行一个。卡片效果里用 flag:标记名 授予，触发条件里用 flag:标记名 判断',
      },
    ],
  },
  {
    /* M2.76：群规则（.帮助 规则 与 docs/群规则.md 共用这一份来源） */
    id: 'community-rules', label: '群规则', group: '运营物料',
    file: 'src/data/community-rules.yaml', rootMode: 'single',
    fields: [
      { key: 'rules', label: '群规则', type: 'strlist', multiline: true, hint: '一行一条，玩家输入「.帮助 规则」时原样列出来' },
      { key: 'forbidden_words_note', label: '敏感词说明', type: 'text', multiline: true, hint: '过滤对入站消息与机器人输出双向生效' },
      { key: 'punishment', label: '处罚梯度', type: 'strlist', multiline: true, hint: '一行一条' },
    ],
  },
  {
    /* M2.76：封测公告要点（.帮助 公告 与 docs/封测公告.md 共用这一份来源） */
    id: 'beta-info', label: '封测公告', group: '运营物料',
    file: 'src/data/beta-info.yaml', rootMode: 'single',
    fields: [
      { key: 'phase', label: '阶段', type: 'text', hint: '公告抬头那句' },
      { key: 'schedule', label: '日程', type: 'strlist', multiline: true, hint: '一行一条' },
      { key: 'scope', label: '本次开放', type: 'strlist', multiline: true, hint: '一行一条。⚠️ 开放途径改了要跟着改这一条，玩家照着它判断能玩什么' },
      { key: 'not_included', label: '本次不做', type: 'strlist', multiline: true, hint: '一行一条。写清楚不做什么，比事后解释便宜' },
      { key: 'service', label: '客服', type: 'strlist', multiline: true, hint: '一行一条，支持 {{客服QQ}} 这类占位符' },
    ],
  },
  {
    /*
     * M2.76：三类事件卡 —— **第一组 rootMode: 'dir' 的表**（一个文件一张卡）。
     *
     * 为什么单开一种根形状：卡片是内容的主体（116 张），而它天生一卡一文件。
     * 硬塞进「一个文件多条」的模型，就得先把 116 个文件合并成几个 ——
     * 那会让 git diff、卡片 lint、人工查阅全部变差。
     *
     * 分三个实体（而不是一个扫全部）：三类的定位不同（普通人 / 每日 / 途径专属），
     * 混在一个列表里翻起来很累；而且一个目录一个实体，目录名本身就是分类。
     */
    id: 'cards-daily', label: '每日事件卡', group: '事件卡',
    file: 'src/cards/daily', rootMode: 'dir',
    idKey: 'id', titleKey: 'name', fields: CARD_FIELDS,
    /*
     * 卡片有自己的 id 约定（cards/lint.ts 的 ID_PATTERN）：小写字母开头、
     * 且**至少要有一个下划线分段**。它不属于「安全」（大写不会写出目录穿越），
     * 但违反它的卡会被 lint 拒掉 —— 在这里配上，新建时就能说清，
     * 而不是建完一张、热重载失败之后才知道。
     */
    idPattern: CARD_ID_PATTERN,
    idHint: '卡片 id 要全小写、且至少带一个下划线分段（例如 daily_100 / path_seer_9）',
  },
  {
    /* 普通人专属卡：未入途径的玩家抽的是这一池（描述模糊、信息少、压迫感强） */
    id: 'cards-mortal', label: '普通人事件卡', group: '事件卡',
    file: 'src/cards/mortal', rootMode: 'dir',
    idKey: 'id', titleKey: 'name', fields: CARD_FIELDS,
    /*
     * 卡片有自己的 id 约定（cards/lint.ts 的 ID_PATTERN）：小写字母开头、
     * 且**至少要有一个下划线分段**。它不属于「安全」（大写不会写出目录穿越），
     * 但违反它的卡会被 lint 拒掉 —— 在这里配上，新建时就能说清，
     * 而不是建完一张、热重载失败之后才知道。
     */
    idPattern: CARD_ID_PATTERN,
    idHint: '卡片 id 要全小写、且至少带一个下划线分段（例如 daily_100 / path_seer_9）',
  },
  {
    /* 途径专属卡：cond 里写着 pathway:xxx，只有那条途径的人抽得到 */
    id: 'cards-pathway', label: '途径专属卡', group: '事件卡',
    file: 'src/cards/pathway', rootMode: 'dir',
    idKey: 'id', titleKey: 'name', fields: CARD_FIELDS,
    /*
     * 卡片有自己的 id 约定（cards/lint.ts 的 ID_PATTERN）：小写字母开头、
     * 且**至少要有一个下划线分段**。它不属于「安全」（大写不会写出目录穿越），
     * 但违反它的卡会被 lint 拒掉 —— 在这里配上，新建时就能说清，
     * 而不是建完一张、热重载失败之后才知道。
     */
    idPattern: CARD_ID_PATTERN,
    idHint: '卡片 id 要全小写、且至少带一个下划线分段（例如 daily_100 / path_seer_9）',
  },
  {
    /*
     * M2.90：**序列专属卡**（M2.87 加的第三个池子，511 张）。
     *
     * 与途径专属卡的区别：途径卡是「一条途径一张」（cond 只写 pathway:X），
     * 这里是「**每条途径的每一档序列各有一张**」（cond 是 pathway:X 且
     * min_seq == max_seq == N）—— 序列 9 的占卜家与序列 4 的占卜家
     * 看到的世界完全不同，靠的就是这一层。
     *
     * ⚠️ 这一批上线时**没登记到后台**：511 张卡运营看不见、也改不了，
     * 而 AGENTS §3.7 的判据是「src 下任何一份 yaml 都不该落在后台外面」。
     * 一个目录一个实体，字段与上面三类卡完全共用（CARD_FIELDS）。
     *
     * ⚠️ 读取入口（写-读闭环）：这些卡**不绑地点**，走的是 `.事件` 的全局池
     * （按 cond 里的途径与序列区间过滤），不像 daily 卡那样挂在 locations.events 里。
     * 实测：序列 8 的占卜家连发 40 次 `.事件`，26 次抽到本池的卡、2 次途径池。
     */
    id: 'cards-seq', label: '序列专属卡', group: '事件卡',
    file: 'src/cards/seq', rootMode: 'dir',
    idKey: 'id', titleKey: 'name', fields: CARD_FIELDS,
    idPattern: CARD_ID_PATTERN,
    idHint: '卡片 id 要全小写、且至少带一个下划线分段（例如 seq7_001 / seq8_seer）',
  },
  {
    /*
     * M2.87：**战斗技能**（110 条 = 22 途径 × 序列 9/7/5/3/1）。
     *
     * 技能名与 text 逐条来自 `pathway-abilities.yaml` 的原文，`source` 字段就是那条能力的 id
     * —— 可追溯、不编造。**效果数值是项目派生值**（原著描述里没有数字），
     * 所以这个字段的 hint 里必须说清楚，别让运营以为那是原作数据。
     */
    id: 'battle-skills', label: '战斗技能', group: '世界内容',
    file: 'src/data/battle-skills.yaml', rootKey: 'battle_skills', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'pathway', label: '途径', type: 'enum', enumMap: PATHWAY_CN },
      { key: 'seq', label: '序列', type: 'number', min: 0, max: 9, hint: '当前数据只落在 1/3/5/7/9（与「技能是解禁不是升级」一致）—— 不放宽也不收紧，因为那是内容约定不是格式约束' },
      { key: 'name', label: '技能名', type: 'text' },
      {
        key: 'kind', label: '分类', type: 'enum',
        enumMap: { strike: '强攻', guard: '防御', control: '控制', restore: '辅助' },
        hint: '按关键词包含匹配从能力原文归出来的（与 tags.ts 同口径，不用 LLM、不分词）',
      },
      { key: 'mpCost', label: '灵性消耗', type: 'number', min: 0, max: 999, hint: '当前 5 ~ 32' },
      {
        key: 'effect', label: '效果（项目派生值）', type: 'object',
        hint: '⚠️ 这些数字不是原作数据 —— 原著描述里没有数值，是本项目按序列派生的',
        /*
         * ⚠️ 字段集**必须来自真实数据**，不许凭印象写。
         *
         * 本字段第一次登记时我凭印象写了 `corReduction` / `madReduction` ——
         * 那两个字段**在 110 条数据里一条都没有**；同时漏掉了真实存在的三个：
         * `hitBonus`（70 条）、`damageTaken`（5 条）、`madResist`（5 条）。
         *
         * 症状：`m2-83` 的「全部内容原样存回」直接红 ——
         * AGENTS §3.10 那条纪律说的正是这个：**收紧校验最容易犯的错不是漏掉坏值，
         * 而是挡住好值**，而它不报错地通过类型检查，只在有人真的去保存时才炸。
         *
         * 范围一律给**宽松的合理界**（-1~1 是比例，0~999 是绝对值），
         * 不按当前观测到的最大值卡死 —— 那会把「以后加一条更强的技能」变成一次故障。
         */
        objectFields: [
          { key: 'damageBonus', label: '伤害加成', type: 'number', min: -1, max: 1, optional: true, hint: '比例' },
          { key: 'damageTaken', label: '受到伤害（负 = 减免）', type: 'number', min: -1, max: 1, optional: true, hint: '比例' },
          { key: 'hitBonus', label: '命中加成', type: 'number', min: -1, max: 1, optional: true, hint: '比例' },
          { key: 'foeHitPenalty', label: '敌方命中惩罚', type: 'number', min: -1, max: 1, optional: true, hint: '比例' },
          { key: 'madResist', label: '疯狂抗性', type: 'number', min: -1, max: 1, optional: true, hint: '比例' },
          { key: 'digBonus', label: '消化加成', type: 'number', min: -1, max: 1, optional: true, hint: '比例' },
          { key: 'mpRestore', label: '灵性回复', type: 'number', min: 0, max: 999, optional: true, hint: '绝对值（当前最大 22）' },
        ],
      },
      { key: 'text', label: '能力原文', type: 'text', multiline: true, hint: '⚠️ 逐字来自 pathway-abilities.yaml，不许改写' },
    ],
  },
  {
    /*
     * M2.87：**商店** —— 「哪里能买到什么」。
     *
     * 每个商店**就是一个地点**（`locationId`），不另造一层「商店实体」：
     * 玩家已经在用地点思考（`.探索 咸鱼市场`），多一层只会多一个要记的名字。
     *
     * 价格不写 → 走 `prices.yaml` 的规则（调价只需改一处）；写了 → 以这里的为准。
     */
    id: 'shops', label: '商店', group: '世界内容',
    file: 'src/data/shops.yaml', rootKey: 'shops', idKey: 'id', titleKey: 'name',
    fields: [
      { key: 'id', label: '内部 ID', type: 'text', readOnly: true },
      { key: 'locationId', label: '所在地点', type: 'ref', ref: 'locations', hint: '商店就是一个地点 —— 玩家用 .探索 <地名> 进去' },
      { key: 'name', label: '店名', type: 'text' },
      {
        key: 'kind', label: '类型', type: 'enum',
        enumMap: { general: '杂货', bookstore: '书店', tavern: '酒馆', church: '教堂', workshop: '工坊', blackmarket: '黑市' },
      },
      { key: 'keeper', label: '店主（一句话）', type: 'text', multiline: true },
      { key: 'greeting', label: '招呼语', type: 'text', multiline: true },
      { key: 'note', label: '运营说明', type: 'text', multiline: true, optional: true, hint: '给后台看的一句话：这家店为什么这么配货。不进判定' },
      {
        key: 'stock', label: '货架', type: 'rows',
        rowFields: [
          { key: 'itemId', label: '物品', type: 'ref', ref: 'items' },
          { key: 'price', label: '定价（便士）', type: 'number', min: 0, max: 9999999, optional: true, hint: '留空则按 prices.yaml 的规则派生' },
          { key: 'stock', label: '库存', type: 'number', min: 0, max: 9999, optional: true },
        ],
      },
    ],
  },
  {
    /*
     * M2.87：**物价表** —— 这个文件回答「一件东西该卖多少钱」。
     *
     * 它是**两层**的，而且必须分开看（AGENTS 三条禁令的第 2、3 条）：
     *   ① `anchors` / `itemAnchors` —— **原作直述的价格**，逐条带章节号。这些数字一个字都不许改。
     *   ② `rules` —— **项目派生的定价规则**，用来给原作没给价的东西定价。
     *
     * ⚠️ 派生值不是原作数据：`rules` 的每一项都要写清「从哪条锚点推的、怎么推的」。
     */
    id: 'prices', label: '物价表', group: '经济',
    file: 'src/data/prices.yaml', rootMode: 'single',
    fields: [
      {
        key: 'anchors', label: '原作价格锚点', type: 'rows',
        hint: '⚠️ 原作直述 —— 逐条带章节号，这些数字一个字都不许改',
        rowFields: [
          { key: 'id', label: '锚点 id', type: 'text' },
          { key: 'item', label: '东西', type: 'text' },
          { key: 'penny', label: '便士', type: 'number', min: 0, max: 999999999 },
          { key: 'chapter', label: '出处章节', type: 'text', hint: '如 ch25 —— 原作可追溯的依据' },
          { key: 'note', label: '说明', type: 'text', optional: true },
        ],
      },
      {
        key: 'itemAnchors', label: '单件锚点（按物品名）', type: 'rows',
        hint: '给某一件具体东西定价 —— 优先于按 kind 的规则命中',
        rowFields: [
          { key: 'id', label: '物品 id', type: 'ref', ref: 'items' },
          { key: 'item', label: '显示名', type: 'text', optional: true },
          { key: 'penny', label: '便士', type: 'number', min: 0, max: 999999999 },
          { key: 'chapter', label: '出处章节', type: 'text', optional: true, hint: '派生值写「派生」' },
          { key: 'basis', label: '依据', type: 'text', optional: true, hint: '⚠️ 派生值必须写清从哪条锚点推的' },
        ],
      },
      {
        key: 'rules', label: '派生定价规则（按 kind）', type: 'rows',
        hint: '⚠️ 全部是项目派生值 —— basis 一栏必须写清从哪条锚点推的',
        rowFields: [
          { key: 'kind', label: '物品类别', type: 'text', hint: '对应 items.yaml 的 kind' },
          { key: 'label', label: '中文名', type: 'text' },
          { key: 'penny', label: '便士', type: 'number', min: 0, max: 999999999 },
          { key: 'basis', label: '依据', type: 'text', multiline: true, hint: '⚠️ 必填 —— 派生值必须能追溯到锚点' },
          { key: 'note', label: '说明', type: 'text', multiline: true, optional: true },
        ],
      },
      {
        key: 'sealLevelPrice', label: '封印物定价（按等级）', type: 'object',
        objectFields: [
          { key: 'basis', label: '依据', type: 'text', multiline: true },
          {
            key: 'prices', label: '等级 → 便士', type: 'object',
            hint: '⚠️ 0 级留空 = 买不到，那是原作设定（封在圣堂地底）',
            objectFields: [
              { key: '0', label: '0 级（买不到）', type: 'number', min: 0, max: 999999999, optional: true },
              { key: '1', label: '1 级', type: 'number', min: 0, max: 999999999, optional: true },
              { key: '2', label: '2 级', type: 'number', min: 0, max: 999999999, optional: true },
              { key: '3', label: '3 级', type: 'number', min: 0, max: 999999999, optional: true },
              { key: 'unrated', label: '未评级', type: 'number', min: 0, max: 999999999, optional: true },
            ],
          },
        ],
      },
      {
        key: 'sequenceMultiplier', label: '序列乘数', type: 'object',
        objectFields: [
          { key: 'factor', label: '倍数', type: 'number', min: 1, max: 99 },
          { key: 'from', label: '从哪一序列起', type: 'number', min: 0, max: 9 },
          { key: 'basis', label: '依据', type: 'text', multiline: true },
          { key: 'note', label: '说明', type: 'text', multiline: true, optional: true },
        ],
      },
    ],
  },
  {
    /*
     * M2.88：**运维节奏** —— 世界什么时候主动说话。
     *
     * 用户的要求是「后台可以设置一个随机的时间范围，从那个时间范围里随机」，
     * 所以这一项**必须**在后台可改：调推送频率不该需要改代码、重新部署（AGENTS §3.3）。
     *
     * ⚠️ 它是**运营参数**，不是原作数据 —— 原作的「世界」没有推送频率这回事。
     * 界面上要标清楚，免得以后有人以为这是从书里抄的。
     */
    id: 'ops-settings', label: '世界节奏（运维）', group: '运营物料',
    file: 'src/data/ops-settings.yaml', rootMode: 'single',
    fields: [
      {
        key: 'world_tick', label: '世界 tick 的随机间隔', type: 'object',
        hint: '⚠️ 项目派生值（运营参数），不是原作数据',
        objectFields: [
          {
            key: 'min_minutes', label: '最短（分钟）', type: 'number', min: 1, max: 1440,
            hint: '太密会刷屏；建议不低于 10',
          },
          {
            key: 'max_minutes', label: '最长（分钟）', type: 'number', min: 1, max: 1440,
            hint: '必须 >= 最短。太疏玩家一晚上什么都碰不到；建议不超过 240',
          },
          { key: 'note', label: '说明', type: 'text', multiline: true, optional: true },
        ],
      },
      {
        key: 'daily_check_minutes', label: '每日结算检查间隔（分钟）', type: 'number', min: 1, max: 1440,
        hint: '这一项不需要随机 —— 它对齐日期，玩家看不见',
      },
    ],
  },
];

export const entityById = (id: string): EntitySpec | undefined => ENTITIES.find((e) => e.id === id);

/**
 * 发给前端的实体元数据。
 *
 * **整份透传，不要手抄白名单。**
 *
 * index.ts 原来手写的是 key/label/type/enumMap/mapKeys/ref/hint/readOnly —— 漏掉了
 * `rowFields` 和 `mapValues`。于是前端拿到的 rows 字段是「一列都没有的空表」、
 * map 字段是「没有选项的空下拉」，而且**哪里都不报错**：页面照常渲染，只是编辑不了，
 * 点「加一行」没有任何反应。手抄的白名单和 schema 一定会漂移（mapKeys 也栽过一次：
 * 在 items.effect 里用了，FieldSpec 上却没声明）。这里原样带过去，以后加字段类型自动跟上。
 *
 * test/admin.test.ts 里有一条测试盯着它。
 */
/**
 * 一组字段里引用到的**其它实体 id**（M2.77）。
 *
 * 前端要拿这些实体的「id + 中文名」做下拉，所以后台的 `/admin/api/data`
 * 必须把它们全列出来。漏一个的后果是**那个下拉是空的**，而且不报错 ——
 * 界面上就是一个没有选项的选择框，保存时读到空值。
 *
 * ⚠️ 必须递归到 `rowFields`（表格列）**和** `objectFields`（嵌套对象）里。
 * 原来这份逻辑写在 index.ts 里、只递归了 rowFields —— 于是「给卡片的 trigger
 * 加一个引用字段」时，那个下拉会是空的。现在把它提到这里，只留一份实现。
 */
export function refTargetsOf(fields: FieldSpec[]): string[] {
  return fields.flatMap((f) => [
    f.ref, f.mapRef, f.itemRef, ...(f.itemRefs ?? []),
    ...refTargetsOf(f.rowFields ?? []),
    ...refTargetsOf(f.objectFields ?? []),
  ].filter((x): x is string => typeof x === 'string'));
}

/**
 * 这个实体的**分类字段**（列表页顶部那排筛选 chips 用它，M2.90）。
 *
 * 判据：字段表里 key 恰好是 kind 的那一个 —— **不手写第二份「哪些实体有分类」的清单**
 * （AGENTS §3.1）：往后加一张带 kind 的内容表，筛选栏自动出现，不用回来改这里。
 * 反过来，把「哪些实体有筛选栏」写死成一个数组，加了新表却忘了登记时**不会报错**，
 * 只会「列表页能翻到 948 条、却没有筛选」。
 *
 * ⚠️ 只认**封闭枚举**（有 enumMap 的那几个）。factions.kind 那种自由文本的值域是开放的，
 * 「一行一个 chip」会变成一屏碎片 —— 那比没有筛选栏更难用。
 */
export function tagFieldOf(spec: EntitySpec): FieldSpec | null {
  const f = spec.fields.find((x) => x.key === 'kind');
  return f !== undefined && f.type === 'enum' && f.enumMap !== undefined ? f : null;
}

/**
 * 发给前端的实体元数据。
 *
 * `canCreate` 是给「＋ 新建」按钮用的：single 模式整份文件就是那一条，
 * 没有「再加一条」这回事 —— **画一个点了没反应的按钮比不画更糟**（M2.51 的教训）。
 */
export interface EntityMeta {
  id: string;
  label: string;
  group: string;
  fields: FieldSpec[];
  /** 记录 id 取自哪个字段（single 模式没有）—— 新建时前端拿它渲染 id 输入框 */
  idKey?: string;
  /** 这一条记录的分类字段 key（列表页筛选栏）—— 没有分类的实体不填 */
  tagKey?: string;
  canCreate: boolean;
}

export const entityMeta = (e: EntitySpec): EntityMeta => {
  const tag = tagFieldOf(e);
  return {
    id: e.id, label: e.label, group: e.group, fields: e.fields,
    ...(e.idKey === undefined ? {} : { idKey: e.idKey }),
    ...(tag === null ? {} : { tagKey: tag.key }),
    canCreate: e.rootMode !== 'single',
  };
};

/** 实体按 group 分组，供左侧分类树用 */
export function groupedEntities(): Array<{ group: string; items: Array<{ id: string; label: string }> }> {
  const map = new Map<string, Array<{ id: string; label: string }>>();
  for (const e of ENTITIES) {
    const list = map.get(e.group) ?? [];
    list.push({ id: e.id, label: e.label });
    map.set(e.group, list);
  }
  return [...map.entries()].map(([group, items]) => ({ group, items }));
}

/**
 * 按字段元数据校验一个值。返回中文错误，null 表示通过。
 *
 * **服务端必须再校验一遍** —— 前端控件只是方便，绕过前端直接打 API 完全可能。
 */
/**
 * 一条文本 / 一个列表项的默认长度上限。
 *
 * 4000 的依据：现在最长的一条内容（卡片正文）约 300 字，失控文本一条几十字 ——
 * 4000 留了**一个数量级**的余量，同时挡住「误粘贴一整篇文档进正文」这种事：
 * 那不会报错，只会在某个玩家身上渲染出一条把群消息撑爆的内容。
 */
export const TEXT_MAX = 4000;

/**
 * 文本与列表项的**形状**约束：长度上限 + 正则。
 *
 * 两条都属于「不查也不会报错、只会在别处表现出来」的那一类：
 * 超长文本把群消息撑爆；标记名拼错一个字符，引用它的条件就永远不成立。
 */
function checkShape(field: FieldSpec, s: string): string | null {
  const max = field.maxLength ?? TEXT_MAX;
  if (s.length > max) {
    return field.label + '太长了：' + s.length + ' 字，上限 ' + max + ' 字';
  }
  if (field.pattern !== undefined && s !== '') {
    let re: RegExp;
    // 元数据自己写错正则时不连累保存 —— 那是代码的问题，不是使用者的
    try { re = new RegExp(field.pattern); } catch { return null; }
    if (!re.test(s)) {
      return field.label + '只能是' + (field.patternHint ?? '符合 ' + field.pattern + ' 的内容') + '：' + s;
    }
  }
  return null;
}

export function validateField(field: FieldSpec, value: unknown): string | null {
  if (value === undefined || value === null) return null;   // 可选字段多，缺就是不改
  switch (field.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return field.label + '必须是数字';
      if (field.min !== undefined && value < field.min) return field.label + '不能小于 ' + field.min;
      if (field.max !== undefined && value > field.max) return field.label + '不能大于 ' + field.max;
      return null;
    case 'bool':
      return typeof value === 'boolean' ? null : field.label + '必须是 true / false';
    case 'text': {
      if (typeof value !== 'string') return field.label + '必须是文本';
      /*
       * 必填文本不许清空：schema 那边写的是 `z.string().min(1)`，
       * 而 `''` **过不了** min(1) —— 存进去的后果是**下一次加载整份文件报错**，
       * 而界面上看到的是「保存成功」（错误只在热重载 / 重启时才冒出来）。
       * 这条与 M2.65 那条「可选字段留空 = 删键」是一对：
       * 可选的两头都通（留空删键），必填的必须当场拦住。
       */
      if (value === '' && field.optional !== true) {
        return field.label + '不能为空（它没有默认值，空着会让整份文件加载失败）';
      }
      return checkShape(field, value);
    }
    case 'enum': {
      if (typeof value !== 'string') return field.label + '必须是文本';
      if (field.enumMap !== undefined && !(value in field.enumMap)) {
        return field.label + '只能是：' + Object.keys(field.enumMap).join(' / ');
      }
      return null;
    }
    case 'strlist':
      /*
       * M2.85：**可选字段的空值要放行** —— 与上面 text 分支同一个口径。
       *
       * 现场：原作材料表里有些材料「没有被任何配方需要」（usedIn 是空数组），
       * 表单读出来是空串，于是「原样存回」被这条挡住 —— 而那份内容本来是合法的。
       * m2-83 的「全部内容原样存回」当场抓到了它。
       */
      /*
       * M2.85：**空值一律放行**。
       *
       * text 分支那边「空串 + 非可选 = 报错」是怕写坏正则之类的单值字段；
       * 而 strlist 在本仓库里**没有一个字段是必填的**（空列表 = 「这项没有」），
       * 表单不提交空值时后端拿到的是 undefined —— 那时再报「必须是字符串列表」，
       * 挡住的其实是一份完全合法、只是这一栏为空的内容（m2-83 的原样存回当场抓到）。
       */
      if (value === '' || value === undefined || value === null) return null;
      if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) {
        return field.label + '必须是字符串列表';
      }
      // 逐项过形状：一条超长的、或者拼错的标记名，单独看是看不出来的
      for (const s of value) {
        const bad = checkShape(field, s);
        if (bad !== null) return bad;
      }
      return null;
    case 'rows': {
      if (!Array.isArray(value)) return field.label + '必须是表格（对象数组）';
      for (let i = 0; i < value.length; i += 1) {
        const row = value[i];
        if (typeof row !== 'object' || row === null || Array.isArray(row)) return field.label + '第 ' + (i + 1) + ' 行不是对象';
        /*
         * 逐格校验。表格里最容易出的错是"数字格留空或填了字"——
         * 那种值写进 yaml 完全合法，但判定层拿到字符串会当场算错，而且不报错。
         */
        for (const col of field.rowFields ?? []) {
          const bad = validateField(col, (row as Record<string, unknown>)[col.key]);
          if (bad !== null) return field.label + '第 ' + (i + 1) + ' 行的' + bad;
        }
      }
      return null;
    }
    case 'map':
      return typeof value === 'object' && !Array.isArray(value) ? null : field.label + '必须是键值对';
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return field.label + '必须是对象';
      }
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const sub = (field.objectFields ?? []).find((c) => c.key === k);
        // 没声明的键写进去，加载期会被 zod 静默剥掉（铁律 9）—— 在这里就拦住
        if (sub === undefined) return field.label + '里没有「' + k + '」这一项';
        const bad = validateField(sub, v);
        if (bad !== null) return bad;
      }
      return null;
    }
    case 'condlist':
      /*
       * 只管**形状** —— 每一条的内容由 data.ts 的 crossCheck 拿真正的解析器验。
       * 分两层是因为解析器在 domain 层，而这一层是纯函数（不认识 domain）。
       */
      return Array.isArray(value) && value.every((x) => typeof x === 'string')
        ? null : field.label + '必须是条件列表';
    case 'maplist': {
      if (!Array.isArray(value)) return field.label + '必须是对象数组';
      for (let i = 0; i < value.length; i += 1) {
        const row = value[i];
        if (typeof row !== 'object' || row === null || Array.isArray(row)) {
          return field.label + '第 ' + (i + 1) + ' 条不是对象';
        }
        for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
          /*
           * 键必须**拼对**。判定层是按名字取这些键的（effect.dig / effect.item），
           * 拼错一个字母不会报错 —— 那条效果就是什么都不做，而卡片看上去完全正常。
           */
          if (field.mapKeys !== undefined && !(k in field.mapKeys)) {
            return field.label + '第 ' + (i + 1) + ' 条的「' + k + '」不是能认的键（只能是：' +
              Object.keys(field.mapKeys).join(' / ') + '）';
          }
          const wantText = (field.textKeys ?? []).includes(k);
          if (wantText ? typeof v !== 'string' : typeof v !== 'number') {
            return field.label + '第 ' + (i + 1) + ' 条的「' + k + '」必须是' + (wantText ? '文本' : '数字');
          }
        }
      }
      return null;
    }
    default:
      return null;
  }
}
