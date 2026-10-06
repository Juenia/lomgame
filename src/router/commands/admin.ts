/**
 * **管理员指令**（M2.172）。
 *
 * 十七条，三种：玩家处置（封禁 / 解禁）、开关（游戏 / 主动推送 / 主动事件推送，各带全局与本群）、
 * 运行状态（游戏 / 世界 / 机器人）。外加 `.管理` 出那张卡片菜单。
 *
 * ## 三条纪律
 *
 * 1. **只有名单里的人能用。** 名单是并集：`.env` 的 `ADMIN_IDS`（后台可改）
 *    与上游插件上报的（见 `domain/admin/registry.ts`）。
 * 2. **非管理员看到的不是「无权」，是「没有这条指令」。** 群里回一句「你不是管理员」
 *    等于把「这个群有管理员指令」告诉了所有人。所以统一回一条**私聊**提示，群里一个字都不发。
 * 3. **每一次写入都进审计**（与后台 GM 同一条纪律）。封了谁、关了哪个群，事后要查得到人。
 *
 * ## 本群类指令为什么必须在群里发
 *
 * 「本群」= 消息所在的会话。私聊里没有群号可用，写 null 会静默落到全局 ——
 * 那是**把一条本群指令变成了全服指令**，而发指令的人以为只影响自己那个群。
 * 所以这类指令在私聊里直接拒绝，并说清要在群里发。
 */
import { parseAtTarget } from '../args.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { SWITCH_KEYS, SWITCH_LABELS, ServerSwitchRepo, type SwitchKey } from '../../infra/db/server-switches.ts';
import { AdminRegistry } from '../../domain/admin/registry.ts';

/*
 * 两个兜底实例（M2.172）：RouterDeps 里那两位是可选的（测试夹具不传），
 * 于是指令层要用一个**共享的默认档** —— 每次新建会让「改完没生效」变成一个随机现象。
 *
 * 默认档 = 开关全开 + 谁都不是管理员。于是：管理员的判断在没配置时恒为 false（安全的一侧），
 * 而开关的读取恒为 true（不改变既有行为）。
 */
const FALLBACK_SWITCHES = new ServerSwitchRepo();
const FALLBACK_ADMINS = new AdminRegistry();

function switchesOf(ctx: CommandContext): ServerSwitchRepo {
  return ctx.deps.serverSwitches ?? FALLBACK_SWITCHES;
}

function adminsOf(ctx: CommandContext): AdminRegistry {
  return ctx.deps.admins ?? FALLBACK_ADMINS;
}
import { TIME_OF_DAY_LABELS, worldClock } from '../../domain/world/clock.ts';

/** 非管理员看到的唯一一句话（私聊，群里不发） */
const NOT_ADMIN = '这条指令只有管理员能用。';

/** 管理员守卫：不是管理员就回一条私聊提示 */
export function requireAdmin(ctx: CommandContext): CommandResult | null {
  if (adminsOf(ctx).isAdmin(ctx.msg.userId)) return null;
  return { privateText: NOT_ADMIN, detailToPrivate: true, suppressMenu: true };
}

/** 当前会话的群号（私聊 / 频道之外为 null） */
function sceneIdOf(ctx: CommandContext): string | null {
  return ctx.msg.scene === 'group' || ctx.msg.scene === 'channel' ? ctx.msg.sceneId : null;
}

/** @ 一个人：先看切好的参数，再看原文（OneBot 的 @ 是 CQ 码，可能整段留在原文里） */
function targetOf(ctx: CommandContext): string | null {
  const fromArgs = parseAtTarget(ctx.args.join(' '));
  if (fromArgs !== null) return fromArgs;
  return parseAtTarget(ctx.msg.rawText);
}

/** 记一笔审计 —— 管理员指令改的是全服状态，事后必须查得到是谁改的 */
function auditIt(ctx: CommandContext, command: string, input: string, output: string): void {
  try {
    ctx.deps.audit.write({ userId: ctx.msg.userId, command, input, output, createdAt: ctx.now });
  } catch { /* 审计失败不该让指令本身失败 —— 判定已经做完了 */ }
}

