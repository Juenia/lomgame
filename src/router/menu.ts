/**
 * 选项驱动的路由层（M2.3）。
 *
 * 硬约束（任务书第十二节）：**状态判断不写在这一层**。
 * 这里只做四件事：
 *   1. 把库里的状态拼成纯函数要的输入（menuCharacterFor / worldSnapshotFor）
 *   2. 生成菜单 → 落 pending_menus → 返回文本（open）
 *   3. 收数字 → 查 pending_menus → 取出对应的完整指令（pick）
 *   4. 自由输入待命（回 0 之后的下一条消息按指令解析）
 *
 * 「生成什么选项」全部在 src/domain/menu/ 的纯函数里，路由层连 if 都不写。
 */
import { NUMERIC } from '../config/numeric.ts';
import { dateKey } from '../infra/date.ts';
import type { PendingMenuRepo } from '../infra/db/pending-menus.ts';
import type { WorldEventRepo } from '../infra/db/world-events.ts';
import { worldEventMenu } from '../domain/menu/world-event.ts';
import type { LocationDef } from '../domain/explore/location.ts';
import { worldClock } from '../domain/world/clock.ts';
import { worldModifiers, type WeatherId } from '../domain/world/weather.ts';
import { menuToInteractive, type InteractiveMessage } from '../adapter/interactive.ts';
import {
  FREEFORM_KEY,
  renderMenu,
  type LocationView,
  type Menu,
  type MenuCharacter,
  type MenuOption,
  type MenuType,
  type WorldSnapshot,
} from '../domain/menu/index.ts';
import type { CharacterState } from '../domain/character/types.ts';
import type { RouterDeps } from './index.ts';

/** 菜单过期后统一话术（任务书 §5.1） */
export const MENU_EXPIRED_TEXT = '菜单已过期，发 .今日 重新开始。';

export type PickResult =
  | { ok: true; kind: 'option'; option: MenuOption; menuType: MenuType }
  | { ok: true; kind: 'freeform'; menuType: MenuType }
  | { ok: false; reason: string };

/**
 * 菜单状态服务。
 * 只持有 pending_menus 仓储 —— 它不需要认识别的仓储，
 * 「菜单该生成什么」是纯函数的事，「菜单该怎么执行」是路由的事。
 */
export class MenuService {
  #repo: PendingMenuRepo;
  /**
   * M2.4：世界公共事件（可选注入）。
   * 有了它，数字回复在**找不到个人菜单**时可以落到最近一条还有效的世界事件上 ——
   * 「群里看到播报 → 私聊回数字」这条链路才不需要玩家先手动开一张菜单。
   * 不注入（老测试直接 new MenuService(repo)）时行为与 M2.3 完全一致。
   */
  #worldEvents: WorldEventRepo | null;

  constructor(repo: PendingMenuRepo, worldEvents?: WorldEventRepo) {
    this.#repo = repo;
    this.#worldEvents = worldEvents ?? null;
  }

  /**
   * 此刻挂在房间里的那张世界事件菜单（没有则为 null）。
   * 只认「还没过期」的事件：世界说过的话有个时效，过期之后再回数字不回放。
   */
  worldEventMenuAt(now: number): { menu: Menu; menuType: MenuType; eventId: string } | null {
    const event = this.#worldEvents?.latestLive(now) ?? null;
    if (!event || (event.options ?? []).length === 0) return null;
    return { menu: worldEventMenu(event), menuType: 'world_event', eventId: event.id };
  }

  /**
   * 生成菜单 → 落库 → 返回文本。
   *
   * 不接收 scene：菜单永远是「私聊资产」——
   * 群聊场景里 detailToPrivate 的那份明细也是发到玩家私聊的，玩家同样可以回数字。
   * 「群里不要在群里摆菜单」这件事由命令层决定（群里直接返回 GROUP_MENU_HINT，压根不调这里）。
   */
  open(characterId: string, type: MenuType, menu: Menu, now: number): string {
    return this.openWith(characterId, type, menu, now).text;
  }

