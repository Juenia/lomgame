import { INITIATION, NUMERIC } from '../../config/numeric.ts';
import { birthCityOf } from '../../domain/geo/index.ts';
import { CURRENCY_ITEM_ID } from '../../domain/item/item.ts';
import type { City } from '../../domain/geo/types.ts';
import { newCharacterId } from '../../infra/ids.ts';
import type { CharacterState, Gender, PathwayId } from '../../domain/character/types.ts';
import { PATHWAY_ALIASES, PATHWAY_LABELS } from '../../domain/character/rules.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { setCurrentLocation } from './wanted-hooks.ts';
import { GROUP_MENU_HINT } from './common.ts';
import { MENU_TYPE_CREATE, createMenuOwner } from './create-menu.ts';

export const CREATE_USAGE = '用法：.创建 姓名（例：.创建 克莱恩）';
export const MAX_NAME_LENGTH = 16;

/** 性别选择的写法：回 1 / 2，或者直接写「男」「女」都认 */
export const GENDER_ALIASES: Readonly<Record<string, Gender>> = {
  男: 'male',
  男性: 'male',
  '1': 'male',
  male: 'male',
  女: 'female',
  女性: 'female',
  '2': 'female',
  female: 'female',
};

export const GENDER_LABELS: Readonly<Record<Gender, string>> = {
  male: '男性',
  female: '女性',
};

/**
 * 纯函数：只负责校验与构造初始角色，不碰数据库（落库由路由/服务负责）。
 *
 * **M2.7.6：创建出来的是一张白纸。**
 *   pathway = null、sequence = null —— 玩家还不知道「途径」是什么，
 *   更不知道自己会走哪一条。他要先被人找上（保底），或者自己翻出一张配方。
 *
 * 初始数值按任务书 §2.1：HP 100 / MP 50 / AP 5 / DIG 0 / MAD 0 / COR 0。
 * MP 给 50 而不是 100 是有意的：普通人没有灵性上的训练，上限就是 50
 * （NUMERIC.initiation.mortalCaps.mp），入了途径之后才会被放开到 100。
 */
