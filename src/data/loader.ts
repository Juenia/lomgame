import { readFileSync } from 'node:fs';
import { PriceTableSchema, type PriceTable } from '../domain/economy/price.ts';
import { ShopTableSchema, type Shop } from '../domain/economy/shop.ts';
import { parseOpsSettings, type OpsSettings } from '../domain/ops/settings.ts';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { parseItem, type ItemDef } from '../domain/item/item.ts';
import { parseLocation, type LocationDef } from '../domain/explore/location.ts';
import { parseRecipe, potionProductId, type RecipeDef } from '../domain/potion/recipe.ts';
import { parseAbility, parseChurchAbility, type AbilityDef, type ChurchAbilityDef } from '../domain/ability/ability.ts';
import { parseCity, parseRegion, parseRoute, type City, type Region, type Route } from '../domain/geo/types.ts';
import { parseFaction } from '../domain/initiation/schema.ts';
import type { GuidedFaction } from '../domain/initiation/types.ts';
import { parseCreatureSpecies } from '../domain/creature/schema.ts';
import type { CreatureSpecies } from '../domain/creature/types.ts';
import { parseRitualsFile, type RitualProfile } from '../domain/ritual/profile.ts';
import { parseAuthoritiesFile, type AuthorityDef } from '../domain/world/authority.ts';
import { parseTarotFile, type TarotCard } from '../domain/divination/tarot.ts';
import { parsePantheonFile, type Deity } from '../domain/world/pantheon.ts';
import { parseOrganizationsFile, type Organization } from '../domain/world/organization.ts';
import { parseFiguresFile, type Figure } from '../domain/world/figure.ts';
import { parseBestiaryFile, type BestiaryEntry } from '../domain/world/bestiary.ts';
import { parseDivineAuthoritiesFile, type DivineAuthority } from '../domain/world/divine-authority.ts';
import { parseAdvancementRitesFile, type AdvancementRite } from '../domain/ritual/advancement-rite.ts';
// M2.99：神座（22 条途径的序列 0 —— 谁在位、谁空着、谁正在被争夺）
import { DivineThroneFileSchema, type DivineThrone } from '../domain/world/divine-throne.ts';
import { parseOriginalMaterialsFile, type OriginalMaterial } from '../domain/world/original-material.ts';
import { parsePathwayAbilitiesFile, type PathwayAbility } from '../domain/world/pathway-ability.ts';
import { NpcTrackSchema, type NpcTrack } from '../domain/world/npc-track.ts';
import { PathwayDeedSchema, type PathwayDeed } from '../domain/world/pathway-deed.ts';
import { NpcDispositionSchema, type NpcDisposition } from '../domain/world/npc-disposition-schema.ts';
import { NpcCastFileSchema, type NpcCast } from '../domain/world/npc-cast.ts';
import { FallenBeastFileSchema, type FallenBeast } from '../domain/world/fallen-beast-schema.ts';
import { DivineRelationFileSchema, type DivineRelation } from '../domain/world/divine-relation.ts';
import { EquipmentSchema, type Equipment } from '../domain/item/equipment.ts';
import { BattleSkillSchema, type BattleSkill } from '../domain/battle/skill-schema.ts';
import { QuestSchema, type Quest } from '../domain/world/quest-schema.ts';
import { FortuneSchema, type Fortune } from '../domain/world/fortune-schema.ts';
import { PATHWAY_LABELS } from '../domain/character/rules.ts';
import { WEATHER_IDS } from '../domain/world/weather.ts';
import { ZoneSchema, type Zone } from '../domain/world/zone.ts';
import { PowerSchema, type Power } from '../domain/world/power.ts';
import { HistoryEventSchema, type HistoryEvent } from '../domain/world/history.ts';
import {
  BoundarySchema,
  ForeignPowerSchema,
  type Boundary,
  type ForeignPower,
} from '../domain/world/boundary.ts';
import { parseChurch, type ChurchDef } from '../domain/church/schema.ts';
import { NUMERIC } from '../config/numeric.ts';
import { OPEN_PATHWAYS } from '../domain/character/rules.ts';
import { checkLinks } from './link-check.ts';

export const DATA_DIR = fileURLToPath(new URL('.', import.meta.url));
export const ITEMS_FILE = join(DATA_DIR, 'items.yaml');
/** M2.56：标签 → 行为短句。玩家每次 .扮演 都会看到它 */
export const TAG_PHRASES_FILE = join(DATA_DIR, 'tag-phrases.yaml');
export const LOCATIONS_FILE = join(DATA_DIR, 'locations.yaml');
export const RECIPES_FILE = join(DATA_DIR, 'recipes.yaml');
export const ABILITIES_FILE = join(DATA_DIR, 'abilities.yaml');
/** M2.7：世界地理三张表（区域 / 城市 / 航线） */
export const REGIONS_FILE = join(DATA_DIR, 'regions.yaml');
export const CITIES_FILE = join(DATA_DIR, 'cities.yaml');
export const ROUTES_FILE = join(DATA_DIR, 'routes.yaml');
/** M2.7.6：本地势力（factions.yaml；M2.85 起决定线索的途径落点） */
export const FACTIONS_FILE = join(DATA_DIR, 'factions.yaml');
/** M2.8：非凡生物物种模板（一处声明，四处生效：地图 / 途径 / 物品 / 行为） */
export const CREATURES_FILE = join(DATA_DIR, 'creatures.yaml');
/** M2.58 阶段二：生态域（地点分组 + 域参数） */
export const ZONES_FILE = join(DATA_DIR, 'zones.yaml');
/** M2.59：文明势力实体（目标 / 资源 / 态度 / 关系） */
export const POWERS_FILE = join(DATA_DIR, 'powers.yaml');
/** M2.61：初始历史（纪元 / 王朝 / 战争 / 灾难 → 生成现在） */
export const HISTORY_FILE = join(DATA_DIR, 'history.yaml');
/** M2.97：神座（22 条途径的序列 0 —— 谁在位、空着、正在被争夺） */
export const DIVINE_THRONES_FILE = join(DATA_DIR, 'divine-thrones.yaml');
/** M2.62：边界输入（港口 / 边境 / 裂隙 + 外部势力） */
export const BOUNDARIES_FILE = join(DATA_DIR, 'boundaries.yaml');
/**
 * M2.76：**晋升仪式档位**（按序列分档：几关、每关多难、要什么前置）。
 *
 * 在这之前仪式只有一套阶段表，参数写死在 NUMERIC.ritual —— 序列 9 与序列 3 做的是同一件事。
 */
export const RITUALS_FILE = join(DATA_DIR, 'rituals.yaml');
/** M2.85 内容填充 P6：晋升仪式要求 132 条（原作数据直出；读取点 `.仪式 准备`） */
export const ADVANCEMENT_RITES_FILE = join(DATA_DIR, 'advancement-rites.yaml');
/** M2.85 内容填充 P4：原作材料全表 1173 条（读取点 `.图鉴 材料`） */
export const ORIGINAL_MATERIALS_FILE = join(DATA_DIR, 'original-materials.yaml');
/** M2.85 内容填充 P5：原作能力清单 2405 条（读取点 `.图鉴 能力`） */
export const PATHWAY_ABILITIES_FILE = join(DATA_DIR, 'pathway-abilities.yaml');
/** M2.85 世界演化第一步：NPC 晋升轨道（读取点 `.图鉴 途径`） */
export const NPC_TRACKS_FILE = join(DATA_DIR, 'npc-tracks.yaml');
/** M2.164 世界居民名册：谁在城里（读取点：场景 / 阴谋池 / 好感 / 生死） */
export const NPC_CAST_FILE = join(DATA_DIR, 'npc-cast.yaml');
/** M2.167 堕落生物：人堕落之后长成什么（读取点：世界 tick 的异变判定） */
export const FALLEN_BEASTS_FILE = join(DATA_DIR, 'fallen-beasts.yaml');
/** M2.169 神与神的关系网：阴谋的依据（读取点：世界 tick 的阴谋发起） */
export const DIVINE_RELATIONS_FILE = join(DATA_DIR, 'divine-relations.yaml');
/*
 * 形态的唯一出处（cards/lost-control.yaml 的 forms 段）。
 *
 * ⚠️ 这里**只读那份文件取 id 集合**，不 import cards 的业务模块 ——
 * 依赖方向是 cards → domain、data → domain，反着引会把两层缠死。
 * 交叉校验要的也只是「这个 formId 存不存在」这一个问题。
 */
const LOST_FORMS_FILE = fileURLToPath(new URL('../../cards/lost-control.yaml', import.meta.url));
/** M2.85 世界演化：**途径行为表**（22 途径 × 2 条） */
export const PATHWAY_DEEDS_FILE = join(DATA_DIR, 'pathway-deeds.yaml');
/** M2.85 RPG 化：NPC 的立场与性情（态度与阴谋读它） */
export const NPC_DISPOSITIONS_FILE = join(DATA_DIR, 'npc-dispositions.yaml');
/** M2.85 RPG 化 B：**装备表**（读取点 .装备 / .装备栏） */
export const EQUIPMENT_FILE = join(DATA_DIR, 'equipment.yaml');
/** M2.85 RPG 化 C：**战斗技能表**（技能池读它） */
export const BATTLE_SKILLS_FILE = join(DATA_DIR, 'battle-skills.yaml');
/** M2.85 RPG 化 D：**委托表**（.委托 读它） */
export const QUESTS_FILE = join(DATA_DIR, 'quests.yaml');
/** M2.85：**奇遇**（.探索 有小概率碰上） */
export const FORTUNES_FILE = join(DATA_DIR, 'fortunes.yaml');
/**
 * M2.76：**权柄**（世界级能力）。
 *
 * 它不是玩家技能表 —— 触发方是 GM 或世界 tick，效果写进 world_overrides（覆盖层）。
 */
export const AUTHORITIES_FILE = join(DATA_DIR, 'authorities.yaml');
/**
 * M2.85 内容填充 P1：塔罗牌（大阿卡那）。
 *
 * 数据源是**原作数据**（三方互证），不是自造；读取点是 `.占卜` 的回执。
 * 与 AUTHORITIES_FILE 一样：它是**纯内容表**，装进 deps 供命令层只读。
 */
export const TAROT_FILE = join(DATA_DIR, 'tarot.yaml');
/** M2.85 内容填充 P1：神明（27 位，原作数据直出；读取点 `.图鉴 神明`） */
export const PANTHEON_FILE = join(DATA_DIR, 'pantheon.yaml');
/** M2.85 内容填充 P1：组织与势力（49 条，原作数据直出；读取点 `.图鉴 组织`） */
export const ORGANIZATIONS_FILE = join(DATA_DIR, 'organizations.yaml');
/** M2.85 内容填充 P1：人物（70 条，原作数据直出；读取点 `.图鉴 人物`） */
export const FIGURES_FILE = join(DATA_DIR, 'figures.yaml');
/** M2.85 内容填充 P1：生物名录（544 条，原作数据直出；读取点 `.图鉴 生物`） */
export const BESTIARY_FILE = join(DATA_DIR, 'bestiary.yaml');
/** 物价锚点与派生定价规则（M2.87）。定义在 `domain/economy/price.ts`，这里只负责读盘。 */
export const PRICES_FILE = join(DATA_DIR, 'prices.yaml');
/** 商店表（M2.87）：一个商店就是一个地点，卖什么写在这里。 */
export const SHOPS_FILE = join(DATA_DIR, 'shops.yaml');
/**
 * M2.88：**运维节奏** —— 世界什么时候主动说话（后面的「随机时间范围」）。
 *
 * 它是一份**运营参数**（不是原作数据）：原作的「世界」没有推送频率这回事。
 * 放 YAML 而不是 numeric.ts 的理由与价格表相同（AGENTS §3.3）：
 * **调推送频率不该需要改代码、重新部署。**
 */
export const OPS_SETTINGS_FILE = join(DATA_DIR, 'ops-settings.yaml');
/** M2.85 内容填充 P1：权柄与象征（95 条，原作数据直出；读取点 `.图鉴 权柄`） */
export const DIVINE_AUTHORITIES_FILE = join(DATA_DIR, 'divine-authorities.yaml');
/**
 * M2.15：正神教会（七正神：途径绑定 / 教义 / 禁忌 / 等级阶梯 / 据点 / 彼此的关系）。
 *
 * ⚠️ 与 FACTIONS_FILE（M2.7.6 的本地势力）是两张不同的表，名字像、概念不同。
 */
export const CHURCHES_FILE = join(DATA_DIR, 'churches.yaml');
/**
 * M2.17：教会技能（达到教内档位解锁的第二层能力）。
 *
 * ⚠️ 与 ABILITIES_FILE 分开是有意的：那一份是**途径能力**（钥匙 = pathway + seq），
 * 这一份是**教会技能**（钥匙 = churchId + rank）。合成一张表就得允许
 * 「pathway 为空」这第三种状态，而没有任何内容需要它。
 */
export const CHURCH_ABILITIES_FILE = join(DATA_DIR, 'church-abilities.yaml');

/**
 * M2.7.7：已知的配方材料地理缺口（详见 loadContent 里那段校验的注释）。
 *
 * 这一份是**已知账**，不是白名单：里面每一条都在报告里点了名，
 * 而且都对应一个「需要改内容才能修」的待办。新增缺口一律 error。
 */
export const KNOWN_MATERIAL_GAPS: readonly string[] = [
  // M2.8 前置 2：已清空。
  // 原来这里有两行（pritz / byron 的「辅助材料·月长石粉」）——
  // 那两座城市的本地产出点是断崖灯塔 / 疫病营地，都是 min_seq 8，普通人去不了，
  // 于是本地的不眠者玩家从拿到配方那天起就注定走不完（M2.7.7 长窗口实测 55/200 卡在这一条）。
  // 修法是不新增地点，只在既有的 min_seq 9 地点加掉落：
  //   pritz  → 潮汐码头（pritz_harbor）
  //   byron  → 骨市（bone_market）
  // 常量本身保留为空数组，作为「以后再出现缺口时往这里记账」的挂点。
];

export interface DataIssue {
  file: string;
  level: 'error' | 'warn';
  message: string;
}

function readYaml(file: string): unknown {
  return parseYaml(readFileSync(file, 'utf8'));
}

export interface TagPhraseBundle {
  /** 途径 → 标签 → 那句行为短句 */
  table: Record<string, Record<string, string>>;
  issues: DataIssue[];
}

/**
 * 标签文案表（M2.56）。
 *
 * ## 为什么这里有一条**硬校验**
 *
 * 判定层（domain/play/score.ts）算消化度用的是**关键词包含匹配**：玩家扮演时说的
 * 那句话里出现了哪个标签词，就按那个标签算分。所以文案里没有「占卜」两个字，
 * 玩家选了这一条**不会涨消化度** —— 菜单就成了骗人的。
 *
 * 而这**不会报任何错**：没有异常、没有日志、测试也不会红（那条测试原来盯的是
 * 代码里的常量，一旦搬进内容表就管不到了）。运营把「摊开牌占卜一件还没发生的事」
 * 改成「看看牌」，那个玩法就静默失效，谁都不知道为什么。
 *
 * 所以把这条规则**从测试搬到这里**：文案不含自己的标签词 ⇒ error ⇒ 服务起不来
 * （与 K17「内容层的错不该等到跑批才发现」同一口径）。
 * 编辑时当场拦住，比事后追查便宜一百倍。
 */
