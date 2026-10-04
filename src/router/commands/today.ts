/**
 * `.今日` 指令（M2.3）。
 *
 * 它是**菜单过期后的重新开始入口**（任务书 §5.1）：
 *   玩家回数字 → 菜单过期 → 「菜单已过期，发 .今日 重新开始」→ 玩家只要发两个字就能拿到全部选项。
 *
 * 同时也是「不看 .世界 也知道今天什么天气」的落点（验收项）：
 * 「.今日 和菜单天然带世界状态」，所以 .世界 的覆盖率不再依赖人为注入。
 */
import { buildTodayMenu, pathwayKit } from '../../domain/menu/index.ts';
import { calamityAt } from '../../domain/world/calamity.ts';
import { TIME_OF_DAY_LABELS } from '../../domain/world/clock.ts';
import { weatherLabel } from '../../domain/world/weather.ts';
import { menuCharacterFor, worldSnapshotFor } from '../menu.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { GROUP_MENU_HINT, requireCharacter } from './common.ts';
import { pvpWaitBlockFor } from './pvp-hooks.ts';

export const TODAY_USAGE = '用法：.今日 看今天的摘要与可做选项（菜单过期后也用它重新开始）';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * M2.14：灾厄那一块文本。
 *
 * ⚠️ `.今日` **不读 world_events`**（今天的菜单是纯函数生成的，没有事件入参），
 * 所以灾厄要进 `.今日` 必须在这里接一段 —— 手法照 M2.11 前置 3 的 pvpWaitBlockFor：
 * 拼在菜单后面，**不碰菜单生成器、不碰 WorldSnapshot、不碰判定层**。
 *
 * `[灾厄]` 前缀是硬要求：`.今日` 后面已经会接第二块（等待提示），
 * 没有前缀就分不清哪一行来自哪一块。
 */
function calamityBlock(deps: CommandContext['deps'], now: number): string[] {
  const calamity = calamityAt(deps.worldSeed ?? 'world', now);
  if (!calamity) return [];
  const leftDays = Math.max(1, Math.ceil((calamity.until - now) / DAY_MS));
  return [
    `[灾厄] ${calamity.name} —— 还有 ${leftDays} 天。外面的东西比平时更强，也更愿意往有人的地方走。`,
    '[灾厄] 出去会更危险；但愿意动手的人，会拿到平时拿不到的东西。',
  ];
}

export async function handleToday(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const { deps, msg, now } = ctx;

  const world = worldSnapshotFor(deps, now, character, undefined, { withLocations: true });
  /*
   * 群聊摘要。群聊与私聊已经合成同一条路（见 router 的 #reply），
   * 所以下面那个 groupText 当前不再参与分流 —— 留着是为了不动 8 个命令的返回结构，
   * 将来若要按场景分口径，钩子还在。
   */
  const summary =
    `${weatherLabel(world.weather)} · ${TIME_OF_DAY_LABELS[world.clock.timeOfDay]}` +
    ` · DIG ${character.dig.toFixed(1)} · MAD ${character.mad} · COR ${character.cor}`;
  const menu = buildTodayMenu(
    menuCharacterFor(deps, character, now),
    world,
    // M2.7.6：普通人没有途径 —— 不传，菜单会走「还没有途径」那一套
    character.pathway ? pathwayKit(character.pathway) : undefined,
    deps.inventory.list(character.id),
  );
  const opened = deps.pendingMenus.openWith(character.id, 'today', menu, now);
  /*
   * M2.11 前置 3：.今日 是「菜单过期后的重新开始入口」，玩家在 PVP 等待期
   * 最常发的就是它。把等待状态接在菜单后面 —— 他要的信息一次给全。
   */
  const calamity = calamityBlock(deps, now);
  const wait = pvpWaitBlockFor(deps, character, now);
  return {
    privateText: [opened.text, ...(calamity ? ['', ...calamity] : []), ...(wait ? ['', ...wait] : [])].join('\n'),
    groupText: `【${character.name}】的今日：${summary}`,
    detailToPrivate: true,
    menuOpened: true,
    // M2.7：官方机器人直接摆按钮；OneBot 发上面那段文本（M2.3 的数字回复不变）
    interactive: opened.interactive,
  };
}