export function buildInitialCharacter(input: {
  userId: string;
  name: string;
  gender: Gender;
  now: number;
  id?: string;
  /** M2.7：出生城市（缺省 null = 还没落在任何城市，地理判定一律不限制） */
  cityId?: string | null;
}): CharacterState {
  return {
    id: input.id ?? newCharacterId(input.userId),
    userId: input.userId,
    name: input.name,
    pathway: null,
    sequence: null,
    pathwayStatus: 'mortal',
    gender: input.gender,
    hp: 100,
    mp: INITIATION.mortalCaps.mp,
    mad: 0,
    cor: 0,
    dig: 0,
    dp: 0,
    status: 'active',
    promotionFails: 0,
    currentCityId: input.cityId ?? null,
    // M2.16：新角色一定未入教（church_id NULL、贡献 0）—— 写出来而不是留空，
    // 这样「刚建出来的卡」与「从库里读回来的卡」逐字段相等（infra 的仓储用例建立在这条上）
    churchId: null,
    churchContribution: 0,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/**
 * 第一步：问性别。
 *
 * 为什么要有这一步（任务书补充 §1.1）：性别是角色的属性，而创建是玩家
 * 唯一一次「定义自己是谁」的机会。做成一句问话 + 两个选项，而不是一个表单。
 *
 * 选项的 command 里带着姓名：.创建 克莱恩 男。
 * 于是「玩家想创建谁」这件事**不需要额外的存储** —— 它就写在菜单里，
 * 而菜单本来就要落 pending_menus。
 */
export function renderGenderPrompt(
  name: string,
  city: City | null,
): { text: string; options: Array<{ key: string; label: string; command: string }> } {
  return {
    text: [
      '【创建角色】',
      ...(city ? [`你落在${city.name}。`] : []),
      '在开始之前，先告诉我们：你是男性还是女性？',
      '',
      '1. 男性',
      '2. 女性',
    ].join('\n'),
    options: [
      { key: '1', label: '男性', command: `创建 ${name} 男` },
      { key: '2', label: '女性', command: `创建 ${name} 女` },
    ],
  };
}

/** 创建完成的回执（任务书 §5.1：城市简介 + 一句氛围 + 「你还不知道自己会变成什么。」） */
export function renderCharacterCreated(state: CharacterState, city: City | null): string {
  const cityName = city?.name ?? '廷根市';
  const flavor = city?.flavor?.trim();
  return [
    '【创建角色】',
    '',
    `你出生在${cityName}。`,
    ...(flavor ? [flavor] : []),
    '',
    '你还不知道自己会变成什么。',
    '先四处走走吧 —— .今日 会给你推荐。',
    '',
    `姓名：${state.name}（${GENDER_LABELS[state.gender]}）`,
    `HP/MP：${state.hp}/${state.mp}`,
    `盘缠：${NUMERIC.geo.startingPenny} 便士`,
    '',
    '接下来：',
    '1. .探索 老码头 —— 四处走走。普通人看到的雾，和以后看到的不一样',
    '2. .状态 —— 看看自己现在是什么样（还没有途径，也没有序列）',
    '3. .线索 —— 手上有哪几张配方线索、主材料去哪里找',
    '',
    '运气好（或者待够几天），探索时你会翻到一张写着主材料的纸。',
    '（发送 .帮助 看全部指令）',
  ].join('\n');
}

/**
 * 旧流程的明确拒绝文案（任务书 §5.1：旧流程彻底删除，不保留）。
 *
 * 为什么不是「忽略第二个参数」：老玩家会本能地发 .创建 姓名 愚者，
 * 一句「未识别」会让他以为是指令写错了 —— 而这里要说清楚的是**设计变了**。
 */
export function legacyCreateRejected(pathway: PathwayId, name: string): string {
  return [
    `${PATHWAY_LABELS[pathway]}不是你现在能选的东西。`,
    '',
    '人不会一出生就知道自己要走哪条路 —— 你是先活着，然后才被人找上，',
    '或者在某个旧书摊上翻出一张纸。',
    '',
    `重新开始：.创建 ${name}`,
  ].join('\n');
}

/** 处理 .创建 */
export async function handleCreate(ctx: CommandContext): Promise<CommandResult> {
  const { msg, args, now, deps } = ctx;

  if (args.length === 0 || args.length > 2) {
    return { privateText: CREATE_USAGE, detailToPrivate: true };
  }

  const name = args[0]!.trim();
  const second = args[1]?.trim();

  if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
    return { privateText: `姓名长度需 1—${MAX_NAME_LENGTH} 字。`, detailToPrivate: true };
  }
  if (deps.sensitive.hit(name)) {
    return { privateText: '这个姓名包含违规内容，换一个吧。', detailToPrivate: true };
  }

  if (deps.characters.findByUserId(msg.userId)) {
    return {
      privateText: '你已经创建过角色了。发送 .状态 查看当前角色。',
      groupText: `【${name}】你已经有角色了。`,
      detailToPrivate: true,
    };
  }

  /*
   * M2.7：出生地是**派生**出来的，不是掷骰子 —— birthCityOf(userId) 保证同一个人
   * 永远落在同一座城市。任务书 §4.3 要求「出生是一次性的，不允许重选」；
   * 如果每次 .创建 都重掷，玩家只要反复重发就能刷到想要的城市，那等于可以重选。
   */
  const birthCity = birthCityOf(msg.userId, deps.geo.birthCities());

  // 只有一个参数 = 第一步：还没有选性别
  if (!second) {
    const prompt = renderGenderPrompt(name, birthCity);
    const opened = deps.pendingMenus.openWith(
      createMenuOwner(msg.userId),
      MENU_TYPE_CREATE,
      {
        title: '【创建角色】',
        context: [`你落在${birthCity.name}。`, '在开始之前，先告诉我们：你是男性还是女性？'],
        options: prompt.options,
        allowFreeform: false,
      },
      now,
    );
    return {
      privateText: opened.text,
      detailToPrivate: true,
      menuOpened: true,
      interactive: opened.interactive,
    };
  }

  /*
   * 第二步：.创建 姓名 男 / 女。
   *
   * 任务书补充 §5.1：旧流程 .创建 姓名 途径 **彻底删除**（不是保留）。
   * 保留会让玩家直接跳过整个普通人阶段，而这一轮的全部内容都长在那个阶段上。
   */
  const gender = GENDER_ALIASES[second];
  if (!gender) {
    const pathway = PATHWAY_ALIASES[second];
    if (pathway) return { privateText: legacyCreateRejected(pathway, name), detailToPrivate: true };
    return {
      privateText: `没有「${second}」这个选项。${CREATE_USAGE}`,
      detailToPrivate: true,
    };
  }

  const character = buildInitialCharacter({
    userId: msg.userId,
    name,
    gender,
    now,
    cityId: birthCity.id,
  });
  try {
    deps.characters.ensureUser(msg.userId, msg.nickname, now);
    deps.characters.insert(character);
  } catch (error) {
    // 并发下唯一约束兜底：两个并发 .创建 只会有一个成功
    if (String((error as Error).message).includes('UNIQUE')) {
      return { privateText: '你已经创建过角色了。发送 .状态 查看当前角色。' };
    }
    throw error;
  }

  /*
   * 启程盘缠（numeric.geo.startingPenny）。
   * 为什么新号要有钱：跨城移动最低一档 20 便士，而实测探索产出约每人每天 2 便士
   * （每次探索抽 1 件掉落，便士在自己城市的权重约三成、数量 1—3），
   * MVP 又没有卖出渠道 —— 身无分文的新号在头两周根本走不出出生城市，
   * 「移动」这条玩法在实例测试里会永远零覆盖。30 便士 = 一次最便宜的陆路 + 一点余量。
   */
  deps.inventory.add(character.id, CURRENCY_ITEM_ID, NUMERIC.geo.startingPenny, 'unbound', now);
  /*
   * 落地点：出生城市的城区。
   * 通缉系统读的是 flags.loc（地点级），城市的城区必须同时写下去 ——
   * 否则新号会以「没有位置」的状态开局，而 null 在判定层等价于无主地点（安全区）。
   */
  setCurrentLocation(deps, character.id, birthCity.center, now);

  deps.characters.appendEvents([
    {
      type: 'character_created',
      characterId: character.id,
      payload: {
        name,
        gender,
        // M2.7.6：创建时**没有**途径。这两个 null 是这一轮最重要的两条记录 ——
        // 「他是什么时候知道自己是愚者的」将来要靠它们回答。
        pathway: null,
        sequence: null,
        pathwayStatus: 'mortal',
        cityId: birthCity.id,
        startingPenny: NUMERIC.geo.startingPenny,
      },
      reason: '创建角色（普通人）',
      createdAt: now,
    },
  ]);

  return {
    privateText: renderCharacterCreated(character, birthCity),
    groupText: `【${msg.nickname || msg.userId}】在${birthCity.name}出生了。他什么都不知道。`,
    detailToPrivate: true,
  };
}