  /**
   * M2.7：开菜单的同时给出**通道无关的选项**（InteractiveMessage）。
   *
   * 为什么两样一起返回而不是各开一次：菜单要落库（pending_menus 是数字回复的依据），
   * 选项要立刻交给通道去渲染。分成两次调用就有机会只做一半 ——
   * 那样的表现是「按钮能点，但点了回数字查不到选项」，最难查的一类 bug。
   *
   * text 仍然走 renderMenu（M2.3 的老渲染）而不是从 InteractiveMessage 反渲染：
   * 两边的等价性由测试守着（test/m2-7-interactive.test.ts 逐字比对），
   * 但生产路径一个字符都不动 —— 127 条既有断言都建立在那份文本上。
   */
  openWith(
    characterId: string,
    type: MenuType,
    menu: Menu,
    now: number,
  ): { text: string; interactive: InteractiveMessage } {
    this.#repo.save(characterId, type, menu, now);
    return { text: renderMenu(menu), interactive: menuToInteractive(menu) };
  }

  /** 当前菜单（过期即视为没有） */
  current(characterId: string, now: number): { menuType: MenuType; menu: Menu } | null {
    const row = this.#repo.findLive(characterId, now);
    return row ? { menuType: row.menuType, menu: row.menu } : null;
  }

  /**
   * 数字 → 选项 / 自由输入 / 失败原因。
   *
   * M2.4 起有**两张菜单源**，优先级：个人菜单（M2.3）> 世界事件菜单（M2.4）。
   * 这个顺序是有意的：玩家自己刚收到的菜单永远比房间里的广播更贴近他的意图。
   * 世界事件只在「个人菜单没有 / 已过期」时兜底 —— 群里那条播报说的就是
   * 「回数字参与」，而玩家并没有为此开过任何个人菜单。
   */
  pick(characterId: string, key: string, now: number): PickResult {
    const row = this.#repo.findLive(characterId, now);
    if (!row) {
      const shared = this.worldEventMenuAt(now);
      if (shared) {
        const option = shared.menu.options.find((entry) => entry.key === key);
        if (option) {
          return { ok: true, kind: 'option', option, menuType: shared.menuType };
        }
      }
      return { ok: false, reason: MENU_EXPIRED_TEXT };
    }
    if (key === FREEFORM_KEY) {
      if (!row.menu.allowFreeform) {
        return { ok: false, reason: `这个菜单没有自由输入。${MENU_EXPIRED_TEXT}` };
      }
      return { ok: true, kind: 'freeform', menuType: row.menuType };
    }
    const option = row.menu.options.find((entry) => entry.key === key);
    if (!option) {
      return {
        ok: false,
        reason: `没有第 ${key} 项（当前菜单有 1—${row.menu.options.length}）。${MENU_EXPIRED_TEXT}`,
      };
    }
    if (option.disabled) {
      return { ok: false, reason: `这一项现在不能选：${option.disabled}` };
    }
    return { ok: true, kind: 'option', option, menuType: row.menuType };
  }

  /** 玩家回了 0：进入「自由输入待命」，下一条私聊文本按完整指令解析 */
  beginFreeform(characterId: string, now: number): string {
    this.#repo.save(
      characterId,
      'freeform',
      {
        title: '【自由输入】',
        context: ['直接说你想做什么，例如：', '  扮演 在街口观察雾里的影子', '  探索 老码头'],
        options: [],
        allowFreeform: false,
      },
      now,
    );
    return [
      '好，你想做什么？直接写出来就行（不用带点号）。',
      '例：扮演 在街口观察雾里的影子　/　探索 老码头',
      `（${NUMERIC.menu.ttlMs / 60000} 分钟内有效；想看选项就发 .今日）`,
    ].join('\n');
  }

  /** 是否处于「自由输入待命」 */
  awaitingFreeform(characterId: string, now: number): boolean {
    return this.#repo.findLive(characterId, now)?.menuType === 'freeform';
  }

  clear(characterId: string): void {
    this.#repo.clear(characterId);
  }

  /** 懒清扫：指令入口顺手调用，节流由调用方控制 */
  clearExpired(now: number): number {
    return this.#repo.clearExpired(now);
  }

  count(): number {
    return this.#repo.count();
  }
}

/**
 * 菜单生成器看到的角色 = 数据库里那张卡 + 几张只读视图。
 * **这里只查、不判**：有没有圣盐、今天休息过没有，全交给纯函数去读。
 */
