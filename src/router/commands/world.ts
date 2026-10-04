/**
 * .世界 指令（M2.2）
 *
 *   群聊：一段摘要（时段 / 月相 / 雾日 + 所有地点的天气一览）
 *   私聊：同一份摘要 + 带编号的地点列表（回 1—11 看某个地点的详情）
 *   .世界 <地点名|编号>：该地点的详细天气 + 影响 + 预告
 *
 * 纯读：只查 world_state / location_weather / locations，不推进 tick（推进由路由统一做）。
 */
import { dangerLabel } from '../../domain/explore/explore.ts';
import { AUTHORITY_KIND_LABELS, activeAuthorities, hoursLeft } from '../../domain/world/authority-effects.ts';
import { hl } from '../../adapter/highlight.ts';
import { EMOJI, withEmoji } from '../../domain/emoji.ts';
import {
  clockLabel,
  moonPhaseLabel,
  nextFogDay,
  TIME_OF_DAY_LABELS,
  worldClock,
  type WorldClock,
} from '../../domain/world/clock.ts';
import {
  findWeather,
  isEpicWeather,
  rollWeatherAt,
  weatherEffectLines,
  weatherLabel,
  weatherWeightContext,
  worldModifiers,
  type WeatherId,
  type WeatherState,
} from '../../domain/world/weather.ts';
import type { Menu, MenuOption } from '../../domain/menu/index.ts';
import type { City, Region } from '../../domain/geo/types.ts';
import { loadLocations } from '../../data/loader.ts';
import type { LocationDef } from '../../domain/explore/location.ts';
import { PATHWAY_LABELS } from '../../domain/character/rules.ts';
import { parsePositiveInt } from '../args.ts';
import type { CommandContext, CommandResult, RouterDeps } from '../index.ts';
import { renderWorldMap } from '../../world/map.ts';
// M2.164：死者与归来者（.世界 死者）
import { DEATH_KIND_LABELS, RETURN_FORM_LABELS, type DeathKind, type ReturnForm } from '../../domain/world/npc-life.ts';
import { dateKey } from '../../infra/date.ts';

/**
 * M2.85 内容填充 P2：原作的城市类型（`city_type`）在 YAML 里保持**原文英文**，
 * 展示时转中文 —— 翻译是展示层的事，不改内容。
 */
const CITY_TYPE_LABELS: Record<string, string> = {
  capital: '首都', city: '城市', port: '港口', town: '城镇',
  village: '村落', historic: '历史城市', otherworld: '异空间城市',
};

/**
 * M2.85 内容填充 P2：**城市档案**（原作设定字段的执行点）。
 *
 * 原作数据里每座城市都有别名 / 特征 / 城区 / 地标 / 人口 —— 没有这一段，
 * 它们就是「只写着没人读」的字段（AGENTS 明令禁止）。
 *
 * ⚠️ 菜单路径与纯文本路径**共用这一个函数**：私聊走 pendingMenus.open()（不是 lines），
 * 只往 lines 里加会让档案在私聊里消失 —— 这正是第一版写错的地方，测试当场抓到了。
 */
function cityProfile(city: City): string[] {
  const profile: string[] = [`【${city.name}】`];
  const kind = city.city_type === '' ? '' : ` · ${CITY_TYPE_LABELS[city.city_type] ?? city.city_type}`;
  if (city.country !== '' || city.city_type !== '') {
    profile.push(`所属：${city.country}${kind}${city.status === '' ? '' : '（' + city.status + '）'}`);
  }
  if (city.population !== '') profile.push(`人口：${city.population}`);
  if (city.aliases.length > 0) profile.push(`别名 / 旧称：${city.aliases.join('、')}`);
  if (city.features.length > 0) {
    profile.push('', '这座城市：');
    for (const feature of city.features.slice(0, 4)) profile.push(`> ${feature}`);
  }
  if (city.districts.length > 0) {
    profile.push('', '城区：');
    for (const district of city.districts) profile.push(`> ${district.name}${district.note === '' ? '' : ' —— ' + district.note}`);
  }
  if (city.notable_places.length > 0) profile.push('', `地标：${city.notable_places.join('、')}`);
  return profile;
}

/**
 * M2.85 内容填充 P2：**区域档案**（原作国家设定字段的执行点）。
 * 执行点：`.世界 区域 <名>`。
 */