/** 管理员回执一律只回给本人：群里刷一片「已封禁」对其他人是噪音 */
function adminResult(ctx: CommandContext, lines: string[], command: string, input = ''): CommandResult {
  auditIt(ctx, command, input, lines.join(' | ').slice(0, 200));
  return { privateText: lines.join('\n'), detailToPrivate: true, suppressMenu: true };
}

/* ------------------------------------------------------------------ */
/* 玩家处置                                                            */
/* ------------------------------------------------------------------ */

function setBanned(ctx: CommandContext, banned: boolean): CommandResult {
  const command = banned ? '封禁' : '解禁';
  const target = targetOf(ctx);
  if (target === null) {
    return adminResult(ctx, ['要指定一个人：.' + command + ' @玩家（也可以直接写 QQ 号）'], command);
  }
  const character = ctx.deps.characters.findByUserId(target);
  if (character === null) {
    return adminResult(ctx, [target + ' 还没有角色 —— 他先在群里发一句 .创建 才有得封。'], command, target);
  }
  if (character.status === 'banned' && banned) {
    return adminResult(ctx, [character.name + '（' + target + '）已经是封禁状态。'], command, target);
  }
  if (character.status !== 'banned' && !banned) {
    return adminResult(ctx, [character.name + '（' + target + '）没有被封禁。'], command, target);
  }
  /*
   * ⚠️ 走 characters.update() 而不是裸 UPDATE —— 与后台 GM 同一条纪律：
   * update() 写全部列，绕开它去改单列很容易丢列（那种事故读库完全看不出来）。
   */
  character.status = banned ? 'banned' : 'active';
  ctx.deps.characters.update(character);
  const done = banned
    ? character.name + '（' + target + '）已封禁 —— 他之后发什么都进不来。解除用 .解禁 @玩家。'
    : character.name + '（' + target + '）已解禁，恢复正常。';
  return adminResult(ctx, [done], command, target);
}

export function handleBan(ctx: CommandContext): CommandResult {
  return requireAdmin(ctx) ?? setBanned(ctx, true);
}

export function handleUnban(ctx: CommandContext): CommandResult {
  return requireAdmin(ctx) ?? setBanned(ctx, false);
}

/* ------------------------------------------------------------------ */
/* 开关                                                                */
/* ------------------------------------------------------------------ */

/** 造一条开关指令：改某个开关的全局值或本群值 */
function switchCommand(key: SwitchKey, on: boolean, sceneScoped: boolean) {
  const verb = on ? '开启' : '关闭';
  const label = SWITCH_LABELS[key];
  const title = (sceneScoped ? '本群' : '') + label;
  return (ctx: CommandContext): CommandResult => {
    const denied = requireAdmin(ctx);
    if (denied !== null) return denied;
    let sceneId: string | null = null;
    if (sceneScoped) {
      sceneId = sceneIdOf(ctx);
      if (sceneId === null) {
        return adminResult(ctx, [
          '这条是「本群」指令，要在群里发。',
          '想改全服就发 .' + verb + label + '。',
        ], verb + title);
      }
    }
    switchesOf(ctx).set(key, sceneId, on, ctx.now);
    const scope = sceneId === null ? '全服' : '本群（' + sceneId + '）';
    const tail = sceneId === null
      ? '（本群单独设过的仍按本群的来；要看全部就发 .游戏状态）'
      : '（这个群从现在起按自己的设定走）';
    return adminResult(ctx, [scope + '的' + label + '已' + verb + '。', tail], verb + title);
  };
}

/* 十二条：三个开关 × 开/关 × 全局/本群 */
export const handleGameOff = switchCommand('game', false, false);
export const handleGameOn = switchCommand('game', true, false);
export const handleSceneGameOff = switchCommand('game', false, true);
export const handleSceneGameOn = switchCommand('game', true, true);
export const handlePushOff = switchCommand('push', false, false);
export const handlePushOn = switchCommand('push', true, false);
export const handleScenePushOff = switchCommand('push', false, true);
export const handleScenePushOn = switchCommand('push', true, true);
export const handleEventPushOff = switchCommand('push_event', false, false);
export const handleEventPushOn = switchCommand('push_event', true, false);
export const handleSceneEventPushOff = switchCommand('push_event', false, true);
export const handleSceneEventPushOn = switchCommand('push_event', true, true);