export function loadTagPhrases(file: string = TAG_PHRASES_FILE): TagPhraseBundle {
  const issues: DataIssue[] = [];
  const raw = readYaml(file) as { phrases?: unknown[] } | null;
  const table: Record<string, Record<string, string>> = {};

  for (const entry of raw?.phrases ?? []) {
    const row = entry as { pathway?: unknown; tag?: unknown; text?: unknown };
    const pathway = typeof row.pathway === 'string' ? row.pathway : '';
    const tag = typeof row.tag === 'string' ? row.tag : '';
    const text = typeof row.text === 'string' ? row.text : '';

    if (pathway === '' || tag === '') {
      issues.push({ file, level: 'error', message: '有一条缺 pathway 或 tag：' + JSON.stringify(entry) });
      continue;
    }
    if (text.trim() === '') {
      issues.push({ file, level: 'error', message: pathway + '.' + tag + ' 的文案是空的' });
      continue;
    }
    if (!text.includes(tag)) {
      issues.push({
        file,
        level: 'error',
        message:
          pathway + '.' + tag + ' 的文案里没有「' + tag + '」两个字 —— 判定层按关键词匹配，' +
          '玩家选了这条不会涨消化度，菜单等于在骗人。现在写的是：' + text,
      });
      continue;
    }

    const own = table[pathway] ?? {};
    if (own[tag] !== undefined) {
      // 同一途径下标签重复：后一条会静默盖掉前一条，那种错没人查得出来
      issues.push({ file, level: 'error', message: pathway + ' 下的「' + tag + '」出现了两次' });
      continue;
    }
    own[tag] = text;
    table[pathway] = own;
  }

  if (Object.keys(table).length === 0) {
    issues.push({ file, level: 'error', message: '扮演文案表是空的 —— 检查 phrases 这一层' });
  }
  return { table, issues };
}

export function loadItems(file: string = ITEMS_FILE): { items: ItemDef[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  const raw = readYaml(file) as { items?: unknown[] } | null;
  const items: ItemDef[] = [];
  for (const entry of raw?.items ?? []) {
    const parsed = parseItem(entry);
    if (!parsed.ok) {
      for (const issue of parsed.issues) issues.push({ file, level: 'error', message: issue });
      continue;
    }
    items.push(parsed.item);
  }
  /*
   * M2.31（P16 落地）：**变体展开**。
   *
   * 这是变体的**唯一读取点** —— 展开之后它们就是普通的 `ItemDef`，
   * `inventory` / `trade` / `battle` / 任何 `itemById` 的调用方**一行都不用改**。
   *
   * 代价是「变体」这个概念只存在于**加载期**：落库与读库看到的都是复合 id。
   * 这正是我们要的 —— 库存表的主键本来就是字符串（`0003_w3.sql:18`），零迁移。
   */
  for (const item of [...items]) {
    for (const variant of item.variants ?? []) {
      items.push({
        ...item,
        id: item.id + '#' + variant.id,
        name: variant.name,
        baseId: item.id,
        variants: [],
        ...(variant.note ? { note: variant.note } : {}),
      });
    }
  }
  /*
   * 交叉校验：变体不能指向不存在的原物品（展开是「原物品 → 变体」，所以这一条其实是自洽的；
   * 但 `baseId` 会被下游当「逆查」用 ⇒ 必须能在 items 里找到它）。
   */
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of items) {
    if (item.baseId && !byId.has(item.baseId)) {
      issues.push({ file, level: 'error', message: `${item.id}: baseId 指向不存在的物品 ${item.baseId}` });
    }
  }
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) issues.push({ file, level: 'error', message: `物品 id 重复：${item.id}` });
    seen.add(item.id);
  }
  return { items, issues };
}