function regionProfile(region: Region, deps: RouterDeps): string {
  const kind = region.type === 'sea' ? '海域' : region.type === 'island' ? '岛屿' : '国家 / 大陆';
  const lines: string[] = [`【${region.name}】${kind}`];
  if (region.name_en !== '') lines.push(`英文：${region.name_en}`);
  if (region.continent !== '') lines.push(`位置：${region.continent}`);
  if (region.government !== '') lines.push(`政体：${region.government}`);
  if (region.capital !== '') lines.push(`首都：${region.capital}`);
  if (region.language !== '') lines.push(`语言：${region.language}`);
  if (region.currency !== '') lines.push(`货币：${region.currency}`);
  if (region.state_religion.length > 0) lines.push(`国教：${region.state_religion.join('、')}`);
  if (region.royal_pathway !== '') lines.push(`皇室途径：${region.royal_pathway}`);
  if (region.status !== '') lines.push(`状态：${region.status}`);
  const cities = deps.geo.cities.filter((city) => city.region_id === region.id);
  lines.push('', `所辖城市：${cities.length > 0 ? cities.map((city) => city.name).join('、') : '（暂无）'}`);
  const pathwayLabels = PATHWAY_LABELS as Record<string, string>;
  lines.push(`传承途径：${region.pathways.length > 0 ? region.pathways.map((p) => pathwayLabels[p] ?? p).join('、') : '（原作未载）'}`);
  lines.push(`危险度：×${region.danger.toFixed(2)}`);
  if (region.origin !== '') lines.push('', region.origin);
  return lines.join('\n');
}

export const WORLD_USAGE =
  '用法：.世界 看世界地图与本城天气；.世界 全部 看全境 58 处；' +
  '.世界 城市 <名> 看某座城市；.世界 <地点名|编号> 看详情（私聊里直接回数字也可以）';

interface LocationView {
  id: string;
  name: string;
  danger: number;
  weather: WeatherId;
  state: WeatherState | null;
}

interface WorldView {
  clock: WorldClock;
  locations: LocationView[];
}

function buildView(deps: RouterDeps, now: number): WorldView {
  deps.world.ensure(now, deps.worldSeed ?? 'world');
  const seed = deps.world.seed();
  const states = deps.world.weatherStates();
  const locations = deps.locations.all().map((location) => {
    const state = findWeather(states, location.id);
    return {
      id: location.id,
      name: location.name,
      danger: location.danger,
      weather: state?.weather ?? ('clear' as WeatherId),
      state,
    };
  });
  return { clock: worldClock(now, seed), locations };
}

function hoursText(ms: number): string {
  if (ms <= 0) return '即将结束';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  if (hours <= 0) return `${minutes} 分钟`;
  return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
}

/** 时段 + 月相 + 雾日（群聊与私聊共用的一行） */
function clockLine(deps: RouterDeps, view: WorldView, now: number): string {
  const seed = deps.world.seed();
  const days = Math.max(0, nextFogDay(seed, view.clock.dayIndex) - view.clock.dayIndex);
  return (
    `【世界】${clockLabel(now)} · ${TIME_OF_DAY_LABELS[view.clock.timeOfDay]}` +
    `　|　月相 ${moonPhaseLabel(view.clock.moonPhase)}（第 ${view.clock.moonPhase} 日）` +
    `　|　${view.clock.foggy ? '雾日（今天）' : `雾日（还有 ${days} 天）`}`
  );
}

function weatherSummaryLine(view: WorldView): string {
  return view.locations.map((location) => `${location.name} ${weatherLabel(location.weather)}`).join('　');
}

/** 该地点下一个天气的预告：与真正换天气时用的是同一个 tick 键，所以预告不会说谎 */
function forecastOf(
  deps: RouterDeps,
  state: WeatherState,
): { weather: WeatherId; at: number } {
  const seed = deps.world.seed();
  const at = state.until;
  const ctx = weatherWeightContext(worldClock(at, seed));
  const weather = rollWeatherAt({
    seed,
    locationId: state.locationId,
    rollAt: at,
    ctx,
    previous: state.weather,
  });
  return { weather, at };
}

/**
 * M2.85 内容填充 P2：地点**内容**索引（不是数据库仓储）。
 *
 * ⚠️ 踩过一次：地点档案一开始读的是 `deps.locations` —— 那是 **LocationRepo（数据库）**，
 * 它没有原作设定字段，于是 place_type / deity 全是空串（而 tsc 不会报错）。
 * 内容层的唯一起点是 `loadLocations()`（与 `.线索` 的反查同一模式）：内容表只在启动时读，
 * 进程活着的时候它不会变，所以模块级记一份。
 */