export function menuCharacterFor(deps: RouterDeps, character: CharacterState, now: number): MenuCharacter {
  const date = dateKey(now);
  const slots = deps.inventory.list(character.id);
  const party = deps.parties.partyOf(character.id);
  // M2.7.6：普通人没有途径，也就没有能力可解锁
  const abilities = character.pathway ? deps.abilities.unlockedFor(character.id, character.pathway) : [];
  const latest = [...abilities].sort((a, b) => b.seq - a.seq)[0];

  const potions = slots
    .map((slot) => deps.items.get(slot.itemId))
    .filter((item): item is NonNullable<typeof item> => item?.kind === 'potion')
    .map((item) => ({
      itemId: item.id,
      name: item.name,
      pathway: item.pathway,
      seq: item.seq,
    }));

  return {
    ...character,
    inventory: slots.map((slot) => {
      /*
       * M2.100：把**中文名**一并给菜单 ——
       * 背包的快捷按钮要写「使用 魔药·愚者·序列9」，没有名字就只能写 `potion_seer_9`。
       */
      const item = deps.items.get(slot.itemId);
      return {
        itemId: slot.itemId,
        quantity: slot.quantity,
        bindType: slot.bindType,
        name: item?.name ?? slot.itemId,
        kind: item?.kind ?? '',
      };
    }),
    partySize: deps.parties.partySizeOf(character.id),
    isPartyLeader: party ? party.leaderId === character.id : false,
    dailyCounters: Object.fromEntries(deps.dailyCounters.todayOf(character.id, date)),
    tagUsage: deps.tagUsage.usageOf(character.id, date),
    potions,
    exploreCounts: Object.fromEntries(deps.exploreDaily.todayOf(character.id, date)),
    // 只把**当前序列**解锁的能力报给菜单（菜单里那条「用新能力做这件事」）
    ...(latest && latest.seq === character.sequence ? { abilityName: latest.name } : {}),
    // M2.7.6 / M2.85：普通人菜单要看的那样 —— 手上有没有那张纸（.线索 项的 preview 用它）
    clueCount: deps.clues.unusedOf(character.id).length,
  };
}

/** 内容表 + 当日探索计数 + 该地点此刻的天气 → 探索菜单要的地点视图 */
export function locationViewsFor(deps: RouterDeps, characterId: string, date: string): LocationView[] {
  const counts = deps.exploreDaily.todayOf(characterId, date);
  return deps.locations.all().map((location: LocationDef) => ({
    id: location.id,
    name: location.name,
    // M2.7：城市归属（探索菜单按它过滤；查不到归属时给空串 = 不参与过滤）
    city: deps.geo.cityOfLocation(location.id)?.id ?? '',
    danger: location.danger,
    minSeq: location.min_seq,
    maxSeq: location.max_seq,
    lootCount: location.loot.length,
    usedToday: counts.get(location.id) ?? 0,
    weather: deps.world.weatherOf(location.id) as WeatherId,
  }));
}

/**
 * 菜单生成器看到的世界。
 * 与命令层判定用的 worldViewFor 走**同一条公式**（worldClock + worldModifiers），
 * 所以菜单上写的「危险 ×1.32」就是判定时真正会用的那个数 —— 菜单不会说谎。
 */
export function worldSnapshotFor(
  deps: RouterDeps,
  now: number,
  character: CharacterState,
  locationId?: string,
  options: { withLocations?: boolean } = {},
): WorldSnapshot {
  deps.world.ensure(now, deps.worldSeed ?? 'world');
  const clock = worldClock(now, deps.world.seed());
  const weather: WeatherId = locationId ? (deps.world.weatherOf(locationId) as WeatherId) : 'clear';
  const date = dateKey(now);
  const counts = deps.exploreDaily.todayOf(character.id, date);
  return {
    clock,
    weather,
    modifiers: worldModifiers({ clock, weather, ...(character.pathway ? { path: character.pathway } : {}) }),
    exploreUsedToday: locationId ? (counts.get(locationId) ?? 0) : 0,
    // 地点列表要查一次 locations 全表：只有真的会用到它的菜单才去取
    // （每条指令都追加「下一步」，这个开关是 200×14 长跑能不能压进 30 分钟的关键之一）
    ...(options.withLocations ? { locations: locationViewsFor(deps, character.id, date) } : {}),
  };
}

export { FREEFORM_KEY };