/* ------------------------------------------------------------------ */
/* 运行状态                                                            */
/* ------------------------------------------------------------------ */

/** 一个开关当前对谁生效 —— 全局值 + 本群有没有单独设过 */
function switchLine(ctx: CommandContext, key: SwitchKey, sceneId: string | null): string {
  const global = switchesOf(ctx).globalOf(key);
  const head = SWITCH_LABELS[key] + '：全服 ' + (global ? '开' : '关');
  if (sceneId === null) return head;
  const scene = switchesOf(ctx).sceneOf(key, sceneId);
  return head + ' · ' + (scene === null ? '本群 跟随全服' : '本群 ' + (scene ? '开' : '关'));
}

export function handleGameStatus(ctx: CommandContext): CommandResult {
  const denied = requireAdmin(ctx);
  if (denied !== null) return denied;
  const sceneId = sceneIdOf(ctx);
  const all = ctx.deps.characters.all();
  const banned = all.filter((character) => character.status === 'banned').length;
  const lines = ['【游戏状态】'];
  for (const key of SWITCH_KEYS) lines.push(switchLine(ctx, key, sceneId));
  lines.push('');
  lines.push('角色 ' + String(all.length) + ' 个 · 封禁 ' + String(banned) + ' 个');
  lines.push('机器人见过的群：' + String(ctx.deps.world.groups().length) + ' 个');
  lines.push('管理员：' + String(adminsOf(ctx).list().length) + ' 人');
  lines.push('');
  lines.push('改开关：.关闭游戏 / .开启游戏 / .关闭本群游戏 ……');
  lines.push('完整清单：.管理');
  return adminResult(ctx, lines, '游戏状态');
}

export function handleWorldStatus(ctx: CommandContext): CommandResult {
  const denied = requireAdmin(ctx);
  if (denied !== null) return denied;
  const clock = worldClock(ctx.now, ctx.deps.world.seed());
  const live = ctx.deps.worldEvents.live(ctx.now);
  const lines = ['【世界状态】'];
  lines.push('第 ' + String(clock.dayIndex) + ' 天 · ' + TIME_OF_DAY_LABELS[clock.timeOfDay] + ' · ' + String(clock.hour) + ' 时');
  lines.push('月相 ' + String(clock.moonPhase) + '/8' + (clock.fullMoon ? '（满月）' : '') + (clock.foggy ? ' · 今天是雾日' : ' · 下一个雾日：第 ' + String(clock.nextFogDay) + ' 天'));
  lines.push('世界 tick 累计 ' + String(ctx.deps.world.countTicks()) + ' 次 · 见过的群 ' + String(ctx.deps.world.groups().length) + ' 个');
  lines.push('');
  lines.push('当前公共事件 ' + String(live.length) + ' 条');
  for (const event of live.slice(0, 5)) {
    lines.push('　· ' + String(event.type) + '（' + String(event.visibility) + '）');
  }
  return adminResult(ctx, lines, '世界状态');
}

export function handleBotStatus(ctx: CommandContext): CommandResult {
  const denied = requireAdmin(ctx);
  if (denied !== null) return denied;
  const up = Math.floor(process.uptime());
  const hours = Math.floor(up / 3600);
  const minutes = Math.floor((up % 3600) / 60);
  const mem = Math.round(process.memoryUsage().rss / 1048576);
  const on = SWITCH_KEYS.map((key) => SWITCH_LABELS[key] + ' ' + (switchesOf(ctx).globalOf(key) ? '开' : '关'));
  const lines = ['【机器人状态】'];
  lines.push('平台：' + ctx.msg.platform + '（本条消息的通道）');
  lines.push('进程已运行 ' + (hours > 0 ? String(hours) + ' 小时 ' : '') + String(minutes) + ' 分 · 内存 ' + String(mem) + ' MB');
  lines.push('全服开关：' + on.join(' · '));
  lines.push('管理员 ' + String(adminsOf(ctx).list().length) + ' 人 · 见过的群 ' + String(ctx.deps.world.groups().length) + ' 个');
  lines.push('');
  lines.push('（通道与配额的详情在游戏机的 /health，这里只报进程与开关）');
  return adminResult(ctx, lines, '机器人状态');
}