let locationContentIndex: Map<string, LocationDef> | null = null;
function locationContentOf(id: string): LocationDef | null {
  if (!locationContentIndex) {
    locationContentIndex = new Map(loadLocations().locations.map((location) => [location.id, location]));
  }
  return locationContentIndex.get(id) ?? null;
}

/**
 * M2.85 内容填充 P2：原作地点类型的中文名（YAML 里保留原文，展示时翻译）。
 */
const PLACE_TYPE_LABELS: Record<string, string> = {
  church: '教堂 / 圣所', ruin: '遗迹', government_site: '政府机构', military_site: '军事设施',
  organization_site: '组织据点', holy_site: '圣地', undefined: '未分类',
};

export function renderWorldDetail(
  deps: RouterDeps,
  now: number,
  query: string,
  /** 玩家所在城市的地点 id。菜单里显示的就是这一批，数字编号要优先在这里找 */
  scope?: readonly string[],
): CommandResult {
  const view = buildView(deps, now);
  const index = parsePositiveInt(query);
  /*
   * 数字编号：**先在本城列表里找，找不到再按全境**。
   *
   * 菜单里只列本城地点、编号从 1 起，所以玩家发「.世界 1」时心里的那个 1
   * 指的是菜单第一项。若这里直接按全境解析，玩家会拿到完全另一个地点 ——
   * 而两条路显示的都只是「1」，这种不一致玩家根本看不出来（测试逮到过）。
   * 保留全境兜底是为了向后兼容：老玩家可能记得某个全境的编号。
   */
  const scoped = scope === undefined
    ? []
    : view.locations.filter((location) => scope.includes(location.id));
  const target =
    index !== null
      ? (scoped[index - 1] ?? view.locations[index - 1] ?? null)
      : (view.locations.find((location) => location.name === query || location.id === query) ?? null);

  if (!target) {
    return { privateText: `没有这个地方：${query}\n${WORLD_USAGE}`, detailToPrivate: true };
  }

  const modifiers = worldModifiers({ clock: view.clock, weather: target.weather });
  /*
   * M2.86：**天气屏也上色 + emoji**（用户：「上色的地方也少，该用 emoji 的也不要省」）。
   *
   * 这一屏原本是一整片同色的文字，玩家要读很久才知道「这里危不危险」。
   * 首行三个信息各配一个 emoji：地点 / 天气 / 危险 —— 扫一眼就知道自己在看什么。
   */
  const wc = deps.supportsColor === true;
  const lines: string[] = [];
  // 三段之间必须有分隔，否则「🌦️ 晴⚠️ 危险」会粘在一起（withEmoji 只在符号前加空格）
  lines.push(
    withEmoji(EMOJI.place, '【' + target.name + '】')
      + ' ' + withEmoji(EMOJI.weather, weatherLabel(target.weather))
      + ' ' + withEmoji(EMOJI.danger, hl(dangerLabel(target.danger), target.danger >= 4 ? 'danger' : target.danger >= 3 ? 'warn' : 'ok', wc)),
  );
  /*
   * M2.85 内容填充 P2：**地点档案**（原作设定字段的执行点）。
   *
   * 原作 37 个地点带来类型 / 神祇 / 角色 / 曾在它这里发生的事 ——
   * 没有这一段，那些字段就是「只写着没人读」（AGENTS 明令禁止）。
   */
  const locationDef = locationContentOf(target.id);
  if (locationDef) {
    const profile: string[] = [];
    if (locationDef.place_type !== '') profile.push(`类型：${PLACE_TYPE_LABELS[locationDef.place_type] ?? locationDef.place_type}`);
    if (locationDef.deity !== '') profile.push(`神祇：${locationDef.deity}`);
    if (locationDef.country !== '') profile.push(`所属：${locationDef.country}`);
    if (locationDef.role !== '') profile.push(`角色：${locationDef.role}`);
    if (locationDef.status !== '') profile.push(`状态：${locationDef.status}`);
    if (locationDef.name_note !== '') profile.push(`注：${locationDef.name_note}`);
    if (locationDef.notable_events.length > 0) {
      profile.push('', '在这里发生过：');
      for (const event of locationDef.notable_events.slice(0, 3)) profile.push(`> ${event}`);
    }
    if (profile.length > 0) lines.push(...profile, '');
  }
  if (target.state) {
    lines.push(
      `起于 ${clockLabel(target.state.since)} · 持续到 ${clockLabel(target.state.until)}` +
        `（还有 ${hoursText(target.state.until - now)}）`,
    );
    if (target.state.pendingWeather && target.state.pendingAt !== null) {
      lines.push(
        withEmoji(EMOJI.weather, `扩散：${weatherLabel(target.state.pendingWeather)} 将在 ${clockLabel(target.state.pendingAt)} 从相邻地区过来`),
      );
    }
  }
  lines.push('');
  lines.push('影响：');
  for (const line of weatherEffectLines(target.weather)) lines.push(`  ${line}`);
  // 探索危险倍率越高越该醒目：>1.5 红、>1.15 橙、否则绿
  const risky = modifiers.exploreDangerMultiplier;
  /*
   * ⚠️ M2.164：这里原来还印着一句「扮演疯狂 +N/次」。
   * `.扮演` 已在 M2.121 下线（用户拍板改走途径专属事件卡）——
   * 于是那句话成了**一个不存在的动作的代价**：玩家照它去试，只会收到「没有这条指令」。
   * M2.122 清过一批失效菜单项，这一处漏了（它不在菜单里，在正文里）。
   */
  lines.push(
    '  ' + withEmoji(EMOJI.danger, '探索危险 ×' + hl(risky.toFixed(2), risky > 1.5 ? 'danger' : risky > 1.15 ? 'warn' : 'ok', wc)) +
      `　调制成功率 ${modifiers.potionSuccessBonus >= 0 ? '+' : ''}${(modifiers.potionSuccessBonus * 100).toFixed(0)}%`,
  );
  if (view.clock.fullMoon) lines.push('  \u{1F315} 月圆：仪式（调制）成功率 +15%、失控概率 +10%');
  lines.push('');
  if (target.state) {
    const forecast = forecastOf(deps, target.state);
    lines.push(
      withEmoji(EMOJI.time, `预告：约 ${hoursText(forecast.at - now)}后转为${weatherLabel(forecast.weather)}`) +
        (isEpicWeather(forecast.weather) ? '（显著天气，会全群播报）' : ''),
    );
  }

  const groupText =
    `【${target.name}】${weatherLabel(target.weather)} · 探索危险 ×${modifiers.exploreDangerMultiplier.toFixed(2)}` +
    ` · 掉落 ×${modifiers.dropMultiplier.toFixed(2)}` +
    (isEpicWeather(target.weather) ? ' · 异象' : '');

  return { privateText: lines.join('\n'), groupText, detailToPrivate: true };
}