export function loadLocations(file: string = LOCATIONS_FILE): { locations: LocationDef[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  const raw = readYaml(file) as { locations?: unknown[] } | null;
  const locations: LocationDef[] = [];
  for (const entry of raw?.locations ?? []) {
    const parsed = parseLocation(entry);
    if (!parsed.ok) {
      for (const issue of parsed.issues) issues.push({ file, level: 'error', message: issue });
      continue;
    }
    locations.push(parsed.location);
  }
  const seen = new Set<string>();
  for (const location of locations) {
    if (seen.has(location.id)) issues.push({ file, level: 'error', message: `地点 id 重复：${location.id}` });
    seen.add(location.id);
  }
  return { locations, issues };
}

export function loadRecipes(file: string = RECIPES_FILE): { recipes: RecipeDef[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  const raw = readYaml(file) as { recipes?: unknown[] } | null;
  const recipes: RecipeDef[] = [];
  for (const entry of raw?.recipes ?? []) {
    const parsed = parseRecipe(entry);
    if (!parsed.ok) {
      for (const issue of parsed.issues) issues.push({ file, level: 'error', message: issue });
      continue;
    }
    recipes.push(parsed.recipe);
  }
  const seen = new Set<string>();
  for (const recipe of recipes) {
    if (seen.has(recipe.id)) issues.push({ file, level: 'error', message: `配方 id 重复：${recipe.id}` });
    seen.add(recipe.id);
  }
  return { recipes, issues };
}

export function loadAbilities(file: string = ABILITIES_FILE): { abilities: AbilityDef[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  const raw = readYaml(file) as { abilities?: unknown[] } | null;
  const abilities: AbilityDef[] = [];
  for (const entry of raw?.abilities ?? []) {
    const parsed = parseAbility(entry);
    if (!parsed.ok) {
      for (const issue of parsed.issues) issues.push({ file, level: 'error', message: issue });
      continue;
    }
    abilities.push(parsed.ability);
  }

  const seen = new Set<string>();
  for (const ability of abilities) {
    if (seen.has(ability.id)) issues.push({ file, level: 'error', message: `能力 id 重复：${ability.id}` });
    seen.add(ability.id);
    if (Object.keys(ability.effect).length === 0) {
      issues.push({ file, level: 'error', message: `${ability.id}: 效果为空，等于没解锁` });
    }
  }

  // 每个途径的序列 8 必须有能力（W4 内容指标）；M2.19 起 sailor 也在这份清单里 ——
  // 它是「已实现的途径都要有序列 8 能力」这条不变量的落点，漏一个就是新途径的玩家升到 8 什么也不给
  // M2.26 第一批：加 perfect（
    // 「已实现的途径都要有序列 8 能力」这条不变量的落点）
    for (const pathway of ['seer', 'warrior', 'sleepless', 'sailor', 'perfect', 'reader', 'mother'] as const) {
    if (!abilities.some((ability) => ability.pathway === pathway && ability.seq === 8)) {
      issues.push({ file, level: 'error', message: `${pathway} 缺少序列 8 能力` });
    }
  }

  return { abilities, issues };
}

/* ---------------- M2.7：世界地理三张表 ---------------- */

export function loadRegions(file: string = REGIONS_FILE): { regions: Region[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  const raw = readYaml(file) as { regions?: unknown[] } | null;
  const regions: Region[] = [];
  for (const entry of raw?.regions ?? []) {
    const parsed = parseRegion(entry);
    if (!parsed.ok) {
      for (const issue of parsed.issues) issues.push({ file, level: 'error', message: issue });
      continue;
    }
    regions.push(parsed.region);
  }
  const seen = new Set<string>();
  for (const region of regions) {
    if (seen.has(region.id)) issues.push({ file, level: 'error', message: `区域 id 重复：${region.id}` });
    seen.add(region.id);
  }
  return { regions, issues };
}

export function loadCities(file: string = CITIES_FILE): { cities: City[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  const raw = readYaml(file) as { cities?: unknown[] } | null;
  const cities: City[] = [];
  for (const entry of raw?.cities ?? []) {
    const parsed = parseCity(entry);
    if (!parsed.ok) {
      for (const issue of parsed.issues) issues.push({ file, level: 'error', message: issue });
      continue;
    }
    cities.push(parsed.city);
  }
  const seen = new Set<string>();
  for (const city of cities) {
    if (seen.has(city.id)) issues.push({ file, level: 'error', message: `城市 id 重复：${city.id}` });
    seen.add(city.id);
    // 城市必须有地点，且城区必须在自己名下 —— 否则玩家会在一个"空城"里出生
    if (city.locations.length === 0) {
      issues.push({ file, level: 'error', message: `${city.id}: 城市没有地点` });
    }
    if (!city.locations.includes(city.center)) {
      issues.push({
        file,
        level: 'error',
        message: `${city.id}: center（${city.center}）不在自己的 locations 里`,
      });
    }
    // 途径必须非空（除非出生权重为 0：那样的城市只能被"到达"，不承担出生）
    if (city.pathways.length === 0 && city.birth_weight > 0) {
      issues.push({ file, level: 'error', message: `${city.id}: 作为出生城市却没有开放途径` });
    }
  }
  const weightSum = cities.reduce((sum, city) => sum + city.birth_weight, 0);
  if (weightSum <= 0) {
    issues.push({ file, level: 'error', message: '所有城市的出生权重都是 0，没人能出生' });
  }
  return { cities, issues };
}

/**
 * 本地势力内容表（M2.7.6；M2.85 起服务于线索的途径落点）。
 *
 * 与地理三表一个口径：**内容不是真相的运行时副本**，启动时读一次即可 ——
 * M2.85：原 pathway_offers（引导邀约）运行时表已随引导玩法删除。
 */
export function loadFactions(file: string = FACTIONS_FILE): { factions: GuidedFaction[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  const raw = readYaml(file) as { factions?: unknown[] } | null;
  const factions: GuidedFaction[] = [];
  for (const entry of raw?.factions ?? []) {
    const parsed = parseFaction(entry);
    if (!parsed.ok) {
      for (const issue of parsed.issues) issues.push({ file, level: 'error', message: issue });
      continue;
    }
    factions.push(parsed.faction);
  }
  const seen = new Set<string>();
  for (const faction of factions) {
    if (seen.has(faction.id)) issues.push({ file, level: 'error', message: `势力 id 重复：${faction.id}` });
    seen.add(faction.id);
  }
  return { factions, issues };
}

/**
 * 非凡生物物种模板（M2.8）。
 *
 * 与地理三表 / 势力表一个口径：**内容不是真相的运行时副本**，启动时读一次即可 ——
 * 生物**实例**（那只饿了两天的低语者在哪）才是运行时状态，那在 creatures 表里。
 */
export function loadCreatures(
  file: string = CREATURES_FILE,
): { creatures: CreatureSpecies[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  const raw = readYaml(file) as { creatures?: unknown[] } | null;
  const creatures: CreatureSpecies[] = [];
  for (const entry of raw?.creatures ?? []) {
    const parsed = parseCreatureSpecies(entry);
    if (!parsed.ok) {
      for (const issue of parsed.issues) issues.push({ file, level: 'error', message: issue });
      continue;
    }
    creatures.push(parsed.species);
  }
  const seen = new Set<string>();
  for (const species of creatures) {
    if (seen.has(species.id)) issues.push({ file, level: 'error', message: `物种 id 重复：${species.id}` });
    seen.add(species.id);
  }
  if (creatures.length === 0) {
    issues.push({ file, level: 'error', message: '一个物种都没有：世界里不会有任何生物' });
  }
  return { creatures, issues };
}

/**
 * 生态域（M2.58 阶段二）。
 *
 * 三件事在**启动时**校验，不留给运行期：
 *   1. 域 id 不重复；
 *   2. `locations` 里的地点在 locations.yaml 里真实存在 ——
 *      写错一个 id = 那个地点永远不会进入这个域，而它的症状只是
 *      「那个地方好像没什么特别的」，没人会去查；
 *   3. 一个地点只属于一个域 —— 重复登记时判定取哪一个就成了实现细节，
 *      而这种事不该由「代码里先出现的那个赢」来决定。
 *
 * `locationIds` 可选：只想单独读域表时可以不传（跳过第 2 条）。
 */
export function loadZones(
  file: string = ZONES_FILE,
  locationIds?: ReadonlySet<string>,
): { zones: Zone[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  const zones: Zone[] = [];
  /*
   * 读不到文件**不是异常，是一种正常状态**：
   * 生态域是可选内容，删掉 zones.yaml 就该回到「所有地点用全局基线」，
   * 而不是让整个服务起不来。所以要报一条 warn（可查），而不是抛。
   * 与 M2.35 同一条纪律：内容缺失要**说出来**，不能静默 ——
   * 静默的话「域表根本没被读到」与「域表是空的」在报告里长得一模一样。
   */
  let raw: { zones?: unknown[] } | null = null;
  try {
    raw = readYaml(file) as { zones?: unknown[] } | null;
  } catch (error) {
    issues.push({
      file,
      level: 'warn',
      message: '读不到生态域表（' + (error as Error).message + '）：所有地点落回全局基线（与加生态域之前相同）',
    });
    return { zones, issues };
  }
  if (raw === null || !Array.isArray(raw.zones)) {
    issues.push({ file, level: 'warn', message: '没有 zones 段：所有地点落回全局基线（与加生态域之前相同）' });
    return { zones, issues };
  }
  const seenZone = new Set<string>();
  const ownerOf = new Map<string, string>();
  for (const entry of raw.zones) {
    const parsed = ZoneSchema.safeParse(entry);
    if (!parsed.success) {
      const where = (entry as { id?: string } | null)?.id ?? '<无 id>';
      const detail = parsed.error.issues
        .map((issue) => (issue.path.join('.') || '<root>') + ': ' + issue.message)
        .join('; ');
      issues.push({ file, level: 'error', message: '域 ' + where + ' — ' + detail });
      continue;
    }
    const zone = parsed.data as Zone;
    if (seenZone.has(zone.id)) {
      issues.push({ file, level: 'error', message: '域 id 重复：' + zone.id });
      continue;
    }
    seenZone.add(zone.id);
    for (const locationId of zone.locations) {
      if (locationIds !== undefined && !locationIds.has(locationId)) {
        issues.push({
          file,
          level: 'error',
          message: '域 ' + zone.id + ': 引用了未登记的地点 ' + locationId + '（它永远不会进入这个域）',
        });
      }
      const owner = ownerOf.get(locationId);
      if (owner !== undefined) {
        issues.push({
          file,
          level: 'error',
          message: '地点 ' + locationId + ' 同时被两个域登记：' + owner + ' 与 ' + zone.id,
        });
        continue;
      }
      ownerOf.set(locationId, zone.id);
    }
    zones.push(zone);
  }
  return { zones, issues };
}

/**
 * 文明势力实体（M2.59）。
 *
 * 四件事在**启动时**校验：
 *   1. 势力 id 不重复；
 *   2. `relations.to` 指向真实存在的势力 ——
 *      指向不存在的 id 等于那条关系永远不生效，而症状只是「外交上少了一条线」；
 *   3. 关系不能指向自己（「我与我是盟友」没有意义，而它会让关系图出现自环）；
 *   4. `home_region` 指向真实存在的区域（regions.yaml）——
 *      写错 = 这家势力永远不会在任何一个区域算主场。
 *
 * `regionIds` 可选：只想单独读势力表时可以不传（跳过第 4 条）。
 */
export function loadPowers(
  file: string = POWERS_FILE,
  regionIds?: ReadonlySet<string>,
): { powers: Power[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  const powers: Power[] = [];
  /*
   * 读不到文件**不是异常，是一种正常状态**（与 loadZones 同一条口径）：
   * 势力表是可删的内容 —— 删掉它就回到「世界出了事没有人动」，
   * 而不是让整个服务起不来。报一条 warn（可查），不抛。
   */
  let raw: { powers?: unknown[] } | null = null;
  try {
    raw = readYaml(file) as { powers?: unknown[] } | null;
  } catch (error) {
    issues.push({
      file,
      level: 'warn',
      message: '读不到势力表（' + (error as Error).message + '）：世界事件里不会有势力反应',
    });
    return { powers, issues };
  }
  if (raw === null || !Array.isArray(raw.powers)) {
    issues.push({ file, level: 'warn', message: '没有 powers 段：世界事件里的势力反应不会发生' });
    return { powers, issues };
  }
  const seen = new Set<string>();
  for (const entry of raw.powers) {
    const parsed = PowerSchema.safeParse(entry);
    if (!parsed.success) {
      const where = (entry as { id?: string } | null)?.id ?? '<无 id>';
      const detail = parsed.error.issues
        .map((issue) => (issue.path.join('.') || '<root>') + ': ' + issue.message)
        .join('; ');
      issues.push({ file, level: 'error', message: '势力 ' + where + ' — ' + detail });
      continue;
    }
    const power = parsed.data as Power;
    if (seen.has(power.id)) {
      issues.push({ file, level: 'error', message: '势力 id 重复：' + power.id });
      continue;
    }
    seen.add(power.id);
    powers.push(power);
  }
  // 关系与区域的交叉校验要等全部 id 收齐（与生态域的重复登记校验同一个手法）
  const ids = new Set(powers.map((power) => power.id));
  for (const power of powers) {
    if (regionIds !== undefined && power.home_region !== '' && !regionIds.has(power.home_region)) {
      issues.push({
        file,
        level: 'error',
        message: '势力 ' + power.id + ': home_region 引用了未登记的区域 ' + power.home_region + '（它永远不会在任何区域算主场）',
      });
    }
    for (const relation of power.relations) {
      if (relation.to === power.id) {
        issues.push({ file, level: 'error', message: '势力 ' + power.id + ' 与自己建立了关系（' + relation.kind + '）' });
        continue;
      }
      if (!ids.has(relation.to)) {
        issues.push({
          file,
          level: 'error',
          message: '势力 ' + power.id + ' 的关系指向未登记的势力 ' + relation.to + '（这条关系永远不会生效）',
        });
      }
    }
  }
  return { powers, issues };
}

/**
 * 初始历史（M2.61）。
 *
 * 校验的分量比别的表重，因为这四条后果**每一条都会改世界**：
 *   power_relations 的势力 id、location_scars / sealed 的地点 id、
 *   taboo_knowledge 的 scope（区域或地点）与 holder（势力）。
 * 写错一个字母的后果是「那条历史不影响任何东西」，
 * 而症状只是「这个世界的过去好像薄了一点」—— 没人会去查。
 *
 * 另加一条**自引用**校验：势力不能跟自己结仇（那会让关系图出现自环）。
 */
export function loadHistory(
  file: string = HISTORY_FILE,
  ids: {
    powers?: ReadonlySet<string>;
    locations?: ReadonlySet<string>;
    regions?: ReadonlySet<string>;
  } = {},
): { history: HistoryEvent[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  const history: HistoryEvent[] = [];
  /*
   * 读不到文件不是异常（与 loadZones / loadPowers 同一条口径）：
   * 历史表可删 —— 删掉就回到「世界没有过去」，而不是让服务起不来。
   */
  let raw: { history?: unknown[] } | null = null;
  try {
    raw = readYaml(file) as { history?: unknown[] } | null;
  } catch (error) {
    issues.push({
      file,
      level: 'warn',
      message: '读不到历史表（' + (error as Error).message + '）：世界不会有过去',
    });
    return { history, issues };
  }
  if (raw === null || !Array.isArray(raw.history)) {
    issues.push({ file, level: 'warn', message: '没有 history 段：世界不会有过去' });
    return { history, issues };
  }
  const seen = new Set<string>();
  for (const entry of raw.history) {
    const parsed = HistoryEventSchema.safeParse(entry);
    if (!parsed.success) {
      const where = (entry as { id?: string } | null)?.id ?? '<无 id>';
      const detail = parsed.error.issues
        .map((issue) => (issue.path.join('.') || '<root>') + ': ' + issue.message)
        .join('; ');
      issues.push({ file, level: 'error', message: '历史 ' + where + ' — ' + detail });
      continue;
    }
    const event = parsed.data as HistoryEvent;
    if (seen.has(event.id)) {
      issues.push({ file, level: 'error', message: '历史事件 id 重复：' + event.id });
      continue;
    }
    seen.add(event.id);
    history.push(event);
  }
  const checkPower = (id: string, where: string): void => {
    if (ids.powers === undefined || ids.powers.has(id)) return;
    issues.push({ file, level: 'error', message: where + ' 引用了未登记的势力 ' + id });
  };
  const checkLocation = (id: string, where: string): void => {
    if (ids.locations === undefined || ids.locations.has(id)) return;
    issues.push({ file, level: 'error', message: where + ' 引用了未登记的地点 ' + id });
  };
  for (const event of history) {
    for (const id of event.parties) checkPower(id, '历史 ' + event.id + '.parties');
    for (const id of event.locations) checkLocation(id, '历史 ' + event.id + '.locations');
    for (const relation of event.effects.power_relations) {
      checkPower(relation.from, '历史 ' + event.id + '.power_relations.from');
      checkPower(relation.to, '历史 ' + event.id + '.power_relations.to');
      if (relation.from === relation.to) {
        issues.push({ file, level: 'error', message: '历史 ' + event.id + ': 势力与自己建立了关系（' + relation.from + '）' });
      }
    }
    for (const scar of event.effects.location_scars) {
      checkLocation(scar.location, '历史 ' + event.id + '.location_scars');
    }
    for (const item of event.effects.sealed) {
      checkLocation(item.location, '历史 ' + event.id + '.sealed');
    }
    for (const item of event.effects.taboo_knowledge) {
      const okScope =
        (ids.regions !== undefined && ids.regions.has(item.scope)) ||
        (ids.locations !== undefined && ids.locations.has(item.scope));
      if (!okScope && ids.regions !== undefined && ids.locations !== undefined) {
        issues.push({
          file,
          level: 'error',
          message: '历史 ' + event.id + '.taboo_knowledge.scope 既不是区域也不是地点：' + item.scope,
        });
      }
      checkPower(item.holder, '历史 ' + event.id + '.taboo_knowledge.holder');
    }
  }
  return { history, issues };
}

/**
 * 边界与外部势力（M2.62）。
 *
 * 三件事在启动时校验：
 *   1. 边界 id 与外部势力 id 都不重复；
 *   2. 边界的 `location` 是真实地点 —— 写错 = 那条边界永远不会被触发；
 *   3. `foreign_power` 指向真实的外部势力，`from_region` 指向真实区域。
 *
 * 另加一条**一个地点只能是一条边界**：同一个地点挂两条边界会让
 * 「这里的张力是多少」有两个答案，而那种事不该由实现的先后决定。
 */
export function loadBoundaries(
  file: string = BOUNDARIES_FILE,
  ids: { locations?: ReadonlySet<string>; regions?: ReadonlySet<string> } = {},
): { boundaries: Boundary[]; foreignPowers: ForeignPower[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  const boundaries: Boundary[] = [];
  const foreignPowers: ForeignPower[] = [];
  let raw: { boundaries?: unknown[]; foreign_powers?: unknown[] } | null = null;
  try {
    raw = readYaml(file) as { boundaries?: unknown[]; foreign_powers?: unknown[] } | null;
  } catch (error) {
    issues.push({
      file,
      level: 'warn',
      message: '读不到边界表（' + (error as Error).message + '）：世界不会有外面',
    });
    return { boundaries, foreignPowers, issues };
  }
  if (raw === null) {
    issues.push({ file, level: 'warn', message: '没有 boundary 段：世界不会有外面' });
    return { boundaries, foreignPowers, issues };
  }
  const seenPower = new Set<string>();
  for (const entry of raw.foreign_powers ?? []) {
    const parsed = ForeignPowerSchema.safeParse(entry);
    if (!parsed.success) {
      const where = (entry as { id?: string } | null)?.id ?? '<无 id>';
      issues.push({
        file,
        level: 'error',
        message:
          '外部势力 ' + where + ' — ' +
          parsed.error.issues.map((issue) => issue.path.join('.') + ': ' + issue.message).join('; '),
      });
      continue;
    }
    const power = parsed.data as ForeignPower;
    if (seenPower.has(power.id)) {
      issues.push({ file, level: 'error', message: '外部势力 id 重复：' + power.id });
      continue;
    }
    if (power.from_region !== '' && ids.regions !== undefined && !ids.regions.has(power.from_region)) {
      issues.push({
        file,
        level: 'error',
        message: '外部势力 ' + power.id + ': from_region 引用了未登记的区域 ' + power.from_region,
      });
    }
    seenPower.add(power.id);
    foreignPowers.push(power);
  }
  const ownerOf = new Map<string, string>();
  const seenBoundary = new Set<string>();
  for (const entry of raw.boundaries ?? []) {
    const parsed = BoundarySchema.safeParse(entry);
    if (!parsed.success) {
      const where = (entry as { id?: string } | null)?.id ?? '<无 id>';
      issues.push({
        file,
        level: 'error',
        message:
          '边界 ' + where + ' — ' +
          parsed.error.issues.map((issue) => issue.path.join('.') + ': ' + issue.message).join('; '),
      });
      continue;
    }
    const boundary = parsed.data as Boundary;
    if (seenBoundary.has(boundary.id)) {
      issues.push({ file, level: 'error', message: '边界 id 重复：' + boundary.id });
      continue;
    }
    seenBoundary.add(boundary.id);
    if (ids.locations !== undefined && !ids.locations.has(boundary.location)) {
      issues.push({
        file,
        level: 'error',
        message: '边界 ' + boundary.id + ': 引用了未登记的地点 ' + boundary.location + '（它永远不会被触发）',
      });
    }
    if (!seenPower.has(boundary.foreign_power)) {
      issues.push({
        file,
        level: 'error',
        message: '边界 ' + boundary.id + ': 对面的外部势力未登记 ' + boundary.foreign_power,
      });
    }
    const owner = ownerOf.get(boundary.location);
    if (owner !== undefined) {
      issues.push({
        file,
        level: 'error',
        message: '地点 ' + boundary.location + ' 同时是两条边界：' + owner + ' 与 ' + boundary.id,
      });
      continue;
    }
    ownerOf.set(boundary.location, boundary.id);
    boundaries.push(boundary);
  }
  return { boundaries, foreignPowers, issues };
}

/**
 * 正神教会内容表（M2.15）。
 *
 * 与地理三表 / 势力表一个口径：**内容不是真相的运行时副本**，启动时读一次即可。
 * ⚠️ 而且它**不落库**（本轮不新增迁移）：教会本身不随世界演化 ——
 * 会随世界演化的那一半（据点的扩张与收缩）是 `src/domain/church/territory.ts` 的纯函数，
 * 每一次调用现场算（与灾厄同一手法，见 docs/M2.15-交付说明.md）。
 */
export function loadChurches(file: string = CHURCHES_FILE): { churches: ChurchDef[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  const raw = readYaml(file) as { churches?: unknown[] } | null;
  const churches: ChurchDef[] = [];
  for (const entry of raw?.churches ?? []) {
    const parsed = parseChurch(entry);
    if (!parsed.ok) {
      /*
       * 报错信息带上 id（借用原始 entry 的 id 字段）。
       * 与 loadFactions 的差别就在这里：zod 的 issue path 是 `taboos.0` 这种相对路径，
       * 一张七家教会的表里没有 id 前缀就定位不到是**哪一家**写错了。
       */
      const rawId = (entry as { id?: unknown } | null)?.id;
      const prefix = typeof rawId === 'string' && rawId.length > 0 ? `${rawId}: ` : '';
      for (const issue of parsed.issues) issues.push({ file, level: 'error', message: prefix + issue });
      continue;
    }
    churches.push(parsed.church);
  }
  const seen = new Set<string>();
  for (const church of churches) {
    if (seen.has(church.id)) issues.push({ file, level: 'error', message: `教会 id 重复：${church.id}` });
    seen.add(church.id);
  }
  if (churches.length === 0) {
    issues.push({ file, level: 'error', message: '一家教会都没有：正神教会的骨架是空的' });
  }
  return { churches, issues };
}

/**
 * M2.17：教会技能表（church-abilities.yaml）。
 *
 * 与 loadAbilities 一个口径：逐条 zod 解析 + id 唯一 + 效果非空。
 * 跨表的那一半（churchId 是不是登记过的教会、rank 有没有超出档位数）
 * 在 validateChurchAbilities 里 —— 与 loadChurches / validateChurches 同一个分工。
 */
export function loadChurchAbilities(
  file: string = CHURCH_ABILITIES_FILE,
): { abilities: ChurchAbilityDef[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  const raw = readYaml(file) as { churchAbilities?: unknown[] } | null;
  const abilities: ChurchAbilityDef[] = [];
  for (const entry of raw?.churchAbilities ?? []) {
    const parsed = parseChurchAbility(entry);
    if (!parsed.ok) {
      const rawId = (entry as { id?: unknown } | null)?.id;
      const prefix = typeof rawId === 'string' && rawId.length > 0 ? `${rawId}: ` : '';
      for (const issue of parsed.issues) issues.push({ file, level: 'error', message: prefix + issue });
      continue;
    }
    abilities.push(parsed.ability);
  }
  const seen = new Set<string>();
  for (const ability of abilities) {
    if (seen.has(ability.id)) issues.push({ file, level: 'error', message: `教会技能 id 重复：${ability.id}` });
    seen.add(ability.id);
  }
  return { abilities, issues };
}

/**
 * M2.17：教会技能的交叉校验。
 *
 * 三条判据，都是「这一层自己能查、但要看另一张表」的东西：
 *   1. churchId 必须是登记过的教会（写错 id 的症状是「技能永远解锁不了」，不报错就查不出来）；
 *   2. rank 不能超出档位数（NUMERIC.church.ranks 的长度，与 churches.yaml 的 ranks 等长，loader 另一处守着）；
 *   3. 途径还没实现的教会**只 warn** —— 内容可以先写，但没有玩家能解锁它。
 */
export function validateChurchAbilities(
  abilities: readonly ChurchAbilityDef[],
  churches: readonly ChurchDef[],
): DataIssue[] {
  const issues: DataIssue[] = [];
  const churchById = new Map(churches.map((church) => [church.id, church]));
  const rankCount = NUMERIC.church.ranks.contributionThreshold.length;
  for (const ability of abilities) {
    const church = churchById.get(ability.churchId);
    if (!church) {
      issues.push({
        file: CHURCH_ABILITIES_FILE,
        level: 'error',
        message: `${ability.id}: churchId=${ability.churchId} 不是登记过的教会`,
      });
      continue;
    }
    if (ability.rank >= rankCount) {
      issues.push({
        file: CHURCH_ABILITIES_FILE,
        level: 'error',
        message: `${ability.id}: rank=${ability.rank} 超出了档位数（${rankCount} 档，索引 0—${rankCount - 1}）`,
      });
    }
    if (church.pathway === null) {
      issues.push({
        file: CHURCH_ABILITIES_FILE,
        level: 'warn',
        message: `${ability.id}: ${church.id} 的途径还没实现，没有玩家能解锁这条技能`,
      });
    }
    if (Object.keys(ability.effect).length === 0) {
      issues.push({ file: CHURCH_ABILITIES_FILE, level: 'error', message: `${ability.id}: 效果为空，等于没解锁` });
    }
  }
  return issues;
}

/**
 * 正神教会的交叉校验（M2.15）。
 *
 * 为什么从 `loadContent` 里抽出来成一个导出的纯函数：
 * 这一段校验的价值有一半在「能不能挡住坏内容」，而内联在 `loadContent` 里的校验
 * **只能用真实内容表验证好的那一半** —— 谁也造不出一份「城市 id 写错的 churches.yaml」
 * 喂给它。抽出来之后，负例（写错途径 / 据点 / 关系 / type）可以直接构造数据单测
 * （见 test/m2-15.test.ts）。
 *
 * 四类校验各自的症状都写在下面每一条的注释里。它们的共同点是**运行期一声不响**：
 * 只表现为「那个人一直没入教」或者「关系莫名其妙是中立的」。
 */
export function validateChurches(
  churches: readonly ChurchDef[],
  cities: readonly City[],
  /** M2.17：判据里的 location 要指向真实存在的地点 */
  locations: readonly LocationDef[] = [],
): DataIssue[] {
  const issues: DataIssue[] = [];
  // 两张查表在函数内现建：这个函数要能脱离 loadContent 单独调用（负例测试就是这么用的）
  const cityIds = new Set(cities.map((city) => city.id));
  const cityById = new Map(cities.map((city) => [city.id, city]));
  /*
   * 教会表写错一个 id 的后果和本地势力是同一类：**运行期一声不响**。
   * 绑错途径 → 玩家入了教却拿到不相干的加成；据点写错城市 → 那座城市永远没有堂口；
   * relations 里写错一家 → 关系查询静默退化成「中立」。
   * 所以四类交叉引用全部放在启动时（与前面几张表一个口径）。
   */
  const churchById = new Map(churches.map((church) => [church.id, church]));
  /** 途径 → 绑它的教会 id（教会与途径是**一对一**：七正神各走一条，谁也不共享） */
  const pathwayOwner = new Map<string, string>();
  for (const church of churches) {
    /*
     * 「每家只有一个 type='church'」的落地口径：**M2.15 只加载正神教会**。
     * order / cult 是 schema 里留给 M2.18 的合法值，但在这一轮它们一旦出现在内容表里，
     * 就意味着有人开始写下一轮的内容了 —— 那时 M2.16 / M2.17 的判定还没做，
     * 这些组织会以「什么都不会发生」的形式静默存在于世界里。
     */
    if (church.type !== 'church') {
      issues.push({
        file: CHURCHES_FILE,
        level: 'error',
        message: `${church.id}: type=${church.type}，而 M2.15 只做正神教会（order / cult 是 M2.18 的预留值）`,
      });
    }
    /*
     * 途径绑定：pathway（已实现的 id）与 plannedPathway（人读的待办标记）**恰有一个非空**。
     *   两个都空 → 这家教会不知道自己信哪条途径；
     *   两个都填 → 「待定」与「已绑」自相矛盾，而 M2.16 的入教判定只读 pathway，
     *              填错的那个 plannedPathway 会被静默忽略。
     */
    if ((church.pathway === null) === (church.plannedPathway === null)) {
      issues.push({
        file: CHURCHES_FILE,
        level: 'error',
        message: `${church.id}: pathway 与 plannedPathway 必须恰有一个非空（绑上途径之后要清掉待办标记）`,
      });
    }
    /*
     * M2.16：档位数量必须与 NUMERIC 的门槛数组**等长**。
     *
     * 这是「档位名是内容、阈值是数值」那两半之间的**唯一契约**：
     * 数量对不上时 currentRank 会按短的那个数组算，症状是
     * 「有人明明捐够了却永远升不上去」——运行期一声不响，只在报告里表现为档位分布异常。
     */
    const expectedRanks = NUMERIC.church.ranks.contributionThreshold.length;
    if (church.ranks.length !== expectedRanks) {
      issues.push({
        file: CHURCHES_FILE,
        level: 'error',
        message:
          `${church.id}: ranks 有 ${church.ranks.length} 档，而 NUMERIC.church.ranks 的` +
          `门槛数组是 ${expectedRanks} 档（两边必须等长）`,
      });
    }
    const boundPathway = church.pathway;
    if (boundPathway) {
      const owner = pathwayOwner.get(boundPathway);
      if (owner) {
        issues.push({
          file: CHURCHES_FILE,
          level: 'error',
          message: `${church.id}: 途径 ${boundPathway} 已经绑给 ${owner} 了（教会与途径是一对一）`,
        });
      } else {
        pathwayOwner.set(boundPathway, church.id);
      }
    }
    for (const seat of church.seats) {
      // 据点写错城市的症状：那座城市里永远没有这家教会的堂口，而内容表看着完全正常
      if (!cityIds.has(seat)) {
        issues.push({
          file: CHURCHES_FILE,
          level: 'error',
          message: `${church.id}: 据点引用了未登记的城市 ${seat}`,
        });
      }
    }
    /*
     * 关系的三条校验：不能指向自己、指向的必须是登记过的教会、**必须对称**。
     * 非对称是设计错误而不是内容风格问题 —— 一份「A 恨 B 而 B 不恨 A」的关系表
     * 会让 M2.17 的势力争夺按谁先被读到而产生两种结果。
     */
    for (const [otherId, relation] of Object.entries(church.relations)) {
      if (otherId === church.id) {
        issues.push({
          file: CHURCHES_FILE,
          level: 'error',
          message: `${church.id}: relations 指向了自己（自反关系恒为 neutral，不需要声明）`,
        });
        continue;
      }
      const other = churchById.get(otherId);
      if (!other) {
        issues.push({
          file: CHURCHES_FILE,
          level: 'error',
          message: `${church.id}: relations 引用了未登记的教会 ${otherId}`,
        });
        continue;
      }
      const back = other.relations[church.id] ?? 'neutral';
      if (back !== relation) {
        issues.push({
          file: CHURCHES_FILE,
          level: 'error',
          message:
            `${church.id} 对 ${otherId} 是 ${relation}，而 ${otherId} 对 ${church.id} 是 ${back}` +
            '（关系必须对称）',
        });
      }
    }
    /*
     * 绑上的途径必须能在**至少一座据点城市**里被玩家拿到。
     * warn 而不是 error 的理由：一家教会有多座据点城市，只要有一座开放这条途径就有一条真路；
     * 而且入教本身（M2.16）还没做。但它值得被报出来 ——
     * 「绑了途径，却没有任何一座城市能提供它」是内容表能犯的最贵的那类错。
     */
    if (boundPathway) {
      const reachable = church.seats.some((seat) => cityById.get(seat)?.pathways.includes(boundPathway));
      if (!reachable) {
        issues.push({
          file: CHURCHES_FILE,
          level: 'warn',
          message: `${church.id}: 绑定的途径 ${boundPathway} 在它的任何一座据点城市里都不开放`,
        });
      }
    }
    /*
     * M2.17：禁忌的判据是**跨表引用**，所以它和 seats / relations 一样要交叉校验。
     *
     * 四条：taboo id 在教内唯一（它会落进 domain_events.payload，重复了报告就分不开）、
     * location / cityId 指向真实存在的地点与城市、action 落在
     * NUMERIC.church.taboo.checkAfter 里（不在的话这条判据永远不会被检查 —— 那是死配置）、
     * 以及 rankBelow 不能大于 rankAbove（没人满足的区间）。
     */
    const seenTaboo = new Set<string>();
    for (const taboo of church.taboos) {
      if (seenTaboo.has(taboo.id)) {
        issues.push({ file: CHURCHES_FILE, level: 'error', message: `${church.id}: 禁忌 id 重复：${taboo.id}` });
      }
      seenTaboo.add(taboo.id);
      const when = taboo.when;
      if (!when) continue;
      if (when.location && !locations.some((location) => location.id === when.location)) {
        issues.push({
          file: CHURCHES_FILE,
          level: 'error',
          message: `${church.id}/${taboo.id}: 判据引用了未登记的地点 ${when.location}`,
        });
      }
      if (when.cityId && !cityById.has(when.cityId)) {
        issues.push({
          file: CHURCHES_FILE,
          level: 'error',
          message: `${church.id}/${taboo.id}: 判据引用了未登记的城市 ${when.cityId}`,
        });
      }
      if (when.action && !NUMERIC.church.taboo.checkAfter.includes(when.action)) {
        issues.push({
          file: CHURCHES_FILE,
          level: 'warn',
          message: `${church.id}/${taboo.id}: action=${when.action} 不在 NUMERIC.church.taboo.checkAfter 里，这条判据不会被检查`,
        });
      }
      if (when.rankBelow !== undefined && when.rankAbove !== undefined && when.rankBelow > when.rankAbove) {
        issues.push({
          file: CHURCHES_FILE,
          level: 'error',
          message: `${church.id}/${taboo.id}: rankBelow > rankAbove，没有任何档位满足它`,
        });
      }
    }
  }

  return issues;
}

export function loadRoutes(file: string = ROUTES_FILE): { routes: Route[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  const raw = readYaml(file) as { routes?: unknown[] } | null;
  const routes: Route[] = [];
  for (const entry of raw?.routes ?? []) {
    const parsed = parseRoute(entry);
    if (!parsed.ok) {
      for (const issue of parsed.issues) issues.push({ file, level: 'error', message: issue });
      continue;
    }
    routes.push(parsed.route);
  }
  const seen = new Set<string>();
  for (const route of routes) {
    if (seen.has(route.id)) issues.push({ file, level: 'error', message: `路线 id 重复：${route.id}` });
    seen.add(route.id);
    if (route.from === route.to) {
      issues.push({ file, level: 'error', message: `${route.id}: 起点与终点是同一座城市` });
    }
    if (route.events.length === 0) {
      // 不是 error：一条没有事件池的路线只是"路上什么都没发生"，
      // 但任务书 §5.3 的硬要求是「移动本身是一段内容」，所以至少要能看见
      issues.push({ file, level: 'warn', message: `${route.id}: 没有路途事件池` });
    }
  }
  return { routes, issues };
}

export interface ContentBundle {
  items: ItemDef[];
  locations: LocationDef[];
  recipes: RecipeDef[];
  abilities: AbilityDef[];
  /** M2.7：世界地理 */
  regions: Region[];
  cities: City[];
  routes: Route[];
  /** M2.7.6：本地势力（M2.85 起决定线索的途径落点） */
  factions: GuidedFaction[];
  /** M2.8：非凡生物物种模板 */
  creatures: CreatureSpecies[];
  /** M2.58 阶段二：生态域（地点分组 + 域参数）。空数组 = 全部地点落全局基线 */
  zones: Zone[];
  /** M2.59：文明势力实体。空数组 = 世界事件里不会有势力反应 */
  powers: Power[];
  /** M2.61：初始历史。空数组 = 世界没有过去 */
  history: HistoryEvent[];
  /** M2.62：边界。空数组 = 世界没有外面 */
  boundaries: Boundary[];
  /** M2.62：外部势力 */
  foreignPowers: ForeignPower[];
  /** M2.15：正神教会（骨架；不落库，装进 ChurchIndex） */
  churches: ChurchDef[];
  /** M2.17：教会技能（达到教内档位解锁；同样不落库 —— 解锁状态是算出来的） */
  churchAbilities: ChurchAbilityDef[];
  /** M2.76：晋升仪式档位（按序列分档）。空数组 = 判定层走 NUMERIC.ritual 的缺省 */
  rituals: RitualProfile[];
  /** M2.76：权柄（世界级能力）。空数组 = 世界不会有权柄事件 */
  authorities: AuthorityDef[];
  /** M2.85 内容填充 P1：塔罗牌 22 张大阿卡那（读取点：.占卜 回执） */
  tarot: TarotCard[];
  /** M2.85 内容填充 P1：神明 27 位（读取点：.图鉴 神明） */
  pantheon: Deity[];
  /** M2.85 内容填充 P1：组织与势力 49 条（读取点：.图鉴 组织） */
  organizations: Organization[];
  /** M2.85 内容填充 P1：人物 70 条（读取点：.图鉴 人物） */
  figures: Figure[];
  /** M2.85 内容填充 P1：生物名录 544 条（读取点：.图鉴 生物；materials 是 P4 的连接键） */
  bestiary: BestiaryEntry[];
  /** M2.85 内容填充 P1：权柄与象征 95 条（读取点：.图鉴 权柄） */
  divineAuthorities: DivineAuthority[];
  /** M2.85 内容填充 P6：晋升仪式要求 132 条（读取点：.仪式 准备 的「原作记载」） */
  advancementRites: AdvancementRite[];
  /** M2.85 内容填充 P4：原作材料全表 1173 条（读取点：.图鉴 材料） */
  originalMaterials: OriginalMaterial[];
  /** M2.85 内容填充 P5：原作能力清单 2405 条（读取点：.图鉴 能力） */
  pathwayAbilities: PathwayAbility[];
  /** M2.85 世界演化：NPC 晋升轨道（读取点：.图鉴 途径） */
  npcTracks: NpcTrack[];
  /** M2.99：**神座**（22 条途径的序列 0）—— 装载时的引用校验会进 issues（M2.164 修的缺口） */
  divineThrones: DivineThrone[];
  /** M2.164：**世界居民名册**（身份 / 常驻 / 性情 / 用途标签）—— 见 domain/world/npc-cast.ts */
  npcCast: NpcCast[];
  /** M2.167：**堕落生物**（形态 → 强度 / 掉落 / 行为 / 感知）—— 见 domain/world/fallen-beast.ts */
  fallenBeasts: FallenBeast[];
  /** M2.169：**神与神的关系网**（盟友 / 水火不容 / 觊觎其位）—— 阴谋只能沿着这些边发生 */
  divineRelations: DivineRelation[];
  /** M2.85 世界演化：途径行为（NPC 会做符合本途径的事） */
  pathwayDeeds: PathwayDeed[];
  /** M2.85 RPG 化：NPC 立场（性情 / 敌对途径 / 赠礼档） */
  npcDispositions: NpcDisposition[];
  /** M2.85 RPG 化 B：**装备**（读取点 .装备 / .装备栏） */
  equipment: Equipment[];
  /** M2.85 RPG 化 C：**战斗技能**（技能池读它） */
  battleSkills: BattleSkill[];
  /** M2.85 RPG 化 D：**委托**（.委托 读它） */
  quests: Quest[];
  /** M2.85：**奇遇**（.探索 有小概率碰上） */
  fortunes: Fortune[];
  /*
   * M2.87 交易体系：
   *   `shops`  一个商店就是一个地点，`locationId` 指回 locations
   *   `prices` 物价锚点与派生规则；**可能是 null**（文件坏了），
   *            调用方那时必须拒绝买卖，而不是当成 0 便士
   */
  shops: Shop[];
  prices: PriceTable | null;
  issues: DataIssue[];
}

/** 交叉引用校验：掉落表 / 配方的材料与成品都必须在 items 里存在 */
/**
 * 读仪式档位表 + 交叉校验。
 *
 * 三条校验都是「不报错就会静默走错」的形状，所以它们在这里、不在判定层：
 *   1. **区间必须覆盖 9—0 不留缺口** —— 缺一档的后果是某几个序列的玩家
 *      `.仪式` 当场抛错（ritualProfileFor 不隐含默认档，K19），那比启动失败更晚；
 *   2. **每档恰好一个融合关**（base === null）—— 没有它，融合关的成功率就没有出处；
 *      有两个则第二个永远不会被读到；
 *   3. **id 唯一**。
 */
export function loadRituals(file: string = RITUALS_FILE): { rituals: RitualProfile[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    // 与 powers.yaml 同一条口径：表可以暂时不存在，但要说一声（warn 不是 error）
    issues.push({ file, level: 'warn', message: `读不到仪式档位表：${String(error)}` });
    return { rituals: [], issues };
  }

  const parsed = parseRitualsFile(raw);
  if (!parsed.ok) {
    for (const message of parsed.issues) issues.push({ file, level: 'error', message });
    return { rituals: [], issues };
  }
  const rituals = parsed.rituals;

  const seen = new Set<string>();
  for (const profile of rituals) {
    if (seen.has(profile.id)) {
      issues.push({ file, level: 'error', message: `仪式档位 id 重复：${profile.id}` });
    }
    seen.add(profile.id);
    const fuseCount = profile.stages.filter((stage) => stage.base === null).length;
    if (fuseCount !== 1) {
      issues.push({
        file,
        level: 'error',
        message: `${profile.id}: 必须有且只有一个融合关（base 为空的阶段），当前 ${fuseCount} 个`,
      });
    }
  }

  if (rituals.length > 0) {
    const covered = new Set<number>();
    for (const profile of rituals) {
      for (let seq = profile.maxSeq; seq <= profile.minSeq; seq += 1) covered.add(seq);
    }
    const missing: number[] = [];
    for (let seq = 9; seq >= 0; seq -= 1) if (!covered.has(seq)) missing.push(seq);
    if (missing.length > 0) {
      issues.push({
        file,
        level: 'error',
        message: `仪式档位没有覆盖序列 ${missing.join('、')} —— 那些序列的玩家 .仪式 会当场抛错`,
      });
    }
  }

  return { rituals, issues };
}

/**
 * 读权柄表 + 交叉校验。
 *
 * 两条校验都是「不报错就会静默走错」的形状：
 *   1. **weather 必须是 WEATHER_IDS 里的一种** —— 写错的后果是覆盖值落进库、
 *      而 `normalizeWeather` 会把它悄悄折成默认天气（玩家看到的是「什么都没发生」）；
 *   2. **id 唯一**。
 */
/**
 * 读塔罗表（22 张大阿卡那）。
 *
 * 四道校验（22 张齐全 / 编号 0—21 / id 唯一 / 途径双向覆盖）都在 `parseTarotFile` 里 ——
 * 「内容表自己坏了」与「加载器读错了」是两件事，判据跟着数据形状走。
 */
export function loadTarot(file: string = TAROT_FILE): { tarot: TarotCard[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    issues.push({ file, level: 'error', message: `读不到塔罗表：${String(error)}` });
    return { tarot: [], issues };
  }
  const parsed = parseTarotFile(raw);
  if (!parsed.ok) {
    for (const message of parsed.issues) issues.push({ file, level: 'error', message });
    return { tarot: [], issues };
  }
  return { tarot: parsed.cards, issues };
}

/** 读组织表（鲁恩机构 / 军队 / 贵族家族 / 商会 / 地下势力 / 隐秘组织）。校验在 `parseOrganizationsFile` 里。 */
export function loadOrganizations(file: string = ORGANIZATIONS_FILE): { organizations: Organization[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    issues.push({ file, level: 'error', message: `读不到组织表：${String(error)}` });
    return { organizations: [], issues };
  }
  const parsed = parseOrganizationsFile(raw);
  if (!parsed.ok) {
    for (const message of parsed.issues) issues.push({ file, level: 'error', message });
    return { organizations: [], issues };
  }
  return { organizations: parsed.organizations, issues };
}

/** 读奇遇表。 */
export function loadFortunes(file: string = FORTUNES_FILE): { fortunes: Fortune[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try { raw = parseYaml(readFileSync(file, 'utf8')); }
  catch (error) { issues.push({ file, level: 'error', message: '读不到奇遇表：' + String(error) }); return { fortunes: [], issues }; }
  const list = (raw as { fortunes?: unknown[] } | null)?.fortunes ?? [];
  const fortunes: Fortune[] = [];
  for (const entry of list) {
    const parsed = FortuneSchema.safeParse(entry);
    if (!parsed.success) { issues.push({ file, level: 'error', message: '奇遇：' + parsed.error.issues.map((i) => i.path.join('.') + '：' + i.message).join('；') }); continue; }
    fortunes.push(parsed.data);
  }
  return { fortunes, issues };
}

/** 读委托表（RPG 化 D）。 */
export function loadQuests(file: string = QUESTS_FILE): { quests: Quest[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try { raw = parseYaml(readFileSync(file, 'utf8')); }
  catch (error) { issues.push({ file, level: 'error', message: `读不到委托表：${String(error)}` }); return { quests: [], issues }; }
  const list = (raw as { quests?: unknown[] } | null)?.quests ?? [];
  const quests: Quest[] = [];
  for (const entry of list) {
    const parsed = QuestSchema.safeParse(entry);
    if (!parsed.success) { issues.push({ file, level: 'error', message: '委托：' + parsed.error.issues.map((i) => i.path.join('.') + '：' + i.message).join('；') }); continue; }
    quests.push(parsed.data);
  }
  return { quests, issues };
}

/** 读战斗技能表（RPG 化 C）。 */
export function loadBattleSkills(file: string = BATTLE_SKILLS_FILE): { battleSkills: BattleSkill[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try { raw = parseYaml(readFileSync(file, 'utf8')); }
  catch (error) { issues.push({ file, level: 'error', message: `读不到战斗技能表：${String(error)}` }); return { battleSkills: [], issues }; }
  const list = (raw as { battle_skills?: unknown[] } | null)?.battle_skills ?? [];
  const battleSkills: BattleSkill[] = [];
  for (const entry of list) {
    const parsed = BattleSkillSchema.safeParse(entry);
    if (!parsed.success) { issues.push({ file, level: 'error', message: '战斗技能：' + parsed.error.issues.map((i) => i.path.join('.') + '：' + i.message).join('；') }); continue; }
    battleSkills.push(parsed.data);
  }
  return { battleSkills, issues };
}

/** 读装备表（RPG 化 B）。 */
export function loadEquipment(file: string = EQUIPMENT_FILE): { equipment: Equipment[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try { raw = parseYaml(readFileSync(file, 'utf8')); }
  catch (error) { issues.push({ file, level: 'error', message: `读不到装备表：${String(error)}` }); return { equipment: [], issues }; }
  const list = (raw as { equipment?: unknown[] } | null)?.equipment ?? [];
  const equipment: Equipment[] = [];
  for (const entry of list) {
    const parsed = EquipmentSchema.safeParse(entry);
    if (!parsed.success) { issues.push({ file, level: 'error', message: '装备：' + parsed.error.issues.map((i) => i.path.join('.') + '：' + i.message).join('；') }); continue; }
    equipment.push(parsed.data);
  }
  return { equipment, issues };
}

/** 读 NPC 立场表。 */
export function loadNpcDispositions(file: string = NPC_DISPOSITIONS_FILE): { dispositions: NpcDisposition[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try { raw = parseYaml(readFileSync(file, 'utf8')); }
  catch (error) { issues.push({ file, level: 'error', message: `读不到 NPC 立场表：${String(error)}` }); return { dispositions: [], issues }; }
  const list = (raw as { npc_dispositions?: unknown[] } | null)?.npc_dispositions ?? [];
  const dispositions: NpcDisposition[] = [];
  for (const entry of list) {
    const parsed = NpcDispositionSchema.safeParse(entry);
    if (!parsed.success) { issues.push({ file, level: 'error', message: 'NPC 立场：' + parsed.error.issues.map((i) => i.path.join('.') + '：' + i.message).join('；') }); continue; }
    dispositions.push(parsed.data);
  }
  return { dispositions, issues };
}

/** 读途径行为表（NPC 会做符合本途径的事）。 */
export function loadPathwayDeeds(file: string = PATHWAY_DEEDS_FILE): { deeds: PathwayDeed[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try { raw = parseYaml(readFileSync(file, 'utf8')); }
  catch (error) { issues.push({ file, level: 'error', message: `读不到途径行为表：${String(error)}` }); return { deeds: [], issues }; }
  const list = (raw as { pathway_deeds?: unknown[] } | null)?.pathway_deeds ?? [];
  const deeds: PathwayDeed[] = [];
  for (const entry of list) {
    const parsed = PathwayDeedSchema.safeParse(entry);
    if (!parsed.success) { issues.push({ file, level: 'error', message: '途径行为：' + parsed.error.issues.map((i) => i.path.join('.') + '：' + i.message).join('；') }); continue; }
    deeds.push(parsed.data);
  }
  return { deeds, issues };
}

/** 读 NPC 晋升轨道（世界演化第一步）。 */
export function loadNpcTracks(file: string = NPC_TRACKS_FILE): { tracks: NpcTrack[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try { raw = parseYaml(readFileSync(file, 'utf8')); }
  catch (error) { issues.push({ file, level: 'error', message: `读不到 NPC 轨道表：${String(error)}` }); return { tracks: [], issues }; }
  const list = (raw as { npc_tracks?: unknown[] } | null)?.npc_tracks ?? [];
  for (const entry of list) {
    const parsed = NpcTrackSchema.safeParse(entry);
    if (!parsed.success) { issues.push({ file, level: 'error', message: 'NPC 轨道：' + parsed.error.issues.map((i) => i.path.join('.') + '：' + i.message).join('；') }); continue; }
    tracks.push(parsed.data);
  }
  return { tracks, issues };
}
/**
 * 读**世界人物名册**（M2.164）。
 *
 * ⚠️ 它只管「读得对不对」（schema / id 重复）。**引用校验**在 `checkNpcCastRefs` ——
 * 那一条要查别的表（城市 / 地点 / 势力 / 组织 / 教会 / 途径），只有 `loadContent` 里才齐全。
 */
export function loadNpcCast(file: string = NPC_CAST_FILE): { cast: NpcCast[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try { raw = parseYaml(readFileSync(file, 'utf8')); }
  catch (error) { issues.push({ file, level: 'error', message: `读不到人物名册：${String(error)}` }); return { cast: [], issues }; }
  const parsed = NpcCastFileSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({ file, level: 'error', message: '人物名册：' + issue.path.join('.') + '：' + issue.message });
    }
    return { cast: [], issues };
  }
  const cast = parsed.data.npc_cast;
  const seen = new Set<string>();
  for (const npc of cast) {
    if (seen.has(npc.id)) issues.push({ file, level: 'error', message: '名册里出现了两次：' + npc.id });
    seen.add(npc.id);
  }
  return { cast, issues };
}

/**
 * **名册的引用校验**（M2.164）—— 四条，全是 error 级。
 *
 * 为什么必须是 error 而不是 warn：这四条错了**都不会报错地跑下去** ——
 *
 *   ① id 与 `npc-tracks` 撞车 ⇒ 「他死了」会写在**另一个身份**上（同一个 id 两处记载）
 *   ② `city` 不存在 ⇒ 他站在一座不存在的城里，场景里永远找不到他
 *   ③ `location` 不属于该城 ⇒ **人在一个到不了的地方**（城在那儿，地点是别城的）
 *   ④ 势力 / 组织 / 教会 / 途径写错 ⇒ 判定层只是永远匹配不上，看不出异常
 *
 * 城市与地点分开查（而不是各查一次存在性）就是为了第 ③ 条：
 * 「这个地点真实存在」与「它在这座城里」是两件事，只查前者会放过第二种。
 */
export function checkNpcCastRefs(
  cast: readonly NpcCast[],
  ids: {
    file?: string;
    tracks?: ReadonlySet<string>;
    /** 城市 id → 它的地点 id（用于查「地点属于该城」） */
    cities?: ReadonlyMap<string, readonly string[]>;
    locations?: ReadonlySet<string>;
    factions?: ReadonlySet<string>;
    organizations?: ReadonlySet<string>;
    churches?: ReadonlySet<string>;
    pathways?: ReadonlySet<string>;
  } = {},
): DataIssue[] {
  const file = ids.file ?? NPC_CAST_FILE;
  const issues: DataIssue[] = [];
  const check = (where: string, value: string, set: ReadonlySet<string> | undefined, what: string): void => {
    if (set === undefined || value === '') return;
    if (!set.has(value)) issues.push({ file, level: 'error', message: where + ' 引用了不存在的' + what + '：' + value });
  };
  for (const npc of cast) {
    if (ids.tracks?.has(npc.id)) {
      issues.push({ file, level: 'error', message: npc.id + ' 与 npc-tracks 撞了 id —— 同一个人不许出现在两张表里（「他死了」会写在错误的身份上）' });
    }
    check(npc.id + '.city', npc.city, ids.cities === undefined ? undefined : new Set(ids.cities.keys()), '城市');
    if (npc.location !== '') {
      check(npc.id + '.location', npc.location, ids.locations, '地点');
      const cityLocations = ids.cities?.get(npc.city);
      if (cityLocations !== undefined && !cityLocations.includes(npc.location)) {
        issues.push({ file, level: 'error', message: npc.id + '.location 的 ' + npc.location + ' 不属于 ' + npc.city + ' —— 人在一个到不了的地方' });
      }
    }
    check(npc.id + '.faction', npc.faction, ids.factions, '势力');
    check(npc.id + '.organization', npc.organization, ids.organizations, '组织');
    check(npc.id + '.church', npc.church, ids.churches, '教会');
    check(npc.id + '.pathway', npc.pathway, ids.pathways, '途径');
  }
  return issues;
}
/**
 * 读**堕落生物**表（M2.167）。
 *
 * 只管「读得对不对」（schema）；**引用校验**在 `checkFallenBeastRefs` ——
 * 那一条要查形态池与物品表，与名册那张表同一个理由（谁调用谁负责）。
 */
export function loadFallenBeasts(file: string = FALLEN_BEASTS_FILE): { fallenBeasts: FallenBeast[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try { raw = parseYaml(readFileSync(file, 'utf8')); }
  catch (error) { issues.push({ file, level: 'error', message: `读不到堕落生物表：${String(error)}` }); return { fallenBeasts: [], issues }; }
  const parsed = FallenBeastFileSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({ file, level: 'error', message: '堕落生物：' + issue.path.join('.') + '：' + issue.message });
    }
    return { fallenBeasts: [], issues };
  }
  const fallenBeasts = parsed.data.fallen_beasts;
  const seen = new Set<string>();
  for (const beast of fallenBeasts) {
    if (seen.has(beast.formId)) issues.push({ file, level: 'error', message: '同一个形态出现了两次：' + beast.formId });
    seen.add(beast.formId);
  }
  return { fallenBeasts, issues };
}

/** 从 lost-control.yaml 取形态 id 集合（只读文件，见 LOST_FORMS_FILE 的注释） */
function lostFormIds(): ReadonlySet<string> {
  try {
    const raw = parseYaml(readFileSync(LOST_FORMS_FILE, 'utf8')) as { forms?: Array<{ id?: unknown }> };
    return new Set((raw.forms ?? []).map((f) => String(f.id)));
  } catch {
    return new Set<string>();
  }
}

/**
 * **堕落生物的引用校验**（M2.167）—— 三条，全是 error 级。
 *
 *   ① formId 必须在 cards/lost-control.yaml 的 forms 里 —— 写错一个 id 的后果不是报错，
 *      而是**那个形态的人堕落时不会变成生物**（找不到就返回 null，而他每小时都会再掷一次，永远掷不到）
 *   ② drops[].itemId 必须是真实物品 —— 否则玩家打死它什么也拿不到，而掉落表看着是满的
 *   ③ drops 不能为空 —— 【原作】怪物是魔药材料的来源；一只不掉东西的怪物等于把这条设定丢了
 *
 * 形态池读不到时（文件坏了）**不报这里的错**：那是 lost-control 自己的加载问题，
 * 报在这里会让「一个文件坏了」变成「两张表都在报错」。
 */
export function checkFallenBeastRefs(
  beasts: readonly FallenBeast[],
  ids: { file?: string; forms?: ReadonlySet<string>; items?: ReadonlySet<string> } = {},
): DataIssue[] {
  const file = ids.file ?? FALLEN_BEASTS_FILE;
  const issues: DataIssue[] = [];
  for (const beast of beasts) {
    if (ids.forms !== undefined && ids.forms.size > 0 && !ids.forms.has(beast.formId)) {
      issues.push({ file, level: 'error', message: beast.formId + ' 不在 lost-control.yaml 的 forms 里 —— 这个形态的人堕落时永远不会变成生物' });
    }
    if (beast.drops.length === 0) {
      issues.push({ file, level: 'error', message: beast.formId + ' 没有掉落 —— 原作里怪物是魔药材料的来源' });
    }
    for (const drop of beast.drops) {
      if (ids.items !== undefined && !ids.items.has(drop.itemId)) {
        issues.push({ file, level: 'error', message: beast.formId + '.drops 引用了不存在的物品：' + drop.itemId });
      }
    }
  }
  return issues;
}
/** 读**神与神的关系网**（M2.169）。引用校验与神座表同一个手法（见 loadDivineThrones）。 */
export function loadDivineRelations(
  file: string = DIVINE_RELATIONS_FILE,
  ids: { pathways?: ReadonlySet<string> } = {},
): { relations: DivineRelation[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try { raw = parseYaml(readFileSync(file, 'utf8')); }
  catch (error) { issues.push({ file, level: 'error', message: `读不到神明关系表：${String(error)}` }); return { relations: [], issues }; }
  const parsed = DivineRelationFileSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({ file, level: 'error', message: '神明关系：' + issue.path.join('.') + '：' + issue.message });
    }
    return { relations: [], issues };
  }
  const relations = parsed.data.divine_relations;
  for (const relation of relations) {
    if (relation.a === relation.b) {
      issues.push({ file, level: 'error', message: relation.a + ' 与自己建立了关系 —— 一位神不会觊觎自己的位置' });
    }
    /*
     * 两端的途径必须真的在神座表里。
     * 写错的后果不是报错，而是那条边**永远匹配不上** —— 于是阴谋少了一条依据，
     * 而报表上只会显示「祂们之间没有关系」。
     */
    if (ids.pathways !== undefined) {
      for (const side of [relation.a, relation.b]) {
        if (!ids.pathways.has(side)) {
          issues.push({ file, level: 'error', message: relation.a + '-' + relation.b + ' 的 ' + side + ' 不在神座表里（途径 id 写错了？）' });
        }
      }
    }
  }
  return { relations, issues };
}

const tracks: NpcTrack[] = [];

/** 读原作能力清单（设定层，与 abilities.yaml 的机制层**故意不合并**）。 */
export function loadPathwayAbilities(file: string = PATHWAY_ABILITIES_FILE): { abilities: PathwayAbility[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    issues.push({ file, level: 'error', message: `读不到原作能力表：${String(error)}` });
    return { abilities: [], issues };
  }
  const parsed = parsePathwayAbilitiesFile(raw);
  if (!parsed.ok) {
    for (const message of parsed.issues) issues.push({ file, level: 'error', message });
    return { abilities: [], issues };
  }
  return { abilities: parsed.abilities, issues };
}

/** 读原作材料全表（设定层）。校验在 `parseOriginalMaterialsFile` 里。 */
export function loadOriginalMaterials(file: string = ORIGINAL_MATERIALS_FILE): { materials: OriginalMaterial[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    issues.push({ file, level: 'error', message: `读不到原作材料表：${String(error)}` });
    return { materials: [], issues };
  }
  const parsed = parseOriginalMaterialsFile(raw);
  if (!parsed.ok) {
    for (const message of parsed.issues) issues.push({ file, level: 'error', message });
    return { materials: [], issues };
  }
  return { materials: parsed.materials, issues };
}

/** 读晋升仪式要求（原作数据直出）。校验在 `parseAdvancementRitesFile` 里。 */
export function loadAdvancementRites(file: string = ADVANCEMENT_RITES_FILE): { rites: AdvancementRite[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    issues.push({ file, level: 'error', message: `读不到晋升仪式表：${String(error)}` });
    return { rites: [], issues };
  }
  const parsed = parseAdvancementRitesFile(raw);
  if (!parsed.ok) {
    for (const message of parsed.issues) issues.push({ file, level: 'error', message });
    return { rites: [], issues };
  }
  return { rites: parsed.rites, issues };
}

/** 读权柄与象征（原作设定层）。校验在 `parseDivineAuthoritiesFile` 里。 */
export function loadDivineAuthorities(file: string = DIVINE_AUTHORITIES_FILE): { divineAuthorities: DivineAuthority[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    issues.push({ file, level: 'error', message: `读不到权柄表：${String(error)}` });
    return { divineAuthorities: [], issues };
  }
  const parsed = parseDivineAuthoritiesFile(raw);
  if (!parsed.ok) {
    for (const message of parsed.issues) issues.push({ file, level: 'error', message });
    return { divineAuthorities: [], issues };
  }
  return { divineAuthorities: parsed.divineAuthorities, issues };
}

/** 读生物名录（材料来源 + 生态资料）。校验在 `parseBestiaryFile` 里。 */
export function loadBestiary(file: string = BESTIARY_FILE): { bestiary: BestiaryEntry[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    issues.push({ file, level: 'error', message: `读不到生物名录：${String(error)}` });
    return { bestiary: [], issues };
  }
  const parsed = parseBestiaryFile(raw);
  if (!parsed.ok) {
    for (const message of parsed.issues) issues.push({ file, level: 'error', message });
    return { bestiary: [], issues };
  }
  return { bestiary: parsed.bestiary, issues };
}

/**
 * 读物价表（M2.87）。
 *
 * ⚠️ 这里的 `issues` 与别处**同等重要**：`anchors` 每一条都带章节号，
 * 是「按原作设计」的凭据；`rules` 每一条都必须有 `basis`（从哪条锚点推的）。
 * schema 把 `basis` 设成必填，就是为了让「不可追溯的派生价」进不来。
 */
export function loadPrices(file: string = PRICES_FILE): { prices: PriceTable | null; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    issues.push({ file, level: 'error', message: `读不到物价表：${String(error)}` });
    return { prices: null, issues };
  }
  const parsed = PriceTableSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({ file, level: 'error', message: `${issue.path.join('.')}: ${issue.message}` });
    }
    return { prices: null, issues };
  }
  return { prices: parsed.data, issues };
}

/** 读商店表（M2.87）。`locationId` 的存在性由启动校验的交叉检查兜底。 */
export function loadShops(file: string = SHOPS_FILE): { shops: Shop[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    issues.push({ file, level: 'error', message: `读不到商店表：${String(error)}` });
    return { shops: [], issues };
  }
  const parsed = ShopTableSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({ file, level: 'error', message: `${issue.path.join('.')}: ${issue.message}` });
    }
    return { shops: [], issues };
  }
  return { shops: parsed.data.shops, issues };
}

/** 读人物表（角色 / 天使 / 圣徒 / 古神 / 帝王）。校验在 `parseFiguresFile` 里。 */
export function loadFigures(file: string = FIGURES_FILE): { figures: Figure[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    issues.push({ file, level: 'error', message: `读不到人物表：${String(error)}` });
    return { figures: [], issues };
  }
  const parsed = parseFiguresFile(raw);
  if (!parsed.ok) {
    for (const message of parsed.issues) issues.push({ file, level: 'error', message });
    return { figures: [], issues };
  }
  return { figures: parsed.figures, issues };
}

/** 读神明表（正神 / 支柱级旧日 / 隐秘存在与邪神）。校验在 `parsePantheonFile` 里。 */
export function loadPantheon(file: string = PANTHEON_FILE): { pantheon: Deity[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    issues.push({ file, level: 'error', message: `读不到神明表：${String(error)}` });
    return { pantheon: [], issues };
  }
  const parsed = parsePantheonFile(raw);
  if (!parsed.ok) {
    for (const message of parsed.issues) issues.push({ file, level: 'error', message });
    return { pantheon: [], issues };
  }
  return { pantheon: parsed.deities, issues };
}

export function loadAuthorities(file: string = AUTHORITIES_FILE): { authorities: AuthorityDef[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    issues.push({ file, level: 'warn', message: `读不到权柄表：${String(error)}` });
    return { authorities: [], issues };
  }

  const parsed = parseAuthoritiesFile(raw);
  if (!parsed.ok) {
    for (const message of parsed.issues) issues.push({ file, level: 'error', message });
    return { authorities: [], issues };
  }
  const authorities = parsed.authorities;

  const valid = new Set<string>(WEATHER_IDS);
  const seen = new Set<string>();
  for (const authority of authorities) {
    if (seen.has(authority.id)) {
      issues.push({ file, level: 'error', message: `权柄 id 重复：${authority.id}` });
    }
    seen.add(authority.id);
    if (!valid.has(authority.weather)) {
      issues.push({
        file,
        level: 'error',
        message: `${authority.id}: weather "${authority.weather}" 不是八种天气之一（${WEATHER_IDS.join(' / ')}）—— ` +
          '写错的覆盖值会被 normalizeWeather 悄悄折成默认天气，玩家看到的是「什么都没发生」',
      });
    }
  }
  if (authorities.length > 0) {
    const covered = new Set(authorities.map((a) => a.pathway));
    for (const pathway of Object.keys(PATHWAY_LABELS)) {
      if (!covered.has(pathway as never)) {
        issues.push({ file, level: 'warn', message: `${pathway} 没有权柄 —— 22 条途径都应当有一条` });
      }
    }
  }

  return { authorities, issues };
}

export function loadContent(options: { cardIds?: ReadonlySet<string> } = {}): ContentBundle {
  const itemsResult = loadItems();
  const locationsResult = loadLocations();
  const recipesResult = loadRecipes();
  const abilitiesResult = loadAbilities();
  // M2.7：地理三张表一起装载，交叉引用在同一处校验（与地点/物品/配方一个口径）
  const regionsResult = loadRegions();
  const citiesResult = loadCities();
  const routesResult = loadRoutes();
  const factionsResult = loadFactions();
  // M2.8：物种模板（一处声明四处生效，所以它的交叉引用校验也集中在这里）
  const creaturesResult = loadCreatures();
  // M2.15：正神教会（七正神的骨架：途径绑定 / 教义 / 禁忌 / 等级 / 据点 / 关系）
  const churchesResult = loadChurches();
  // M2.17：教会技能（第二层能力；与途径能力分表，合并规则在 domain/ability/ability.ts）
  const churchAbilitiesResult = loadChurchAbilities();
  // M2.76：晋升仪式档位（按序列分档的阶段表）
  const ritualsResult = loadRituals();
  // M2.76：权柄（世界级能力的内容表）
  const authoritiesResult = loadAuthorities();
  // M2.85 内容填充 P1：塔罗牌（大阿卡那，读取点 .占卜）
  const tarotResult = loadTarot();
  // M2.85 内容填充 P1：神明（读取点 .图鉴 神明）
  const pantheonResult = loadPantheon();
  // M2.85 内容填充 P1：组织与势力（读取点 .图鉴 组织）
  const organizationsResult = loadOrganizations();
  // M2.85 内容填充 P1：人物（读取点 .图鉴 人物）
  const figuresResult = loadFigures();
  // M2.85 内容填充 P1：生物名录（读取点 .图鉴 生物）
  const bestiaryResult = loadBestiary();
  // M2.85 内容填充 P1：权柄与象征（读取点 .图鉴 权柄）
  const divineAuthoritiesResult = loadDivineAuthorities();
  // M2.85 内容填充 P6：晋升仪式要求（读取点 .仪式 准备）
  const advancementRitesResult = loadAdvancementRites();
  // M2.85 内容填充 P4：原作材料全表（读取点 .图鉴 材料）
  const originalMaterialsResult = loadOriginalMaterials();
  // M2.85 内容填充 P5：原作能力清单（读取点 .图鉴 能力）
  const pathwayAbilitiesResult = loadPathwayAbilities();
  const npcTracksResult = loadNpcTracks();
  const pathwayDeedsResult = loadPathwayDeeds();
  const npcCastResult = loadNpcCast();
  const fallenBeastsResult = loadFallenBeasts();
  const npcDispositionsResult = loadNpcDispositions();
  const equipmentResult = loadEquipment();
  const battleSkillsResult = loadBattleSkills();
  const questsResult = loadQuests();
  const fortunesResult = loadFortunes();
  // M2.87 交易体系：商店与物价（读取点 .商店 / .买 / .卖）
  const shopsResult = loadShops();
  const pricesResult = loadPrices();
  const items = itemsResult.items;
  const locations = locationsResult.locations;
  const recipes = recipesResult.recipes;
  const abilities = abilitiesResult.abilities;
  const regions = regionsResult.regions;
  const cities = citiesResult.cities;
  const routes = routesResult.routes;
  const factions = factionsResult.factions;
  const creatures = creaturesResult.creatures;
  const churches = churchesResult.churches;
  const churchAbilities = churchAbilitiesResult.abilities;
  const issues: DataIssue[] = [
    ...itemsResult.issues,
    ...locationsResult.issues,
    ...recipesResult.issues,
    ...abilitiesResult.issues,
    ...regionsResult.issues,
    ...citiesResult.issues,
    ...routesResult.issues,
    ...factionsResult.issues,
    ...creaturesResult.issues,
    ...churchesResult.issues,
    ...churchAbilitiesResult.issues,
    ...ritualsResult.issues,
    ...authoritiesResult.issues,
    ...tarotResult.issues,
    ...pantheonResult.issues,
    ...organizationsResult.issues,
    ...figuresResult.issues,
    ...bestiaryResult.issues,
    ...divineAuthoritiesResult.issues,
    ...advancementRitesResult.issues,
    ...originalMaterialsResult.issues,
    ...pathwayAbilitiesResult.issues,
    ...npcTracksResult.issues,
    ...pathwayDeedsResult.issues,
    ...npcCastResult.issues,
    ...fallenBeastsResult.issues,
    ...npcDispositionsResult.issues,
    ...equipmentResult.issues,
    ...battleSkillsResult.issues,
    ...questsResult.issues,
    ...fortunesResult.issues,

    ...shopsResult.issues,

    ...pricesResult.issues,
  ];

  const itemIds = new Set(items.map((i) => i.id));
  const locationIds = new Set(locations.map((l) => l.id));
  const locationById = new Map(locations.map((l) => [l.id, l]));
  const regionIds = new Set(regions.map((r) => r.id));
  const cityIds = new Set(cities.map((c) => c.id));

  for (const location of locations) {
    if (location.min_seq > location.max_seq && location.max_seq !== 0) {
      issues.push({ file: LOCATIONS_FILE, level: 'error', message: `${location.id}: min_seq 不能大于 max_seq` });
    }
    for (const loot of location.loot) {
      if (!itemIds.has(loot.itemId)) {
        issues.push({ file: LOCATIONS_FILE, level: 'error', message: `${location.id}: 掉落引用了未登记物品 ${loot.itemId}` });
      }
      if (loot.minQty > loot.maxQty) {
        issues.push({ file: LOCATIONS_FILE, level: 'error', message: `${location.id}: ${loot.itemId} 的 minQty 大于 maxQty` });
      }
    }
    for (const eventId of location.events) {
      if (options.cardIds && !options.cardIds.has(eventId)) {
        issues.push({ file: LOCATIONS_FILE, level: 'error', message: `${location.id}: 引用了不存在的事件卡 ${eventId}` });
      }
    }
    if (location.events.length === 0) {
      issues.push({ file: LOCATIONS_FILE, level: 'warn', message: `${location.id}: 没有绑定任何事件卡` });
    }
  }

  for (const recipe of recipes) {
    for (const need of [...recipe.main, ...recipe.aux]) {
      if (!itemIds.has(need.itemId)) {
        issues.push({ file: RECIPES_FILE, level: 'error', message: `${recipe.id}: 引用了未登记材料 ${need.itemId}` });
      }
    }
    const productId = potionProductId(recipe);
    if (!itemIds.has(productId)) {
      issues.push({ file: RECIPES_FILE, level: 'error', message: `${recipe.id}: 缺少成品物品定义 ${productId}` });
    }
  }

  /* ---------------- M2.7：地理交叉引用 ---------------- */
  // 城市引用的地点必须真的存在。写错一个 id 的后果很隐蔽：
  // 那座城市在菜单里少一个地方、在地图上看不出来，但玩家永远走不到它。
  for (const city of cities) {
    if (!regionIds.has(city.region_id)) {
      issues.push({ file: CITIES_FILE, level: 'error', message: `${city.id}: 引用了未登记的区域 ${city.region_id}` });
    }
    for (const locationId of city.locations) {
      if (!locationIds.has(locationId)) {
        issues.push({ file: CITIES_FILE, level: 'error', message: `${city.id}: 引用了未登记的地点 ${locationId}` });
      }
    }
  }
  // 区域声称的城市必须存在（区域表里的 cities 是冗余索引，但它一旦说谎就会误导内容同学）
  for (const region of regions) {
    for (const cityId of region.cities) {
      if (!cityIds.has(cityId)) {
        issues.push({ file: REGIONS_FILE, level: 'error', message: `${region.id}: 声称包含未登记的城市 ${cityId}` });
      }
    }
  }
  // 每条路线两端都必须是真实城市
  for (const route of routes) {
    for (const cityId of [route.from, route.to]) {
      if (!cityIds.has(cityId)) {
        issues.push({ file: ROUTES_FILE, level: 'error', message: `${route.id}: 引用了未登记的城市 ${cityId}` });
      }
    }
  }
  // 每座城市都必须有出路（除了孤岛）：没有任何一条路线连着它 = 出生在那儿就再也走不掉
  for (const city of cities) {
    const connected = routes.some((route) => route.from === city.id || route.to === city.id);
    if (!connected) {
      issues.push({ file: ROUTES_FILE, level: 'error', message: `${city.id}: 没有任何航线连着它，出生在这里就出不去了` });
    }
  }
  // 每个地点都必须属于某座城市：不在任何 City.locations 里的地点是"玩家看得见但去不了"的幽灵内容
  const claimed = new Set(cities.flatMap((city) => city.locations));
  for (const location of locations) {
    if (!claimed.has(location.id)) {
      issues.push({ file: CITIES_FILE, level: 'warn', message: `${location.id}: 不属于任何城市（不会被任何城市的玩家看到）` });
    }
  }

  /* ---------------- M2.7.6 / M2.85：本地势力交叉引用 ---------------- */
  /*
   * 本地势力写错（途径不在城市开放清单里）的后果，比地理表写错更隐蔽：
   * 玩家会接到一个「去某个不存在的地方」的任务，而任务永远不会完成 ——
   * 表现出来只是「这个人一直没入途径」，没有任何报错。
   */
  const cityById = new Map(cities.map((city) => [city.id, city]));
  for (const faction of factions) {
    const city = cityById.get(faction.cityId);
    if (!city) {
      issues.push({
        file: FACTIONS_FILE,
        level: 'error',
        message: `${faction.id}: 引用了未登记的城市 ${faction.cityId}`,
      });
      continue;
    }
    if (!city.pathways.includes(faction.pathway)) {
      issues.push({
        file: FACTIONS_FILE,
        level: 'error',
        message: `${faction.id}: 传承的途径 ${faction.pathway} 不在 ${city.id} 开放的途径里（玩家拿到配方也调制不了）`,
      });
    }
    /*
     * M2.85：tasks 的地点可达性校验随引导玩法删除 —— tasks 现在只是
     * 内容存档，运行时不再读它（schema 仍校验它的基本结构）。
     */
  }
  /*
   * 出生城市必须有本地势力。
   *
   * 这一条不是洁癖：线索的途径落点就是「本城势力名单」（rollRecipeClue）。
   * 一座能出生的城市没有本地势力，那里的玩家翻不到任何线索 ——
   * 而这件事在运行期完全看不出来，只会在报告里表现为「某个城市的玩家入不了途径」。
   */
  for (const city of cities) {
    if (city.birth_weight <= 0) continue;
    if (!factions.some((faction) => faction.cityId === city.id)) {
      issues.push({
        file: FACTIONS_FILE,
        level: 'error',
        message: `${city.id}: 是出生城市却没有本地势力，那里的玩家翻不到线索`,
      });
    }
  }

  /*
   * M2.26 第二批：**城市开放的每条途径，本城至少要有一家本地势力传承它。**
   *
   * 为什么（这是 K16 的第五个实例，而且它让两批小批的读数被误读了）：
   *   玩家入哪条途径，**不是**由画像偏好决定的 —— 是「本城势力名单」决定的：
   *     · 翻配方线索走的就是本城势力名单（rollRecipeClue → pickGuidedFaction）；
   *   两份名单（cities.yaml 的 pathways 与 factions.yaml 的 city + pathway）一旦不同步，
   *   那条途径在这座城市的**期望就是 0** —— 不是「低」，是 0；
   *   而跑批读数看起来跟「抽样运气不好」一模一样。
   *   M2.19 的 sailor、M2.26 第一批的 perfect、第二批的 reader 都栽在这里。
   *
   * 修法是**把一致性交给校验**（K16：见到手抄清单，先问权威清单在哪），
   *   而不是靠「加途径时记得回来改第二份表」。
   */
  for (const city of cities) {
    if (city.pathways.length === 0) continue;
    const inherited = new Set(
      factions.filter((faction) => faction.cityId === city.id).map((faction) => faction.pathway),
    );
    for (const pathway of city.pathways) {
      if (inherited.has(pathway)) continue;
      issues.push({
        file: FACTIONS_FILE,
        level: 'error',
        message:
          `${city.id}: 开放了 ${pathway} 途径，但这座城市的本地势力里没有一家传承它 —— ` +
          '配方线索只认本城势力，所以这条途径在这里的期望是 0（不是「低」）',
      });
    }
  }


  /* ---------------- M2.15：正神教会交叉引用 ---------------- */
  issues.push(...validateChurches(churches, cities, locations));
  // M2.17：教会技能的交叉校验（churchId 必须是登记过的教会、rank 不能超出档位数）
  issues.push(...validateChurchAbilities(churchAbilities, churches));

  /* ---------------- M2.7.7：配方材料的地理可达性 ---------------- */
  /*
   * 每座能出生的城市，必须能**在本地**凑齐它开放的每条途径的配方材料
   * （主材料 + 辅助材料），而且那些地点的 min_seq 必须是 9 ——
   * 因为拿配方的人必然是还没有序列的普通人。
   *
   * 为什么这条校验值得存在（M2.7.7 的 200×30 长窗口实测）：
   *   30 天后仍有 36.5% 是普通人，而其中 **55/73 卡在同一个地方** ——
   *   「辅助材料·月长石粉」在普利兹港与拜朗**没有任何 min_seq 9 的产出点**。
   *   那两座城市的不眠者玩家从拿到配方那天起就注定走不完，
   *   而运行期一声不响（只表现为「那两座城市入途径特别慢」）。
   *
   * KNOWN_MATERIAL_GAPS 是**已知缺口清单**，与 M2.7.6 处理「这座城市没人出生」同一手法：
   * 已知的写成 warn 并点名，未知的一律 error —— 这样既不让既有的缺口挡住启动，
   * 也不会让**新**的缺口静默通过。
   *
   * ## ★ 「传承城市」怎么来的（M2.30 任务 3 写死在这里）
   *
   *     for (const city of cities) for (const pathway of city.pathways) …
   *
   * ⇒ 取的是 **`cities.yaml` 里开放这条途径的城市**，而不是某家教会的 `seats`。
   *
   * ⚠️ **某途径没有教会时**（本版只有 `seer` 是这种情况），「传承城市」= **所有开放它的城市**
   * ⇒ **主材料与辅助材料必须在每一座都有产出点**。
   *
   * 这条规则是 M2.29 批次 A1 现场踩出来的：seer 的材料只放在 tingen 时，§0 报了 3 条 error
   * （backlund / trier / byron 各一条）。当时只在报告里处置了，没写进代码 —— 本轮补上。
   */
  const recipesByPathway = new Map<string, typeof recipes>();
  for (const recipe of recipes) {
    const list = recipesByPathway.get(recipe.pathway) ?? [];
    list.push(recipe);
    recipesByPathway.set(recipe.pathway, list);
  }
  for (const city of cities) {
    if (city.birth_weight <= 0) continue;
    for (const pathway of city.pathways) {
      /*
       * M2.12：**按配方自己的序列**决定要求的可达性门槛。
       *
       * 原来的实现写死 min_seq === 9，理由是「拿配方的人必然是还没有序列的普通人」——
       * 那句话只对 seq 9 的配方成立。序列 8 的配方是给**序列 8 的玩家**的，
       * 他要能去的是 min_seq ≥ 8 的地点（min_seq 的语义：玩家序列 ≤ min_seq 才能进）。
       *
       * 这条修正同时挡住了一个**死锁**：如果把序列 8 的材料只放在 min_seq 7 的地点里，
       * 序列 8 的人根本进不去 —— 材料永远拿不到，链路在纸面上存在、实际走不通。
       */
      for (const recipe of recipesByPathway.get(pathway) ?? []) {
      const requiredMinSeq = recipe.seq;
      for (const need of [...recipe.main, ...recipe.aux]) {
        const reachable = locations.some(
          (location) =>
            city.locations.includes(location.id) &&
            location.min_seq >= requiredMinSeq &&
            location.loot.some((loot) => loot.itemId === need.itemId),
        );
        if (reachable) continue;
        const key = city.id + ':' + need.itemId;
        if (KNOWN_MATERIAL_GAPS.includes(key)) {
          issues.push({
            file: RECIPES_FILE,
            level: 'warn',
            message:
              key + '：这座城市没有 min_seq 9 的产出点（**已知缺口**，M2.7.7 长窗口发现，待单独立项）',
          });
          continue;
        }
        issues.push({
          file: RECIPES_FILE,
          level: 'error',
          message:
            city.id + ' 传承 ' + pathway + '（序列 ' + recipe.seq + ' 的配方），但' + need.itemId +
            ' 在这座城市没有 min_seq ≥ ' + requiredMinSeq + ' 的产出点 ——' +
            ' 这里的玩家拿到配方也走不完（他到不了那些地点）。' +
            '【规则】「传承城市」= cities.yaml 里开放这条途径的城市；无教会的途径（如 seer）' +
            '等于**所有开放它的城市**，所以材料必须在每一座都有产出点（详见本函数上方的注释）',
        });
      }
      }
    }
  }

  /* ---------------- M2.8：物种模板的交叉引用 ---------------- */
  /*
   * 物种是「一处声明，四处生效」的那个点，所以它写错的后果也是四处扩散的：
   *   habitat 写错 → 这只生物永远不会出现在世界里（没有出生点），运行期一声不响
   *   drops 写错   → 玩家辛辛苦苦观察本质，采到一个不存在的物品
   *   pathwayAffinity 拼错 → 只是不命中任何玩家（静默降级，所以只 warn）
   * 前两类一律 error：它们不会自己好，也不会被人发现。
   */
  const implementedPathways = new Set<string>();
  for (const recipe of recipes) implementedPathways.add(recipe.pathway);
  const plannedPathways = new Set<string>();
  for (const city of cities) {
    for (const pathway of city.planned_pathways) plannedPathways.add(pathway);
  }
  for (const species of creatures) {
    for (const locationId of species.habitat) {
      if (!locationIds.has(locationId)) {
        issues.push({
          file: CREATURES_FILE,
          level: 'error',
          message: `${species.id}: 栖息地引用了未登记的地点 ${locationId}（这只生物永远不会出现）`,
        });
      }
    }
    for (const drop of species.drops) {
      if (!itemIds.has(drop.itemId)) {
        issues.push({
          file: CREATURES_FILE,
          level: 'error',
          message: `${species.id}: 掉落引用了未登记物品 ${drop.itemId}`,
        });
      }
    }
    for (const pathway of species.pathwayAffinity) {
      if (implementedPathways.has(pathway) || plannedPathways.has(pathway)) continue;
      issues.push({
        file: CREATURES_FILE,
        level: 'warn',
        message:
          `${species.id}: 途径亲和 ${pathway} 既不是已实现的途径、也不在任何城市的 planned_pathways 里` +
          '（拼错了？它不会命中任何玩家，只会静默降级）',
      });
    }
  }
  /*
   * M2.58：生态关系网的交叉引用（"不排斥现有数据"的那道护栏）。
   *
   * 关系段是**可选**的 —— 没写的物种逐位沿用 M2.8 的序列差规则，
   * 所以这里不校验"有没有写"，只校验"写了的部分对不对"。
   *
   * 两类错，都是 error 而不是 warn：
   *   - 关系里引用了不存在的物种 id：那条边永远不会生效，
   *     而症状只是"捕食次数偏低"，有太多别的原因可以解释它；
   *   - 自己吃自己 / 自己寄生自己：生态 tick 会把它当成一条真实关系跑起来。
   */
  const speciesIds = new Set(creatures.map((species) => species.id));
  for (const species of creatures) {
    const relations = species.relations;
    if (relations === undefined) continue;
    const lists: Array<[string, readonly string[]]> = [
      ['prey', relations.prey],
      ['predators', relations.predators],
      ['symbiosis', relations.symbiosis],
      ['parasite', relations.parasite],
    ];
    for (const [field, ids] of lists) {
      for (const otherId of ids) {
        if (otherId === species.id) {
          issues.push({
            file: CREATURES_FILE,
            level: 'error',
            message: species.id + ': relations.' + field + ' 引用了自己（生态 tick 会把它当成一条真实关系跑起来）',
          });
          continue;
        }
        if (!speciesIds.has(otherId)) {
          issues.push({
            file: CREATURES_FILE,
            level: 'error',
            message: species.id + ': relations.' + field + ' 引用了未登记的物种 ' + otherId + '（这条关系永远不会生效）',
          });
        }
      }
    }
  }
  /*
   * 双向一致性：A 吃 B 时，B 的 predators 里应当有 A。
   *
   * 口径是 **warn 不是 error** —— 只写一边在功能上是够的（见 canPreyOn 规则 1：
   * 正向与反向任一条命中即吃得到）。把它判成 error 会让"先写正向、回头补反向"
   * 这个完全正常的编辑过程启动不了。但它值得提醒，因为不补的话，
   * "这张网长什么样"就要看两个地方才知道。
   */
  const relationsById = new Map(
    creatures.map((species) => [species.id, species.relations] as const),
  );
  for (const species of creatures) {
    const relations = species.relations;
    if (relations === undefined) continue;
    for (const preyId of relations.prey) {
      const back = relationsById.get(preyId)?.predators;
      if (back === undefined) continue;
      if (back.includes(species.id)) continue;
      issues.push({
        file: CREATURES_FILE,
        level: 'warn',
        message:
          species.id + ' 声明吃 ' + preyId + '，但 ' + preyId + '.relations.predators 里没有 ' + species.id +
          '（两边都写才能一眼看出这张网长什么样）',
      });
    }
  }
  /*
   * "一个声明了关系的物种，四条边一条都没有"是最安静的一种内容错：
   * 它在世界里照常存在、照常被遇到，只是与谁都不发生关系 ——
   * 表现出来和"没写 relations"几乎一样，但那其实是两种不同的状态。
   */
  for (const species of creatures) {
    const relations = species.relations;
    if (relations === undefined) continue;
    const total =
      relations.prey.length +
      relations.predators.length +
      relations.symbiosis.length +
      relations.parasite.length;
    if (total > 0) continue;
    issues.push({
      file: CREATURES_FILE,
      level: 'warn',
      message: species.id + ': 声明了 relations 但四条边全空（它是一个孤立点，与谁都不发生关系）',
    });
  }

  /*
   * 「这个物种谁都遇不到」是**最隐蔽**的一种内容错：
   * 它的栖息地都在别的城市，而出生城市没有任何物种 —— 于是整座城的玩家永远碰不到生物，
   * 表现出来只是「那里的雾比较安静」。至少保证每个能出生的城市都有物种落脚。
   */
  for (const city of cities) {
    if (city.birth_weight <= 0) continue;
    const reachable = creatures.some((species) =>
      species.habitat.some((locationId) => city.locations.includes(locationId)),
    );
    if (!reachable) {
      issues.push({
        file: CREATURES_FILE,
        level: 'warn',
        message: `${city.id}: 是出生城市，但没有任何物种以它为栖息地（那里的玩家一辈子遇不到生物）`,
      });
    }
  }

  /* ---------------- M2.35 任务 1：链路检查（三项） ---------------- */
  /*
   * 放在**最后**是有意的：它们检查的是「前面那些校验都过了之后，链路通不通」。
   * 文件级校验（schema / 交叉引用）对下面三种故障天然免疫，而它们正是
   * M2.26 / M2.29 / M2.33 三个坑的形状（**文件都在、校验都过、服务端起得来，链路是断的**）：
   *
   *   ① 配方缺一层（seq 7 缺 7 条，M2.32 靠人翻表才发现）；
   *   ② 配置没有生产读取点（sequenceGating.planned，M2.28 登记、M2.33 才接上）；
   *   ③ 内容做完但跑批够不到（序列 6/5，M2.29 实测一个人都没到）。
   *
   * error 级 ⇒ 服务端起不来（K17：内容层的错不该等到跑批才发现）。
   * 判据、清单与口径**全在 src/data/link-check.ts**（唯一出处，K22）——
   * 这里只喂数据，不写任何判据。
   */
  issues.push(
    ...checkLinks({
      pathways: OPEN_PATHWAYS,
      recipes,
      cities,
      factions,
      churches,
      creatures,
      // M2.71 第 5 项：区域传承的途径 / 城市声明的势力 —— 两条一致性判据要读它们
      regions,
      geoCities: cities,
    }).issues,
  );

  /*
   * M2.58 阶段二：生态域。最后装载，因为它的校验要拿到**全部地点 id** ——
   * 「域引用了不存在的地点」这条判据只有在 locations 读完才成立。
   */
  const zonesResult = loadZones(ZONES_FILE, new Set(locations.map((location) => location.id)));
  issues.push(...zonesResult.issues);
  const zones = zonesResult.zones;

  /*
   * M2.59：文明势力。同样最后装载 —— 「home_region 引用了不存在的区域」
   * 这条判据只有在 regions 读完才成立。
   */
  const powersResult = loadPowers(POWERS_FILE, new Set(regions.map((region) => region.id)));
  issues.push(...powersResult.issues);
  const powers = powersResult.powers;

  /*
   * M2.61：初始历史。最后装载 —— 它的四条后果要同时引用势力 / 地点 / 区域，
   * 只有三张表都读完，那四条交叉校验才成立。
   */
  const historyResult = loadHistory(HISTORY_FILE, {
    powers: new Set(powers.map((power) => power.id)),
    locations: new Set(locations.map((location) => location.id)),
    regions: new Set(regions.map((region) => region.id)),
  });
  issues.push(...historyResult.issues);
  const history = historyResult.history;

  /*
   * M2.62：边界输入。同样最后装载 —— 它的校验要拿到全部地点与区域 id。
   */
  const boundariesResult = loadBoundaries(BOUNDARIES_FILE, {
    locations: new Set(locations.map((location) => location.id)),
    regions: new Set(regions.map((region) => region.id)),
  });
  issues.push(...boundariesResult.issues);
  const boundaries = boundariesResult.boundaries;
  const foreignPowers = boundariesResult.foreignPowers;

  const rituals = ritualsResult.rituals;
  const authorities = authoritiesResult.authorities;
  const tarot = tarotResult.tarot;
  const pantheon = pantheonResult.pantheon;
  const organizations = organizationsResult.organizations;
  const figures = figuresResult.figures;
  const bestiary = bestiaryResult.bestiary;
  const divineAuthorities = divineAuthoritiesResult.divineAuthorities;
  const advancementRites = advancementRitesResult.rites;
  const originalMaterials = originalMaterialsResult.materials;
  const pathwayAbilities = pathwayAbilitiesResult.abilities;
  const npcTracks = npcTracksResult.tracks;
  const pathwayDeeds = pathwayDeedsResult.deeds;
  const npcCast = npcCastResult.cast;
  const npcDispositions = npcDispositionsResult.dispositions;
  /*
   * M2.164：**名册的引用校验**（与神座表同一手法，见 loadDivineThrones）。
   *
   * 放在这里而不是 loadNpcCast 里面：它要查**别的表**（城市 / 地点 / 势力 / 组织 / 教会 / 途径），
   * 而那些表只有在 loadContent 里才全部就位。
   *
   * ⚠️ 分开的代价是「谁调用谁负责」—— 所以 m2-164 的用例不直接调 checkNpcCastRefs，
   * 而是走 loadContentOrThrow，把这条防线钉在**真实加载路径**上。
   */
  issues.push(...checkNpcCastRefs(npcCast, {
    file: NPC_CAST_FILE,
    tracks: new Set(npcTracks.map((t) => t.id)),
    cities: new Map(cities.map((c) => [c.id, c.locations ?? []])),
    locations: new Set(locations.map((l) => l.id)),
    factions: new Set(factions.map((f) => f.id)),
    organizations: new Set(organizations.map((o) => o.id)),
    churches: new Set(churches.map((c) => c.id)),
    pathways: new Set(Object.keys(PATHWAY_LABELS)),
  }));
  /*
   * M2.99 神座表 —— **在这里装载，而不是在 app 里**（M2.164 补上的缺口）。
   *
   * 在这之前 app.ts 写的是 `loadDivineThrones(...).divineThrones`：**校验结果被丢掉了**。
   * 后果不是报错，而是静默失效 —— 实测 `resources.reach` 里写着两个地点 id
   * （backlund_slum / backlund_underground），而神座的引用校验一声不吭：
   * 那两处「够得到的城市」永远匹配不上，决策引擎安静地按错的 reach 算。
   *
   * 现在它走 loadContent：error 级并进 issues ⇒ loadContentOrThrow 让服务端起不来。
   */
  /*
   * M2.169：关系网与神座表一起装载 —— 它的交叉校验要查「途径 id 在不在神座里」，
   * 而那两份表在这里才都就位。
   */
  const divineThronesResult = loadDivineThrones(DIVINE_THRONES_FILE, {
    npcTracks: new Set(npcTracks.map((t) => t.id)),
    churches: new Set(churches.map((c) => c.id)),
    powers: new Set(powers.map((p) => p.id)),
    cities: new Set(cities.map((c) => c.id)),
  });
  issues.push(...divineThronesResult.issues);
  const divineThrones = divineThronesResult.divineThrones;
  /*
   * M2.169：关系网**排在神座之后** —— 它的交叉校验要查「这两端的途径在不在神座里」，
   * 而那需要神座已经读完。
   */
  const divineRelationsResult = loadDivineRelations(DIVINE_RELATIONS_FILE, {
    pathways: new Set(divineThrones.map((t) => t.pathway)),
  });
  issues.push(...divineRelationsResult.issues);
  const divineRelations = divineRelationsResult.relations;
  /*
   * M2.167：**堕落生物的引用校验** —— 形态 id 指向 cards/lost-control.yaml 的 forms，
   * 掉落指向 items。两条都是「写错了不报错、只是安静地不生效」的那一类。
   */
  const fallenBeasts = fallenBeastsResult.fallenBeasts;
  issues.push(...checkFallenBeastRefs(fallenBeasts, {
    file: FALLEN_BEASTS_FILE,
    forms: lostFormIds(),
    items: new Set(items.map((i) => i.id)),
  }));
  const equipment = equipmentResult.equipment;
  const battleSkills = battleSkillsResult.battleSkills;
  const quests = questsResult.quests;
  const fortunes = fortunesResult.fortunes;

  return {
    items, locations, recipes, abilities, regions, cities, routes, factions, creatures,
    zones, powers, history, boundaries, foreignPowers, churches, churchAbilities, rituals, authorities, tarot, pantheon,
    organizations, figures, bestiary, divineAuthorities, advancementRites, originalMaterials, pathwayAbilities, npcTracks, npcCast, fallenBeasts, pathwayDeeds, npcDispositions, divineThrones, divineRelations, equipment, battleSkills, quests, fortunes,
    shops: shopsResult.shops,
    prices: pricesResult.prices,
    issues,
  };
}

export function loadContentOrThrow(options: { cardIds?: ReadonlySet<string> } = {}): ContentBundle {
  const bundle = loadContent(options);
  const errors = bundle.issues.filter((i) => i.level === 'error');
  if (errors.length > 0) {
    throw new Error(`内容数据存在 ${errors.length} 个 error：\n${errors.map((e) => `  ${e.message}`).join('\n')}`);
  }
  return bundle;
}

/**
 * 读运维节奏。
 *
 * ⚠️ **读不到时不抛，返回内置默认值。**
 *
 * 理由是它与内容表**性质不同**：内容表的错必须拒绝启动（那是「卡写错了」），
 * 而这份配置决定的是「世界多久说一次话」—— 它读不到时最该做的是**照常跑起来**，
 * 用一份合理的默认节奏，然后在日志里说一声。
 * 让一个运维参数把整个服务拦在门外，是把小故障放大成大故障。
 */
export function loadOpsSettings(file: string = OPS_SETTINGS_FILE): OpsSettings {
  const fallback: OpsSettings = {
    meta: {},
    world_tick: { min_minutes: 25, max_minutes: 95, note: '' },
    daily_check_minutes: 1,
  };
  let raw: unknown = null;
  try {
    raw = readYaml(file);
  } catch {
    return fallback;
  }
  const parsed = parseOpsSettings(raw);
  return parsed.ok ? parsed.settings : fallback;
}

/**
 * **神座**（M2.99）：二十二条途径的序列 0 —— 谁在位、谁空着、谁正在被争夺。
 *
 * 与 `pantheon.yaml` 的分工写在 `domain/world/divine-throne.ts` 的开头：
 * 那张表说「神是谁」，这张表说「神在不在于这个位置」。
 *
 * 交叉校验三件事（都是 error 级 —— 数据写错会让决策引擎安静地做错事）：
 *   ① `claimant` 必须是 `npc-tracks.yaml` 里有的 NPC（否则「正在往上爬的那位」是编的）
 *   ② `resources.churches` / `factions` / `reach` 要连到真实的教会 / 势力 / 城市
 *   ③ 每个 `methods[].goal` 必须是这位神自己的目标之一（对不上的手段永远不会被选中）
 */
export function loadDivineThrones(
  file: string = DIVINE_THRONES_FILE,
  ids: {
    npcTracks?: ReadonlySet<string>;
    churches?: ReadonlySet<string>;
    powers?: ReadonlySet<string>;
    cities?: ReadonlySet<string>;
  } = {},
): { divineThrones: DivineThrone[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  const divineThrones: DivineThrone[] = [];
  let raw: unknown = null;
  try {
    raw = readYaml(file);
  } catch (error) {
    issues.push({ file, level: 'warn', message: '读不到神座表（' + (error as Error).message + '）：众神沉寂' });
    return { divineThrones, issues };
  }
  const parsed = DivineThroneFileSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({ file, level: 'error', message: issue.path.join('.') + '：' + issue.message });
    }
    return { divineThrones, issues };
  }
  const seen = new Set<string>();
  for (const throne of parsed.data.divine_thrones) {
    if (seen.has(throne.pathway)) {
      issues.push({ file, level: 'error', message: '这条途径出现了两次：' + throne.pathway });
      continue;
    }
    seen.add(throne.pathway);
    const check = (where: string, value: string, set: ReadonlySet<string> | undefined): void => {
      if (set === undefined || value === '') return;
      if (!set.has(value)) issues.push({ file, level: 'error', message: where + ' 引用了不存在的 ' + value });
    };
    check(throne.pathway + '.claimant', throne.claimant, ids.npcTracks);
    for (const id of throne.resources.churches) check(throne.pathway + '.resources.churches', id, ids.churches);
    /*
     * ⚠️ M2.164：`none` 是**哨兵值**（无主 / 伸手够不到任何势力），不是 powers 表里的 id。
     * 与 `cities.factions` 同一口径：合法但不在任何表里，所以要显式放行 ——
     * 不放行的后果是 12 条 error（全是假警报，真值是对的）。
     */
    for (const id of throne.resources.factions) {
      if (id === 'none') continue;
      check(throne.pathway + '.resources.factions', id, ids.powers);
    }
    for (const id of throne.resources.reach) check(throne.pathway + '.resources.reach', id, ids.cities);
    // ③ 手段的目标必须是这位神自己的目标之一
    const goals = new Set(throne.goals.map((g) => g.id));
    for (const method of throne.methods) {
      if (method.goal !== '' && !goals.has(method.goal)) {
        issues.push({
          file,
          level: 'error',
          message: throne.pathway + '.' + method.id + ' 的目标 ' + method.goal + ' 不在它的 goals 里 —— 这条手段永远不会被选中',
        });
      }
    }
    divineThrones.push(throne);
  }
  return { divineThrones, issues };
}