export async function handleWorld(ctx: CommandContext): Promise<CommandResult> {
  const { deps, now, msg } = ctx;
  const query = ctx.args.join(' ').trim();
  const character = deps.characters.findByUserId(msg.userId);
  // 玩家当前**地点**（存在 flags.loc 里，与 .挑战 那条路读的是同一个键）。
  // 地图上那个「你在」标记靠它 —— 城市不够，玩家要知道自己站在哪一处。
  const here = character === null ? null : deps.flags.value(character.id, 'loc');
  // 玩家所在城市的地点 id —— 菜单只列这一批，数字编号也按这一批解析（两者必须一致）
  const cityLocationIds = character?.currentCityId
    ? (deps.cities.get(character.currentCityId)?.locations ?? [])
    : null;

  /*
   * ── 切换（M2.55）──────────────────────────────
   *   .世界           默认：地图 + 本城文字 + 菜单
   *   .世界 地图       只发地图，不落菜单 —— 只想瞄一眼天气时用
   *   .世界 全部       全境 58 处（图照发，老玩家习惯的那份完整列表）
   *   .世界 城市 <名>  看某座城市
   *   .世界 <地点>     地点详情（原有路径，一个字都没动）
   *
   * ⚠️ 城市**必须带「城市」这两个字**，不能省。
   * 我第一版让城市名直接匹配，结果「廷根市」既是城市 id 又是那座城里一个地点 ——
   * .世界 廷根市 从「看这个地点」变成了「看整座城市」，而这条老路径是有测试钉着的
   * （测试当场红）。名字空间的冲突不能靠猜优先级解决，只能靠显式语法。
   * 同理，关键词先于地点解析：将来真出一个叫「地图」的地点，也不会把模式吞掉。
   */
  const onlyMap = query === '地图' || query === '图';
  const showAll = query === '全部' || query === '全境' || query === '所有';
  /*
   * M2.85 P2：**.世界 区域 <名>** —— 原作国家设定（政体 / 首都 / 语言 / 国教 / 皇室途径）
   * 的执行点。没有它，regions.yaml 新扩的那批字段就是「只写着没人读」。
   */
  const regionArg = /^区域\s*(.+)$/.exec(query);
  if (regionArg !== null) {
    const wanted = regionArg[1]!.trim();
    const region = deps.geo.regions.find((entry) => entry.name === wanted || entry.id === wanted) ?? null;
    if (region === null) {
      return {
        privateText: `没有这个区域：${wanted}\n可用的区域：${deps.geo.regions.map((entry) => entry.name).join('、')}`,
        detailToPrivate: true,
      };
    }
    return { privateText: regionProfile(region, deps), detailToPrivate: true };
  }

/**
 * M2.164：**死者与归来者** —— `.世界 死者` 的执行点。
 *
 * 为什么必须有这个入口：死亡是**世界侧的状态**（npc_life 表），而玩家能看到的
 * 只有那一条会过期的世界播报。没有这个入口，「NPC 真的会死」对玩家来说就只是
 * 一条刷过去就没了的话 —— 与「显示个文本但没机制」是同一类问题。
 *
 * 三件事按顺序说：**最近走的**（含死因与谁的手笔）· **被找回来的** · 以及那条规矩本身。
 */

/**
 * M2.167：**这个世界里的人是怎么坏掉的** —— `.世界 堕落` 的执行点。
 *
 * 三件事，按玩家该知道的顺序说：
 *   ① 这一带现在有什么东西在走动（带**它原本是谁** —— 那才是让人记住的部分）
 *   ② 这座城市里已经不是人的那些
 *   ③ 被清理过的（教会做过什么，以及为什么有些清理没成）
 *
 * ⚠️ 只报**地点与名字**，不报隐藏数值（危险度、序列、血量那一套属于遭遇时的事）——
 *    与 `.世界 死者` 同一条口径：玩家读到的是世界里的事实，不是一张表。
 */
function fallenRoll(deps: RouterDeps, character: { currentCityId?: string | null } | null): string[] {
  const lines: string[] = ['【世界 · 堕落】'];
  const cityId = character?.currentCityId ?? null;
  const inCity = (locationId: string): boolean =>
    cityId === null || deps.geo.cityOfLocation(locationId)?.id === cityId;
  const alive = deps.creatures.all().filter((c) => c.speciesId.startsWith('fallen:') && inCity(c.locationId));
  if (alive.length === 0) {
    lines.push('', '这一带暂时没有那种东西在走动。');
  } else {
    lines.push('', '这一带现在有：');
    for (const beast of alive) {
      const npcId = beast.id.startsWith('beast:') ? beast.id.slice('beast:'.length) : '';
      const was = npcId === '' ? '' : deps.npcRoster.nameOf(npcId);
      const species = deps.creatureIndex.byId(beast.speciesId);
      const where = deps.locations.get(beast.locationId)?.name ?? beast.locationId;
      lines.push(' · ' + where + '：一只「' + (species?.name ?? '？') + '」' + (was === '' ? '' : ' —— 它原本是' + was));
    }
  }
  const changed = deps.npcLife.beasts();
  if (changed.length > 0) {
    lines.push('', '已经不是人的（' + changed.length + ' 位）：');
    for (const life of changed.slice(0, 8)) lines.push(' · ' + deps.npcRoster.nameOf(life.npcId));
    if (changed.length > 8) lines.push(' …（还有 ' + (changed.length - 8) + ' 位）');
  }
  const culled = deps.worldEvents.all().filter((e) => e.id.startsWith('npc-cull-')).slice(-6);
  if (culled.length > 0) {
    lines.push('', '被清理过的：');
    for (const e of culled) lines.push(' · ' + e.text.split(String.fromCharCode(10)).slice(1).join(' '));
  }
  lines.push('', '（教会管这件事。他们来得早或晚，取决于城里有没有人手。）');
  return lines;
}
function deadRoll(deps: RouterDeps, now: number): string[] {
  const all = deps.npcLife.dead();
  const lines: string[] = ['【世界 · 死者】'];
  if (all.length === 0) {
    lines.push('', '这一阵没有人死。');
  } else {
    lines.push('', '最近走的（共 ' + all.length + ' 位）：');
    for (const life of all.slice(0, 12)) {
      const name = deps.npcRoster.nameOf(life.npcId);
      const kind = DEATH_KIND_LABELS[life.deathKind as DeathKind] ?? life.deathKind;
      const when = life.diedAt === null ? '' : dateKey(life.diedAt);
      const by = life.killer === '' ? '' : '（' + deps.npcRoster.nameOf(life.killer) + ' 的手笔）';
      lines.push(' · ' + name + ' —— ' + kind + by + (when === '' ? '' : ' · ' + when));
    }
    if (all.length > 12) lines.push(' …（还有 ' + (all.length - 12) + ' 位）');
  }
  const back = deps.npcLife.all().filter((life) => life.alive && life.revivals > 0);
  if (back.length > 0) {
    lines.push('', '被找回来的：');
    for (const life of back) {
      const name = deps.npcRoster.nameOf(life.npcId);
      /*
       * ⚠️ M2.164：这一行必须写清「回来的是谁」——
       * 用户追问过「神明复活的他还是他吗？邪神复活的他还是人吗？」。
       * 只写「某某回来了」等于把这个问题藏起来（而形态是已经算好的状态）。
       */
      const form = RETURN_FORM_LABELS[life.returnedAs as ReturnForm] ?? '回来了';
      const notHuman = life.human ? '' : ' —— 而他不再是人';
      lines.push(' · ' + name + '（被找回来 ' + life.revivals + ' 次 · ' + form + notHuman + '）');
    }
  }
  lines.push('', '（死在这个世界里是不可逆的 —— 唯一一条回来的路，是有人替他开了一扇门。）');
  return lines;
}
  /*
   * M2.164：**.世界 死者** —— 谁死了、谁被找了回来。
   *
   * 与「地图 / 全部」同样的写法：**关键词先于地点解析** ——
   * 将来真出一个叫「死者」的地点，也不会把这个模式吞掉。
   */
  if (query === '死者' || query === '死亡') {
    return { privateText: deadRoll(deps, now).join('\n'), detailToPrivate: true };
  }
  /*
   * M2.167：**.世界 堕落** —— 这个世界的坏掉是可以被看见的。
   *
   * 与 `.世界 死者` 并列：那一条说「谁死了」，这一条说「谁不再是人了、以及谁被清掉了」。
   */
  if (query === '堕落' || query === '异变') {
    return { privateText: fallenRoll(deps, character).join('\n'), detailToPrivate: true };
  }
  const cityArg = /^城市\s*(.+)$/.exec(query);
  const wantedCity = cityArg === null ? null : cityArg[1]!.trim();
  const queryCity = wantedCity === null
    ? null
    // M2.85 P2：走 GeoIndex（内容层的 City，含原作设定字段），不是数据库的 cities 表
    : deps.geo.cityByNameOrId(wantedCity);
  if (wantedCity !== null && queryCity === null) {
    return {
      privateText: '没有这座城市：' + wantedCity + '\n可用的城市：' +
        deps.geo.cities.map((city) => city.name).join('、'),
      detailToPrivate: true,
    };
  }
  if (query !== '' && !onlyMap && !showAll && wantedCity === null) {
    return renderWorldDetail(deps, now, query, cityLocationIds ?? undefined);
  }

  // scopeIds = null 表示全境；否则只列这些地点
  const scopeIds = showAll ? null : (queryCity?.locations ?? cityLocationIds);
  const scopeTitle = showAll ? null : (queryCity?.name ?? null);

  const view = buildView(deps, now);
  const summary = clockLine(deps, view, now);
  const clearDanger = worldModifiers({ clock: view.clock, weather: 'clear' }).exploreDangerMultiplier;
  /*
   * 世界地图（M2.54）：**一张图代替 58 行文字**。
   *
   * 原来的 .世界 返回 1691 字 / 65 行，大部分行说的还是同一件事（全服都是晴）——
   * 那不是展示世界，那是把数据库倒给玩家看。地图能给出列表给不出的东西：
   * 空间、异常在哪、以及「哪几处即将变天」（世界在动，就靠那一颗颗金点说出来）。
   *
   * 顺序与角色卡一致：**先出图、文字兜底**。发不出图时下面的文字仍然完整，
   * 玩家不会因为通道不支持图片就看不到世界。
   */
  const adapter = deps.adapter;
  if (character && adapter?.supportsImages === true && adapter.sendImage) {
    try {
      const png = renderWorldMap(deps.db, now, here);
      await adapter.sendImage(msg.scene, msg.scene === 'private' ? msg.userId : msg.sceneId, {
        bytes: png,
        mediaType: 'image/png',
        alt: '世界地图',
      });
    } catch (error) {
      deps.logger?.warn?.('[world] 世界地图出图失败，回落文字：' + (error as Error).message);
    }
  }

  // 只想看图：图已经发出去了，不必再落一份菜单（菜单是有状态的，落了就要等回复）
  if (onlyMap) return { privateText: '', groupText: '', detailToPrivate: true };

  /*
   * 文字只列**本次范围内**的地点 —— 地图已经把全境给完了。
   * 默认范围是玩家所在城市（他真正会走的多半就是那几个），
   * 想换范围用上面那几种参数（地图 / 全部 / 城市名）。
   */
  const scoped = scopeIds === null
    ? view.locations
    : view.locations.filter((location) => scopeIds.includes(location.id));
  // 范围内一处都没匹配到（内容表漏登记、或城市刚建还没挂地点）时退回全境 ——
  // 宁可多列，也不要给玩家一片空白
  const shown = scoped.length > 0 ? scoped : view.locations;

  const list = shown.map((location) => {
    const mark = isEpicWeather(location.weather) ? ' ⚠' : '';
    return ` · ${location.name}（${dangerLabel(location.danger)}）${weatherLabel(location.weather)}${mark}`;
  });

  const epic = view.locations.filter((location) => isEpicWeather(location.weather));
  const lines = [
    summary,
    `本时段基准：探索危险 ×${clearDanger.toFixed(2)}（${TIME_OF_DAY_LABELS[view.clock.timeOfDay]}${view.clock.foggy ? '·雾日' : ''}）` +
      `　${view.clock.fullMoon ? '月圆：调制成功率 +15%、失控概率 +10%' : '非月圆'}`,
    '',
    shown.length < view.locations.length
      ? (scopeTitle === null ? '本城天气' : scopeTitle + '天气') +
        '　·　全境共 ' + view.locations.length + ' 处（.世界 全部 看全境，地图上是全部）：'
      : '地点天气：',
    ...list,
  ];
  if (epic.length > 0) {
    lines.push('', `异象中：${epic.map((location) => `${location.name} ${weatherLabel(location.weather)}`).join('、')}`);
  }
  /*
   * M2.85 内容填充 P2：**城市档案**。
   *
   * 原作数据里每座城市都有别名 / 特征 / 城区 / 地标 / 人口 —— 这些字段的执行点就是这里
   * （.世界 城市 <名或别名>）。没有这一段，它们就是「只写着没人读」的字段。
   */
  if (queryCity) {
    const profile = cityProfile(queryCity);
    if (profile.length > 0) lines.splice(2, 0, ...profile, '');
  }
  // M2.4：世界说过的话也在 .世界 里留个底（错过群里那条播报的玩家能补看）
  const liveEvent = deps.worldEvents.latestLive(now);
  if (liveEvent) {
    lines.push('', `【世界动态】${liveEvent.text.replace(/\n/g, ' ')}`);
  }
  /*
   * M2.87：**【神明出手】** —— 让权柄「看得见」。
   *
   * ## 为什么单开一栏，而不是塞进世界动态
   *
   * 用户的要求：「神明的权柄是能够影响整个世界的，这点你要设计的让玩家都能直白的感受到
   * 神明权柄的强大」。
   *
   * 世界动态是**一条流**（过去发生过什么），而权柄是**一个处境**（现在你正处在什么之中）。
   * 两者混在一起的话，玩家会把它当成又一条播报划过去 —— 而它其实正在改他的数字。
   * 所以这一栏放在最显眼的位置，而且**写清它改了什么**：不是「愚弄降临了」，
   * 而是「愚弄 · 理智 ×1.5 · 剩 4 小时 · 全境」。
   */
  /*
   * 抽成变量：**两条输出路径都要用它**（`lines` 给公屏、菜单 context 给私聊）。
   * 写成一个函数/变量而不是抄两遍 —— 抄两遍的下场是改一处忘一处。
   */
  const authorityLines: string[] = [];
  const active = activeAuthorities(deps.world, now);
  if (active.length > 0) {
    const rows = active.map((a) => {
      const id = a.source.replace('authority:', '');
      const def = (deps.authorities ?? []).find((x) => x.id === id) ?? null;
      const name = def?.name ?? id;
      const where = a.scope === '*' ? '全境' : (deps.locations.get(a.scope)?.name ?? a.scope);
      const kinds = a.kinds
        .map((k) => AUTHORITY_KIND_LABELS[k] ?? k)
        .join(' · ');
      return '· ' + name + '　' + kinds + '　' + hoursLeft(a.until, now) + '　' + where;
    });
    authorityLines.push(
      '【神明出手】' + active.length + ' 处在生效 —— 它们正在改这个世界的规则：',
      ...rows,
      '> 权柄生效期间，你在受影响范围里的某些举动会**直接失效**。这不是你的问题。',
    );
    lines.push('', ...authorityLines);
  }
  lines.push('', '发送 .世界 <地点名|编号> 查看详细天气、影响与预告。');

  // M2.3：私聊里把地点列表落成菜单 —— M2.2 的「回数字看详情」从此走统一的 pending_menus，
  // 而不是靠路由里那条特判（那条特判已经被「数字 = 菜单回复」取代）。
  if (character) {
    /*
     * key 是**菜单自己的序号**（1、2、3…），因为它只服务一条路：
     * 玩家回数字 → 走 pending_menus → 它按 key 找菜单项。
     *
     * 曾经想过用全局序号让两者一致，但那会让菜单编号跳号（6、9、13…）——
     * 玩家看到的第一项是「6. 黑荆棘修道院」，没人会去回 6。
     * 所以文字列表里**不显示编号**（见上面 list 的注释），
     * 「.世界 编号」那条显式路径保留全境语义，两者不再互相干扰。
     */
    const baseOptions: MenuOption[] = shown.map((location, index) => ({
      key: String(index + 1),
      label:
        `${location.name}（${dangerLabel(location.danger)} · ${weatherLabel(location.weather)}）` +
        (isEpicWeather(location.weather) ? ' ⚠ 异象' : ''),
      command: `世界 ${location.name}`,
      preview: `危险 ×${worldModifiers({ clock: view.clock, weather: location.weather }).exploreDangerMultiplier.toFixed(2)}`,
    }));
    // 世界事件的三个选项接在地点后面（编号顺延，不覆盖地点那一段）
    const eventOptions: MenuOption[] = (liveEvent?.options ?? []).map((option, index) => ({
      key: String(baseOptions.length + index + 1),
      label: `世界事件：${option.label}`,
      command: option.command,
    }));
    const menu: Menu = {
      title: '【世界 · 各地天气】',
      context: [
        summary,
        /*
         * ⚠️ **两条输出路径各自建文本，`lines` 不会被复用。**
         *
         * 有角色时走菜单（这一支），菜单的 context 是**在这里重新拼的** ——
         * 所以任何「推给 lines」的内容在私聊里都不会出现。
         * 【神明出手】栏第一版就栽在这儿：推到 lines 里，公屏看得到、私聊看不到，
         * 而私聊才是玩家最常用的那条路（世界动态也是因此在这里单独又说了一遍）。
         */
        ...(authorityLines.length > 0 ? [...authorityLines, ''] : []),
        // M2.85 P2：城市档案 —— 私聊走的是菜单，档案必须挂在这里（不是 lines）
        ...(queryCity ? [...cityProfile(queryCity), ''] : []),
        `本时段基准危险 ×${clearDanger.toFixed(2)}（${TIME_OF_DAY_LABELS[view.clock.timeOfDay]}${view.clock.foggy ? '·雾日' : ''}）`,
        ...(liveEvent ? [`世界动态：${liveEvent.text.replace(/\n/g, ' ')}`] : []),
      ],
      options: [...baseOptions, ...eventOptions],
      allowFreeform: true,
    };
    return {
      privateText: deps.pendingMenus.open(character.id, 'world', menu, now),
      groupText: [summary, weatherSummaryLine(view), '发送 .世界 地点 查看详情。'].join('\n'),
      detailToPrivate: true,
      menuOpened: true,
    };
  }

  return {
    privateText: lines.join('\n'),
    groupText: [summary, weatherSummaryLine(view), '发送 .世界 地点 查看详情。'].join('\n'),
    detailToPrivate: true,
  };
}
